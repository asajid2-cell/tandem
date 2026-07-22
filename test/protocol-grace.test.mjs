// protocol-grace.test.mjs — T4 protocol grace for the claude partner (stream-json interrupt). When
// supervision stops a claude turn, serve.mjs writes an `interrupt` control_request over the SAME live
// stdin pipe it feeds user turns to. The CLI ends the turn (error_during_execution) WITHOUT dying, so
// the persistent daemon+session stay warm — a CHECKPOINT, not a kill — and the next ask resumes the
// same session with no respawn. Hard-kill remains the FINAL backstop for a partner that ignores the
// interrupt. Fully isolated (temp TANDEM_STATE + fake claude); the peer()/freshState() helpers are
// copied minimally from provider-limit.test.mjs so this file stands alone.
//
// Timing note: a HANGING claude turn is dispatched via `ask --bg` + a poll for the terminal job
// state, mirroring bridge-cases' "Claude daemon stall recovery" test. A foreground `ask` on a hang
// with a sub-second stall window trips the driver-side WEDGED liveness check during the (multi-second,
// cold) daemon spawn — before the turn even starts — which is a spawn-latency artifact, not the
// behavior under test. The `peer wait` call proves the error-shaped exit contract without that race.
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
  const d = mkdtempSync(join(tmpdir(), "tandem-grace-"));
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
  for (const k of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TANDEM_NESTED_AGENT", "TANDEM_TIER", "TANDEM_MODEL", "TANDEM_EFFORT", "TANDEM_NO_LIMIT_CLASSIFY", "TANDEM_STALL_SEC", "TANDEM_MAX_TURN_SEC", "TANDEM_STOP_GRACE_SEC", "TANDEM_INTERRUPT_GRACE_SEC"]) delete e[k];
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
function peer(args, { state, driver, partner = "claude", env = {} } = {}) {
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
// Poll `status` until the lane's job reaches a terminal error record (mirrors bridge-cases' Claude
// stall test — the cold daemon spawn + hang can flash WEDGED/running before the record finishes).
async function pollUntilError(state, driver) {
  let status = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(200);
    status = peer(["status"], { state, driver, partner: "claude" });
    if (/job: error/i.test(status.out)) return status;
  }
  return status;
}

// 1) CHECKPOINT, NOT KILL: a stalled claude turn is stopped via the stream-json interrupt. The turn
//    ends error-shaped (STALLED/WEDGED preserved) but the daemon+session survive — proven warm by a
//    follow-up ask on the SAME lane that resolves the SAME session id, with no respawn.
test("a stalled claude turn CHECKPOINTS via stream-json interrupt — daemon+session stay warm", async (t) => {
  const state = freshState(t);
  const driver = "graceCheckpointDrv";
  const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  // FAKE_HANG_MATCH pins the hang to the STALL task only, so the warm follow-up (a different task) is
  // answered by the SAME persistent fake — the daemon survived, so its startup env is what's in force.
  const started = peer(["ask", "--bg", "CHECKPOINT-STALL-NOW"], {
    state,
    driver,
    partner: "claude",
    env: {
      FAKE_SID: sid,
      FAKE_HANG_AFTER_SESSION: "1",
      FAKE_HANG_MATCH: "CHECKPOINT-STALL-NOW",
      TANDEM_STALL_SEC: "0.2",
      TANDEM_INTERRUPT_GRACE_SEC: "8",
    },
  });
  assert.equal(started.code, 0, "the background dispatch is accepted");

  const status = await pollUntilError(state, driver);
  assert.match(status.out, /job: error/i, "the stalled turn resolves error-shaped");
  assert.match(status.out, /CHECKPOINTED/, "the checkpoint phrasing surfaces");
  assert.match(status.out, /STALLED\/WEDGED/i, "the pinned stall shape survives");

  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.status, "error", "status stays within the frozen enum");
  assert.ok(job.termination, "the job carries a termination record");
  assert.equal(job.termination.checkpoint, true, "the turn was CHECKPOINTED, not killed");
  assert.equal(job.termination.stopChannel, "stream-json-interrupt", "the stop went through the protocol channel");
  assert.equal(job.termination.stopDeliveryProven, true, "the CLI's control_response PROVED it received the stop");
  assert.ok(!job.termination.hardKilled, "no hard tree-kill was needed");

  // The error-shaped exit contract: a finished error record surfaces as a nonzero `wait` exit.
  const waited = peer(["wait", "5"], { state, driver, partner: "claude" });
  assert.equal(waited.code, 1, "wait surfaces the checkpointed error record as exit 1");
  assert.match(waited.out, /CHECKPOINTED/, "the checkpoint clause reaches the driver");

  // WARMTH: the daemon is still a LIVE process (never destroyed) and answers a second ask on the SAME
  // lane, resolving the SAME session id — proof the interrupt neither killed nor respawned anything.
  const servePid = readServePid(state);
  assert.ok(servePid > 0 && pidAlive(servePid), "the serve daemon is still alive after the checkpoint");

  const warm = peer(["ask", "WARM-AGAIN-PLEASE"], { state, driver, partner: "claude" });
  assert.equal(warm.code, 0, "the warm follow-up succeeds against the same session");
  assert.match(warm.out, new RegExp(`sid=${sid}`), "the same session answered — never destroyed, never respawned");

  // Clean teardown: close the persistent session explicitly.
  peer(["stop"], { state, driver, partner: "claude" });
});

// 2) HARD-KILL FALLBACK: a partner that IGNORES the interrupt (FAKE_IGNORE_INTERRUPT) never produces
//    a terminal result, so the hard-kill backstop must still end the turn. checkpoint stays false and
//    delivery is unproven — the truthful record of a stop the CLI never acknowledged.
test("a claude turn that ignores the interrupt is hard-killed by the backstop (no checkpoint)", async (t) => {
  const state = freshState(t);
  const driver = "graceFallbackDrv";
  const sid = "11111111-2222-4333-8444-555555555555";
  const started = peer(["ask", "--bg", "IGNORE-INTERRUPT-STALL"], {
    state,
    driver,
    partner: "claude",
    env: {
      FAKE_SID: sid,
      FAKE_HANG_AFTER_SESSION: "1",
      FAKE_IGNORE_INTERRUPT: "1",
      TANDEM_STALL_SEC: "0.2",
      TANDEM_INTERRUPT_GRACE_SEC: "0.3",
    },
  });
  assert.equal(started.code, 0, "the background dispatch is accepted");

  const status = await pollUntilError(state, driver);
  assert.match(status.out, /job: error/i, "the ignored-interrupt turn still resolves error-shaped");
  assert.match(status.out, /STALLED\/WEDGED/i, "the pinned stall shape survives the fallback");

  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.status, "error");
  assert.ok(job.termination, "the job carries a termination record");
  assert.ok(!job.termination.checkpoint, "an ignored interrupt is NOT a checkpoint");
  if (process.platform === "win32") {
    assert.equal(job.termination.hardKilled, true, "the hard-kill backstop still ended the turn (win32)");
  } else {
    assert.ok(job.termination.hardKilled, "the hard-kill backstop still ended the turn");
  }
  assert.equal(job.termination.stopDeliveryProven, false, "no control_response arrived → delivery is unproven");
});
