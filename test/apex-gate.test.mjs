// The apex context gate — rebuilt after an adversarial review found the first design hardening
// the wrong layer entirely.
//
// What actually happened on the live campaign: an apex reached 790k against a 300k backstop and
// never refreshed. Not negligence — `partnerEnv` scrubs TANDEM_STATE/TANDEM_LABEL from the apex's
// own environment and the CLI re-sets CLAUDE_CODE_SESSION_ID in its children, so `fleet context`
// from inside the session resolved to a directory that does not exist, `liveContext` returned 0,
// and `fleet refresh` was a silent no-op. The verb could not work.
//
// So: identity is a RECORDED property (stamped at spawn), the meter lives where the stream is
// (serve), and at the hard limit the engine INJECTS a fixed dump turn rather than refusing —
// because a refusal stalls an autonomous campaign at 3am into a log nobody reads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DUMP_PROMPT, apexGateDecision, meterNotice, readBoundIdentity, recordBoundIdentity } from "../bin/apex-gate.mjs";

const fresh = (p) => mkdtempSync(join(tmpdir(), p));

// ---- identity is RECORDED, never re-derived from ambient env --------------------------------

test("identity is stamped at spawn and read back verbatim", () => {
  const dir = fresh("gate-id-");
  const file = join(dir, "serve.bound.json");
  writeFileSync(file, JSON.stringify({ pid: 1, model: "opus" }));
  recordBoundIdentity(file, { stateDir: "/lanes/astro-apex", fleetDir: "/harness/.campaign/fleet", label: "astro-apex", role: "apex" });
  const id = readBoundIdentity(file);
  assert.equal(id.role, "apex");
  assert.equal(id.label, "astro-apex");
  assert.equal(id.fleetDir, "/harness/.campaign/fleet");
  assert.equal(id.stateDir, "/lanes/astro-apex");
  // it must not clobber what the daemon already recorded
  assert.equal(JSON.parse(readFileSync(file, "utf8")).model, "opus");
});

test("identity read from a missing or corrupt file is empty, never a throw", () => {
  assert.deepEqual(readBoundIdentity(join(tmpdir(), "nope-999.json")), {});
  const dir = fresh("gate-corrupt-");
  const f = join(dir, "b.json");
  writeFileSync(f, "{not json");
  assert.deepEqual(readBoundIdentity(f), {});
});

// ---- the gate ---------------------------------------------------------------------------------

const HARD = 300_000;
const SOFT = 100_000;

test("a non-apex lane is never gated, whatever its context", () => {
  const d = apexGateDecision({ role: "junior", context: 900_000, threshold: SOFT, hard: HARD });
  assert.equal(d.allow, true);
  assert.equal(d.injectDump, false);
  assert.equal(d.notice, "");
});

test("under the soft threshold: allowed, silent", () => {
  const d = apexGateDecision({ role: "apex", context: 40_000, threshold: SOFT, hard: HARD });
  assert.equal(d.allow, true);
  assert.equal(d.notice, "");
});

test("between soft and hard: allowed, but the turn carries an IN-BAND meter notice", () => {
  // console warnings are worthless — the only 3am dispatcher pipes output to /dev/null
  const d = apexGateDecision({ role: "apex", context: 150_000, threshold: SOFT, hard: HARD });
  assert.equal(d.allow, true);
  assert.equal(d.injectDump, false);
  assert.match(d.notice, /150000/);
  assert.match(d.notice, /fleet refresh/);
});

test("at the hard limit: the engine INJECTS a fixed dump turn instead of refusing", () => {
  const d = apexGateDecision({ role: "apex", context: 800_000, threshold: SOFT, hard: HARD });
  assert.equal(d.injectDump, true);
  assert.equal(d.allow, false, "the requested task does not run — the dump replaces it");
  assert.equal(d.prompt, DUMP_PROMPT);
  assert.match(d.reason, /hard limit|backstop/i);
});

test("the dump injects ONCE per cycle — it can never become a loop", () => {
  const after = apexGateDecision({ role: "apex", context: 800_000, threshold: SOFT, hard: HARD, dumpedThisCycle: true });
  assert.equal(after.injectDump, false);
  assert.equal(after.allow, true, "after the dump has run, work proceeds so the refresh can follow");
  assert.match(after.notice, /refresh/i);
});

test("the dump prompt is FIXED TEXT and asks only for externalization — never for judgment", () => {
  assert.equal(typeof DUMP_PROMPT, "string");
  assert.ok(DUMP_PROMPT.length > 100);
  assert.match(DUMP_PROMPT, /fleet note|fleet current/);
  // engine-authored turns must not tell a mind what to CONCLUDE
  assert.doesNotMatch(DUMP_PROMPT, /decide whether|judge|is the work correct/i);
});

test("meterNotice states the number and what to do, in one line", () => {
  const n = meterNotice({ context: 220_000, threshold: SOFT, hard: HARD });
  assert.match(n, /220000/);
  assert.match(n, /300000/);
  assert.ok(n.split("\n").length <= 3);
});

test("a missing/zero context reading never gates — an unmeasured turn is not a violation", () => {
  const d = apexGateDecision({ role: "apex", context: 0, threshold: SOFT, hard: HARD });
  assert.equal(d.allow, true);
  assert.equal(d.injectDump, false);
  assert.equal(d.unmeasured, true, "and it says so, rather than silently certifying 'under the limit'");
});
