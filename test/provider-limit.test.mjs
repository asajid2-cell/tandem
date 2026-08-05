// provider-limit.test.mjs — tandem's provider-limit awareness (Step 2 of the provider-policy
// unification). A capped partner subscription must be CLASSIFIED and parked, never returned as a
// task verdict; a parked provider must fast-fail future asks before any spawn; and none of it may
// happen when the escape hatch is set. Fully isolated (temp TANDEM_STATE + fake partners), like
// bridge-cases.mjs — the peer()/freshState() helpers are copied minimally here so this file stands
// alone (bridge-cases.mjs's cases are index-range partitioned and must not be renumbered).
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
  const d = mkdtempSync(join(tmpdir(), "tandem-limit-"));
  writeFileSync(
    join(d, "tandem.config.json"),
    JSON.stringify({
      cwd: ROOT,
      codexModel: "gpt-x",
      codexEffort: "medium",
      claudeModel: "gpt-x",
      claudeEffort: "medium",
    }),
  );
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
    cwd: state,
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
const readLast = (state, driver) => {
  const f = join(state, `last-${jobKey(driver)}.txt`);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const CODEX_BANNER = "You've hit your usage limit";
const CLAUDE_BANNER = "You've hit your session limit";

// Isolation guard: every peer spawn in this suite runs under a temp TANDEM_STATE, so the repo's
// LIVE lane state (.state/ + tandems/<label>/provider-state.json) must be byte-identical when the
// suite ends — a test that parks a provider in a real lane's state is itself a critical bug.
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

test("codex banner with exit 0: classified as provider-limit, banner NEVER surfaced as a verdict", (t) => {
  const state = freshState(t);
  const driver = "limitCodexDrv";
  const r = peer(["ask", "classify this please"], { state, driver, env: { FAKE_LIMIT: "1" } });

  assert.equal(r.code, 1, "a provider-limit turn exits 1");
  const job = readJob(state, driver);
  assert.ok(job, "a job record was written");
  assert.equal(job.status, "error", "status stays within the frozen enum");
  assert.equal(job.errorKind, "provider-limit");
  assert.equal(job.provider, "codex");
  assert.ok(job.resetAt > Date.now(), `resetAt (${job.resetAt}) is in the future`);
  assert.match(job.providerMessage, /You've hit your usage limit/);
  assert.match(job.verdict, /provider limit hit — codex parked/, "the recorded verdict is the loud line");
  assert.doesNotMatch(job.verdict, /purchase more credits/, "the recorded verdict is NOT the raw banner");

  // printed output carries the loud line, not the bare banner-as-verdict
  assert.match(r.out, /provider limit hit — codex parked/);
  assert.match(r.out, /NOT a task verdict/);
  assert.doesNotMatch(r.stdout, new RegExp(CODEX_BANNER), "the raw banner is never printed as the verdict");

  // provider-state.json was written under the LANE state dir
  const ps = JSON.parse(readFileSync(join(state, "provider-state.json"), "utf8"));
  assert.ok(ps.codex && ps.codex.until > Date.now(), "codex is parked in provider-state.json");
});

test("codex nonzero-exit limit (banner on stderr, exit 1) classifies the same", (t) => {
  const state = freshState(t);
  const driver = "limitCodexExitDrv";
  const r = peer(["ask", "run"], { state, driver, env: { FAKE_LIMIT: "1", FAKE_LIMIT_EXIT: "1" } });
  assert.equal(r.code, 1);
  const job = readJob(state, driver);
  assert.equal(job?.status, "error");
  assert.equal(job?.errorKind, "provider-limit");
  assert.ok(job.resetAt > Date.now());
  assert.match(r.out, /provider limit hit — codex parked/);
});

test("claude daemon banner (exit-0 result): LASTMSG is the loud line, job is provider-limit", (t) => {
  const state = freshState(t);
  const driver = "limitClaudeDrv";
  const r = peer(["ask", "please answer"], { state, driver, partner: "claude", env: { FAKE_LIMIT: "1" } });
  assert.equal(r.code, 1, "the wait path exits 1 on a provider-limit");
  const job = readJob(state, driver);
  assert.equal(job?.status, "error");
  assert.equal(job?.errorKind, "provider-limit");
  assert.equal(job?.provider, "claude");
  assert.ok(job.resetAt > Date.now());
  const last = readLast(state, driver);
  assert.match(last, /provider limit hit — claude parked/, "LASTMSG is the loud line");
  assert.doesNotMatch(last, new RegExp(CLAUDE_BANNER), "LASTMSG is NOT the bare banner");
  const ps = JSON.parse(readFileSync(join(state, "provider-state.json"), "utf8"));
  assert.ok(ps.claude && ps.claude.until > Date.now());
});

test("claude 429 JSON variant classifies as provider-limit", (t) => {
  const state = freshState(t);
  const driver = "limit429Drv";
  const r = peer(["ask", "please answer"], { state, driver, partner: "claude", env: { FAKE_LIMIT_429: "1" } });
  assert.equal(r.code, 1);
  const job = readJob(state, driver);
  assert.equal(job?.status, "error");
  assert.equal(job?.errorKind, "provider-limit");
  assert.match(readLast(state, driver), /provider limit hit — claude parked/);
});

test("pre-flight fast-fail: a parked provider is never spawned, and the reset + alternate are surfaced", (t) => {
  const state = freshState(t);
  const driver = "preflightDrv";
  const now = Date.now();
  const until = now + 3600_000;
  // seed a park so pre-flight must short-circuit BEFORE any partner spawn
  writeFileSync(join(state, "provider-state.json"), JSON.stringify({ codex: { until, kind: "limit", reason: "seeded", since: now } }));
  const r = peer(["ask", "should not spawn"], { state, driver, env: { TANDEM_MODEL: "gpt-x", TANDEM_EFFORT: "medium" } });
  assert.equal(r.code, 1);
  // the fake codex records its pid the instant it starts — its absence proves ZERO spawns
  const procDir = join(state, ".test-processes");
  const ran = existsSync(procDir) ? readdirSync(procDir) : [];
  assert.deepEqual(ran, [], "no partner process was spawned during a pre-flight fast-fail");
  assert.match(r.out, /parked/i);
  assert.match(r.out, new RegExp(new Date(until).toISOString()), "the reset time is surfaced");
  assert.match(r.out, /alternate/i, "an alternate (or its absence) is surfaced");
  const job = readJob(state, driver);
  assert.equal(job?.errorKind, "provider-limit");
});

test("--failover: a parked codex fails over to a FRESH claude lane and returns claude's verdict", (t) => {
  const state = freshState(t);
  const driver = "failoverDrv";
  const now = Date.now();
  writeFileSync(join(state, "provider-state.json"), JSON.stringify({ codex: { until: now + 3600_000, kind: "limit", reason: "seeded", since: now } }));
  // codex is the initial partner (parked); the alternate claude needs its fake bin + a model to resolve
  const r = peer(["ask", "--failover", "do the work on the alternate"], {
    state,
    driver,
    partner: "codex",
    env: { TANDEM_CLAUDE_BIN: FAKE_CLAUDE, TANDEM_MODEL: "gpt-x" },
  });
  assert.match(r.out, /FAILOVER/, "the loud FAILOVER line is printed");
  assert.match(r.out, /FAKE-CLAUDE ok/, "the final verdict comes from the alternate claude lane");
  assert.equal(r.code, 0, "the failed-over turn succeeds");
});

test("false-positive guard: a limit string in the STREAM (not the verdict) does NOT trip a park", (t) => {
  const state = freshState(t);
  const driver = "noiseDrv";
  const r = peer(["ask", "clean turn"], { state, driver, env: { FAKE_STREAM_LIMIT_NOISE: "1" } });
  assert.equal(r.code, 0, "a clean turn with noisy tool output succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job?.errorKind, undefined, "must NOT be classified as a provider-limit");
  assert.ok(!existsSync(join(state, "provider-state.json")), "nothing was parked");
});

test("escape hatch (flag): --no-limit-classify restores plain banner-as-verdict behavior", (t) => {
  const state = freshState(t);
  const driver = "hatchFlagDrv";
  const r = peer(["ask", "--no-limit-classify", "run"], { state, driver, env: { FAKE_LIMIT: "1" } });
  assert.equal(r.code, 0, "without classification the banner is an ordinary (successful) verdict");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job?.errorKind, undefined);
  assert.match(job.verdict, /purchase more credits/, "the banner IS the verdict when classification is off");
});

test("escape hatch (env): TANDEM_NO_LIMIT_CLASSIFY=1 also disables classification", (t) => {
  const state = freshState(t);
  const driver = "hatchEnvDrv";
  const r = peer(["ask", "run"], { state, driver, env: { FAKE_LIMIT: "1", TANDEM_NO_LIMIT_CLASSIFY: "1" } });
  assert.equal(r.code, 0);
  assert.equal(readJob(state, driver)?.status, "done");
});

// ---- false-positive regression: the model's ANSWER is never limit evidence -------------------
// The production incident this guards: a lead lane BUILDING this very feature answered with prose
// quoting the claude banner ("resets 3am"); the old classifier loose-scanned the verdict and
// parked a healthy claude (its usage probe showed 35% — not limited). An exit-0 answer that
// discusses/quotes limit banners is a NORMAL verdict; only a genuine CLI failure signal (nonzero
// exit with the banner on stderr, or the banner AS the whole result) may classify.
const LIMIT_PROSE = [
  "Classifier review complete. Notes on the banner strings:",
  "the claude 5h shape is \"You've hit your session limit · resets 3am (America/Edmonton)\",",
  "the codex shape says \"You've hit your usage limit\" and \"purchase more credits or try again at 2:29 PM\",",
  "and the structured variant is a rate_limit_error 429 (provider-limit).",
  "None of these, quoted inside an answer, may ever park a healthy provider.",
].join("\n");

test("REGRESSION: an exit-0 codex ANSWER that merely DISCUSSES limit banners is a normal verdict — no park", (t) => {
  const state = freshState(t);
  const driver = "proseCodexDrv";
  const r = peer(["ask", "review the classifier"], { state, driver, env: { FAKE_VERDICT: LIMIT_PROSE } });
  assert.equal(r.code, 0, "the turn succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job?.errorKind, undefined, "must NOT be classified as a provider-limit");
  assert.match(job.verdict, /resets 3am/, "the answer survives verbatim as the verdict");
  assert.doesNotMatch(r.out, /provider limit hit/, "no loud park line is printed");
  assert.ok(!existsSync(join(state, "provider-state.json")), "nothing was parked");
});

test("REGRESSION: an exit-0 claude ANSWER that merely DISCUSSES limit banners is a normal verdict — no park", (t) => {
  const state = freshState(t);
  const driver = "proseClaudeDrv";
  const r = peer(["ask", "review the classifier"], { state, driver, partner: "claude", env: { FAKE_VERDICT: LIMIT_PROSE } });
  assert.equal(r.code, 0, "the turn succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job?.errorKind, undefined, "must NOT be classified as a provider-limit");
  assert.match(readLast(state, driver), /resets 3am/, "LASTMSG is the answer, not a park line");
  assert.ok(!existsSync(join(state, "provider-state.json")), "nothing was parked");
});

test("REGRESSION: a transient 429 retry notice on stderr of a SUCCESSFUL (exit-0) turn does not park", (t) => {
  const state = freshState(t);
  const driver = "retryNoiseDrv";
  const r = peer(["ask", "clean turn with retry noise"], { state, driver, env: { FAKE_STDERR_NOISE: "1" } });
  assert.equal(r.code, 0, "the surviving turn succeeds");
  const job = readJob(state, driver);
  assert.equal(job?.status, "done");
  assert.equal(job?.errorKind, undefined);
  assert.ok(!existsSync(join(state, "provider-state.json")), "a retried-but-successful turn never parks");
});

test("wait on an errorKind record still exits 1 (unchanged consumer contract)", (t) => {
  const state = freshState(t);
  const driver = "waitErrDrv";
  const now = Date.now();
  // a finished provider-limit job record, exactly as ask()/the daemon would leave it
  writeFileSync(
    join(state, `job-${jobKey(driver)}.json`),
    JSON.stringify({ status: "error", partner: "codex", errorKind: "provider-limit", provider: "codex", resetAt: now + 3600_000, error: "provider usage limit on codex", dispatchId: "seed", startedTs: now, finishedTs: now, ts: now }),
  );
  const r = peer(["wait", "5"], { state, driver });
  assert.equal(r.code, 1, "wait surfaces the error record as a nonzero exit");
  assert.match(r.out, /provider usage limit/);
});
