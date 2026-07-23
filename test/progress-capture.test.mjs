// progress-capture.test.mjs — T5: after a supervised stop, ONE bounded follow-up turn runs on the
// SAME durable session to capture the stopped turn's progress, and lands ADDITIVELY on the same job
// record (progressCapture) without disturbing the stop record itself (status/error/termination/
// stalled and every pinned phrasing stay exactly as T3/T4/T6 left them).
//   codex: peer.mjs resumes the recorded sid for the capture (codex exec resume) — the fake's
//          verdict embeds sid= and mode=resume, so same-session is PROVEN, not assumed.
//   claude: serve.mjs captures right after a T4 CHECKPOINT, on the still-warm daemon session,
//          BEFORE finishing the dispatch — so the record `wait` returns already carries the report.
// Fully isolated (temp TANDEM_STATE + fakes); helpers copied minimally from tool-stall.test.mjs /
// protocol-grace.test.mjs so this file stands alone. Stall windows are ≥0.5s per the cold-start
// lesson (node spawn→first-stdout is ~105-157ms under load; sub-0.2s windows flake).
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
  const d = mkdtempSync(join(tmpdir(), "tandem-capture-"));
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
// Every supervision/capture env key is scrubbed so an inherited TANDEM_* can never bleed into a case.
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
const readServePid = (state) => {
  const f = join(state, "serve.pid");
  return existsSync(f) ? Number(readFileSync(f, "utf8").trim()) : 0;
};
// Poll `status` until the lane's job reaches a terminal error record (the claude daemon path defers
// the finish until the capture resolves, so the record can take a couple of extra seconds).
async function pollUntilError(state, driver) {
  let status = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(200);
    status = peer(["status"], { state, driver, partner: "claude" });
    if (/job: error/i.test(status.out)) return status;
  }
  return status;
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

