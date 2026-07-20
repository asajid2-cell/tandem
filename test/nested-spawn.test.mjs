// Nested orchestration survival: a lane's worker spawned by a caller that runs
// INSIDE a Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (and no
// breakaway) must outlive that job closing. This is exactly what happens when a
// headless agent lane runs `peer.mjs ask --bg` from its own shell tool: the
// harness closes the tool call's job when the call returns, and every process
// still inside it is terminated — including a `detached: true` worker, because
// DETACHED_PROCESS does not remove a child from its parent's job.
//
// test/jobsim.ps1 recreates that environment deterministically: it runs the
// command in a fresh kill-on-close job and closes the job handle the moment the
// command exits. Windows-only (the bug and the fix are both Windows-specific).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { LANE_IDENTITY_VARS } from "../bin/claudeEnv.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobKey } from "../bin/groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PEER = join(ROOT, "bin", "peer.mjs");
const JOBSIM = join(HERE, "jobsim.ps1");
const FAKE_CODEX = join(HERE, "fake-codex.mjs");
const FAKE_CLAUDE = join(HERE, "fake-claude.mjs");
const IS_WIN = process.platform === "win32";
const CASE_TIMEOUT_MS = 90_000;
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE only — no breakaway flags, the restrictive
// job shape observed under nested headless-agent harnesses.
const KILL_ON_CLOSE = "0x2000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
  } catch {
    /* already gone */
  }
}

function laneEnv(state, driver, partner) {
  const env = { ...process.env };
  for (const k of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete env[k];
  env.TANDEM_STATE = state;
  env.TANDEM_PARTNER = partner;
  env.TANDEM_CWD = "";
  // real nested callers carry this marker: tandem injects it into every
  // partner agent's environment, and the agent's tool calls inherit it
  env.TANDEM_NESTED_AGENT = "1";
  if (partner === "claude") {
    env.CODEX_SESSION_ID = driver;
    env.TANDEM_CLAUDE_BIN = FAKE_CLAUDE;
  } else {
    env.CLAUDE_CODE_SESSION_ID = driver;
    env.TANDEM_CODEX_BIN = FAKE_CODEX;
  }
  return env;
}

// Run `peer.mjs <args>` inside a fresh kill-on-close job; the job handle closes
// as soon as the peer call returns — the nested caller's teardown, distilled.
function peerInsideJob(args, env) {
  const commandLine = [`"${process.execPath}"`, `"${PEER}"`, ...args.map((a) => `"${a}"`)].join(" ");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", JOBSIM, "-Flags", KILL_ON_CLOSE, "-Cwd", ROOT, "-CommandLine", commandLine, "-TimeoutMs", "60000"],
    { encoding: "utf8", windowsHide: true, timeout: 75_000, env },
  );
  const out = (r.stdout || "") + (r.stderr || "");
  assert.equal(r.status, 0, `jobsim failed: ${out}`);
  assert.match(out, /childExit=0/, `peer call inside the job did not succeed: ${out}`);
  return out;
}

function readJob(state, driver) {
  const file = join(state, `job-${jobKey(driver)}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

function readLast(state, driver) {
  const file = join(state, `last-${jobKey(driver)}.txt`);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

async function waitFor(condition, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = condition();
      if (value) return value;
    } catch {
      /* not ready yet */
    }
    await sleep(150);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
}

function freshState(t) {
  const state = mkdtempSync(join(tmpdir(), "tandem-nested-"));
  t.after(() => {
    // reap anything the lane still owns, then the daemon pid if present
    for (const name of readdirSync(state)) {
      if (/^job-.*\.json$/.test(name)) {
        try {
          const job = JSON.parse(readFileSync(join(state, name), "utf8"));
          for (const key of ["workerPid", "partnerPid"]) {
            if (Number(job?.[key]) > 0 && pidAlive(Number(job[key]))) killTree(Number(job[key]));
          }
        } catch {
          /* ignore */
        }
      }
    }
    const servePid = join(state, "serve.pid");
    if (existsSync(servePid)) {
      const pid = Number(readFileSync(servePid, "utf8").trim());
      if (pid && pidAlive(pid)) killTree(pid);
    }
    rmSync(state, { recursive: true, force: true });
  });
  return state;
}

test(
  "nested codex lane: the background worker survives the spawning caller's kill-on-close job",
  { skip: !IS_WIN, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const state = freshState(t);
    const driver = "nestedCodexDriver";
    const env = laneEnv(state, driver, "codex");
    env.FAKE_DELAY = "5000"; // keep the turn running well past the job close

    peerInsideJob(["ask", "--bg", "NESTED-SURVIVAL-TASK"], env);
    // jobsim has returned → the caller's job is closed. The worker must be alive.
    const job = readJob(state, driver);
    assert.ok(job, "background dispatch recorded a job");
    assert.equal(job.status, "running");
    assert.ok(Number(job.workerPid) > 0, "job records a worker pid");
    await sleep(1_000); // let any kill-on-close reaping land
    assert.ok(
      pidAlive(Number(job.workerPid)),
      `worker pid ${job.workerPid} must survive the nested caller's job closing`,
    );

    // and the turn must COMPLETE, not just linger
    const done = await waitFor(
      () => {
        const j = readJob(state, driver);
        return j?.status === "done" ? j : null;
      },
      "the nested-spawned turn to finish",
      30_000,
    );
    assert.equal(done.status, "done");
    assert.match(readLast(state, driver), /NESTED-SURVIVAL-TASK/);
  },
);

