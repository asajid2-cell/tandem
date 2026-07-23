// progress-idle.test.mjs — W3: a progress-based idle detector (codex side) plus the maxTurnHours
// alias. The raw stall clock measures stream BYTES, so a busy-but-STUCK partner — one that spins on
// the SAME failing command, re-prints retry banners, or loops without touching a file — streams
// bytes forever and never stalls. progressIdleSec adds a heuristic built ONLY from signals already
// on the --json stream (distinct-new-command / file-change recency / output repetition): a turn is
// stopped kind "no-progress" ONLY when ALL of — no novel command AND no file change for
// progressIdleSec AND the recent window is mostly repetition. It is CONJUNCTIVE and OFF by default,
// because a false positive would kill a slow-but-legitimately-working turn.
//
// Fully isolated (temp TANDEM_STATE + fake codex), like tool-stall.test.mjs — the peer()/freshState()
// helpers are copied minimally here so this file stands alone. Windows are chosen so no case flakes:
// a repeating stream emits every 100ms (comfortably keeping the raw stall clock alive) while the
// progress window (0.5s) trips only when repetition persists WITHOUT a novel command.
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
  const d = mkdtempSync(join(tmpdir(), "tandem-prog-"));
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
    "TANDEM_STALL_SEC", "TANDEM_TOOL_MAX_SEC", "TANDEM_PROGRESS_IDLE_SEC", "TANDEM_MAX_TURN_SEC", "TANDEM_MAX_TURN_HOURS", "TANDEM_STOP_GRACE_SEC",
    "TANDEM_CAPTURE_ON_STOP", "TANDEM_CAPTURE_MAX_SEC",
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

