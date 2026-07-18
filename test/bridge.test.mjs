// Regression tests for the tandem bridge. Every bug we hit in the field gets a test here so it
// can't come back. Fully isolated: a temp .state per test (TANDEM_STATE) + a fake codex partner
// (TANDEM_CODEX_BIN) — no real sessions, no API, no cost, never touches your live .state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobKey, readGroups, recordGroup, readDetached, markDetached, stateDir, listStateDirs, setLabel } from "../bin/groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PEER = join(ROOT, "bin", "peer.mjs");
const FAKE_CODEX = join(HERE, "fake-codex.mjs");
const FAKE_CLAUDE = join(HERE, "fake-claude.mjs");

function freshState(t) {
  const d = mkdtempSync(join(tmpdir(), "tandem-test-"));
  t.after(() => {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return d;
}

// Build the child env for a driver. partner="codex" → this is a Claude driver pairing with the
// fake codex; partner="claude" → this is a Codex driver pairing with the fake claude daemon.
function buildEnv(state, driver, partner, env) {
  const e = { ...process.env };
  for (const k of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete e[k];
  e.TANDEM_STATE = state;
  e.TANDEM_PARTNER = partner;
  if (partner === "claude") {
    e.CODEX_SESSION_ID = driver;
    e.TANDEM_CLAUDE_BIN = FAKE_CLAUDE;
  } else {
    e.CLAUDE_CODE_SESSION_ID = driver;
    e.TANDEM_CODEX_BIN = FAKE_CODEX;
  }
  return { ...e, ...env };
}
// Run a peer.mjs command synchronously in an isolated state dir against a fake partner.
function peer(args, { state, driver, partner = "codex", env = {} } = {}) {
  const r = spawnSync(process.execPath, [PEER, ...args], { encoding: "utf8", env: buildEnv(state, driver, partner, env) });
  return { stdout: r.stdout || "", out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}
// Async variant for genuinely parallel (overlapping) runs.
function peerAsync(args, { state, driver, partner = "codex", env = {} } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [PEER, ...args], { env: buildEnv(state, driver, partner, env) });
    let out = "";
    c.stdout.on("data", (b) => (out += b));
    c.stderr.on("data", (b) => (out += b));
    c.on("exit", (code) => resolve({ out, stdout: out, code }));
  });
}
// Kill a serve daemon started during a test (reads its pid from the isolated state). Tree-kill on
// Windows so the fake-claude child doesn't linger between daemon tests.
function stopDaemon(state) {
  try {
    const pid = Number(readFileSync(join(state, "serve.pid"), "utf8").trim());
    if (!pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid);
  } catch {
    /* already gone */
  }
}
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const readLast = (state, driver) => {
  const f = join(state, `last-${jobKey(driver)}.txt`);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const sidOf = (s) => /sid=(\S+)/.exec(s)?.[1];

// ---------- unit: shared state-key + group logic ----------
test("jobKey isolates drivers and sanitizes to a safe filename", () => {
  assert.notEqual(jobKey("driver-a"), jobKey("driver-b"));
  assert.match(jobKey("a/b c:1"), /^[a-zA-Z0-9-]+$/);
  assert.equal(jobKey(""), "default");
  assert.equal(jobKey(null), "default");
});

test("recordGroup keeps a stable group number per immutable pair", (t) => {
  const f = join(freshState(t), "g.json");
  const a = recordGroup(f, { claudeId: "C1", codexId: "X1", direction: "claude->codex" });
  const a2 = recordGroup(f, { claudeId: "C1", codexId: "X1", direction: "claude->codex" });
  assert.equal(a.n, a2.n); // same pair → same group
  const b = recordGroup(f, { claudeId: "C1", codexId: "X2", direction: "claude->codex" });
  assert.notEqual(b.n, a.n); // different codex → new group
  assert.equal(Object.keys(readGroups(f).groups).length, 2);
});

test("markDetached stamps a driver so old pairings can be ignored", (t) => {
  const f = join(freshState(t), "d.json");
  markDetached(f, "C1");
  assert.ok(readDetached(f)["C1"] > 0);
});

test("stateDir routes each driver to tandems/<label>, with id fallback + override", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tandem-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  delete process.env.TANDEM_STATE;
  delete process.env.TANDEM_LABEL;
  // no label yet → session-id fallback under tandems/
  assert.equal(stateDir(root, "drvA"), join(root, "tandems", jobKey("drvA")));
  assert.notEqual(stateDir(root, "drvA"), stateDir(root, "drvB")); // unrelated tandems never share
  assert.equal(stateDir(root, ""), join(root, ".state")); // no driver → legacy shared
  // driver-set label → readable folder (sanitized)
  setLabel(root, "drvA", "Watch Together / CDN engine!");
  assert.equal(stateDir(root, "drvA"), join(root, "tandems", "Watch-Together-CDN-engine"));
  // explicit override wins over everything
  process.env.TANDEM_STATE = join(root, "ov");
  assert.equal(stateDir(root, "drvA"), resolve(join(root, "ov")));
  delete process.env.TANDEM_STATE;
});

test("setLabel migrates an already-used id folder to the named one (late naming keeps state)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tandem-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  delete process.env.TANDEM_STATE;
  delete process.env.TANDEM_LABEL;
  const idFolder = join(root, "tandems", jobKey("drvX"));
  mkdirSync(idFolder, { recursive: true });
  writeFileSync(join(idFolder, "groups.json"), '{"seq":1,"groups":{}}'); // pretend it already has state
  setLabel(root, "drvX", "my-feature");
  assert.ok(existsSync(join(root, "tandems", "my-feature", "groups.json")), "state migrated to the named folder");
  assert.ok(!existsSync(idFolder), "old id folder gone");
  assert.equal(stateDir(root, "drvX"), join(root, "tandems", "my-feature"));
});

