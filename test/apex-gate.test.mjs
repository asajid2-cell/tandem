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
import { DUMP_PROMPT, apexGateDecision, ledgerWrittenSince, meterNotice, readBoundIdentity, recordBoundIdentity, stallDecision } from "../bin/apex-gate.mjs";

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

// ---- THE BACKSTOP IS AN ACTUATOR, NOT A REQUEST ---------------------------------------------
//
// MEASURED FAILURE, and the reason this section exists. The gate's first version detected the
// limit correctly (it fired at 300,030) and injected the dump correctly (the apex complied and
// wrote a 4,290-byte CURRENT.md one minute later). Then it latched `dumpedThisCycle = true` and
// returned `allow: true` with a notice reading "refresh now" — delegating the recovery to the one
// mind whose judgment was impaired by the very condition being detected. It did not refresh.
// TWENTY-NINE further turns ran over the next 86 minutes, every one of them allowed, every one
// reporting "Nothing done. Same state.", until the owner killed the heartbeat by hand.
//
// A backstop that asks is not a backstop. Past the hard limit the gate now returns an ACTION the
// engine performs — and there is no dump state, reachable or not, in which it returns a plain
// permissive turn.

test("the dump injects ONCE — a second hard-limit turn is not another dump", () => {
  const after = apexGateDecision({ role: "apex", context: 800_000, threshold: SOFT, hard: HARD, dump: { attempts: 1, landed: true } });
  assert.equal(after.injectDump, false, "injecting again is how a gate becomes a loop");
});

test("after a landed dump the gate ORDERS a refresh — it never asks the mind to refresh itself", () => {
  const after = apexGateDecision({ role: "apex", context: 800_000, threshold: SOFT, hard: HARD, dump: { attempts: 1, landed: true } });
  assert.equal(after.action, "refresh", "the engine performs it; asking is what burned 29 turns");
  assert.equal(after.allow, false, "and no further work runs on the exhausted body");
});

test("a dump that did not land is retried rather than disarming the gate", () => {
  const retry = apexGateDecision({ role: "apex", context: 800_000, threshold: SOFT, hard: HARD, dump: { attempts: 1, landed: false } });
  assert.equal(retry.injectDump, true, "a mind that replied without writing must be asked again");
  assert.equal(retry.action, "dump");
  assert.equal(retry.allow, false);
});

test("a dump that never lands STILL ends in a refresh — a lost dump beats an endless burn", () => {
  const exhausted = apexGateDecision({ role: "apex", context: 800_000, threshold: SOFT, hard: HARD, dump: { attempts: 2, landed: false }, maxDumpAttempts: 2 });
  assert.equal(exhausted.action, "refresh");
  assert.equal(exhausted.allow, false);
  assert.match(exhausted.reason, /without|lost|unwritten/i, "and it records that state was lost, rather than implying a clean dump");
});

test("INVARIANT: past the hard limit, NO dump state yields an unguarded turn", () => {
  for (let attempts = 0; attempts <= 6; attempts++) {
    for (const landed of [true, false]) {
      const d = apexGateDecision({ role: "apex", context: 700_000, threshold: SOFT, hard: HARD, dump: { attempts, landed } });
      assert.ok(
        d.action === "dump" || d.action === "refresh",
        `attempts=${attempts} landed=${landed} produced action='${d.action}' — this is the 29-turn burn`,
      );
      assert.equal(d.allow, false, `attempts=${attempts} landed=${landed} allowed ordinary work past the backstop`);
    }
  }
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

// ---- the pump ------------------------------------------------------------------------------------
//
// THE SECOND ROOT CAUSE of the same incident, and the one the context gate alone would not have
// caught. The heartbeat exists so a finished wave is never left unintegrated overnight; it nudges
// whenever the lane is idle. It has no notion of whether the previous nudge ACHIEVED anything, so
// when the apex began replying "Nothing done. Same state." while making zero tool calls, the
// heartbeat kept feeding it — "the heartbeat has become a pump", in the owner's words.
//
// Context exhaustion was only why it stalled THAT time. A freshly refreshed body at 20k tokens
// that stalls for any other reason would loop just as long, and hit no limit for hours. So the
// engine counts turns that did no work, and a nudge loop gets a termination condition: one refresh
// (the cheapest unstick — a stall is often degradation the meter has not caught yet), and if that
// does not take, the lane PARKS. Parking is loud and requires a human; it can never loop.

test("a lane doing real work is never parked, however long it runs", () => {
  assert.equal(stallDecision({ idleStreak: 0, stallRefreshes: 0 }).action, "");
  assert.equal(stallDecision({ idleStreak: 2, stallRefreshes: 0 }).action, "", "an occasional answer-only turn is normal");
});

test("consecutive turns that make NO tool calls trigger one refresh — the cheapest unstick", () => {
  const d = stallDecision({ idleStreak: 3, stallRefreshes: 0 });
  assert.equal(d.action, "refresh");
  assert.match(d.reason, /no tool calls|did no work/i);
});

test("a lane that stalls AGAIN after its refresh is parked, not refreshed forever", () => {
  const d = stallDecision({ idleStreak: 3, stallRefreshes: 1 });
  assert.equal(d.action, "park", "a second rebirth that changes nothing is just a slower pump");
});

test("INVARIANT: no stall state refreshes more than the bound, and parking is terminal", () => {
  for (let streak = 0; streak <= 8; streak++) {
    for (let refreshes = 0; refreshes <= 4; refreshes++) {
      const d = stallDecision({ idleStreak: streak, stallRefreshes: refreshes, threshold: 3, maxStallRefreshes: 1 });
      assert.ok(["", "refresh", "park"].includes(d.action));
      if (d.action === "refresh") assert.ok(refreshes < 1, `refreshed ${refreshes} times already — this is a rebirth loop`);
      if (refreshes >= 1 && streak >= 3) assert.equal(d.action, "park", "once the bound is spent the only escalation left is a human");
    }
  }
});

// ---- did the dump actually land? ---------------------------------------------------------------
// "The model replied" is not evidence. On the live incident the reply and the write happened to
// agree, but a mind at 320k that answers "DUMPED" and writes nothing would have latched the old
// gate permanently open. The engine believes the FILE, not the answer.

test("a ledger write after the dump fired counts as landed", () => {
  const dir = fresh("gate-land-");
  const fired = Date.now() - 60_000;
  writeFileSync(join(dir, "CURRENT.md"), "# orientation\nreal content written by the dump turn\n");
  assert.equal(ledgerWrittenSince(dir, fired), true);
});

test("a ledger untouched since the dump fired is NOT landed — the reply is not the evidence", () => {
  const dir = fresh("gate-stale-");
  writeFileSync(join(dir, "CURRENT.md"), "# orientation\nwritten long before this cycle\n");
  assert.equal(ledgerWrittenSince(dir, Date.now() + 60_000), false);
});

test("a missing ledger is not landed, and never throws into the dispatch path", () => {
  assert.equal(ledgerWrittenSince(join(fresh("gate-none-"), "nope"), Date.now() - 1000), false);
  assert.equal(ledgerWrittenSince("", 0), false);
});

test("a missing/zero context reading never gates — an unmeasured turn is not a violation", () => {
  const d = apexGateDecision({ role: "apex", context: 0, threshold: SOFT, hard: HARD });
  assert.equal(d.allow, true);
  assert.equal(d.injectDump, false);
  assert.equal(d.unmeasured, true, "and it says so, rather than silently certifying 'under the limit'");
});
