// tool-stall.test.mjs — the codex stall clock is SUSPENDED while a single tool call is open (T6).
// `codex exec --json` emits NOTHING during a long command_execution (a build, a test suite, an
// install): item.started, then total silence, then item.completed. The raw stall guard reads stream
// activity, so any tool call longer than stallSec is indistinguishable from a wedge and gets killed
// mid-legitimate-work. peer.mjs now tracks OPEN tool items and, while one is open, suspends the stall
// check — only toolMaxSec (this single tool) and the absolute maxTurnSec cap may still fire; the
// moment the tool closes, the ordinary stall clock resumes. Fully isolated (temp TANDEM_STATE + fake
// codex), like provider-limit.test.mjs / termination-truth.test.mjs — the peer()/freshState() helpers
// are copied minimally here so this file stands alone. Windows are chosen so no case can flake (a
// 60s / forever hang measured against a sub-second supervisor), mirroring the bridge-cases stall tests.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
// Collect the pids any lane process recorded under a state root (job worker/partner + the fake's own
// pid record), so teardown can reap a leak instead of stranding a killed-but-lingering child.
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
  const d = mkdtempSync(join(tmpdir(), "tandem-tool-"));
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

// Default partner is codex: a Claude driver + fake codex. Every supervision env key is scrubbed so an
// inherited TANDEM_* from the parent test run can never bleed into a case's chosen windows.
function buildEnv(state, driver, env) {
  const e = { ...process.env };
  for (const k of [
    "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
    "TANDEM_NESTED_AGENT", "TANDEM_TIER", "TANDEM_MODEL", "TANDEM_EFFORT", "TANDEM_NO_LIMIT_CLASSIFY",
    "TANDEM_STALL_SEC", "TANDEM_TOOL_MAX_SEC", "TANDEM_MAX_TURN_SEC", "TANDEM_STOP_GRACE_SEC",
  ]) delete e[k];
  e.TANDEM_STATE = state;
  e.TANDEM_PARTNER = "codex";
  e.CLAUDE_CODE_SESSION_ID = driver;
  e.TANDEM_CODEX_BIN = FAKE_CODEX;
  return { ...e, ...env, TANDEM_TEST_PROCESS_DIR: join(state, ".test-processes") };
}
function peer(args, { state, driver, env = {} } = {}) {
  const r = spawnSync(process.execPath, [PEER, ...args], {
    encoding: "utf8",
    env: buildEnv(state, driver, env),
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

// Isolation guard: never touch a live provider-state.json (copied from provider-limit.test.mjs).
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

// Window-sizing note: the stall clock starts at spawn, so the fake partner's node COLD START (spawn
// → first stdout) counts as idle before any tool opens. Measured at ~110-160ms under a loaded box, it
// races a sub-150ms stallSec and false-stalls in the pre-tool window (an artifact of a 0.15s window, not
// of the suspension logic — real stallSec is 240s). So the two cases whose pass/fail hinges on the
// PRE-tool stall window (1: must NOT stall; 2: must stall as a tool-timeout, not a raw stall) use a
// stallSec (0.5s) comfortably clear of cold start, while the open-tool silence still dwarfs it. Cases 3
// (expects a stall either way) and 4 (stall disabled) are unaffected by cold-start jitter and keep their
// tight windows.

// 1) SUSPENDED: a tool ~4x longer than the stall window survives — the stall clock is suspended
//    while the command_execution item is open, so a legitimate long build is never killed.
test("a tool call far longer than the stall window survives (stall clock suspended)", (t) => {
  const state = freshState(t);
  const driver = "toolSuspendDrv";
  const r = peer(["ask", "run a long build"], {
    state,
    driver,
    env: {
      FAKE_SID: "11111111-2222-4333-8444-555555555551",
      FAKE_TOOL_OPEN_MS: "2000", // ~4x the 0.5s stall window: a clearly-legitimate long silent tool
      TANDEM_STALL_SEC: "0.5", // > worst-case node cold start so the pre-tool window never false-stalls
      TANDEM_MAX_TURN_SEC: "0",
    },
  });

  assert.equal(r.code, 0, "the turn survives its open tool and exits 0");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done", "the job is a normal completion");
  assert.doesNotMatch(r.out, /STALLED|KILLED|stopped/, "no supervised-stop language — the tool was legitimate work");
  assert.match(r.out, /FAKE ok/, "the normal verdict is returned");
});

// 2) TOOL BOUND: an open tool past toolMaxSec is stopped as a tool-timeout — factual, not stalled.
test("an open tool past toolMaxSec is stopped as a tool-timeout (not a stall)", (t) => {
  const state = freshState(t);
  const driver = "toolBoundDrv";
  const r = peer(["ask", "run an oversized tool"], {
    state,
    driver,
    env: {
      FAKE_SID: "22222222-2222-4333-8444-555555555552",
      FAKE_TOOL_OPEN_MS: "60000",
      TANDEM_STALL_SEC: "0.5", // > node cold start: the stop must be the toolMaxSec bound, never a pre-tool stall
      TANDEM_TOOL_MAX_SEC: "0.3",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1, "an over-bound tool exits 1");
  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.status, "error");
  assert.equal(job.termination?.kind, "tool-timeout", "the stop is a tool-timeout, not a stall or absolute cap");
  assert.match(r.out, /toolMaxSec/, "the output names the toolMaxSec bound");
  assert.ok(!job.stalled, "a tool-timeout is NOT a stall");
});

// 3) CLOCK RESUMES: the suspension ends with the tool. Once item.completed closes it, a subsequent
//    silent hang trips the ordinary stall guard — proving the clock was suspended, not disabled.
test("the stall clock resumes once the tool closes (a later hang still stalls)", (t) => {
  const state = freshState(t);
  const driver = "toolResumeDrv";
  const r = peer(["ask", "run a tool then hang"], {
    state,
    driver,
    env: {
      FAKE_SID: "33333333-2222-4333-8444-555555555553",
      FAKE_TOOL_OPEN_MS: "200",
      FAKE_HANG_AFTER_TOOL: "1",
      TANDEM_STALL_SEC: "0.2",
      TANDEM_MAX_TURN_SEC: "0",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1, "the post-tool hang is caught and exits 1");
  const job = readJob(state, driver);
  assert.equal(job?.termination?.kind, "stall", "the resumed clock catches the hang as a stall");
  assert.ok(job?.stalled, "a resumed-clock stall is a stall");
  assert.match(r.out, /STALLED\/WEDGED/i, "the pinned stall shape is reported");
});

// 4) ABSOLUTE CAP STILL FIRES DURING A TOOL: suspension defers the STALL check only — the absolute
//    maxTurnSec backstop is never suspended, even with tools unbounded (toolMaxSec=0).
test("the absolute maxTurnSec cap still fires while a tool is open (tools unbounded)", (t) => {
  const state = freshState(t);
  const driver = "toolAbsDrv";
  const r = peer(["ask", "run a tool under an absolute cap"], {
    state,
    driver,
    env: {
      FAKE_SID: "44444444-2222-4333-8444-555555555554",
      FAKE_TOOL_OPEN_MS: "60000",
      TANDEM_STALL_SEC: "0",
      TANDEM_MAX_TURN_SEC: "0.3",
      TANDEM_TOOL_MAX_SEC: "0",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1, "the absolute cap stops the turn and exits 1");
  const job = readJob(state, driver);
  assert.equal(job?.termination?.kind, "absolute", "the absolute cap fires even mid-open-tool");
});
