// Regression tests for the tandem bridge. Every bug we hit in the field gets a test here so it
// can't come back. Fully isolated: a temp .state per test (TANDEM_STATE) + a fake codex partner
// (TANDEM_CODEX_BIN) — no real sessions, no API, no cost, never touches your live .state.
import { after, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobKey, readGroups, recordGroup, readDetached, markDetached, stateDir, listStateDirs, setLabel } from "../bin/groups.mjs";
import { supervisionDecision } from "../bin/process-control.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PEER = join(ROOT, "bin", "peer.mjs");
const FAKE_CODEX = join(HERE, "fake-codex.mjs");
const FAKE_CLAUDE = join(HERE, "fake-claude.mjs");
const TEST_CASE_TIMEOUT_MS = 30_000;
const TEST_PROCESS_TIMEOUT_MS = 20_000;
const TEST_KILL_TIMEOUT_MS = 5_000;
// Node 22 applies --test-timeout to each file worker, so entry files select bounded case ranges.
const [SHARD_FIRST, SHARD_LAST] = globalThis.__TANDEM_BRIDGE_TEST_RANGE__ || [1, Number.POSITIVE_INFINITY];
const ACTIVE_TEST_ROOTS = new Set();
const ACTIVE_PEERS = new Map();
const CLEANUP_WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));
let testNumber = 0;
const test = (name, fn) => {
  testNumber += 1;
  if (testNumber < SHARD_FIRST || testNumber > SHARD_LAST) return;
  return nodeTest(name, { timeout: TEST_CASE_TIMEOUT_MS }, fn);
};

function freshState(t) {
  const d = mkdtempSync(join(tmpdir(), "tandem-test-"));
  ACTIVE_TEST_ROOTS.add(d);
  t.after(() => {
    const livePids = stopStateProcesses(d);
    let removeError = null;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch (error) {
      removeError = error;
    }
    ACTIVE_TEST_ROOTS.delete(d);
    assert.deepEqual(livePids, [], `test cleanup left live processes for ${d}: ${livePids.join(", ")}`);
    if (removeError) throw removeError;
  });
  return d;
}

// Build the child env for a driver. partner="codex" → this is a Claude driver pairing with the
// fake codex; partner="claude" → this is a Codex driver pairing with the fake claude daemon.
function buildEnv(state, driver, partner, env) {
  const e = { ...process.env };
  // TANDEM_NESTED_AGENT would route worker spawns through the job-escape path
  // (extra latency) if this suite itself runs under a nested agent — these
  // tests exercise top-level lane behavior, so always start unmarked
  for (const k of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TANDEM_NESTED_AGENT"]) delete e[k];
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
// Run a peer.mjs command synchronously in an isolated state dir against a fake partner.
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
    stopStateProcesses(state);
    assert.fail(
      `peer ${args.join(" ")} did not complete within ${TEST_PROCESS_TIMEOUT_MS}ms: ${r.error.message}`,
    );
  }
  return { stdout: r.stdout || "", out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}
// Async variant for genuinely parallel (overlapping) runs.
function peerAsync(args, { state, driver, partner = "codex", env = {} } = {}) {
  let child = null;
  let timedOut = false;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let killTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (child) ACTIVE_PEERS.delete(child);
      fn(value);
    };
    child = spawn(process.execPath, [PEER, ...args], {
      env: buildEnv(state, driver, partner, env),
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    child.on("error", (error) => {
      finish(reject, new Error(`peer ${args.join(" ")} failed to spawn: ${error.message}`));
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish(
          reject,
          new Error(`peer ${args.join(" ")} did not complete within ${TEST_PROCESS_TIMEOUT_MS}ms`),
        );
      } else {
        finish(resolve, { out, stdout: out, code });
      }
    });
    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      killTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        finish(
          reject,
          new Error(
            `peer ${args.join(" ")} did not close within ${TEST_KILL_TIMEOUT_MS}ms after timeout cleanup`,
          ),
        );
      }, TEST_KILL_TIMEOUT_MS);
    }, TEST_PROCESS_TIMEOUT_MS);
    ACTIVE_PEERS.set(child, {
      state,
      cancel: () => {
        if (child.pid) killTree(child.pid);
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        finish(reject, new Error(`peer ${args.join(" ")} was cancelled by test cleanup`));
      },
    });
  });
  promise.catch(() => {});
  return promise;
}

function pathIsInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function recordedProcessIds(root) {
  const pids = new Set();
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === "serve.pid") {
        try {
          pids.add(Number(readFileSync(file, "utf8").trim()));
        } catch {
          /* already gone */
        }
        continue;
      }
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".lock")) continue;
      try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        let keys = [];
        if (dir.endsWith(".test-processes")) {
          keys = ["pid", "ppid"];
        } else if (/^job-.*\.json$/i.test(entry.name) && ["running", "WEDGED"].includes(value?.status)) {
          keys = ["workerPid", "partnerPid", "controllerPid"];
        } else if (/^dispatch-.*\.lock$/i.test(entry.name)) {
          keys = ["ownerPid"];
        } else if (/^heartbeat-.*\.json$/i.test(entry.name)) {
          keys = ["pid"];
        }
        for (const key of keys) {
          if (Number(value?.[key]) > 0) pids.add(Number(value[key]));
        }
      } catch {
        /* partially written or unrelated JSON */
      }
    }
  }
  pids.delete(process.pid);
  pids.delete(0);
  return [...pids];
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function stopTrackedPeers(root) {
  for (const [child, meta] of ACTIVE_PEERS) {
    if (!pathIsInside(root, meta.state)) continue;
    meta.cancel();
  }
}

