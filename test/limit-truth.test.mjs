// limit-truth.test.mjs — T2: limit truth from STRUCTURAL signals (claude partner). The claude CLI
// emits a machine-readable rate_limit_event every turn; that in-band evidence is now PRIMARY, and
// banner text drops to last-resort corroboration. These cases prove the ladder: a refusal status
// parks with the EXACT structural reset epoch (not banner parsing); a refusal alongside a real
// verdict from a turn that DID WORK keeps the verdict AND parks the future; a banner after real
// tool work no longer parks; an "allowed"/"allowed_warning" event is noise but is still persisted
// for the later predictive item; and a bare banner still parks as the last-resort signal.
//
// Fully isolated (temp TANDEM_STATE + fake partners). The peer()/freshState() helpers are copied
// minimally from provider-limit.test.mjs so this file stands alone (that suite's cases must not be
// renumbered), including the live provider-state isolation guard.
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
// Collect the pids any lane process recorded under a state root, so teardown can reap a leak.
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
  const d = mkdtempSync(join(tmpdir(), "tandem-truth-"));
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
const readState = (state) => {
  const f = join(state, "provider-state.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};
const readRateLimit = (state) => {
  const f = join(state, "rate-limit.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

// Isolation guard: every peer spawn runs under a temp TANDEM_STATE, so the repo's LIVE lane state
// must be byte-identical when the suite ends — a test that parks a provider in a real lane is a bug.
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

// 1. STRUCTURAL PARK — a refusal status with NO real verdict parks on the EXACT structural epoch,
//    proving the rate_limit_event (not banner parsing) is what set resetAt.
test("STRUCTURAL PARK: a refusal rate_limit_event parks on its EXACT reset epoch, not the banner", (t) => {
  const state = freshState(t);
  const driver = "structParkDrv";
  const resetsAt = Math.floor(Date.now() / 1000) + 7200; // now + 2h, in epoch SECONDS
  const r = peer(["ask", "please answer"], {
    state,
    driver,
    partner: "claude",
    env: { FAKE_RATE_LIMIT_STATUS: "rejected", FAKE_RATE_LIMIT_RESETS_AT: String(resetsAt), FAKE_LIMIT: "1" },
  });
  assert.equal(r.code, 1, "a provider-limit turn exits 1");
  const job = readJob(state, driver);
  assert.equal(job?.status, "error", "status stays within the frozen enum");
  assert.equal(job?.errorKind, "provider-limit");
  assert.equal(job?.limitSignal, "rate_limit_event", "the structural signal is stamped");
  assert.equal(job?.resetAt, resetsAt * 1000, "the STRUCTURAL epoch won — resetAt is exactly resetsAt*1000");
  const ps = readState(state);
  assert.ok(ps?.claude && ps.claude.until > Date.now(), "claude is parked in provider-state.json");
});

// 2. WORK SURVIVES — a refusal signal alongside a real verdict from a turn that DID work keeps the
//    verdict AND parks the provider for future asks.
test("WORK SURVIVES: a refusal + real tool work keeps the verdict but parks future asks", (t) => {
  const state = freshState(t);
  const driver = "workSurvivesDrv";
  const r = peer(["ask", "do the work"], {
    state,
    driver,
    partner: "claude",
    env: { FAKE_RATE_LIMIT_STATUS: "rejected", FAKE_TOOL_USE: "1" },
  });
  assert.equal(r.code, 0, "the turn that produced a real verdict succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done", "the verdict is NOT destroyed");
  assert.match(job?.verdict || "", /FAKE-CLAUDE ok/, "the recorded verdict is the real answer");
  assert.equal(job?.limitSignal, "rate_limit_event");
  assert.match(job?.warning || "", /provider limit signaled/, "the record warns the provider is parked");
  const ps = readState(state);
  assert.ok(ps?.claude && ps.claude.until > Date.now(), "claude is parked so future asks fast-fail");
});

// 3. DID-WORK GATE — a whole-result banner AFTER real tool work is an ordinary verdict, not a park
//    (a genuinely capped turn cannot run tools).
test("DID-WORK GATE: a banner after real tool work does NOT park", (t) => {
  const state = freshState(t);
  const driver = "didWorkGateDrv";
  const r = peer(["ask", "run"], { state, driver, partner: "claude", env: { FAKE_LIMIT: "1", FAKE_TOOL_USE: "1" } });
  assert.equal(r.code, 0, "the turn succeeds — no park");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job?.errorKind, undefined, "must NOT be classified as a provider-limit");
  assert.match(job?.verdict || "", /You've hit your session limit/, "the banner survives as an ordinary verdict");
  assert.equal(readState(state), null, "nothing was parked");
});

// 4. ALLOWED IS NOISE — an "allowed" event never parks, but is persisted for the predictive item.
test("ALLOWED IS NOISE: an allowed rate_limit_event never parks but IS persisted", (t) => {
  const state = freshState(t);
  const driver = "allowedDrv";
  const r = peer(["ask", "clean turn"], { state, driver, partner: "claude", env: { FAKE_RATE_LIMIT_STATUS: "allowed" } });
  assert.equal(r.code, 0, "a healthy turn succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job?.errorKind, undefined, "no park");
  assert.ok(!job?.warning, "no limit warning on a healthy turn");
  assert.equal(readState(state), null, "nothing was parked");
  const rl = readRateLimit(state);
  assert.equal(rl?.info?.status, "allowed", "the event was persisted for later predictive use");
});

// 4b. WARNING IS NOT A PARK — a proximity ("allowed_warning") status is captured but never parks.
test("WARNING IS NOT A PARK: allowed_warning is captured but never parks", (t) => {
  const state = freshState(t);
  const driver = "warnDrv";
  const r = peer(["ask", "clean turn"], { state, driver, partner: "claude", env: { FAKE_RATE_LIMIT_STATUS: "allowed_warning" } });
  assert.equal(r.code, 0, "a proximity warning is not a failure");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job?.errorKind, undefined, "no park, no error");
  assert.match(job?.verdict || "", /FAKE-CLAUDE ok/, "the verdict is intact");
  assert.equal(readState(state), null, "nothing was parked");
  const rl = readRateLimit(state);
  assert.equal(rl?.info?.status, "allowed_warning", "the warning status was captured");
});

// 5. BANNER LAST-RESORT REGRESSION — a bare banner (no structural event, no tool work) still parks,
//    now via the last-resort signal.
test("BANNER LAST-RESORT: a bare banner parks exactly as before, tagged limitSignal=banner", (t) => {
  const state = freshState(t);
  const driver = "bannerDrv";
  const r = peer(["ask", "run"], { state, driver, partner: "claude", env: { FAKE_LIMIT: "1" } });
  assert.equal(r.code, 1, "a bare banner parks");
  const job = readJob(state, driver);
  assert.equal(job?.status, "error");
  assert.equal(job?.errorKind, "provider-limit");
  assert.equal(job?.limitSignal, "banner", "the last-resort banner signal is stamped");
  const ps = readState(state);
  assert.ok(ps?.claude && ps.claude.until > Date.now(), "claude is parked");
});
