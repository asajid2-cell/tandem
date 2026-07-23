// run-loop.test.mjs — W4: the completion SIGNAL file (push, not poll) and the bounded run loop.
//
//   Signal:  every terminal job record drops a `job-<sk>.done` next to `job-<sk>.json` carrying
//            { dispatchId, status, ts }, so a watcher is WOKEN the instant a dispatch finishes
//            instead of sleep-polling. The job JSON stays the sole source of truth; the signal only
//            changes latency. A fresh dispatch clears any leftover signal at acquire time, so a
//            waiter can never be woken early by a prior turn's file.
//   Run loop: `peer.mjs run "<task>" --max-turns N [--until "<marker>"]` runs up to N ordinary bounded
//            turns on the SAME coupled session through the exact `ask` flow. exit 0 = marker found /
//            all N clean · 1 = a turn errored · 4 = marker unseen in N · 2 = usage error.
//
// Fully isolated (temp TANDEM_STATE + fakes); helpers copied minimally from progress-capture.test.mjs
// so this file stands alone. Stall windows are ≥0.5s per the cold-start lesson (node spawn→first-
// stdout is ~105-157ms under load; sub-0.2s windows flake). The `--until "mode=resume"` marker rides
// the fake's own verdict shape (turn 1 fresh embeds mode=fresh, turn 2 resume embeds mode=resume), so
// the loop's turn-2 stop and its coupling are proven without any new fixture env.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// Collect the pids any lane process recorded under a state root (serve daemon + job worker/partner +
// the fakes' own pid records), so teardown can reap a leak instead of stranding a daemon/worker.
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
  const d = mkdtempSync(join(tmpdir(), "tandem-runloop-"));
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
// Every supervision env key is scrubbed so an inherited TANDEM_* can never bleed into a case's windows.
function buildEnv(state, driver, partner, env) {
  const e = { ...process.env };
  for (const k of [
    "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
    "TANDEM_NESTED_AGENT", "TANDEM_TIER", "TANDEM_MODEL", "TANDEM_EFFORT", "TANDEM_NO_LIMIT_CLASSIFY",
    "TANDEM_STALL_SEC", "TANDEM_TOOL_MAX_SEC", "TANDEM_MAX_TURN_SEC", "TANDEM_STOP_GRACE_SEC",
    "TANDEM_INTERRUPT_GRACE_SEC", "TANDEM_CAPTURE_ON_STOP", "TANDEM_CAPTURE_MAX_SEC",
  ]) delete e[k];
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
const doneFile = (state, driver) => join(state, `job-${jobKey(driver)}.done`);
const readDone = (state, driver) => {
  const f = doneFile(state, driver);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};
// The verdict strings the lane logged, in order — one per completed turn. Used to prove the run loop
// resumed the SAME session across turns (both verdicts embed the same sid=).
function verdictLog(state) {
  const f = join(state, "tandem.log.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((o) => o && o.type === "verdict")
    .map((o) => String(o.verdict || ""));
}
const sidOf = (verdict) => (verdict.match(/sid=([0-9a-f-]{36})/i) || [])[1] || "";
async function pollUntilDone(state, driver, partner = "codex") {
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(150);
    const j = readJob(state, driver);
    if (j && j.status !== "running") return j;
    // status also drives the WEDGED read path — not expected here, but bounded regardless
    peer(["status"], { state, driver, partner });
  }
  return readJob(state, driver);
}

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

// 1a) SIGNAL AFTER A CODEX ASK: a finished codex dispatch drops job-<sk>.done with the SAME
//     dispatchId + status the job record carries.
test("a codex ask drops a done signal matching the finished dispatch", (t) => {
  const state = freshState(t);
  const driver = "sigCodexDrv";
  const r = peer(["ask", "hello codex"], {
    state,
    driver,
    env: { FAKE_SID: "10000000-1111-4222-8333-444444444401" },
  });
  assert.equal(r.code, 0, "the ask succeeds");
  const job = readJob(state, driver);
  const done = readDone(state, driver);
  assert.ok(job, "a job record exists");
  assert.ok(done, "a done signal file exists");
  assert.equal(done.status, "done", "the signal carries the finished status");
  assert.equal(done.dispatchId, job.dispatchId, "the signal names the SAME dispatch as the job record");
  assert.ok(Number(done.ts) > 0, "the signal is timestamped");
});

// 1b) SIGNAL AFTER A CLAUDE DAEMON ASK: the daemon's finish goes through finishDispatch (lease path),
//     so the same done signal lands for a claude turn.
test("a claude daemon ask drops a done signal matching the finished dispatch", (t) => {
  const state = freshState(t);
  const driver = "sigClaudeDrv";
  const r = peer(["ask", "hello claude"], {
    state,
    driver,
    partner: "claude",
    env: { FAKE_SID: "20000000-1111-4222-8333-444444444402" },
  });
  assert.equal(r.code, 0, "the claude ask succeeds");
  const job = readJob(state, driver);
  const done = readDone(state, driver);
  assert.ok(job, "a job record exists");
  assert.ok(done, "a done signal file exists after the claude turn");
  assert.equal(done.status, "done", "the signal carries the finished status");
  assert.equal(done.dispatchId, job.dispatchId, "the signal names the SAME dispatch as the claude job record");
  peer(["stop"], { state, driver, partner: "claude" });
});

// 2) NO EARLY WAKE: a fresh dispatch clears the PRIOR dispatch's done file at acquire time (before it
//    can finish), and only re-signals with the NEW dispatchId once the new turn finishes.
test("a fresh dispatch clears the previous done file before finishing (no early wake)", async (t) => {
  const state = freshState(t);
  const driver = "sigClearDrv";
  // Turn 1: finishes and signals dispatch A.
  const r1 = peer(["ask", "first turn"], {
    state,
    driver,
    env: { FAKE_SID: "30000000-1111-4222-8333-444444444403" },
  });
  assert.equal(r1.code, 0);
  const jobA = readJob(state, driver);
  const doneA = readDone(state, driver);
  assert.equal(doneA?.dispatchId, jobA.dispatchId, "turn 1's signal names dispatch A");

  // Turn 2 in the background WITH a delay, so it is still running after startJob returns. The acquire
  // clears the stale done file synchronously in the parent BEFORE the worker finishes → the file is
  // absent right now (a waiter here cannot be woken by dispatch A's stale signal).
  const started = peer(["ask", "--bg", "second turn"], {
    state,
    driver,
    env: { FAKE_SID: "30000000-1111-4222-8333-444444444403", FAKE_DELAY: "2500" },
  });
  assert.equal(started.code, 0, "the background turn is accepted");
  assert.equal(existsSync(doneFile(state, driver)), false, "the stale done file was cleared at acquire — no early wake");

  // Once turn 2 finishes, the signal reappears naming dispatch B (a different dispatchId).
  const jobB = await pollUntilDone(state, driver);
  assert.equal(jobB.status, "done", "turn 2 finished");
  assert.notEqual(jobB.dispatchId, jobA.dispatchId, "turn 2 is a distinct dispatch");
  const doneB = readDone(state, driver);
  assert.equal(doneB?.dispatchId, jobB.dispatchId, "the re-signalled file names dispatch B, not the cleared A");
});

// 3) WAIT RETURNS ON A BACKGROUND ASK: `wait` blocks on the push signal and returns the finished
//    verdict with the right exit code. Latency is not asserted (fs.watch varies by filesystem); only
//    that the wait resolves correctly.
test("wait returns the verdict of a background ask", (t) => {
  const state = freshState(t);
  const driver = "waitDrv";
  const started = peer(["ask", "--bg", "background task"], {
    state,
    driver,
    env: { FAKE_SID: "40000000-1111-4222-8333-444444444404" },
  });
  assert.equal(started.code, 0, "the background dispatch is accepted");
  const waited = peer(["wait", "20"], { state, driver });
  assert.equal(waited.code, 0, "wait resolves to the done turn and exits 0");
  assert.match(waited.out, /FAKE ok/, "wait prints the finished verdict");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done", "the lane is a normal completion");
});

// 4) RUN LOOP STOPS ON THE MARKER AT TURN 2, coupling held: turn 1 fresh (mode=fresh, no match), turn
//    2 resume (mode=resume, matches) → exit 0 at turn 2, and BOTH turns were answered by the SAME sid.
test("run stops on the marker at turn 2 and both turns share the coupled session", (t) => {
  const state = freshState(t);
  const driver = "runMarkerDrv";
  const sid = "50000000-1111-4222-8333-444444444405";
  const r = peer(["run", "do the work", "--max-turns", "3", "--until", "mode=resume"], {
    state,
    driver,
    env: { FAKE_SID: sid },
  });
  assert.equal(r.code, 0, "the marker was found → exit 0");
  assert.match(r.out, /marker found in turn 2\/3/, "the loop reports the turn the marker landed on");
  const verdicts = verdictLog(state);
  assert.equal(verdicts.length, 2, "exactly two turns ran (the loop stopped at turn 2)");
  assert.match(verdicts[0], /mode=fresh/, "turn 1 was a FRESH session (no marker)");
  assert.match(verdicts[1], /mode=resume/, "turn 2 RESUMED the coupled session and matched the marker");
  assert.equal(sidOf(verdicts[0]), sid, "turn 1 ran on the coupled sid");
  assert.equal(sidOf(verdicts[1]), sid, "turn 2 ran on the SAME sid — coupling held across the loop");
});

// 5) EXHAUSTED: a marker that never appears runs all N turns, then exits 4 with a factual line.
test("run exhausts N turns without the marker and exits 4", (t) => {
  const state = freshState(t);
  const driver = "runExhaustDrv";
  const r = peer(["run", "do the work", "--max-turns", "2", "--until", "MARKER_NEVER_APPEARS_XYZ"], {
    state,
    driver,
    env: { FAKE_SID: "60000000-1111-4222-8333-444444444406" },
  });
  assert.equal(r.code, 4, "the marker was never seen in N turns → exit 4");
  assert.match(r.out, /never seen in 2 turn/i, "the exhaustion line is factual");
  assert.equal(verdictLog(state).length, 2, "all N turns ran before exhaustion");
});

// 6) A TURN ERROR MID-LOOP STOPS THE LOOP: turn 1 stalls (hang pinned to it) → the loop stops at turn
//    1 with exit 1 and the ORDINARY stop record (the same shape a lone `ask` stall leaves behind).
test("a stall on turn 1 stops the loop with exit 1 and the ordinary stop record", (t) => {
  const state = freshState(t);
  const driver = "runStallDrv";
  const r = peer(["run", "STALLME now", "--max-turns", "3", "--until", "mode=resume"], {
    state,
    driver,
    env: {
      FAKE_SID: "70000000-1111-4222-8333-444444444407",
      FAKE_HANG_AFTER_SESSION: "1",
      FAKE_HANG_MATCH: "STALLME", // pins the hang to turn 1's task; the T5 capture prompt is answered
      TANDEM_STALL_SEC: "0.5",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });
  assert.equal(r.code, 1, "a turn error stops the loop → exit 1");
  assert.match(r.out, /run stopped at turn 1\/3/, "the loop names the turn it stopped on");
  const job = readJob(state, driver);
  assert.equal(job?.status, "error", "the last record is the ordinary error-shaped stop");
  assert.equal(job?.termination?.kind, "stall", "the stop record keeps the stall termination");
  assert.ok(job?.stalled, "the stall flag is set, exactly as a lone ask stall");
  assert.match(job.error || "", /STALLED\/WEDGED/i, "the pinned stall phrasing survives");
});

// 7) BAD USAGE: --max-turns must be an integer 1..50 and is required. 0 / 51 / missing → exit 2.
test("bad --max-turns usage exits 2 (0, 51, and missing)", (t) => {
  const state = freshState(t);
  const driver = "runUsageDrv";
  const zero = peer(["run", "task", "--max-turns", "0", "--until", "x"], { state, driver });
  assert.equal(zero.code, 2, "--max-turns 0 is a usage error");
  assert.match(zero.out, /1\.\.50/, "the bound is stated");
  const over = peer(["run", "task", "--max-turns", "51", "--until", "x"], { state, driver });
  assert.equal(over.code, 2, "--max-turns 51 is a usage error");
  const missing = peer(["run", "task", "--until", "x"], { state, driver });
  assert.equal(missing.code, 2, "--max-turns is required");
  assert.match(missing.out, /requires --max-turns/, "the missing-flag message is clear");
  // No partner was ever spawned for a usage error → no job record.
  assert.equal(readJob(state, driver), null, "a usage error never dispatches a turn");
});