function stopStateProcesses(root) {
  for (let attempt = 0; attempt < 3; attempt++) {
    stopTrackedPeers(root);
    for (const pid of recordedProcessIds(root)) {
      if (pidIsAlive(pid)) killTree(pid);
    }
    Atomics.wait(CLEANUP_WAIT_CELL, 0, 0, 50);
  }
  const livePids = recordedProcessIds(root).filter(pidIsAlive);
  for (const pid of livePids) killTree(pid);
  if (livePids.length) Atomics.wait(CLEANUP_WAIT_CELL, 0, 0, 50);
  return recordedProcessIds(root).filter(pidIsAlive);
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: TEST_KILL_TIMEOUT_MS,
      });
    }
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

after(() => {
  const leaked = [];
  for (const root of [...ACTIVE_TEST_ROOTS]) {
    leaked.push(...stopStateProcesses(root));
  }
  assert.deepEqual(leaked, [], `bridge shard left live processes: ${leaked.join(", ")}`);
});

process.once("exit", () => {
  for (const root of ACTIVE_TEST_ROOTS) stopStateProcesses(root);
});

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function waitFor(condition, description, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = condition();
      if (value) return value;
    } catch {
      /* state may not exist yet */
    }
    await sleep(20);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
}
function readJob(state, driver) {
  const file = join(state, `job-${jobKey(driver)}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}
function waitForRunningJob(state, driver) {
  return waitFor(
    () => {
      const job = readJob(state, driver);
      return job?.status === "running" && Number(job.workerPid) > 0 ? job : null;
    },
    `lane ${driver} to own a running job`,
  );
}
function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: TEST_PROCESS_TIMEOUT_MS,
  });
  if (result.error) {
    assert.fail(`git ${args.join(" ")} did not complete: ${result.error.message}`);
  }
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
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

test("`compact` is refused while the lane already owns a live partner turn", async (t) => {
  const s = freshState(t);
  peer(["ask", "establish compact target"], { state: s, driver: "compactLocked" });
  const opts = { state: s, driver: "compactLocked", env: { FAKE_DELAY: "1200" } };

  const active = peerAsync(["ask", "LONG-LIVE-TURN"], opts);
  try {
    await waitForRunningJob(s, "compactLocked");
    const compact = peer(["compact", "must not race the live turn"], opts);
    assert.equal(compact.code, 3);
    assert.match(compact.out, /dispatch refused: existing job is running/i);
    assert.ok(!existsSync(join(s, "codex.seed")), "a refused compact must not detach or seed a replacement");
  } finally {
    await active;
  }
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
  const r = peer(["ask", "CLAUDEUI build the lock panel"], { state: s, driver: "codexDrvA", partner: "claude" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /CLAUDEUI/); // verdict came back from the daemon, for this driver
  assert.match(readLast(s, "codexDrvA"), /CLAUDEUI/);
});

test("codex→claude spawn failure releases the lane instead of wedging it", (t) => {
  const s = freshState(t);
  const failed = peer(["ask", "CLAUDE-SPAWN-FAIL"], {
    state: s,
    driver: "claudeSpawnFail",
    partner: "claude",
    env: { TANDEM_CLAUDE_BIN: join(s, "missing-claude.exe") },
  });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /did not become ready|exited before the Claude partner became ready/i);

  const status = peer(["status"], {
    state: s,
    driver: "claudeSpawnFail",
    partner: "claude",
  });
  assert.match(status.out, /job: error/i);
  assert.doesNotMatch(status.out, /WEDGED/);
  assert.equal(peer(["ask", "CLAUDE-SPAWN-RECOVERED"], {
    state: s,
    driver: "claudeSpawnFail",
    partner: "claude",
  }).code, 0);
});

test("codex→claude and claude→codex do NOT clobber each other (cross-direction — the field bug)", (t) => {
  const s = freshState(t);
  peer(["ask", "CLAUDEWORK alpha"], { state: s, driver: "cdxDrv", partner: "claude" }); // → claude daemon
  peer(["ask", "CODEXWORK beta"], { state: s, driver: "cldDrv", partner: "codex" }); // → codex
  assert.match(readLast(s, "cdxDrv"), /CLAUDEWORK/);
  assert.match(readLast(s, "cldDrv"), /CODEXWORK/);
  assert.doesNotMatch(readLast(s, "cdxDrv"), /CODEXWORK/); // the codex turn must not overwrite the claude verdict
});

test("codex→claude: `new` yields a FRESH claude session (no re-glue to the old one)", (t) => {
  const s = freshState(t);
  const r1 = peer(["ask", "first ui task"], { state: s, driver: "cdxN", partner: "claude" });
  const sid1 = sidOf(r1.stdout) || sidOf(readLast(s, "cdxN"));
  peer(["new"], { state: s, driver: "cdxN", partner: "claude" }); // must reset the daemon + detach
  const r2 = peer(["ask", "second ui task"], { state: s, driver: "cdxN", partner: "claude" });
  const sid2 = sidOf(r2.stdout) || sidOf(readLast(s, "cdxN"));
  assert.ok(sid1 && sid2, "both turns should report a claude sid");
  assert.notEqual(sid2, sid1, "`new` must give a fresh claude session, not re-glue the old pairing");
});

test("codex→claude: `compact` is lane-locked, preserves the last real verdict, and reseeds fresh", (t) => {
  const s = freshState(t);
  const base = { state: s, driver: "claudeCompact", partner: "claude" };
  const first = peer(["ask", "CLAUDE-REALWORK-one"], base);
  const sid1 = sidOf(first.stdout) || sidOf(readLast(s, "claudeCompact"));
  const last1 = readLast(s, "claudeCompact");

  const compacted = peer(["compact", "preserve the Claude plan"], base);
  assert.equal(compacted.code, 0);
  assert.match(compacted.out, /Claude partner compacted/i);
  assert.equal(readLast(s, "claudeCompact"), last1, "Claude compact must not overwrite the last real verdict");

  const second = peer(["ask", "CLAUDE-REALWORK-two"], base);
  const sid2 = sidOf(second.stdout) || sidOf(readLast(s, "claudeCompact"));
  assert.ok(sid1 && sid2);
  assert.notEqual(sid2, sid1);
  assert.match(readLast(s, "claudeCompact"), /CLAUDE-REALWORK-two/);
  assert.match(readLast(s, "claudeCompact"), /Handoff from a previous session/i);
  // the reseeded session is a FRESH bridge session → it must carry the [TANDEM ...] brand as its
  // first line (exactly the 1-2 message backlog-spam class the brand exists to make filterable)
  assert.match(readLast(s, "claudeCompact"), /branded=1/);
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

test("concurrent fresh turns couple only to the rollout carrying their lane nonce", async (t) => {
  const root = freshState(t);
  const stateA = join(root, "lane-a");
  const stateB = join(root, "lane-b");
  const rollouts = join(root, "rollouts");
  mkdirSync(stateA, { recursive: true });
  mkdirSync(stateB, { recursive: true });
  const env = {
    FAKE_DELAY: "300",
    FAKE_OMIT_SESSION_ID: "1",
    FAKE_WRITE_ROLLOUT: "1",
    TANDEM_CODEX_SESSIONS: rollouts,
  };

  const [a1, b1] = await Promise.all([
    peerAsync(["ask", "COUPLE-LANE-A"], { state: stateA, driver: "sharedDriver", env }),
    peerAsync(["ask", "COUPLE-LANE-B"], { state: stateB, driver: "sharedDriver", env }),
  ]);
  const sidA = sidOf(a1.out);
  const sidB = sidOf(b1.out);
  assert.ok(sidA && sidB, "both fake turns report their actual session ids");
  assert.notEqual(sidA, sidB);

  const a2 = peer(["ask", "COUPLE-LANE-A-CONTINUE"], { state: stateA, driver: "sharedDriver", env });
  const b2 = peer(["ask", "COUPLE-LANE-B-CONTINUE"], { state: stateB, driver: "sharedDriver", env });
  assert.match(a2.out, /mode=resume/);
  assert.match(b2.out, /mode=resume/);
  assert.equal(sidOf(a2.out), sidA, "lane A resumes the rollout containing A's nonce");
  assert.equal(sidOf(b2.out), sidB, "lane B resumes the rollout containing B's nonce");
});

test("fresh coupling ignores generic event ids and accepts only an explicit session id", (t) => {
  const state = freshState(t);
  const actual = "11111111-2222-4333-8444-555555555555";
  const decoy = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const env = { FAKE_SID: actual, FAKE_DECOY_ID: decoy };

  const first = peer(["ask", "DECOY-ID-FIRST"], { state, driver: "decoyDriver", env });
  assert.equal(first.code, 0);
  assert.equal(sidOf(first.out), actual);
  const second = peer(["ask", "DECOY-ID-CONTINUE"], { state, driver: "decoyDriver", env });
  assert.match(second.out, /mode=resume/);
  assert.equal(sidOf(second.out), actual);
  assert.doesNotMatch(second.out, new RegExp(decoy));
});

test("fresh coupling fails closed with a persistent warning when no session metadata can be proven", (t) => {
  const root = freshState(t);
  const state = join(root, "lane");
  const sessions = join(root, "empty-sessions");
  mkdirSync(state, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const uncoupledEnv = {
    FAKE_OMIT_SESSION_ID: "1",
    TANDEM_CODEX_SESSIONS: sessions,
  };

  const first = peer(["ask", "UNCOUPLED-FIRST"], {
    state,
    driver: "uncoupledDriver",
    env: uncoupledEnv,
  });
  assert.equal(first.code, 0);
  assert.match(first.out, /could not prove its session id/i);
  assert.ok(!existsSync(join(state, "peer.session")));

  const status = peer(["status"], {
    state,
    driver: "uncoupledDriver",
    env: uncoupledEnv,
  });
  assert.match(status.out, /continuity was left uncoupled/i);

  const replacement = peer(["ask", "UNCOUPLED-REPLACEMENT"], {
    state,
    driver: "uncoupledDriver",
    env: { FAKE_SID: "99999999-8888-4777-8666-555555555555", TANDEM_CODEX_SESSIONS: sessions },
  });
  assert.equal(replacement.code, 0);
  assert.match(replacement.out, /mode=fresh/);
});

test("lane worktree provisioning persists an isolated cwd for fresh editing turns", (t) => {
  const root = freshState(t);
  const repo = join(root, "repo");
  const state = join(root, "state");
  const worktree = join(root, "editing-worktree");
  mkdirSync(repo, { recursive: true });
  mkdirSync(state, { recursive: true });
  runGit(["init"], repo);
  runGit(["config", "user.email", "tandem-test@example.invalid"], repo);
  runGit(["config", "user.name", "Tandem Test"], repo);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  runGit(["add", "seed.txt"], repo);
  runGit(["commit", "-m", "seed"], repo);

  const created = peer(
    ["worktree", "create", worktree, "tandem/edit-lane", "HEAD"],
    {
      state,
      driver: "worktreeDriver",
      env: { TANDEM_CWD: repo, TANDEM_LABEL: "edit-lane" },
    },
  );
  assert.equal(created.code, 0);
  assert.match(created.out, /created worktree/i);
  assert.ok(existsSync(join(worktree, ".git")));
  const worktreeList = runGit(["worktree", "list", "--porcelain"], repo).replaceAll("/", "\\");
  assert.ok(worktreeList.toLowerCase().includes(resolve(worktree).toLowerCase()));

  const metadata = JSON.parse(readFileSync(join(state, "lane.json"), "utf8"));
  assert.equal(resolve(metadata.cwd), resolve(worktree));
  assert.equal(metadata.worktree.branch, "tandem/edit-lane");

  const asked = peer(
    ["ask", "EDIT-IN-ISOLATED-WORKTREE"],
    {
      state,
      driver: "worktreeDriver",
      env: { TANDEM_CWD: repo, TANDEM_LABEL: "edit-lane" },
    },
  );
  assert.equal(asked.code, 0);
  assert.match(asked.out, /EDIT-IN-ISOLATED-WORKTREE/);
  assert.match(asked.out, new RegExp(`cwd=${worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
});

test("worktree binding is immutable after coupling and detached worktrees are rejected", (t) => {
  const root = freshState(t);
  const repo = join(root, "repo");
  const state = join(root, "state");
  const firstWorktree = join(root, "editing-one");
  const secondWorktree = join(root, "editing-two");
  const detachedWorktree = join(root, "detached");
  mkdirSync(repo, { recursive: true });
  mkdirSync(state, { recursive: true });
  runGit(["init"], repo);
  runGit(["config", "user.email", "tandem-test@example.invalid"], repo);
  runGit(["config", "user.name", "Tandem Test"], repo);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  runGit(["add", "seed.txt"], repo);
  runGit(["commit", "-m", "seed"], repo);

  const opts = {
    state,
    driver: "immutableWorktreeDriver",
    env: { TANDEM_CWD: repo, TANDEM_LABEL: "immutable-edit-lane" },
  };
  assert.equal(
    peer(["worktree", "create", firstWorktree, "tandem/immutable-one", "HEAD"], opts).code,
    0,
  );
  assert.equal(peer(["ask", "COUPLE-IN-FIRST-WORKTREE"], opts).code, 0);

  const refused = peer(
    ["worktree", "create", secondWorktree, "tandem/immutable-two", "HEAD"],
    opts,
  );
  assert.equal(refused.code, 3);
  assert.match(refused.out, /worktree change refused after coupling/i);
  assert.ok(!existsSync(secondWorktree));

  assert.equal(peer(["new"], opts).code, 0);
  const moved = peer(
    ["worktree", "create", secondWorktree, "tandem/immutable-two", "HEAD"],
    opts,
  );
  assert.equal(moved.code, 0);
  assert.ok(existsSync(join(secondWorktree, ".git")));

  runGit(["worktree", "add", "--detach", detachedWorktree, "HEAD"], repo);
  const detachedState = join(root, "detached-state");
  mkdirSync(detachedState, { recursive: true });
  const detached = peer(["worktree", "attach", detachedWorktree], {
    state: detachedState,
    driver: "detachedWorktreeDriver",
    env: { TANDEM_CWD: repo, TANDEM_LABEL: "detached-edit-lane" },
  });
  assert.equal(detached.code, 2);
  assert.match(detached.out, /worktree is detached/i);
});

test("persistent Claude lanes start inside the worktree pinned in lane metadata", (t) => {
  const root = freshState(t);
  const repo = join(root, "repo");
  const state = join(root, "state");
  const worktree = join(root, "claude-editing");
  mkdirSync(repo, { recursive: true });
  mkdirSync(state, { recursive: true });
  runGit(["init"], repo);
  runGit(["config", "user.email", "tandem-test@example.invalid"], repo);
  runGit(["config", "user.name", "Tandem Test"], repo);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  runGit(["add", "seed.txt"], repo);
  runGit(["commit", "-m", "seed"], repo);

  const opts = {
    state,
    driver: "claudeWorktreeDriver",
    partner: "claude",
    env: { TANDEM_CWD: repo, TANDEM_LABEL: "claude-editing-lane" },
  };
  assert.equal(
    peer(["worktree", "create", worktree, "tandem/claude-editing", "HEAD"], opts).code,
    0,
  );
  const asked = peer(["ask", "CLAUDE-EDIT-IN-WORKTREE"], opts);
  assert.equal(asked.code, 0);
  assert.ok(
    readLast(state, "claudeWorktreeDriver").includes(`cwd=${resolve(worktree)}`),
    "Claude daemon inherited the persisted lane cwd",
  );
});

test("swarm start auto-namespaces five same-driver lanes and aggregates their states", (t) => {
  const state = freshState(t);
  const manifest = join(state, "swarm.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      gates: false,
      lanes: Array.from({ length: 5 }, (_, index) => ({
        name: `lane-${index + 1}`,
        task: `SWARM-TASK-${index + 1}`,
      })),
    }),
  );
  const opts = { state, driver: "swarmDriver", env: { FAKE_DELAY: "1500", TANDEM_CWD: "" } };

  const started = peer(["swarm", "start", "hardening", manifest], opts);
  assert.equal(started.code, 0);
  for (let index = 1; index <= 5; index++) assert.match(started.out, new RegExp(`hardening/lane-${index} started`));

  const record = JSON.parse(readFileSync(join(state, "swarms", "hardening.json"), "utf8"));
  assert.equal(record.lanes.length, 5);
  assert.equal(new Set(record.lanes.map((lane) => lane.label)).size, 5);
  assert.equal(new Set(record.lanes.map((lane) => lane.state)).size, 5);
  for (const lane of record.lanes) {
    assert.match(lane.label, /^hardening--lane-[1-5]$/);
    assert.ok(existsSync(lane.state));
  }

  const status = peer(["swarm", "status", "hardening"], opts);
  for (let index = 1; index <= 5; index++) assert.match(status.out, new RegExp(`lane-${index}\\s+(running|done)`));

  const waited = peer(["swarm", "wait", "hardening", "12"], opts);
  assert.equal(waited.code, 0);
  assert.match(waited.out, /done=5/);
  const results = peer(["swarm", "results", "hardening"], opts);
  for (let index = 1; index <= 5; index++) assert.match(results.out, new RegExp(`SWARM-TASK-${index}`));

  const laneOne = record.lanes[0];
  const attached = peer(["swarm", "attach", "hardening", "lane-1", "--command"], opts);
  assert.equal(attached.code, 0);
  assert.match(attached.out, new RegExp(readFileSync(join(laneOne.state, "peer.session"), "utf8").trim()));

  const continued = peer(["swarm", "continue", "hardening", "lane-1", "SWARM-FOLLOWUP"], opts);
  assert.equal(continued.code, 0);
  assert.equal(peer(["swarm", "wait", "hardening", "8"], opts).code, 0);
  const oneResult = peer(["swarm", "result", "hardening", "lane-1"], opts);
  assert.match(oneResult.out, /SWARM-FOLLOWUP/);
  assert.doesNotMatch(oneResult.out, /SWARM-TASK-2/);
  const oneTail = peer(["swarm", "tail", "hardening", "lane-1", "10"], opts);
  assert.match(oneTail.out, /SWARM-FOLLOWUP/);
});

