import test from "node:test";
import assert from "node:assert/strict";
// D7 (live wave-0 finding): a sealed brief that CONTRADICTS ITSELF passed all of R1–R6 — the
// junior lane caught it, the gate did not. R7 catches the specific, mechanical class: a brief
// that forbids reading other files AND elsewhere instructs the lane to read one.
import { lintBrief as lintBriefR7, RULES as RULES_R7 } from "../bin/brief-lint.mjs";
import test0 from "node:test";
import assert0 from "node:assert/strict";

const SEALED_OK = `## FROZEN CONTRACT
Build one module.
DELIVERABLE: bin/x.mjs
VERIFY: node --test test/x.test.mjs
Do NOT open, read, or modify any other file. Everything you need is in this brief.
Report AMBIGUITIES: every judgment call this contract did not decide.
${"filler ".repeat(80)}`;

test0("R7 exists in the rule table", () => {
  assert0.ok(RULES_R7.some((r) => r.id === "R7-self-contradiction"));
});

test0("R7: a brief that forbids other-file reads AND tells the lane to read one is a violation", () => {
  const contradictory = `${SEALED_OK}
You may read crates/xen-be-wasm/src/accept_alu.rs to see the assertions you must satisfy.`;
  const { ok, violations } = lintBriefR7(contradictory);
  assert0.equal(ok, false);
  assert0.ok(violations.some((v) => v.rule === "R7-self-contradiction"), JSON.stringify(violations));
});

test0("R7: a consistent sealed brief does NOT trip it (no false positives on the good shape)", () => {
  assert0.equal(lintBriefR7(SEALED_OK).ok, true, JSON.stringify(lintBriefR7(SEALED_OK).violations));
});

test0("R7: a brief with NO no-read clause may reference files freely", () => {
  const open = `## FROZEN CONTRACT
DELIVERABLE: bin/y.mjs
VERIFY: node --test test/y.test.mjs
Read docs/spec.md for the wire format. Report AMBIGUITIES you hit.
${"filler ".repeat(80)}`;
  assert0.equal(lintBriefR7(open).ok, true);
});

import { lintBrief } from "../bin/brief-lint.mjs";

const sample = `# Sealed Brief

## FROZEN CONTRACT
Implement the requested module exactly as specified, preserving the frozen contract and
reporting every ambiguity that remains undecided by the brief.

DELIVERABLE: bin/x.mjs
VERIFY: node --test t.mjs

The brief is intentionally self-contained and gives exact behavior, interfaces, error
handling, and output requirements. Do not infer additional features or alter unrelated
behavior. Before reporting completion, run the verification command and report its result.
Keep implementation practical, deterministic, and compatible with the stated runtime.
`;

test("accepts a known-good sealed brief", () => {
  assert.ok(sample.length > 400);
  assert.deepEqual(lintBrief(sample), { ok: true, violations: [] });
});

test("R1 fails when the contract block is removed", () => {
  const brief = sample.replaceAll(/frozen contract/gi, "implementation agreement");
  assert.equal(lintBrief(brief).violations[0].rule, "R1-contract");
});

test("R2 fails when the deliverable is missing", () => {
  const brief = sample.replace("DELIVERABLE: bin/x.mjs", "OUTPUT: x");
  assert.ok(lintBrief(brief).violations.some(({ rule }) => rule === "R2-deliverable"));
});

test("R2 rejects a bare deliverable word", () => {
  const brief = sample.replace("DELIVERABLE: bin/x.mjs", "DELIVERABLE: yes");
  assert.ok(lintBrief(brief).violations.some(({ rule }) => rule === "R2-deliverable"));
});

test("R3 fails when verification is missing", () => {
  const brief = sample.replace("VERIFY: node --test t.mjs", "CHECK: later");
  assert.ok(lintBrief(brief).violations.some(({ rule }) => rule === "R3-verify"));
});

test("R4 fails when ambiguity reporting is removed", () => {
  const brief = sample.replace("reporting every ambiguity", "handling every decision");
  assert.ok(lintBrief(brief).violations.some(({ rule }) => rule === "R4-ambiguity"));
});

test("R5 catches explore the repository", () => {
  const brief = sample + "\nDo not explore the repository before implementation.";
  assert.ok(lintBrief(brief).violations.some(({ rule }) => rule === "R5-no-explore"));
});

test("R5 catches read the codebase", () => {
  const brief = sample + "\nDo not read the codebase before implementation.";
  assert.ok(lintBrief(brief).violations.some(({ rule }) => rule === "R5-no-explore"));
});

test("R5 does not fire on research alone", () => {
  assert.ok(!lintBrief(sample + "\nResearch is not required.").violations.some(({ rule }) => rule === "R5-no-explore"));
});

test("R5 does not fire on grep without a repo word nearby", () => {
  assert.ok(!lintBrief(sample + "\nThe word grep may appear in an unrelated example.").violations.some(({ rule }) => rule === "R5-no-explore"));
});

test("R6 fails for short text", () => {
  const result = lintBrief(`## FROZEN CONTRACT
DELIVERABLE: x.mjs
VERIFY: node --test t.mjs
Ambiguities must be reported.`);
  assert.ok(result.violations.some(({ rule }) => rule === "R6-size"));
  assert.equal(result.violations.find(({ rule }) => rule === "R6-size").detail, "too short (<400 chars)");
});

test("R6 fails for text longer than the maximum", () => {
  const result = lintBrief(sample + "x".repeat(32769));
  assert.ok(result.violations.some(({ rule }) => rule === "R6-size"));
  assert.equal(result.violations.find(({ rule }) => rule === "R6-size").detail, "too long");
});

test("non-string input is treated as empty text", () => {
  const result = lintBrief(null);
  assert.equal(result.ok, false);
  assert.equal(result.violations.at(-1).rule, "R6-size");
});
