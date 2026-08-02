// Apex immortality: a mind that never compacts, only clears and reloads from disk.
//
// Compaction is generation loss — each cycle summarizes a context that already contains a
// summary, so by the tenth hop the apex reasons from a copy of a copy. A clear-and-reload is
// always exactly ONE hop from source, so fidelity is constant no matter how long the apex lives.
// That only holds if memory is on disk FIRST: without the ledger a clear is destructive, with it
// a clear is a refresh.
//
// This spec was rewritten after an adversarial deep-tier review found three defects severe
// enough to ship bugs. Each is pinned by a test below and named where it bites.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRehydrationBrief,
  contextSizeFromUsage,
  liveContext,
  noteDecision,
  noteDistrust,
  noteHypothesis,
  noteSurprise,
  readOpen,
  refreshDecision,
  setCurrent,
  verifyBrief,
} from "../bin/apex-memory.mjs";

const fresh = (p) => mkdtempSync(join(tmpdir(), p));

// ---- the meter -----------------------------------------------------------------------------
// MEASURED 2026-08-02 on the real wave-1 apex log: the LAST assistant record's message.usage
// computed to 491,739 (the true context) while the `result` record's usage computed to
// 53,152,747 — the turn AGGREGATE summed across 310 API calls. Reading the result record as
// context is precisely defect F7, and it would trip a 100k threshold ~500x too early, turning
// the refresh loop into amnesia-thrash. The result record is SPEND accounting, never context.

test("contextSizeFromUsage: context is a single call's prompt; output tokens are not context", () => {
  const u = { input_tokens: 1200, cache_read_input_tokens: 98_000, cache_creation_input_tokens: 700, output_tokens: 4000 };
  assert.equal(contextSizeFromUsage(u), 99_900);
  assert.equal(contextSizeFromUsage({}), 0);
  assert.equal(contextSizeFromUsage(null), 0);
});

test("liveContext: reads the last ASSISTANT call, and IGNORES the result aggregate", () => {
  const dir = fresh("apex-meter-");
  const f = join(dir, "turn.jsonl");
  writeFileSync(
    f,
    [
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 20_000 } } }),
      "garbage line that must not throw",
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 2, cache_read_input_tokens: 491_352, cache_creation_input_tokens: 385 } } }),
      // the real shape: the turn aggregate lands AFTER the last assistant record and is ~100x larger
      JSON.stringify({ type: "result", usage: { input_tokens: 332, cache_read_input_tokens: 52_681_182, cache_creation_input_tokens: 471_233 } }),
    ].join("\n"),
  );
  assert.equal(liveContext(f), 491_739, "the last ASSISTANT call is the context — the result record is spend, not context");
  assert.equal(liveContext(join(dir, "missing.jsonl")), 0);
});

// ---- the refresh decision ------------------------------------------------------------------
// Thresholds follow CONTEXT-THESIS §1.3 (exact-state coding — the closest analogue to apex work
// — is under 50% for most models by 36-60k). The prior draft cited that doc and then set numbers
// 3x above its own "serious" band; these defaults are what the cited evidence actually supports.

test("refreshDecision: below the quality threshold, keep working", () => {
  const d = refreshDecision({ context: 60_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: false });
  assert.equal(d.refresh, false);
});

test("refreshDecision: past the threshold at a CLEAN SEAM, refresh (no dump needed — a seam IS the dump)", () => {
  const d = refreshDecision({ context: 120_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: false });
  assert.equal(d.refresh, true);
  assert.equal(d.requiresDump, false);
  assert.match(d.reason, /threshold/i);
});

test("refreshDecision: never mid-sweep below the backstop — defer to the next clean seam", () => {
  const d = refreshDecision({ context: 120_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: true });
  assert.equal(d.refresh, false);
  assert.equal(d.defer, true);
});

test("refreshDecision: the backstop is UNCONDITIONAL and demands a pre-clear dump", () => {
  // The backstop is the ONLY path that clears mid-sweep, which makes it the maximal-loss event,
  // not a safety net: in-flight hypotheses and calibrated distrust die with the session. It must
  // force a dump turn first — a degraded apex writing a degraded dump still beats zero.
  const d = refreshDecision({ context: 320_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: true });
  assert.equal(d.refresh, true);
  assert.equal(d.requiresDump, true, "mid-sweep clear must externalize in-flight state first");
  assert.match(d.reason, /backstop|hard/i);
});

test("refreshDecision: a frequently-firing backstop is reported as a mis-set trigger, not normal", () => {
  const d = refreshDecision({ context: 320_000, thresholdTokens: 100_000, hardTokens: 300_000, busy: true, backstopFires: 3 });
  assert.match(d.warning || "", /trigger/i);
});

// ---- the ledger ----------------------------------------------------------------------------

test("the ledger carries NEGATIVE knowledge, not just decisions — the class a mind forgets to write", () => {
  const dir = fresh("apex-ledger-");
  noteDecision(dir, { what: "ABI follows ARCH.md", why: "ARCH is the contract", alternatives_rejected: ["keep env.memory"], tier: "constitution" });
  noteHypothesis(dir, { statement: "cranelift disagrees with the golden", status: "confirmed", evidence: "brint f8f1 vs efb2", kill_criterion: "digests match" });
  noteHypothesis(dir, { statement: "the golden is stale", status: "ruled_out", evidence: "xen-wl reproduces it exactly" });
  noteDistrust(dir, { target: "fleet wake without --swarm", why: "returns hour-old events (F4)", evidence: "wave1 friction" });
  noteSurprise(dir, { what: "cranelift != golden", evidence: "digest mismatch" });
  const open = readOpen(dir);
  assert.equal(open.decisions.length, 1);
  assert.equal(open.hypotheses.length, 2);
  assert.equal(open.hypotheses.find((h) => h.status === "ruled_out").statement, "the golden is stale");
  assert.equal(open.distrust.length, 1);
  assert.equal(open.surprises.length, 1);
  assert.equal(open.decisions[0].alternatives_rejected.length, 1, "a decision without its rejected alternatives invites relitigating it");
});