test("swarm rejects duplicate labels after sanitization before dispatching any lane", (t) => {
  const state = freshState(t);
  const manifest = join(state, "duplicate-swarm.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      gates: false,
      lanes: [
        { name: "same lane", task: "one" },
        { name: "same-lane", task: "two" },
      ],
    }),
  );
  const result = peer(["swarm", "start", "duplicates", manifest], {
    state,
    driver: "swarmDriver",
    env: { TANDEM_CWD: "" },
  });
  assert.equal(result.code, 2);
  assert.match(result.out, /duplicate lane label after sanitization/i);
  assert.ok(!existsSync(join(state, "swarms", "duplicates.json")));
});

test("concurrent swarm creation atomically reserves one namespace and dispatches once", async (t) => {
  const state = freshState(t);
  const manifest = join(state, "race-swarm.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      gates: false,
      lanes: [
        { name: "one", task: "RACE-SWARM-ONE" },
        { name: "two", task: "RACE-SWARM-TWO" },
      ],
    }),
  );
  const opts = { state, driver: "swarmRaceDriver", env: { FAKE_DELAY: "500", TANDEM_CWD: "" } };
  const starts = await Promise.all([
    peerAsync(["swarm", "start", "same-name", manifest], opts),
    peerAsync(["swarm", "start", "same-name", manifest], opts),
  ]);
  assert.equal(starts.filter((result) => result.code === 0).length, 1);
  const rejected = starts.find((result) => result.code !== 0);
  assert.equal(rejected?.code, 2);
  assert.match(rejected?.out || "", /swarm "same-name" already exists/i);

  const waited = peer(["swarm", "wait", "same-name", "8"], opts);
  assert.equal(waited.code, 0);
  assert.match(waited.out, /done=2/);
});