// 1) CODEX CAPTURE OK: the primary turn stalls (hang pinned to it); the capture resumes the SAME
//    sid and is answered. The stop record is untouched; progressCapture is additive and PROVES the
//    session (sid= and mode=resume are embedded in the fake's verdict).
test("a stalled codex turn captures progress on the same resumed session", (t) => {
  const state = freshState(t);
  const driver = "capCodexOkDrv";
  const sid = "aaaaaaaa-1111-4222-8333-444444444441";
  const r = peer(["ask", "CAPTURE-PRIMARY-STALL"], {
    state,
    driver,
    env: {
      FAKE_SID: sid,
      FAKE_HANG_AFTER_SESSION: "1",
      FAKE_HANG_MATCH: "CAPTURE-PRIMARY-STALL",
      TANDEM_STALL_SEC: "0.5",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1, "the stopped primary turn still exits 1");
  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.status, "error", "the stop record stays error-shaped");
  assert.equal(job.termination?.kind, "stall", "the stop record keeps the primary turn's termination");
  assert.ok(job.stalled, "the stall flag is untouched by the capture");
  assert.match(job.error || "", /STALLED\/WEDGED/i, "the pinned stall phrasing survives");
  assert.equal(job.progressCapture?.attempted, true, "a capture was attempted");
  assert.equal(job.progressCapture?.ok, true, "the capture succeeded");
  assert.match(job.progressCapture.verdict, new RegExp(`sid=${sid}`), "the capture ran on the SAME session");
  assert.match(job.progressCapture.verdict, /mode=resume/, "the capture RESUMED the durable session (not a fresh one)");
  assert.match(r.out, /progress captured before the stop/, "the driver sees the recovery report");
});

// 2) CAPTURE ITSELF HANGS: an unpinned hang stalls the capture too. Exactly one attempt, recorded
//    ok:false via the inherited stall window — bounded, honest, and never recursive.
test("a capture that itself hangs is recorded ok:false and never retried", (t) => {
  const state = freshState(t);
  const driver = "capCodexHangDrv";
  const t0 = Date.now();
  const r = peer(["ask", "EVERYTHING-HANGS"], {
    state,
    driver,
    env: {
      FAKE_SID: "bbbbbbbb-1111-4222-8333-444444444442",
      FAKE_HANG_AFTER_SESSION: "1", // no FAKE_HANG_MATCH: the capture turn hangs too
      TANDEM_STALL_SEC: "0.5",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1, "the stopped turn exits 1");
  assert.ok(Date.now() - t0 < 20_000, "the capture is bounded — the ask returns well inside the harness timeout");
  const job = readJob(state, driver);
  assert.equal(job?.termination?.kind, "stall", "the PRIMARY stall owns the termination record");
  assert.equal(job?.progressCapture?.attempted, true, "the one capture attempt is recorded");
  assert.equal(job?.progressCapture?.ok, false, "a hung capture is a FAILED capture");
  assert.match(job.progressCapture.error || "", /stopped/i, "the failure states the capture was itself stopped");
  // Non-recursion, structurally visible: the record carries exactly ONE capture object, and the
  // driver output mentions exactly one capture attempt.
  assert.equal((r.out.match(/capturing progress from codex/g) || []).length, 1, "exactly one capture attempt, never a capture-of-a-capture");
});

// 3) DISABLED: TANDEM_CAPTURE_ON_STOP=0 → no capture turn runs; the record says so honestly.
test("captureOnStop disabled skips the capture and records the reason", (t) => {
  const state = freshState(t);
  const driver = "capCodexOffDrv";
  const r = peer(["ask", "STALL-NO-CAPTURE"], {
    state,
    driver,
    env: {
      FAKE_SID: "cccccccc-1111-4222-8333-444444444443",
      FAKE_HANG_AFTER_SESSION: "1",
      TANDEM_CAPTURE_ON_STOP: "0",
      TANDEM_STALL_SEC: "0.5",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1);
  const job = readJob(state, driver);
  assert.equal(job?.progressCapture?.attempted, false, "no capture was attempted");
  assert.match(job?.progressCapture?.reason || "", /disabled/i, "the skip reason is recorded");
  assert.doesNotMatch(r.out, /capturing progress/, "no capture turn was dispatched");
});

// 4) TOOL-TIMEOUT CAPTURE: the T6 tool-timeout stop also captures — and the capture inherits the
//    lane's TIGHTER toolMaxSec, so a capture that reopens the oversized tool is bounded and fails
//    honestly instead of hanging for captureMaxSec.
test("a tool-timeout stop captures too, bounded by the tighter lane windows", (t) => {
  const state = freshState(t);
  const driver = "capToolDrv";
  const r = peer(["ask", "OVERSIZED-TOOL"], {
    state,
    driver,
    env: {
      FAKE_SID: "dddddddd-1111-4222-8333-444444444444",
      FAKE_TOOL_OPEN_MS: "60000", // the fake reopens the tool on the capture turn as well
      TANDEM_STALL_SEC: "0.5",
      TANDEM_TOOL_MAX_SEC: "0.3",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1);
  const job = readJob(state, driver);
  assert.equal(job?.termination?.kind, "tool-timeout", "the primary stop is the T6 tool-timeout");
  assert.ok(!job?.stalled, "a tool-timeout is still NOT a stall");
  assert.equal(job?.progressCapture?.attempted, true, "the capture was attempted after the tool-timeout");
  assert.equal(job?.progressCapture?.ok, false, "the capture (same oversized tool) is bounded and fails honestly");
});

// 5) CLAUDE CHECKPOINT CAPTURE: a checkpointed claude stall captures on the WARM daemon session
//    BEFORE the dispatch finishes — the awaited record already carries the report, the daemon
//    survives, and a follow-up ask resolves the SAME session (no kill, no respawn).
test("a checkpointed claude turn captures on the warm session before the record lands", async (t) => {
  const state = freshState(t);
  const driver = "capClaudeDrv";
  const sid = "eeeeeeee-1111-4222-8333-444444444445";
  const started = peer(["ask", "--bg", "CLAUDE-CAPTURE-STALL"], {
    state,
    driver,
    partner: "claude",
    env: {
      FAKE_SID: sid,
      FAKE_HANG_AFTER_SESSION: "1",
      FAKE_HANG_MATCH: "CLAUDE-CAPTURE-STALL",
      TANDEM_STALL_SEC: "0.5",
      TANDEM_INTERRUPT_GRACE_SEC: "8",
      TANDEM_CAPTURE_MAX_SEC: "8",
    },
  });
  assert.equal(started.code, 0, "the background dispatch is accepted");

  const status = await pollUntilError(state, driver);
  assert.match(status.out, /job: error/i, "the stopped turn resolves error-shaped");

  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.status, "error");
  assert.equal(job.termination?.checkpoint, true, "the T4 checkpoint is intact");
  assert.match(job.error || "", /CHECKPOINTED/, "the pinned checkpoint phrasing survives");
  assert.equal(job.progressCapture?.attempted, true, "the daemon attempted the capture");
  assert.equal(job.progressCapture?.ok, true, "the warm session answered the capture");
  assert.match(job.progressCapture.verdict, new RegExp(`sid=${sid}`), "the capture came from the SAME warm session");

  // `wait` returns the finished record — capture included — and surfaces the report.
  const waited = peer(["wait", "5"], { state, driver, partner: "claude" });
  assert.equal(waited.code, 1, "the stop is still error-shaped for wait");
  assert.match(waited.out, /progress captured before the stop/, "wait surfaces the recovery report");

  // WARMTH: daemon alive, and the next ask resumes the same session — capture consumed no lives.
  const servePid = readServePid(state);
  assert.ok(servePid > 0 && pidAlive(servePid), "the serve daemon survived stop + capture");
  const warm = peer(["ask", "WARM-AFTER-CAPTURE"], { state, driver, partner: "claude" });
  assert.equal(warm.code, 0, "the warm follow-up succeeds");
  assert.match(warm.out, new RegExp(`sid=${sid}`), "the same session answered — never destroyed, never respawned");

  peer(["stop"], { state, driver, partner: "claude" });
});

// 6) CLAUDE CAPTURE DISABLED: the checkpointed record still lands promptly with the honest skip
//    note — proving the deferred-finish path is only taken when capture is actually enabled.
test("a checkpointed claude turn with capture disabled finishes immediately with the skip reason", async (t) => {
  const state = freshState(t);
  const driver = "capClaudeOffDrv";
  const started = peer(["ask", "--bg", "CLAUDE-STALL-NO-CAPTURE"], {
    state,
    driver,
    partner: "claude",
    env: {
      FAKE_SID: "ffffffff-1111-4222-8333-444444444446",
      FAKE_HANG_AFTER_SESSION: "1",
      FAKE_HANG_MATCH: "CLAUDE-STALL-NO-CAPTURE",
      TANDEM_CAPTURE_ON_STOP: "0",
      TANDEM_STALL_SEC: "0.5",
      TANDEM_INTERRUPT_GRACE_SEC: "8",
    },
  });
  assert.equal(started.code, 0);

  const status = await pollUntilError(state, driver);
  assert.match(status.out, /job: error/i);
  const job = readJob(state, driver);
  assert.equal(job?.termination?.checkpoint, true, "the checkpoint itself is unaffected by the capture switch");
  assert.equal(job?.progressCapture?.attempted, false, "no capture was attempted");
  assert.match(job?.progressCapture?.reason || "", /disabled/i, "the skip reason is recorded");

  peer(["stop"], { state, driver, partner: "claude" });
});
