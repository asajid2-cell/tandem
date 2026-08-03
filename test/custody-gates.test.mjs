// Everything the cold audit flagged that is mechanism rather than documentation.
//
// Its central finding (B): "the apex writes the manifest, and the engine verifies whatever
// command the manifest names" — so a lane can write tests INSIDE its own deliverable asserting
// its own wrong behavior, and prove-red certifies it. The fix that made the campaigns trustworthy
// (apex-owned acceptance filters) was DOCTRINE, and the system's own charter says doctrine-only
// control measurably failed in the predecessor. These gates make it mechanical.
import test from "node:test";
import assert from "node:assert/strict";
import { checkVerifyCustody } from "../bin/write-scope.mjs";
import { quotaVerdict } from "../bin/lane-ledger.mjs";
import { buildRehydrationBrief, noteDecision, setCurrent } from "../bin/apex-memory.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- (B) verifier custody -------------------------------------------------------------------

test("custody: a lane with NO apex-owned grader is refused — it would grade itself", () => {
  const v = checkVerifyCustody({ verify: "cargo test -p xen-be-wasm --lib", seeds: [], expectRed: "E0583", expectGreen: "12 passed" });
  assert.equal(v.ok, false);
  assert.match(v.detail, /grader|seeds/i);
});

test("custody: a verify command that never references the apex's grader is refused", () => {
  // wave 0's briefs literally said `cargo test -p xen-be-wasm --lib` — which runs the LANE's own
  // tests too, so a lane asserting its own wrong behavior passes
  const v = checkVerifyCustody({
    verify: "cargo test -p xen-be-wasm --lib",
    seeds: ["crates/xen-be-wasm/src/accept_alu.rs"],
    expectRed: "E0583",
    expectGreen: "12 passed",
  });
  assert.equal(v.ok, false);
  assert.match(v.detail, /accept_alu/);
});

test("custody: referencing the apex-owned grader passes", () => {
  const v = checkVerifyCustody({
    verify: "cargo test -p xen-be-wasm --lib accept_alu::",
    seeds: ["crates/xen-be-wasm/src/accept_alu.rs"],
    expectRed: "E0583",
    expectGreen: "12 passed",
  });
  assert.equal(v.ok, true);
});

test("custody: missing expectRed/expectGreen is refused — exit codes alone are not proof", () => {
  const base = { verify: "cargo test --lib accept_alu::", seeds: ["src/accept_alu.rs"] };
  assert.equal(checkVerifyCustody({ ...base, expectGreen: "12 passed" }).ok, false);
  assert.equal(checkVerifyCustody({ ...base, expectRed: "E0583" }).ok, false);
  assert.equal(checkVerifyCustody({ ...base, expectRed: "E0583", expectGreen: "12 passed" }).ok, true);
});

// ---- (C) the quota ceiling FLEET-DESIGN promised and never implemented ----------------------

test("quotaVerdict: under the ceiling, dispatch proceeds", () => {
  const q = quotaVerdict({ usedPercent: 40, ceilingPercent: 80 });
  assert.equal(q.halt, false);
  assert.equal(q.warn, false);
});

test("quotaVerdict: warns before it halts, so a halt is never a surprise", () => {
  const q = quotaVerdict({ usedPercent: 68, ceilingPercent: 80, softRatio: 0.8 });
  assert.equal(q.halt, false);
  assert.equal(q.warn, true);
});

test("quotaVerdict: at or past the ceiling, dispatch HALTS and says what to do", () => {
  const q = quotaVerdict({ usedPercent: 81, ceilingPercent: 80 });
  assert.equal(q.halt, true);
  assert.match(q.detail, /ceiling/i);
});

test("quotaVerdict: an unreadable quota does NOT halt work — fail open, but say so", () => {
  const q = quotaVerdict({ usedPercent: null, ceilingPercent: 80 });
  assert.equal(q.halt, false);
  assert.equal(q.unknown, true);
});

test("quotaVerdict: ceiling 0 disables the gate entirely", () => {
  assert.equal(quotaVerdict({ usedPercent: 99, ceilingPercent: 0 }).halt, false);
});

// ---- ledger growth: the constitution block grows monotonically toward the brief budget -------

test("the brief bounds the CONSTITUTION block too, newest-first, and reports what it dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-grow-"));
  setCurrent(dir, { goal: "G", next: "N" });
  for (let i = 0; i < 300; i++) noteDecision(dir, { what: `const-${i}`, why: "y".repeat(150), tier: "constitution" });
  const brief = buildRehydrationBrief(dir, { maxTokens: 1_500 });
  assert.match(brief, /const-299/, "newest constitution survives");
  assert.doesNotMatch(brief, /const-0\b/, "an unbounded constitution block would eventually eat the whole budget");
  assert.match(brief, /constitution_dropped=\d+/, "and it says how much it dropped, rather than pretending it is complete");
  assert.ok(brief.length < 1_500 * 4 + 3_000);
});
