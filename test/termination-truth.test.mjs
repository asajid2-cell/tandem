// termination-truth.test.mjs — truthful termination records + bound-config visibility (T3). A stop
// verdict must state ONLY what the supervisor can know: no "graceful stop accepted" theater on a
// win32 WM_CLOSE that a hidden console child never receives, and no "the ask was oversized or the
// partner spun" fiction on a maxTurnSec cap the supervisor cannot diagnose. And a running serve
// daemon enforces the supervision windows + model it BOUND at startup, not whatever the config says
// now — status must surface that (and DRIFT) so "we fixed the config" can't masquerade as "the fleet
// is fixed". Fully isolated (temp TANDEM_STATE + fake partners); the peer()/freshState() helpers are
// copied minimally here so this file stands alone, matching provider-limit.test.mjs / provenance.test.mjs.
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
  const d = mkdtempSync(join(tmpdir(), "tandem-term-"));
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
  for (const k of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TANDEM_NESTED_AGENT", "TANDEM_TIER", "TANDEM_MODEL", "TANDEM_EFFORT", "TANDEM_NO_LIMIT_CLASSIFY", "TANDEM_STALL_SEC", "TANDEM_MAX_TURN_SEC", "TANDEM_STOP_GRACE_SEC"]) delete e[k];
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
const readBound = (state) => {
  const f = join(state, "serve.bound.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};
const readServePid = (state) => {
  const f = join(state, "serve.pid");
  return existsSync(f) ? Number(readFileSync(f, "utf8").trim()) : 0;
};

// Isolation guard: every peer spawn in this suite runs under a temp TANDEM_STATE, so the repo's LIVE
// lane state (.state/ + tandems/<label>/provider-state.json) must be byte-identical when the suite
// ends — a test that parks a provider in a real lane's state is itself a critical bug (copied from
// provider-limit.test.mjs).
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

const OVERSIZED_FICTION = /oversized or the partner spun|oversized|spun/;

// 1) STALL RECORD TRUTH: a stalled codex kill records the stop CHANNEL truthfully (a non-empty
//    channel, a boolean callAccepted, deliveryProven that is NEVER true on win32) and never revives
//    the deleted "oversized / partner spun" fiction. The pinned STALLED/WEDGED shape survives.
test("stall record: truthful stop-channel fields, no 'oversized/spun' fiction", (t) => {
  const state = freshState(t);
  const driver = "stallTruthDrv";
  const r = peer(["ask", "STALL-THIS-TURN"], {
    state,
    driver,
    env: {
      FAKE_SID: "11111111-2222-4333-8444-555555555555",
      FAKE_HANG_AFTER_SESSION: "1",
      TANDEM_STALL_SEC: "0.15",
      TANDEM_MAX_TURN_SEC: "0",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1, "a supervised stall exits 1");
  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.status, "error");
  assert.ok(job.termination, "the job carries a termination record");
  assert.equal(job.termination.kind, "stall");
  assert.ok(job.termination.stopChannel && typeof job.termination.stopChannel === "string", "stopChannel is a non-empty string");
  assert.equal(typeof job.termination.stopCallAccepted, "boolean", "stopCallAccepted is a boolean");
  if (process.platform === "win32") {
    assert.equal(job.termination.stopDeliveryProven, false, "win32: delivery to a hidden console child is NEVER provable");
  } else {
    assert.equal(job.termination.stopDeliveryProven, job.termination.stopCallAccepted, "posix: a successful kill(2) DID deliver the signal");
  }

  // the pinned STALLED/WEDGED shape survives; the deleted editorial diagnosis does not
  assert.match(r.out, /STALLED\/WEDGED/i);
  assert.match(r.out, /no partner activity/i);
  assert.doesNotMatch(r.out, OVERSIZED_FICTION, "the 'oversized/spun' fiction is gone from the output");
  assert.doesNotMatch(job.verdict || "", OVERSIZED_FICTION, "the recorded verdict does not editorialize a cause");
  assert.doesNotMatch(job.error || "", OVERSIZED_FICTION, "the recorded error does not editorialize a cause");
});

// 2) CAP VERDICT FACTUAL: a maxTurnSec (absolute) kill states ONLY that the cap elapsed — never why.
test("maxTurnSec cap verdict is factual — 'the cap elapsed, not why', no fiction", (t) => {
  const state = freshState(t);
  const driver = "capTruthDrv";
  const r = peer(["ask", "CAP-THIS-TURN"], {
    state,
    driver,
    env: {
      FAKE_SID: "22222222-3333-4444-8555-666666666666",
      FAKE_HANG_AFTER_SESSION: "1",
      TANDEM_STALL_SEC: "0",
      TANDEM_MAX_TURN_SEC: "0.2",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(r.code, 1, "a supervised cap kill exits 1");
  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.termination?.kind, "absolute", "the cap kill is an absolute termination");
  assert.match(job.verdict || "", /turn KILLED after .*maxTurnSec cap/, "the verdict keeps the KILLED shape and names the cap");
  assert.doesNotMatch(job.verdict || "", OVERSIZED_FICTION, "the verdict does not diagnose a cause the supervisor cannot know");
  assert.doesNotMatch(r.out, OVERSIZED_FICTION, "the printed output does not diagnose a cause");
});

// 3) BOUND FILE: a claude daemon records the values it BOUND at startup, stamped with its own pid.
test("serve.bound.json records the daemon's bound config with its live pid", (t) => {
  const state = freshState(t);
  const driver = "boundFileDrv";
  const r = peer(["ask", "bind the daemon"], {
    state,
    driver,
    partner: "claude",
    env: { TANDEM_MAX_TURN_SEC: "7.5" },
  });
  assert.equal(r.code, 0, "the turn succeeds and the daemon stays up");
  const bound = readBound(state);
  assert.ok(bound, "serve.bound.json was written at daemon startup");
  assert.equal(bound.maxTurnSec, 7.5, "the daemon bound the env's maxTurnSec");
  const servePid = readServePid(state);
  assert.ok(servePid > 0 && pidAlive(servePid), "the serve daemon is live");
  assert.equal(bound.pid, servePid, "the bound file is stamped with the live daemon pid");
});

// 4) DRIFT VISIBLE: once the daemon has bound maxTurnSec 7.5, a status whose current config disagrees
//    prints a loud DRIFT line naming maxTurnSec; a status whose config agrees prints none.
test("status surfaces daemon DRIFT when the config diverges from the bound values", (t) => {
  const state = freshState(t);
  const driver = "driftDrv";
  const started = peer(["ask", "bind the daemon"], {
    state,
    driver,
    partner: "claude",
    env: { TANDEM_MAX_TURN_SEC: "7.5" },
  });
  assert.equal(started.code, 0);
  assert.ok(pidAlive(readServePid(state)), "the daemon is live for the status checks");

  const drifted = peer(["status"], { state, driver, partner: "claude", env: { TANDEM_MAX_TURN_SEC: "0" } });
  assert.match(drifted.out, /daemon: pid/, "the daemon bound line is printed");
  assert.match(drifted.out, /daemon DRIFT/, "a drift is surfaced loudly");
  assert.match(drifted.out, /maxTurnSec/, "the drifted field is named");

  const aligned = peer(["status"], { state, driver, partner: "claude", env: { TANDEM_MAX_TURN_SEC: "7.5" } });
  assert.match(aligned.out, /daemon: pid/, "the daemon line still prints when aligned");
  assert.doesNotMatch(aligned.out, /daemon DRIFT/, "no drift when the current config matches the bound values");
});

// 5) STALE BOUND IGNORED: a serve.bound.json whose pid isn't a live daemon must not paint a daemon
//    or drift line onto a lane with no running daemon.
test("a stale serve.bound.json (no live daemon) is ignored by status", (t) => {
  const state = freshState(t);
  const driver = "staleBoundDrv";
  writeFileSync(
    join(state, "serve.bound.json"),
    JSON.stringify({ pid: 999999, startedTs: Date.now(), stallSec: 1, maxTurnSec: 9, stopGraceSec: 5, model: "ghost", effort: "high", bin: "x", cwd: "y" }),
  );
  const r = peer(["status"], { state, driver, partner: "claude" });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /daemon: pid/, "no daemon line for a crashed daemon's stale file");
  assert.doesNotMatch(r.out, /daemon DRIFT/, "a stale file never paints drift onto a fresh lane");
});