test("swarm refuses to reuse a pre-existing lane state and preserves lane identity in long names", (t) => {
  const state = freshState(t);
  const longName = "long-swarm-name-that-would-otherwise-truncate-away-every-lane-suffix";
  const manifest = join(state, "long-swarm.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      gates: false,
      lanes: [
        { name: "alpha", task: "LONG-ALPHA" },
        { name: "beta", task: "LONG-BETA" },
      ],
    }),
  );
  const opts = { state, driver: "longSwarmDriver", env: { TANDEM_CWD: "" } };
  const started = peer(["swarm", "start", longName, manifest], opts);
  assert.equal(started.code, 0);
  assert.equal(peer(["swarm", "wait", longName, "8"], opts).code, 0);

  const file = readdirSync(join(state, "swarms")).find((name) => name.endsWith(".json"));
  const record = JSON.parse(readFileSync(join(state, "swarms", file), "utf8"));
  assert.equal(new Set(record.lanes.map((lane) => lane.label)).size, 2);
  assert.ok(record.lanes.every((lane) => lane.label.length <= 60));

  const collisionManifest = join(state, "collision-swarm.json");
  writeFileSync(collisionManifest, JSON.stringify({ gates: false, lanes: [{ name: "lane", task: "MUST-NOT-DISPATCH" }] }));
  const occupied = join(state, "lanes", "occupied--lane");
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, "groups.json"), JSON.stringify({ stale: true }));
  const collision = peer(["swarm", "start", "occupied", collisionManifest], opts);
  assert.equal(collision.code, 2);
  assert.match(collision.out, /lane state already exists/i);
  const failed = JSON.parse(readFileSync(join(state, "swarms", "occupied.json"), "utf8"));
  assert.equal(failed.setupStatus, "error");
  assert.ok(!existsSync(join(occupied, `job-${jobKey("longSwarmDriver")}.json`)));
});

