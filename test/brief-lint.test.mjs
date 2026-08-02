import test from "node:test";
import assert from "node:assert/strict";
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