test(
  "nested claude lane: the serve daemon survives the spawning caller's kill-on-close job",
  { skip: !IS_WIN, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const state = freshState(t);
    const driver = "nestedClaudeDriver";
    const env = laneEnv(state, driver, "claude");
    env.FAKE_DELAY = "4000";
    env.FAKE_DELAY_MATCH = "NESTED-CLAUDE-TASK";

    peerInsideJob(["ask", "--bg", "NESTED-CLAUDE-TASK"], env);
    // caller's job is closed; the daemon must still be alive and finish the turn
    const servePidFile = join(state, "serve.pid");
    assert.ok(existsSync(servePidFile), "serve daemon recorded its pid");
    const servePid = Number(readFileSync(servePidFile, "utf8").trim());
    await sleep(1_000);
    assert.ok(pidAlive(servePid), `serve daemon pid ${servePid} must survive the nested caller's job closing`);

    const done = await waitFor(
      () => {
        const j = readJob(state, driver);
        return j?.status === "done" ? j : null;
      },
      "the nested claude turn to finish",
      30_000,
    );
    assert.equal(done.status, "done");
    assert.match(readLast(state, driver), /NESTED-CLAUDE-TASK/);
  },
);

// Run `peer.mjs <args>` directly (no job — these cases test lane identity, not
// job survival). Returns combined output; asserts nothing about the exit code.
function peerPlain(args, env) {
  return spawnSync(process.execPath, [PEER, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 75_000,
    cwd: ROOT,
    env,
  });
}

test(
  "the spawned claude partner's environment carries no lane identity (only the nested marker)",
  { skip: !IS_WIN, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const state = freshState(t);
    const driver = "envScrubDriver";
    const env = laneEnv(state, driver, "claude");
    env.TANDEM_LABEL = "parent-lane";
    env.TANDEM_MODEL = "fake-opus";
    env.TANDEM_TIER = "deep";
    env.FAKE_ENV_FILE = join(state, "partner-env.json");

    const r = peerPlain(["ask", "--bg", "ENV-SCRUB-TASK"], env);
    assert.equal(r.status, 0, `ask failed: ${(r.stdout || "") + (r.stderr || "")}`);
    await waitFor(() => readJob(state, driver)?.status === "done", "the env-scrub turn to finish", 30_000);

    const partnerEnv = JSON.parse(
      await waitFor(() => existsSync(env.FAKE_ENV_FILE) && readFileSync(env.FAKE_ENV_FILE, "utf8"), "the partner env dump", 10_000),
    );
    for (const k of LANE_IDENTITY_VARS) {
      assert.equal(partnerEnv[k], undefined, `${k} must NOT leak into the partner's environment`);
    }
    assert.equal(partnerEnv.TANDEM_NESTED_AGENT, "1", "the partner keeps the nested-agent marker");
  },
);