test("editing swarm provisions a distinct git worktree and branch per lane", (t) => {
  const state = freshState(t);
  const repo = join(state, "repo");
  mkdirSync(repo, { recursive: true });
  runGit(["init"], repo);
  runGit(["config", "user.email", "tandem-test@example.invalid"], repo);
  runGit(["config", "user.name", "Tandem Test"], repo);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  runGit(["add", "seed.txt"], repo);
  runGit(["commit", "-m", "seed"], repo);

  const manifest = join(state, "editing-swarm.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      gates: false,
      lanes: [
        { name: "editor-a", task: "EDIT-SWARM-A", worktree: true },
        { name: "editor-b", task: "EDIT-SWARM-B", worktree: true },
      ],
    }),
  );
  const opts = { state, driver: "editingSwarmDriver", env: { TANDEM_CWD: repo } };
  const started = peer(["swarm", "start", "edit-swarm", manifest], opts);
  assert.equal(started.code, 0);
  assert.equal(peer(["swarm", "wait", "edit-swarm", "10"], opts).code, 0);

  const record = JSON.parse(readFileSync(join(state, "swarms", "edit-swarm.json"), "utf8"));
  assert.equal(record.lanes.length, 2);
  assert.notEqual(resolve(record.lanes[0].cwd), resolve(record.lanes[1].cwd));
  assert.notEqual(record.lanes[0].worktree?.branch, record.lanes[1].worktree?.branch);
  for (const lane of record.lanes) {
    assert.ok(existsSync(join(lane.cwd, ".git")), `${lane.name} has a linked worktree`);
    assert.equal(runGit(["branch", "--show-current"], lane.cwd), `tandem/${lane.label}`);
  }

  const results = peer(["swarm", "results", "edit-swarm"], opts);
  assert.match(results.out, /EDIT-SWARM-A/);
  assert.match(results.out, /EDIT-SWARM-B/);
  for (const lane of record.lanes) {
    const normalizedOutput = results.out.replaceAll("/", "\\").toLowerCase();
    assert.ok(normalizedOutput.includes(resolve(lane.cwd).toLowerCase()), `${lane.name} ran in its own cwd`);
  }
});

