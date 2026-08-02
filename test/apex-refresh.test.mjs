// The refresh PRIMITIVE — the mechanism behind clear-and-reload.
//
// An adversarial review established that none of the existing commands is the primitive:
//   `stop`    is the ANTI-primitive — the session persists and the next ask RESUMES it warm,
//             reloading exactly the context the refresh exists to shed (serve.mjs:417-419).
//   `compact` has the right teardown but seeds from the dying session's own narration — the
//             generation-loss path being replaced.
//   `new`     is the right forget, but is gated by refuseLaneMutationWhileActive — and the hard
//             backstop fires precisely when lanes ARE active, so as coded the backstop cannot run.
//
// refresh = compact's teardown + a brief DERIVED at ask time from the ledger + a fresh session id,
// with seat succession so the fleet tree survives the rebirth.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPACT_MARKERS,
  detectCompactBoundary,
  planRefresh,
  seatHistory,
  succeedSeat,
} from "../bin/apex-refresh.mjs";
import { getSession, registerSession } from "../bin/fleet-registry.mjs";

const fresh = (p) => mkdtempSync(join(tmpdir(), p));

// ---- the plan: what a refresh must DO, and when it may bypass the lane guard ----------------

test("planRefresh: under threshold — no teardown, no bypass", () => {
  const p = planRefresh({ context: 40_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: false });
  assert.equal(p.act, false);
});

test("planRefresh: at a clean seam — full teardown, NO lane-guard bypass needed", () => {
  const p = planRefresh({ context: 150_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: false });
  assert.equal(p.act, true);
  assert.equal(p.bypassLaneGuard, false);
  assert.equal(p.dumpFirst, false);
  // the teardown is compact's, minus the seed: kill the daemon, forget the session id, detach
  assert.deepEqual(p.steps, ["dump-skip", "stop-daemon", "forget-session", "mark-detached", "succeed-seat", "rehydrate-on-next-ask"]);
});

test("planRefresh: mid-sweep under the backstop — defer, do nothing", () => {
  const p = planRefresh({ context: 150_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: true });
  assert.equal(p.act, false);
  assert.equal(p.defer, true);
});

test("planRefresh: the BACKSTOP bypasses the lane guard, but only after a dump turn", () => {
  // This is the case the existing plumbing refuses. The bypass is what makes the backstop able
  // to execute at all; the dump is what stops it being the maximal-loss event.
  const p = planRefresh({ context: 350_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: true });
  assert.equal(p.act, true);
  assert.equal(p.bypassLaneGuard, true, "the backstop must be able to run while lanes are live");
  assert.equal(p.dumpFirst, true, "in-flight hypotheses must be externalized before the clear");
  assert.equal(p.steps[0], "dump");
  assert.ok(p.steps.includes("succeed-seat"));
});

test("planRefresh: never seeds — the brief is derived on the next ask, never stored", () => {
  const p = planRefresh({ context: 350_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: true });
  assert.ok(!p.steps.includes("write-seed"), "a stored seed is consumed once and lost if the first turn fails");
  assert.equal(p.steps.at(-1), "rehydrate-on-next-ask");
});

// ---- seat succession: the seat is an identity, the session id is a body ---------------------

test("succeedSeat: the seat keeps ONE registry node across rebirths, recording its predecessors", () => {
  const dir = fresh("seat-");
  registerSession(dir, { id: "apex-w2", kind: "apex", label: "apex" });
  succeedSeat(dir, "apex-w2", "session-A");
  succeedSeat(dir, "apex-w2", "session-B");
  const rec = getSession(dir, "apex-w2");
  assert.equal(rec.id, "apex-w2", "the SEAT id never changes — fleet tree stays intact");
  const hist = seatHistory(dir, "apex-w2");
  assert.deepEqual(hist.sessions, ["session-A", "session-B"]);
  assert.equal(hist.current, "session-B");
  assert.equal(hist.rebirths, 1, "two bodies, one rebirth");
});

test("succeedSeat: idempotent — re-recording the same body is not a rebirth", () => {
  const dir = fresh("seat-idem-");
  registerSession(dir, { id: "apex", kind: "apex" });
  succeedSeat(dir, "apex", "session-A");
  succeedSeat(dir, "apex", "session-A");
  assert.equal(seatHistory(dir, "apex").sessions.length, 1);
});

test("succeedSeat: never throws on an unknown seat or an unwritable registry", () => {
  const dir = fresh("seat-safe-");
  assert.doesNotThrow(() => succeedSeat(dir, "ghost-seat", "s1"));
  assert.doesNotThrow(() => succeedSeat("\0bad\0", "x", "s1"));
});

// ---- auto-compact: prevention is not enough, because its failure is INVISIBLE ---------------
// If the CLI's own auto-compact fires first, context DROPS — so the refresh trigger never fires
// and the session silently becomes a summary of a summary. The bridge must be able to see it.

test("detectCompactBoundary: finds a compaction event in a turn stream", () => {
  const stream = [
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 180_000 } } }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }),
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 20_000 } } }),
  ].join("\n");
  const d = detectCompactBoundary(stream);
  assert.equal(d.compacted, true);
  assert.match(d.evidence, /compact/i);
});

test("detectCompactBoundary: a clean stream reports nothing, and garbage lines do not throw", () => {
  const stream = [
    "not json at all",
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 20_000 } } }),
  ].join("\n");
  assert.equal(detectCompactBoundary(stream).compacted, false);
  assert.equal(detectCompactBoundary("").compacted, false);
  assert.equal(detectCompactBoundary(null).compacted, false);
});

test("detectCompactBoundary: a large unexplained context DROP is itself evidence", () => {
  // belt and braces: even without a marker, context falling off a cliff mid-session means
  // something compacted us
  const stream = [
    JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: 240_000 } } }),
    JSON.stringify({ type: "assistant", message: { usage: { cache_read_input_tokens: 18_000 } } }),
  ].join("\n");
  const d = detectCompactBoundary(stream);
  assert.equal(d.compacted, true);
  assert.match(d.evidence, /drop/i);
});

test("COMPACT_MARKERS is a documented, extensible contract", () => {
  assert.ok(Array.isArray(COMPACT_MARKERS) && COMPACT_MARKERS.length > 0);
});