// 1) NO-PROGRESS STOP: a stream that re-emits the SAME command_execution item — bytes flowing (so the
//    raw stall clock cannot fire) but NO novel command, NO file change, and a repeating window — is
//    stopped with kind "no-progress". Factual phrasing, stalled false, exit 1, capture attempted.
test("a repeating no-progress stream is stopped with kind no-progress (not a stall)", (t) => {
  const state = freshState(t);
  const driver = "noProgDrv";
  const r = peer(["ask", "spin on the same command"], {
    state,
    driver,
    env: {
      FAKE_SID: "aaaaaaaa-2222-4333-8444-555555555551",
      FAKE_REPEAT_STREAM_MS: "100", // a byte every 100ms → the raw stall clock (0.5s) never fires
      FAKE_REPEAT_COUNT: "60", // ~6s of repetition — far longer than the 0.5s progress window
      TANDEM_STALL_SEC: "0.5", // > worst-case node cold start AND > the 100ms inter-byte gap: stall CANNOT fire here
      TANDEM_PROGRESS_IDLE_SEC: "0.5",
      TANDEM_MAX_TURN_SEC: "0",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1, "a no-progress stop exits 1");
  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.status, "error");
  assert.equal(job.termination?.kind, "no-progress", "the stop is a no-progress stop, not a stall or cap");
  assert.ok(!job.stalled, "no-progress is NOT a stall — stalled stays false");
  // Factual phrasing: what was MEASURED (no new command/file for Ns; ~P% repetition), never a guess at why.
  assert.match(job.error || "", /no new distinct command or file change for [\d.]+s and the output stream was ~\d+% repetition/, "the error states only what the supervisor measured");
  assert.doesNotMatch(job.error || "", /STALLED|WEDGED/, "no-progress must not borrow the stall phrasing");
  // T5 capture fires on any killed-with-termination stop; the same repeating stream stops it too, so
  // it is HONESTLY recorded as attempted-but-failed — never dressed up as progress.
  assert.ok(job.progressCapture?.attempted, "a progress capture was attempted after the no-progress stop");
});

// 2) CONTRAST — a stream with the SAME repetition cadence but a DISTINCT (novel) command each cycle
//    is NOT stopped: the novel-command signal keeps the progress clock fresh, so the conjunction never
//    completes even though the normalized output repeats. Proves repetition ALONE never kills.
test("a stream of novel commands at the same cadence is NOT stopped (progress clock stays fresh)", (t) => {
  const state = freshState(t);
  const driver = "novelDrv";
  const r = peer(["ask", "make real progress"], {
    state,
    driver,
    env: {
      FAKE_SID: "bbbbbbbb-2222-4333-8444-555555555552",
      FAKE_STREAM_INTERVAL_MS: "100", // same cadence as case 1
      FAKE_STREAM_COUNT: "25", // ~2.5s of DISTINCT commands (fake-stream-activity-1,2,3,…)
      TANDEM_STALL_SEC: "0.5",
      TANDEM_PROGRESS_IDLE_SEC: "0.5",
      TANDEM_MAX_TURN_SEC: "0",
    },
  });

  assert.equal(r.code, 0, "a genuinely-progressing turn survives and exits 0");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done", "the job is a normal completion");
  assert.equal(job?.termination, null, "nothing was stopped");
  assert.match(r.out, /FAKE ok/, "the normal verdict is returned");
});

// 3) OFF BY DEFAULT — the exact repeating stream from case 1 runs to completion when progressIdleSec
//    is unset. The detector is opt-in; without it the raw stall clock stays the only idle guard.
test("the detector is OFF by default — the same repeating stream completes when progressIdleSec is unset", (t) => {
  const state = freshState(t);
  const driver = "offDrv";
  const r = peer(["ask", "spin, but detector off"], {
    state,
    driver,
    env: {
      FAKE_SID: "cccccccc-2222-4333-8444-555555555553",
      FAKE_REPEAT_STREAM_MS: "100",
      FAKE_REPEAT_COUNT: "20", // ~2s of repetition, then a clean finish
      TANDEM_STALL_SEC: "0.5", // bytes every 100ms keep it alive; stall never fires
      // TANDEM_PROGRESS_IDLE_SEC intentionally UNSET → default 0 = OFF
      TANDEM_MAX_TURN_SEC: "0",
    },
  });

  assert.equal(r.code, 0, "with the detector off the repeating stream runs to completion");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done", "no stop — a normal completion");
  assert.equal(job?.termination, null, "no termination when the detector is off");
  assert.match(r.out, /FAKE ok/, "the normal verdict is returned");
});

// 4) OPEN TOOL SUSPENDS THE PROGRESS CLOCK — a silent open tool LONGER than progressIdleSec must
//    survive: while a command_execution item is open the progress clock is suspended (a legitimate
//    silent tool is not "no progress"), exactly like the T6 stall-clock suspension.
test("an open tool suspends the progress clock (a silent tool longer than progressIdleSec survives)", (t) => {
  const state = freshState(t);
  const driver = "toolSuspendDrv";
  const r = peer(["ask", "run a silent build under the progress detector"], {
    state,
    driver,
    env: {
      FAKE_SID: "dddddddd-2222-4333-8444-555555555554",
      FAKE_TOOL_OPEN_MS: "1500", // ~5x the 0.3s progress window: a clearly-legitimate silent tool
      TANDEM_STALL_SEC: "0", // isolate the progress detector: the stall clock is disabled
      TANDEM_PROGRESS_IDLE_SEC: "0.3",
      TANDEM_MAX_TURN_SEC: "0",
    },
  });

  assert.equal(r.code, 0, "the silent open tool survives — the progress clock was suspended");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done", "a normal completion, no no-progress stop");
  assert.equal(job?.termination, null, "nothing was stopped while the tool was open");
  assert.match(r.out, /FAKE ok/, "the normal verdict is returned");
});

// 5a) maxTurnHours MAPS to the absolute cap — a tiny fractional hours value (~0.3s) stops a hung turn
//     at the absolute backstop with the existing pinned "maxTurnSec backstop" phrasing.
test("maxTurnHours maps to the absolute maxTurnSec cap (pinned phrasing preserved)", (t) => {
  const state = freshState(t);
  const driver = "hoursMapDrv";
  const r = peer(["ask", "hang under an hours cap"], {
    state,
    driver,
    env: {
      FAKE_SID: "eeeeeeee-2222-4333-8444-555555555555",
      FAKE_HANG_AFTER_SESSION: "1",
      TANDEM_STALL_SEC: "0", // only the absolute cap may fire
      TANDEM_MAX_TURN_HOURS: String(0.3 / 3600), // ≈ 0.3s once mapped to maxTurnSec
      TANDEM_STOP_GRACE_SEC: "0.1",
      TANDEM_CAPTURE_ON_STOP: "0", // this case tests the config mapping, not capture
    },
  });

  assert.equal(r.code, 1, "the hours-derived cap stops the turn and exits 1");
  const job = readJob(state, driver);
  assert.equal(job?.termination?.kind, "absolute", "maxTurnHours produced an absolute-cap stop");
  assert.match(job?.error || "", /maxTurnSec backstop/, "the pinned absolute-cap phrasing is preserved");
});

// 5b) EXPLICIT maxTurnSec WINS — with BOTH set, an explicit (tiny) maxTurnSec beats a large
//     maxTurnHours, proving hours only fills an UNSET seconds value and never double-bounds. If hours
//     had won (3600s) the hung turn would run to the 25s test timeout instead of stopping fast.
test("an explicit maxTurnSec wins over maxTurnHours (no double-bounding)", (t) => {
  const state = freshState(t);
  const driver = "explicitWinsDrv";
  const r = peer(["ask", "hang with both bounds set"], {
    state,
    driver,
    env: {
      FAKE_SID: "ffffffff-2222-4333-8444-555555555556",
      FAKE_HANG_AFTER_SESSION: "1",
      TANDEM_STALL_SEC: "0",
      TANDEM_MAX_TURN_HOURS: "1", // 3600s — would never stop within the test timeout
      TANDEM_MAX_TURN_SEC: "0.3", // the explicit second value must win
      TANDEM_STOP_GRACE_SEC: "0.1",
      TANDEM_CAPTURE_ON_STOP: "0",
    },
  });

  assert.equal(r.code, 1, "the explicit 0.3s cap fired (hours did not win)");
  const job = readJob(state, driver);
  assert.equal(job?.termination?.kind, "absolute", "an absolute-cap stop, from the explicit seconds value");
  assert.ok(job?.termination?.elapsedSec < 5, "stopped in well under a second — proof the tiny seconds bound won, not the 1h alias");
});
