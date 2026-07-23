// usage-headroom.test.mjs — W3 (3): cash in the predictive-warning groundwork. serve.mjs already
// persists every claude rate_limit_event; its classification ladder treats a warn-shaped status
// (e.g. allowed_warning) as "never a park — persisted for the predictive item only". This suite
// proves that a warn-shaped event now ALSO attaches an ADDITIVE, driver-facing proximity warning to
// the turn's record (composed into the existing `warning` field) — never a park, never error-shaped,
// the verdict fully intact — while a plain "allowed" event produces NO warning at all.
//
// codex side: intentionally NOT mirrored. Codex's only structural usage signal is a raw used_percent
// read OUT-OF-BAND from rollout files (probe-codex.mjs) — there is no warn-shaped status EVENT on the
// live exec stream, so a proximity warning would require inventing a threshold, which the brief forbids.
//
// Fully isolated (temp TANDEM_STATE + fake claude). Helpers copied minimally from limit-truth.test.mjs.
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
  const d = mkdtempSync(join(tmpdir(), "tandem-headroom-"));
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

// Codex driver + claude partner (the daemon path serve.mjs owns). Scrub inherited supervision/limit env.
function buildEnv(state, driver, env) {
  const e = { ...process.env };
  for (const k of [
    "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
    "TANDEM_NESTED_AGENT", "TANDEM_TIER", "TANDEM_MODEL", "TANDEM_EFFORT", "TANDEM_NO_LIMIT_CLASSIFY",
    "TANDEM_STALL_SEC", "TANDEM_MAX_TURN_SEC", "TANDEM_MAX_TURN_HOURS", "TANDEM_STOP_GRACE_SEC",
  ]) delete e[k];
  e.TANDEM_STATE = state;
  e.TANDEM_PARTNER = "claude";
  e.CODEX_SESSION_ID = driver;
  e.TANDEM_CLAUDE_BIN = FAKE_CLAUDE;
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
const readRateLimit = (state) => {
  const f = join(state, "rate-limit.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

// Isolation guard: never touch a live provider-state.json.
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

// 1) PROXIMITY WARNING — a warn-shaped rate_limit_event (allowed_warning) completes the turn "done"
//    with the verdict intact, and attaches an ADDITIVE headroom warning built from the event's own
//    fields (status + rateLimitType + resets epoch). Never a park, never error-shaped.
test("a warn-shaped rate_limit_event attaches an additive proximity warning, verdict intact", (t) => {
  const state = freshState(t);
  const driver = "headroomDrv";
  const resetsAt = Math.floor(Date.now() / 1000) + 3600; // a plausible 10-digit epoch → surfaced as ISO
  const r = peer(["ask", "clean turn near the limit"], {
    state,
    driver,
    env: {
      FAKE_RATE_LIMIT_STATUS: "allowed_warning",
      FAKE_RATE_LIMIT_TYPE: "five_hour",
      FAKE_RATE_LIMIT_RESETS_AT: String(resetsAt),
    },
  });

  assert.equal(r.code, 0, "a proximity warning is not a failure");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done", "the turn completes normally");
  assert.equal(job?.errorKind, undefined, "no park, no error");
  assert.match(job?.verdict || "", /FAKE-CLAUDE ok/, "the verdict is fully intact");
  assert.ok(job?.warning, "an additive warning was attached");
  assert.match(job.warning, /usage headroom warning \(five_hour\)/, "the warning names the rate-limit type from the event");
  assert.match(job.warning, /approaching the limit/, "the warning is factual proximity language");
  assert.match(job.warning, new RegExp(new Date(resetsAt * 1000).toISOString().slice(0, 10)), "the reset epoch is surfaced as an ISO date");
  const rl = readRateLimit(state);
  assert.equal(rl?.info?.status, "allowed_warning", "the event was still persisted for the predictive item");
});

// 2) CONTRAST — a plain "allowed" event is pure noise: no park, and crucially NO warning. The
//    proximity notice fires ONLY on a warn-shaped status.
test("a plain allowed rate_limit_event produces NO proximity warning", (t) => {
  const state = freshState(t);
  const driver = "allowedNoWarnDrv";
  const r = peer(["ask", "clean healthy turn"], {
    state,
    driver,
    env: { FAKE_RATE_LIMIT_STATUS: "allowed", FAKE_RATE_LIMIT_TYPE: "five_hour" },
  });

  assert.equal(r.code, 0, "a healthy turn succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.ok(!job?.warning, "no proximity warning on a plain allowed turn");
  assert.match(job?.verdict || "", /FAKE-CLAUDE ok/, "the verdict is intact");
});