test(
  "self-ask guard: a peer.mjs running inside the lane's own claude partner is refused, not self-injected",
  { skip: !IS_WIN, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const state = freshState(t);
    const driver = "guardDriver";
    const env = laneEnv(state, driver, "claude");

    const first = peerPlain(["ask", "--bg", "GUARD-SETUP-TASK"], env);
    assert.equal(first.status, 0, `setup ask failed: ${(first.stdout || "") + (first.stderr || "")}`);
    await waitFor(() => readJob(state, driver)?.status === "done", "the setup turn to finish", 30_000);
    const partnerPid = Number(
      await waitFor(() => existsSync(join(state, "claude.pid")) && readFileSync(join(state, "claude.pid"), "utf8").trim(), "the daemon's claude pid record", 10_000),
    );
    assert.ok(partnerPid > 0, "serve recorded its claude child pid");

    // the leaked-identity scenario: a tool call OF THIS LANE'S OWN PARTNER
    // (CLAUDE_PID = the partner) asking with the lane's own TANDEM_STATE
    const inner = laneEnv(state, "innerPartnerSession", "claude");
    inner.CLAUDECODE = "1";
    inner.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
    inner.CLAUDE_CODE_SESSION_ID = "innerPartnerSession";
    inner.CLAUDE_PID = String(partnerPid);
    delete inner.CODEX_SESSION_ID;
    const refused = peerPlain(["ask", "--bg", "SELF-ASK-TASK must not reach my own inbox"], inner);
    assert.notEqual(refused.status, 0, "the self-ask must fail loudly");
    assert.match(
      (refused.stdout || "") + (refused.stderr || ""),
      /INSIDE the lane's own Claude partner/,
      "the refusal names the self-ask",
    );
    assert.ok(!existsSync(join(state, "inbox.txt")), "no task was relayed into the lane's own inbox");
  },
);

test(
  "claude→claude: an ask from inside the claude partner opens a NEW sub-lane whose daemon survives the tool-call teardown",
  { skip: !IS_WIN, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const state = freshState(t);
    const subLabel = "nested-subtest-lane";
    const subState = join(ROOT, "tandems", subLabel);
    const cleanSub = () => {
      const pidFile = join(subState, "serve.pid");
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        if (pid && pidAlive(pid)) killTree(pid);
      }
      const subJob = readJob(subState, "subPartner001");
      for (const key of ["workerPid", "partnerPid"]) {
        if (Number(subJob?.[key]) > 0 && pidAlive(Number(subJob[key]))) killTree(Number(subJob[key]));
      }
      rmSync(subState, { recursive: true, force: true });
    };
    cleanSub(); // a previous crashed run must not alias this one
    t.after(cleanSub);

    const driver = "nestedNestedDriver";
    const env = laneEnv(state, driver, "claude");
    env.FAKE_NESTED_ASK = "1";
    env.FAKE_SUB_LABEL = subLabel;
    env.FAKE_SUB_DELAY = "4000";

    // parent turn: the fake claude partner runs `peer.mjs ask --bg` for a claude
    // sub-lane inside a kill-on-close job (its "tool call"), which closes before
    // the fake replies — the sub-lane must outlive it.
    const r = peerPlain(["ask", "--bg", "PARENT-TURN SPAWN-SUB-LANE now"], env);
    assert.equal(r.status, 0, `parent ask failed: ${(r.stdout || "") + (r.stderr || "")}`);
    const parentDone = await waitFor(
      () => {
        const j = readJob(state, driver);
        return j?.status === "done" ? j : null;
      },
      "the parent turn to finish",
      60_000,
    );
    assert.match(parentDone.verdict || "", /NESTED-ASK .*childExit=0/, "the partner's nested ask tool call succeeded");

    // the sub-lane got its OWN state (not the parent's), its daemon survived the
    // nested caller's job closing, and its turn completes end-to-end
    const subPidFile = join(subState, "serve.pid");
    assert.ok(existsSync(subPidFile), "the nested ask created its own sub-lane state with a serve daemon");
    const subPid = Number(readFileSync(subPidFile, "utf8").trim());
    await sleep(1_000); // let any kill-on-close reaping land
    assert.ok(pidAlive(subPid), `sub-lane daemon pid ${subPid} must survive the partner's tool-call teardown`);
    assert.ok(!existsSync(join(state, "inbox.txt")), "nothing was relayed into the parent lane's inbox");

    const subDone = await waitFor(
      () => {
        const j = readJob(subState, "subPartner001");
        return j?.status === "done" ? j : null;
      },
      "the sub-lane turn to finish",
      30_000,
    );
    assert.equal(subDone.status, "done");
    assert.match(readLast(subState, "subPartner001"), /SUB-LANE-TASK/);
  },
);
