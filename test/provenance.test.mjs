// provenance.test.mjs — model/effort provenance in every job record (T1). tandem must record what
// the partner CLI ACTUALLY ran (proven from the claude stream / the codex rollout turn_context),
// not just what config claimed, and warn loudly on a PROVEN mismatch — without ever flipping a
// turn's outcome. Fully isolated (temp TANDEM_STATE + fake partners + a temp codex-sessions root);
// the peer()/freshState() helpers are copied minimally here so this file stands alone, matching
// provider-limit.test.mjs (whose cases must not be renumbered).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobKey } from "../bin/groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PEER = join(ROOT, "bin", "peer.mjs");
const FAKE_CODEX = join(HERE, "fake-codex.mjs");
const FAKE_CLAUDE = join(HERE, "fake-claude.mjs");
const TEST_PROCESS_TIMEOUT_MS = 25_000;

const ACTIVE_ROOTS = new Set();

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
// Collect the pids any lane process recorded under a state root (serve daemon + job worker/partner
// + the fakes' own pid records), so teardown can reap a leak instead of stranding a daemon.
function recordedPids(root) {
  const pids = new Set();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (e.name === "serve.pid") {
        try {
          pids.add(Number(readFileSync(p, "utf8").trim()));
        } catch {
          /* gone */
        }
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      try {
        const v = JSON.parse(readFileSync(p, "utf8"));
        for (const k of ["pid", "ppid", "workerPid", "partnerPid"]) if (Number(v?.[k]) > 0) pids.add(Number(v[k]));
      } catch {
        /* not a pid record */
      }
    }
  }
  pids.delete(process.pid);
  pids.delete(0);
  return [...pids];
}
function stopState(root) {
  for (let i = 0; i < 3; i++) {
    for (const pid of recordedPids(root)) if (pidAlive(pid)) killTree(pid);
  }
  return recordedPids(root).filter(pidAlive);
}

function freshState(t) {
  const d = mkdtempSync(join(tmpdir(), "tandem-prov-"));
  ACTIVE_ROOTS.add(d);
  t.after(() => {
    const leaked = stopState(d);
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    ACTIVE_ROOTS.delete(d);
    assert.deepEqual(leaked, [], `test cleanup left live processes for ${d}: ${leaked.join(", ")}`);
  });
  return d;
}
after(() => {
  for (const root of [...ACTIVE_ROOTS]) stopState(root);
});