test("human attach resumes the exact lane session and head continue reuses it", (t) => {
  const state = freshState(t);
  const first = peer(["ask", "ATTACH-ESTABLISH"], { state, driver: "attachDriver" });
  const sid = sidOf(first.out);
  assert.ok(sid);

  const command = peer(["attach", "--command"], { state, driver: "attachDriver" });
  assert.equal(command.code, 0);
  assert.match(command.out, new RegExp(sid));
  assert.match(command.out, /command argv:/);

  const attached = peer(["attach", "--force"], { state, driver: "attachDriver" });
  assert.equal(attached.code, 0);
  assert.match(attached.out, /mode=resume/);
  assert.equal(sidOf(attached.out), sid);

  const continued = peer(["continue", "ATTACH-CONTINUE"], { state, driver: "attachDriver" });
  assert.equal(continued.code, 0);
  assert.match(continued.out, /mode=resume/);
  assert.equal(sidOf(continued.out), sid);
  assert.match(continued.out, /ATTACH-CONTINUE/);
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
  try {
    await waitForRunningJob(s, "lockedLane");
    const backgroundRefused = peer(["ask", "--bg", "LOCK-BG-REFUSED"], opts);
    assert.equal(backgroundRefused.code, 3);
    assert.match(backgroundRefused.out, /existing job is running/i);
  } finally {
    await foreground;
  }
  assert.match(readLast(s, "lockedLane"), /LOCK-FOREGROUND-HOLDER/);
  assert.doesNotMatch(readLast(s, "lockedLane"), /LOCK-BG-REFUSED/);
});