test("listStateDirs finds legacy .state and every tandems/<label> (skips .labels.json)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tandem-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  delete process.env.TANDEM_STATE;
  mkdirSync(join(root, ".state"), { recursive: true });
  mkdirSync(join(root, "tandems", "alpha"), { recursive: true });
  mkdirSync(join(root, "tandems", "beta"), { recursive: true });
  writeFileSync(join(root, "tandems", ".labels.json"), "{}");
  const dirs = listStateDirs(root);
  assert.ok(dirs.includes(join(root, ".state")));
  assert.ok(dirs.includes(join(root, "tandems", "alpha")));
  assert.ok(dirs.includes(join(root, "tandems", "beta")));
  assert.ok(!dirs.some((d) => d.endsWith(".labels.json")));
});

test("`ledger` writes to THIS pair's own TANDEM.md (never shared)", (t) => {
  const s = freshState(t);
  peer(["ledger", "DECISION: parallelize the height pump"], { state: s, driver: "drvL" });
  assert.match(readFileSync(join(s, "TANDEM.md"), "utf8"), /DECISION: parallelize the height pump/);
  const r = peer(["ledger"], { state: s, driver: "drvL" }); // no arg → print it
  assert.match(r.stdout, /DECISION: parallelize the height pump/);
});

// ---------- integration: the real peer.mjs flow against a fake partner ----------
test("verdict is THIS turn's output, never a stale file", (t) => {
  const s = freshState(t);
  const r = peer(["ask", "ZULU-marker implement the widget"], { state: s, driver: "drvA" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ZULU-marker/); // captured the task we just sent
});

test("concurrent tandems do NOT clobber each other's verdict (the field bug)", (t) => {
  const s = freshState(t);
  peer(["ask", "ALPHA-task"], { state: s, driver: "drvA" });
  peer(["ask", "BETA-task"], { state: s, driver: "drvB" });
  assert.match(readLast(s, "drvA"), /ALPHA-task/);
  assert.match(readLast(s, "drvB"), /BETA-task/);
  assert.doesNotMatch(readLast(s, "drvA"), /BETA-task/); // A never sees B's result
});

test("a repeat ask resumes the SAME codex (immutable coupling)", (t) => {
  const s = freshState(t);
  const r1 = peer(["ask", "first"], { state: s, driver: "drvA" });
  const sid1 = sidOf(r1.stdout);
  assert.ok(sid1, "first ask should report a fresh sid");
  const r2 = peer(["ask", "second"], { state: s, driver: "drvA" });
  assert.match(r2.stdout, /mode=resume/);
  assert.equal(sidOf(r2.stdout), sid1); // same codex
});

test("`new` starts a genuinely fresh thread (not the old context-exhausted one)", (t) => {
  const s = freshState(t);
  const sid1 = sidOf(peer(["ask", "first"], { state: s, driver: "drvA" }).stdout);
  peer(["new"], { state: s, driver: "drvA" });
  const r2 = peer(["ask", "second"], { state: s, driver: "drvA" });
  assert.match(r2.stdout, /mode=fresh/);
  assert.notEqual(sidOf(r2.stdout), sid1);
});

test("`compact` on an unmatched driver touches nothing", (t) => {
  const s = freshState(t);
  const r = peer(["compact", "summarize"], { state: s, driver: "nobody" });
  assert.match(r.out, /no codex session to compact/i);
  assert.equal(readLast(s, "nobody"), "");
});

test("`compact` hands off to a fresh seeded thread without polluting the verdict slot", (t) => {
  const s = freshState(t);
  peer(["ask", "REALWORK-one"], { state: s, driver: "drvA" });
  const last1 = readLast(s, "drvA");
  assert.match(last1, /REALWORK-one/);
  peer(["compact", "preserve the plan and current task"], { state: s, driver: "drvA" });
  assert.equal(readLast(s, "drvA"), last1, "compact must not overwrite the real verdict");
  const r2 = peer(["ask", "REALWORK-two"], { state: s, driver: "drvA" });
  assert.match(r2.stdout, /mode=fresh/); // re-coupled to a fresh thread
  assert.match(readLast(s, "drvA"), /REALWORK-two/);
});

test("reactive net recovers on a fresh session when a turn hits the context wall", (t) => {
  const s = freshState(t);
  peer(["ask", "establish"], { state: s, driver: "drvA" }); // couples fresh
  const r = peer(["ask", "keep going"], { state: s, driver: "drvA", env: { FAKE_FAIL_CONTEXT: "1" } });
  assert.match(r.out, /recovering on a fresh session/i); // reactive path fired
  assert.match(r.stdout, /mode=fresh/); // and produced a fresh verdict, not a hard failure
});

test("after `new`, the fresh thread becomes the new STABLE couple (re-couples by recency)", (t) => {
  const s = freshState(t);
  const sid1 = sidOf(peer(["ask", "one"], { state: s, driver: "drvA" }).stdout);
  peer(["new"], { state: s, driver: "drvA" });
  const sid2 = sidOf(peer(["ask", "two"], { state: s, driver: "drvA" }).stdout); // fresh
  assert.notEqual(sid2, sid1);
  const r3 = peer(["ask", "three"], { state: s, driver: "drvA" }); // must resume sid2, not sid1, not fresh
  assert.match(r3.stdout, /mode=resume/);
  assert.equal(sidOf(r3.stdout), sid2);
});

test("each driver couples to its OWN codex, never the other's (no wrong-side routing)", (t) => {
  const s = freshState(t);
  const a1 = sidOf(peer(["ask", "A-one"], { state: s, driver: "drvA" }).stdout);
  const b1 = sidOf(peer(["ask", "B-one"], { state: s, driver: "drvB" }).stdout);
  assert.notEqual(a1, b1);
  const a2 = peer(["ask", "A-two"], { state: s, driver: "drvA" });
  const b2 = peer(["ask", "B-two"], { state: s, driver: "drvB" });
  assert.equal(sidOf(a2.stdout), a1, "A must resume A's codex");
  assert.equal(sidOf(b2.stdout), b1, "B must resume B's codex");
});

test("low-context notice fires for the driver when the passenger nears the limit", (t) => {
  const s = freshState(t);
  const r = peer(["ask", "big turn"], { state: s, driver: "drvA", env: { TANDEM_COMPACT_AT: "500", FAKE_TOKENS: "900" } });
  assert.match(r.out, /running low on context/i);
  assert.match(r.out, /peer\.mjs compact/);
});

// ---------- Codex→Claude path (the persistent serve daemon) ----------
test("codex→claude (daemon): the driver's verdict is captured from the result event", (t) => {
  const s = freshState(t);
  t.after(() => stopDaemon(s));
  const r = peer(["ask", "CLAUDEUI build the lock panel"], { state: s, driver: "codexDrvA", partner: "claude" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /CLAUDEUI/); // verdict came back from the daemon, for this driver
  assert.match(readLast(s, "codexDrvA"), /CLAUDEUI/);
});

test("codex→claude and claude→codex do NOT clobber each other (cross-direction — the field bug)", (t) => {
  const s = freshState(t);
  t.after(() => stopDaemon(s));
  peer(["ask", "CLAUDEWORK alpha"], { state: s, driver: "cdxDrv", partner: "claude" }); // → claude daemon
  peer(["ask", "CODEXWORK beta"], { state: s, driver: "cldDrv", partner: "codex" }); // → codex
  assert.match(readLast(s, "cdxDrv"), /CLAUDEWORK/);
  assert.match(readLast(s, "cldDrv"), /CODEXWORK/);
  assert.doesNotMatch(readLast(s, "cdxDrv"), /CODEXWORK/); // the codex turn must not overwrite the claude verdict
});

test("codex→claude: `new` yields a FRESH claude session (no re-glue to the old one)", (t) => {
  const s = freshState(t);
  t.after(() => stopDaemon(s));
  const r1 = peer(["ask", "first ui task"], { state: s, driver: "cdxN", partner: "claude" });
  const sid1 = sidOf(r1.stdout) || sidOf(readLast(s, "cdxN"));
  peer(["new"], { state: s, driver: "cdxN", partner: "claude" }); // must reset the daemon + detach
  const r2 = peer(["ask", "second ui task"], { state: s, driver: "cdxN", partner: "claude" });
  const sid2 = sidOf(r2.stdout) || sidOf(readLast(s, "cdxN"));
  assert.ok(sid1 && sid2, "both turns should report a claude sid");
  assert.notEqual(sid2, sid1, "`new` must give a fresh claude session, not re-glue the old pairing");
});

// ---------- true parallelism (overlapping turns, not sequential) ----------
test("genuinely concurrent codex tandems never clobber (parallel, overlapping)", async (t) => {
  const s = freshState(t);
  const drivers = ["pA", "pB", "pC"];
  // FAKE_DELAY makes all three turns overlap in time, so a shared-file race would actually trigger
  await Promise.all(drivers.map((d) => peerAsync(["ask", `PARALLEL-${d} work`], { state: s, driver: d, env: { FAKE_DELAY: "300" } })));
  for (const d of drivers) {
    assert.match(readLast(s, d), new RegExp(`PARALLEL-${d}`), `${d} kept its own verdict`);
    for (const other of drivers) {
      if (other !== d) assert.doesNotMatch(readLast(s, d), new RegExp(`PARALLEL-${other}`), `${d} not clobbered by ${other}`);
    }
  }
});

test("same-lane double dispatch is atomically refused, including a foreground holder", async (t) => {
  const s = freshState(t);
  const opts = { state: s, driver: "lockedLane", env: { FAKE_DELAY: "1200" } };

  const racing = await Promise.all([
    peerAsync(["ask", "--bg", "LOCK-RACE-A"], opts),
    peerAsync(["ask", "--bg", "LOCK-RACE-B"], opts),
  ]);
  assert.equal(racing.filter((r) => r.code === 0).length, 1, "exactly one background dispatch acquires the lane");
  const refused = racing.find((r) => r.code !== 0);
  assert.equal(refused?.code, 3);
  assert.match(refused?.out || "", /dispatch refused: existing job is running/i);

  const foregroundRefused = peer(["ask", "LOCK-FOREGROUND-REFUSED"], opts);
  assert.equal(foregroundRefused.code, 3);
  assert.match(foregroundRefused.out, /existing job is running/i);
  assert.doesNotMatch(readLast(s, "lockedLane"), /LOCK-FOREGROUND-REFUSED/);

  const waited = peer(["wait", "8"], opts);
  assert.match(waited.out, /PARTNER VERDICT/);

  const foreground = peerAsync(["ask", "LOCK-FOREGROUND-HOLDER"], opts);
  await sleep(200);
  const backgroundRefused = peer(["ask", "--bg", "LOCK-BG-REFUSED"], opts);
  assert.equal(backgroundRefused.code, 3);
  assert.match(backgroundRefused.out, /existing job is running/i);
  await foreground;
  assert.match(readLast(s, "lockedLane"), /LOCK-FOREGROUND-HOLDER/);
  assert.doesNotMatch(readLast(s, "lockedLane"), /LOCK-BG-REFUSED/);
});

test("hard-killed worker becomes WEDGED and requires explicit reap before replacement", async (t) => {
  const s = freshState(t);
  const opts = { state: s, driver: "wedgedLane", env: { FAKE_DELAY: "10000" } };
  const started = peer(["ask", "--bg", "WEDGE-ORIGINAL"], opts);
  assert.equal(started.code, 0);

  const jobFile = join(s, `job-${jobKey("wedgedLane")}.json`);
  const job = JSON.parse(readFileSync(jobFile, "utf8"));
  assert.ok(job.workerPid, "background job records its worker pid");
  killTree(job.workerPid);
  await sleep(250);

  const status = peer(["status"], opts);
  assert.match(status.out, /job: WEDGED/);
  assert.match(status.out, /worker pid .* is not alive/i);

  const blindRetry = peer(["ask", "--bg", "WEDGE-BLIND-RETRY"], opts);
  assert.equal(blindRetry.code, 3);
  assert.match(blindRetry.out, /existing job is WEDGED/i);

  const reaped = peer(["reap"], opts);
  assert.equal(reaped.code, 0);
  assert.match(reaped.out, /WEDGED lane reaped/i);

  const replacement = peer(["ask", "WEDGE-REPLACEMENT"], { state: s, driver: "wedgedLane" });
  assert.equal(replacement.code, 0);
  assert.match(replacement.out, /WEDGE-REPLACEMENT/);
  assert.doesNotMatch(replacement.out, /WEDGE-BLIND-RETRY/);
});