// partner="codex" → Claude driver + fake codex; partner="claude" → Codex driver + fake claude daemon.
function buildEnv(state, driver, partner, env) {
  const e = { ...process.env };
  for (const k of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TANDEM_NESTED_AGENT", "TANDEM_TIER", "TANDEM_MODEL", "TANDEM_EFFORT", "TANDEM_NO_LIMIT_CLASSIFY"]) delete e[k];
  e.TANDEM_STATE = state;
  e.TANDEM_PARTNER = partner;
  if (partner === "claude") {
    e.CODEX_SESSION_ID = driver;
    e.TANDEM_CLAUDE_BIN = FAKE_CLAUDE;
  } else {
    e.CLAUDE_CODE_SESSION_ID = driver;
    e.TANDEM_CODEX_BIN = FAKE_CODEX;
  }
  return { ...e, ...env, TANDEM_TEST_PROCESS_DIR: join(state, ".test-processes") };
}
function peer(args, { state, driver, partner = "codex", env = {} } = {}) {
  const r = spawnSync(process.execPath, [PEER, ...args], {
    encoding: "utf8",
    env: buildEnv(state, driver, partner, env),
    windowsHide: true,
    timeout: TEST_PROCESS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.error) {
    if (r.pid) killTree(r.pid);
    stopState(state);
    assert.fail(`peer ${args.join(" ")} did not complete: ${r.error.message}`);
  }
  return { stdout: r.stdout || "", out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}
const readJob = (state, driver) => {
  const f = join(state, `job-${jobKey(driver)}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};
const hasMismatch = (job, re) => !!(job?.warning && re.test(job.warning));

// Isolation guard: every peer spawn in this suite runs under a temp TANDEM_STATE, so the repo's
// LIVE lane state must be byte-identical when the suite ends — a test that parks a provider in a
// real lane's state is itself a critical bug (copied wholesale from provider-limit.test.mjs).
const liveStateFiles = () => {
  const found = {};
  const laneDirs = existsSync(join(ROOT, "tandems"))
    ? readdirSync(join(ROOT, "tandems")).map((d) => join(ROOT, "tandems", d))
    : [];
  for (const d of [join(ROOT, ".state"), ...laneDirs]) {
    const f = join(d, "provider-state.json");
    if (existsSync(f)) found[f] = readFileSync(f, "utf8");
  }
  return found;
};
const LIVE_STATE_BEFORE = liveStateFiles();
after(() => {
  assert.deepEqual(liveStateFiles(), LIVE_STATE_BEFORE, "the suite must never touch a live provider-state.json");
});

// 1) codex fresh turn, rollout written: requested and actual both proven and matching → no warning.
test("codex fresh turn: model+effort provenance recorded from the rollout, no mismatch warning", (t) => {
  const state = freshState(t);
  const sessions = join(state, "codex-sessions");
  const driver = "provCodexMatchDrv";
  const r = peer(["ask", "prove the model"], {
    state,
    driver,
    env: { TANDEM_MODEL: "gpt-5.6-sol", TANDEM_EFFORT: "high", FAKE_WRITE_ROLLOUT: "1", FAKE_ACTUAL_MODEL: "gpt-5.6-sol", FAKE_ACTUAL_EFFORT: "high", TANDEM_CODEX_SESSIONS: sessions },
  });
  assert.equal(r.code, 0, "a clean turn succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job.modelRequested, "gpt-5.6-sol");
  assert.equal(job.effortRequested, "high");
  assert.equal(job.modelActual, "gpt-5.6-sol", "modelActual proven from the rollout turn_context");
  assert.equal(job.effortActual, "high", "effortActual proven from the rollout turn_context");
  assert.ok(!hasMismatch(job, /mismatch/), "matching model+effort produce no mismatch warning");
});

// 2) codex mismatch: requested vs proven model disagree → loud model-mismatch warning.
test("codex mismatch: a proven model different from the request warns loudly", (t) => {
  const state = freshState(t);
  const sessions = join(state, "codex-sessions");
  const driver = "provCodexMismatchDrv";
  const r = peer(["ask", "route me"], {
    state,
    driver,
    env: { TANDEM_MODEL: "gpt-5.6-sol", FAKE_WRITE_ROLLOUT: "1", FAKE_ACTUAL_MODEL: "gpt-5.6-luna", TANDEM_CODEX_SESSIONS: sessions },
  });
  assert.equal(r.code, 0, "provenance never flips the outcome — the turn still succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job.modelRequested, "gpt-5.6-sol");
  assert.equal(job.modelActual, "gpt-5.6-luna", "both the requested and actual model are recorded");
  assert.match(job.warning, /model mismatch/, "a proven model divergence is flagged");
});

// 3) codex with NO rollout: modelActual stays "" and absence of evidence is not a mismatch.
test("codex without a rollout: modelActual is empty and absence is never a mismatch", (t) => {
  const state = freshState(t);
  const sessions = join(state, "codex-sessions");
  const driver = "provCodexNoRolloutDrv";
  const r = peer(["ask", "no rollout here"], {
    state,
    driver,
    env: { TANDEM_MODEL: "gpt-5.6-sol", TANDEM_CODEX_SESSIONS: sessions },
  });
  assert.equal(r.code, 0);
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job.modelRequested, "gpt-5.6-sol");
  assert.equal(job.modelActual, "", "no rollout → modelActual is unproven, never guessed");
  assert.ok(!hasMismatch(job, /mismatch/), "an unproven actual never produces a mismatch warning");
});

// 4) claude daemon turn: an alias request contained in the proven model id is NOT a mismatch.
test("claude daemon: modelActual proven from the stream, alias request contained → no warning", (t) => {
  const state = freshState(t);
  const driver = "provClaudeAliasDrv";
  const r = peer(["ask", "answer please"], {
    state,
    driver,
    partner: "claude",
    env: { TANDEM_MODEL: "opus", FAKE_MODEL: "claude-opus-4-8" },
  });
  assert.equal(r.code, 0);
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job.modelRequested, "opus");
  assert.equal(job.modelActual, "claude-opus-4-8", "the stream's assistant model is captured");
  assert.ok(!hasMismatch(job, /mismatch/), "alias containment (actual contains 'opus') is not a mismatch");
});

// 5) claude mismatch: an unrelated request warns, but the outcome stays "done".
test("claude mismatch: a request the proven model does not contain warns; status stays done", (t) => {
  const state = freshState(t);
  const driver = "provClaudeMismatchDrv";
  const r = peer(["ask", "answer please"], {
    state,
    driver,
    partner: "claude",
    env: { TANDEM_MODEL: "fable", FAKE_MODEL: "claude-opus-4-8" },
  });
  const job = readJob(state, driver);
  assert.equal(job?.status, "done", "provenance never changes an outcome — a mismatch is still a done turn");
  assert.equal(job.modelRequested, "fable");
  assert.equal(job.modelActual, "claude-opus-4-8");
  assert.match(job.warning, /model mismatch/);
});

// 6) effort provenance (codex): a proven effort different from the request warns; model still recorded.
test("codex effort mismatch: proven effort differs from the request → effort-mismatch warning", (t) => {
  const state = freshState(t);
  const sessions = join(state, "codex-sessions");
  const driver = "provCodexEffortDrv";
  const r = peer(["ask", "effort check"], {
    state,
    driver,
    env: { TANDEM_EFFORT: "medium", FAKE_WRITE_ROLLOUT: "1", FAKE_ACTUAL_EFFORT: "high", TANDEM_CODEX_SESSIONS: sessions },
  });
  assert.equal(r.code, 0);
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job.effortRequested, "medium");
  assert.equal(job.effortActual, "high");
  assert.equal(job.modelActual, "gpt-5.6-sol", "the model is still recorded alongside an effort mismatch");
  assert.match(job.warning, /effort mismatch/);
});