test("readOpen: a torn trailing append is skipped, never thrown on", () => {
  const dir = fresh("apex-torn-");
  noteDecision(dir, { what: "first", why: "x" });
  writeFileSync(join(dir, "decisions.jsonl"), `${readFileSync(join(dir, "decisions.jsonl"), "utf8")}{"what":"tor`);
  const open = readOpen(dir);
  assert.equal(open.decisions.length, 1);
});

test("setCurrent: machine-derived fields are NOT accepted from the mind (drift must not be relocated)", () => {
  // "machine-owned CURRENT.md" means PROVENANCE, not file format. A mind asserting its own
  // verified[] is the drift channel with a JSON schema around it.
  const dir = fresh("apex-current-");
  const rec = setCurrent(dir, {
    goal: "execution proof",
    next: "compose",
    verified: [{ test_filter: "accept_alu::", exit_code: 0, green_count: 12, commit: "a54e1be" }],
    suspicions: ["the reference may be wrong"],
  });
  assert.equal(rec.verified.length, 1, "verified entries carrying machine evidence are kept");
  const bad = setCurrent(dir, { goal: "g", next: "n", verified: ["conv", "div"] });
  assert.equal(bad.verified.length, 0, "a bare asserted claim with no evidence is REFUSED");
  assert.ok(Array.isArray(bad.rejected) && bad.rejected.length === 2, "and the refusal is recorded, not silent");
});

test("setCurrent: state is REPLACED wholesale and written atomically (no torn read)", () => {
  const dir = fresh("apex-replace-");
  setCurrent(dir, { goal: "execution proof", next: "compose" });
  setCurrent(dir, { goal: "vmx breadth", next: "recon" });
  const text = readFileSync(join(dir, "CURRENT.md"), "utf8");
  assert.match(text, /vmx breadth/);
  assert.doesNotMatch(text, /execution proof/, "stale state is a drift source");
  assert.doesNotMatch(text, /\.tmp/);
});

// ---- rehydration ---------------------------------------------------------------------------

test("buildRehydrationBrief: derived from FILES at build time — idempotent, never a stored seed", () => {
  // A stored seed is consumed once and lost if the first turn fails (serve.mjs already has that
  // bug shape). The brief must be recomputable from the ledger at every ask, forever.
  const dir = fresh("apex-rehydrate-");
  setCurrent(dir, { goal: "execution proof", next: "compose" });
  noteDecision(dir, { what: "ABI follows ARCH.md", why: "ARCH is the contract" });
  const a = buildRehydrationBrief(dir, { maxTokens: 20_000 });
  const b = buildRehydrationBrief(dir, { maxTokens: 20_000 });
  assert.equal(a, b, "recomputable and identical — nothing is consumed");
  assert.match(a, /execution proof/);
  assert.match(a, /ABI follows ARCH\.md/);
});

test("buildRehydrationBrief: PINNED constitution survives a budget squeeze; unpinned oldest go first", () => {
  // The prior spec mandated dropping decision-0 first. In the real campaign decision zero was
  // "ABI follows ARCH.md" — the one decision a reborn apex must never lose. Age is the wrong
  // eviction key.
  const dir = fresh("apex-budget-");
  setCurrent(dir, { goal: "KEEP-THIS-GOAL", next: "KEEP-THIS-NEXT" });
  noteDecision(dir, { what: "CONSTITUTION-ABI", why: "ARCH is the contract", tier: "constitution" });
  for (let i = 0; i < 400; i++) noteDecision(dir, { what: `tactical-${i}`, why: "x".repeat(200), tier: "tactical" });
  const brief = buildRehydrationBrief(dir, { maxTokens: 2_000 });
  assert.match(brief, /KEEP-THIS-GOAL/, "current state is never sacrificed to budget");
  assert.match(brief, /CONSTITUTION-ABI/, "pinned decisions survive");
  assert.match(brief, /tactical-399/, "newest tactical detail survives");
  assert.doesNotMatch(brief, /tactical-0\b/, "oldest UNPINNED goes first");
});

test("buildRehydrationBrief: self-authenticating — carries head, counts, and an end sentinel", () => {
  const dir = fresh("apex-auth-");
  setCurrent(dir, { goal: "g", next: "n" });
  noteDecision(dir, { what: "d1", why: "y" });
  const brief = buildRehydrationBrief(dir, { maxTokens: 20_000, head: "abc1234" });
  assert.match(brief, /abc1234/, "the git head at build time");
  assert.match(brief, /decisions_included/);
  const v = verifyBrief(brief, { head: "abc1234" });
  assert.equal(v.ok, true);
  assert.equal(verifyBrief(brief.slice(0, brief.length - 40), { head: "abc1234" }).ok, false, "truncation is caught by the missing sentinel");
  assert.equal(verifyBrief(brief, { head: "deadbee" }).ok, false, "staleness is caught by the head mismatch");
});

test("buildRehydrationBrief: an empty ledger says so explicitly instead of looking like fresh state", () => {
  const dir = fresh("apex-empty-");
  const brief = buildRehydrationBrief(dir, { maxTokens: 5_000 });
  assert.match(brief, /no prior campaign state/i);
  assert.match(brief, /verify against git/i);
});