test("session identity mutations are refused while a live turn owns the lane", (t) => {
  const s = freshState(t);
  const opts = { state: s, driver: "lifecycleLocked", env: { FAKE_DELAY: "1200" } };
  assert.equal(peer(["ask", "--bg", "LIFECYCLE-LIVE-TURN"], opts).code, 0);

  for (const command of [["new"], ["resume"], ["label", "must-not-move"]]) {
    const result = peer(command, opts);
    assert.equal(result.code, 3, `${command[0]} is refused`);
    assert.match(result.out, /refused while lane is running/i);
  }
  assert.ok(!existsSync(join(s, "detached.json")));
  assert.equal(peer(["wait", "8"], opts).code, 0);
  assert.equal(peer(["new"], opts).code, 0);
});

test("`stop` cancels an active Claude turn without leaving a wedged lease", (t) => {
  const s = freshState(t);
  const opts = {
    state: s,
    driver: "claudeStop",
    partner: "claude",
    env: { FAKE_DELAY: "10000", FAKE_DELAY_MATCH: "CLAUDE-STOP-LIVE" },
  };
  assert.equal(peer(["ask", "CLAUDE-PREVIOUS-RESULT"], opts).code, 0);
  assert.match(readLast(s, "claudeStop"), /CLAUDE-PREVIOUS-RESULT/);
  assert.equal(peer(["ask", "--bg", "CLAUDE-STOP-LIVE"], opts).code, 0);
  const stopped = peer(["stop"], opts);
  assert.equal(stopped.code, 0);
  assert.match(stopped.out, /active turn cancelled/i);

  const status = peer(["status"], opts);
  assert.match(status.out, /job: error/i);
  assert.match(status.out, /cancelled by the driver/i);
  assert.doesNotMatch(status.out, /WEDGED/);
  const result = peer(["result"], opts);
  assert.equal(result.code, 1);
  assert.match(result.out, /cancelled by the driver/i);
  assert.doesNotMatch(result.out, /CLAUDE-PREVIOUS-RESULT/);
  assert.equal(peer(["wait", "1"], opts).code, 1);
});

