// Regression tests for the tandem bridge. Every bug we hit in the field gets a test here so it
// can't come back. Fully isolated: a temp .state per test (TANDEM_STATE) + a fake codex partner
// (TANDEM_CODEX_BIN) — no real sessions, no API, no cost, never touches your live .state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobKey, readGroups, recordGroup, readDetached, markDetached } from "../bin/groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PEER = join(ROOT, "bin", "peer.mjs");
const FAKE = join(HERE, "fake-codex.mjs");

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

// Run a peer.mjs command for a driver, in an isolated state dir, against the fake codex.
function peer(args, { state, driver, env = {} } = {}) {
  const clean = { ...process.env };
  for (const k of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CONVERSATION_ID"]) delete clean[k];
  const r = spawnSync(process.execPath, [PEER, ...args], {
    encoding: "utf8",
    env: {
      ...clean,
      TANDEM_STATE: state,
      TANDEM_CODEX_BIN: FAKE,
      TANDEM_PARTNER: "codex",
      CLAUDE_CODE_SESSION_ID: driver,
      ...env,
    },
  });
  return { stdout: r.stdout || "", out: (r.stdout || "") + (r.stderr || ""), code: r.status };
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