test("`wait` fails immediately when a lane has no job", (t) => {
  const s = freshState(t);
  const waited = peer(["wait", "30"], { state: s, driver: "emptyWait" });
  assert.equal(waited.code, 2);
  assert.match(waited.out, /no job exists for this lane/i);
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

test("mismatched finished job and stale lease become WEDGED and can be reaped", (t) => {
  const s = freshState(t);
  const driver = "mismatchedLease";
  const sk = jobKey(driver);
  writeFileSync(
    join(s, `job-${sk}.json`),
    JSON.stringify({
      status: "done",
      dispatchId: "finished-dispatch",
      partner: "codex",
      verdict: "old result",
      ts: Date.now() - 1000,
    }),
  );
  writeFileSync(
    join(s, `dispatch-${sk}.lock`),
    JSON.stringify({
      dispatchId: "stale-dispatch",
      ownerPid: 2147483647,
      partner: "codex",
      startedTs: Date.now() - 1000,
    }),
  );
  writeFileSync(
    join(s, `heartbeat-${sk}.json`),
    JSON.stringify({ dispatchId: "stale-dispatch", pid: 2147483647, ts: Date.now() - 1000 }),
  );

  const opts = { state: s, driver };
  const status = peer(["status"], opts);
  assert.match(status.out, /job: WEDGED/);
  assert.match(status.out, /finished job\/lease dispatch IDs disagree/i);

  const reaped = peer(["reap"], opts);
  assert.equal(reaped.code, 0);
  assert.ok(!existsSync(join(s, `dispatch-${sk}.lock`)));
  assert.ok(!existsSync(join(s, `heartbeat-${sk}.json`)));
  const replacement = peer(["ask", "MISMATCH-RECOVERED"], opts);
  assert.equal(replacement.code, 0);
  assert.match(replacement.out, /MISMATCH-RECOVERED/);
});

test("streaming fake partner remains alive past the former 2400-second elapsed cap", (t) => {
  const s = freshState(t);
  const sid = "11111111-2222-4333-8444-555555555555";
  assert.equal(
    supervisionDecision({
      now: 2_401_000,
      startedAt: 0,
      lastActivityAt: 2_400_950,
      stallSec: 240,
      maxSec: 0,
    }),
    null,
    "recent activity must keep a turn alive after 2400 total seconds",
  );
  assert.equal(
    supervisionDecision({
      now: 2_401_000,
      startedAt: 0,
      lastActivityAt: 2_400_950,
      stallSec: 240,
      maxSec: 2400,
    })?.kind,
    "absolute",
    "an explicitly configured absolute backstop still wins",
  );
  const started = Date.now();
  const turn = peer(["ask", "STREAMING-LONG-TURN"], {
    state: s,
    driver: "streamingLane",
    env: {
      FAKE_SID: sid,
      FAKE_STREAM_INTERVAL_MS: "40",
      FAKE_STREAM_COUNT: "8",
      TANDEM_STALL_SEC: "0.12",
      TANDEM_MAX_TURN_SEC: "0",
    },
  });

  assert.equal(turn.code, 0);
  assert.ok(Date.now() - started >= 250, "the turn should outlive multiple configured stall windows");
  assert.match(turn.out, /STREAMING-LONG-TURN/);
  assert.doesNotMatch(turn.out, /STALLED|WEDGED|KILLED/i);
  assert.match(peer(["status"], { state: s, driver: "streamingLane" }).out, /job: done/i);
});

test("a silent partner is gracefully stopped and reported as STALLED/WEDGED", (t) => {
  const s = freshState(t);
  const sid = "22222222-3333-4444-8555-666666666666";
  const turn = peer(["ask", "STALL-THIS-TURN"], {
    state: s,
    driver: "stalledLane",
    env: {
      FAKE_SID: sid,
      FAKE_HANG_AFTER_SESSION: "1",
      TANDEM_STALL_SEC: "0.15",
      TANDEM_MAX_TURN_SEC: "1.5",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });

  assert.equal(turn.code, 1);
  assert.match(turn.out, /STALLED\/WEDGED/i);
  assert.match(turn.out, /no partner activity/i);
  const status = peer(["status"], { state: s, driver: "stalledLane" });
  assert.match(status.out, /job: error/i);
  assert.match(status.out, /STALLED\/WEDGED/i);
});

test("continuation after a stall resumes the durably persisted session", (t) => {
  const s = freshState(t);
  const driver = "warmAfterStall";
  const sid = "33333333-4444-4555-8666-777777777777";
  const first = peer(["ask", "STALL-BUT-KEEP-CONTEXT"], {
    state: s,
    driver,
    env: {
      FAKE_SID: sid,
      FAKE_HANG_AFTER_SESSION: "1",
      TANDEM_STALL_SEC: "0.15",
      TANDEM_MAX_TURN_SEC: "1.5",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });
  assert.equal(first.code, 1);
  assert.equal(readFileSync(join(s, "peer.session"), "utf8").trim(), sid);

  const continued = peer(["continue", "WARM-CONTINUATION"], {
    state: s,
    driver,
    env: {
      TANDEM_STALL_SEC: "1",
      TANDEM_MAX_TURN_SEC: "0",
    },
  });
  assert.equal(continued.code, 0);
  assert.match(continued.out, new RegExp(`sid=${sid}`));
  assert.match(continued.out, /mode=resume/);
  assert.match(continued.out, /WARM-CONTINUATION/);
});

test("Claude daemon stall recovery reopens the same persisted session", async (t) => {
  const s = freshState(t);
  const driver = "claudeWarmAfterStall";
  const sid = "44444444-5555-4666-8777-888888888888";
  // T4 protocol grace: a stalled claude turn now CHECKPOINTS (stream-json interrupt) instead of
  // tree-killing the daemon — the persistent daemon+session SURVIVE and the next ask reuses them
  // warm (no respawn). FAKE_HANG_MATCH pins the hang to THIS stall turn only, so the warm
  // continuation below is answered by the same surviving fake instead of hanging a second time.
  const started = peer(["ask", "--bg", "CLAUDE-STALL-BUT-KEEP-CONTEXT"], {
    state: s,
    driver,
    partner: "claude",
    env: {
      FAKE_SID: sid,
      FAKE_HANG_AFTER_SESSION: "1",
      FAKE_HANG_MATCH: "CLAUDE-STALL-BUT-KEEP-CONTEXT",
      TANDEM_STALL_SEC: "0.15",
      TANDEM_MAX_TURN_SEC: "1.5",
      TANDEM_STOP_GRACE_SEC: "0.1",
    },
  });
  assert.equal(started.code, 0);

  let status = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(200);
    status = peer(["status"], { state: s, driver, partner: "claude" });
    if (/job: error/i.test(status.out)) break;
  }
  assert.match(status.out, /job: error/i);
  assert.match(status.out, /STALLED\/WEDGED/i);
  assert.equal(readFileSync(join(s, "claude.session"), "utf8").trim(), sid);

  const continued = peer(["continue", "CLAUDE-WARM-CONTINUATION"], {
    state: s,
    driver,
    partner: "claude",
    env: {
      TANDEM_STALL_SEC: "1",
      TANDEM_MAX_TURN_SEC: "0",
    },
  });
  assert.equal(continued.code, 0);
  assert.match(continued.out, new RegExp(`sid=${sid}`));
  assert.match(continued.out, /CLAUDE-WARM-CONTINUATION/);
});

test("zero absolute cap plus zero stall window leaves long turns unsupervised", (t) => {
  const s = freshState(t);
  const started = Date.now();
  const turn = peer(["ask", "UNLIMITED-TURN"], {
    state: s,
    driver: "unlimitedLane",
    env: {
      FAKE_DELAY: "350",
      TANDEM_STALL_SEC: "0",
      TANDEM_MAX_TURN_SEC: "0",
    },
  });

  assert.equal(turn.code, 0);
  assert.ok(Date.now() - started >= 300);
  assert.match(turn.out, /UNLIMITED-TURN/);
});
