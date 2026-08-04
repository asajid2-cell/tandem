// The apex gate running inside a REAL serve daemon, against the fake Claude.
//
// The unit tests prove the decision function. These prove the WIRING — which is where every
// defect in this system has actually lived: a gate that reads the wrong directory, a check placed
// after the file it reads is deleted, an enforcement keyed on an env var that doctrine forbids
// setting. The live campaign failure was never a wrong decision; it was a decision nothing
// consumed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PEER = join(ROOT, "bin", "peer.mjs");
const FAKE = join(HERE, "fake-claude.mjs");

function runPeer(args, { state, env = {} }) {
  try {
    return execFileSync(process.execPath, [PEER, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        TANDEM_STATE: state,
        TANDEM_CLAUDE_BIN: FAKE,
        TANDEM_PARTNER: "claude",
        TANDEM_CWD: ROOT,
        FAKE_DELAY: "0",
        ...env,
      },
    });
  } catch (error) {
    return `${error.stdout || ""}${error.stderr || ""}`;
  }
}

function freshState() {
  return mkdtempSync(join(tmpdir(), "gatelive-"));
}

function stopDaemon(state, env = {}) {
  runPeer(["stop"], { state, env });
}

test("serve RECORDS its identity at startup — role and ledger dir, not re-derived later", (t) => {
  const state = freshState();
  const fleet = join(state, "campaign-fleet");
  t.after(() => stopDaemon(state, { TANDEM_ROLE: "apex", TANDEM_FLEET_DIR: fleet, TANDEM_LABEL: "an-apex" }));
  runPeer(["ask", "hello"], { state, env: { TANDEM_ROLE: "apex", TANDEM_FLEET_DIR: fleet, TANDEM_LABEL: "an-apex" } });
  const bound = JSON.parse(readFileSync(join(state, "serve.bound.json"), "utf8"));
  assert.equal(bound.role, "apex", "the daemon knows what it is without asking the environment again");
  assert.equal(bound.fleetDir, fleet, "and which ledger it belongs to — the wrong-directory bug, closed");
  assert.equal(bound.label, "an-apex");
  assert.ok(bound.model, "identity is merged INTO the existing bound record, not written over it");
});

test("an apex past the HARD limit gets the engine's fixed dump turn instead of its task", (t) => {
  const state = freshState();
  const env = { TANDEM_ROLE: "apex", TANDEM_LABEL: "big-apex", FAKE_CTX: "800000", TANDEM_HARD_AT: "300000" };
  t.after(() => stopDaemon(state, env));
  // turn 1 establishes the meter (the daemon learns this session's context from the stream)
  runPeer(["ask", "FIRST-TASK"], { state, env });
  // turn 2 is the one that must be replaced
  const out = runPeer(["ask", "SECOND-TASK-MUST-NOT-RUN"], { state, env });
  assert.match(out, /DUMPED|first=\[ENGINE\]/, `expected the engine dump turn, got: ${out.slice(-400)}`);
  assert.doesNotMatch(out, /first=SECOND-TASK-MUST-NOT-RUN/, "the requested task must NOT have been delivered");
});

// THE 29-TURN BURN, as a live test. The gate's first version passed a test asserting that "work
// must proceed after the dump" — and that assertion WAS the defect. On the live campaign the gate
// fired at 300,030, the apex complied and wrote its ledger a minute later, and then the gate
// returned allow+notice forever: 29 turns over 86 minutes, every one making zero tool calls and
// replying "Nothing done. Same state.", stopped only by a human disabling the heartbeat. What
// follows is the corrected contract — the engine performs the recovery, and no dump state lets
// ordinary work resume on an exhausted body.

test("a dump the mind did not honour is RETRIED — a reply is not evidence of a write", (t) => {
  const state = freshState();
  const env = { TANDEM_ROLE: "apex", TANDEM_LABEL: "retry-apex", FAKE_CTX: "800000", TANDEM_HARD_AT: "300000", TANDEM_FLEET_DIR: join(state, "campaign-fleet") };
  t.after(() => stopDaemon(state, env));
  runPeer(["ask", "PRIME"], { state, env });
  runPeer(["ask", "TASK-A"], { state, env }); // replaced by the dump; the fake writes no ledger
  const third = runPeer(["ask", "TASK-B-MUST-NOT-RUN"], { state, env });
  assert.doesNotMatch(third, /first=TASK-B-MUST-NOT-RUN/, `ordinary work resumed past the hard limit — this is the burn; got: ${third.slice(-400)}`);
  assert.match(third, /first=\[ENGINE\]/, "an unwritten ledger must produce another dump, not a disarmed gate");
});

test("once the ledger is written the ENGINE refreshes the body itself — it does not ask", async (t) => {
  const state = freshState();
  const fleet = join(state, "campaign-fleet");
  const env = { TANDEM_ROLE: "apex", TANDEM_LABEL: "refresh-apex", FAKE_CTX: "800000", TANDEM_HARD_AT: "300000", TANDEM_FLEET_DIR: fleet };
  t.after(() => stopDaemon(state, env));
  runPeer(["ask", "PRIME"], { state, env });
  runPeer(["ask", "TASK-A"], { state, env }); // replaced by the dump
  assert.ok(existsSync(join(state, "claude.session")), "precondition: the body has a session to forget");

  // the dump "lands": the ledger is written after the dump fired, which is the only evidence the
  // engine accepts. No further ask is needed — the refresh must be self-firing.
  mkdirSync(join(fleet, "apex"), { recursive: true });
  writeFileSync(join(fleet, "apex", "CURRENT.md"), "# orientation\nwhat was in flight\n");

  const deadline = Date.now() + 15_000;
  while (existsSync(join(state, "claude.session")) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(!existsSync(join(state, "claude.session")), "the engine must FORGET the session — the next ask has to open a fresh body");
  const events = readFileSync(join(state, "tandem.log.jsonl"), "utf8");
  assert.match(events, /"apex-refresh"/, "and record that it did so");

  // AND IT MUST COME BACK BRIEFED. A refresh that produced a memoryless body would be worse than
  // the burn it replaced — the engine would be destroying context on a schedule. The brief is
  // derived at ask time from the ledger, so the reborn body's turn carries it AHEAD of the task.
  const reborn = runPeer(["ask", "AFTER-REBIRTH"], { state, env });
  assert.match(reborn, /last=AFTER-REBIRTH/, `the reborn body must run the task; got: ${reborn.slice(-400)}`);
  assert.doesNotMatch(reborn, /first=AFTER-REBIRTH/, "the rehydration brief must be PREPENDED — a body reborn without its ledger is worse than one that burned");
  assert.ok(existsSync(join(state, "claude.session")), "and the fresh body records its own session");
});

test("between the thresholds the turn is delivered WITH an in-band meter notice", (t) => {
  const state = freshState();
  const env = { TANDEM_ROLE: "apex", TANDEM_LABEL: "warn-apex", FAKE_CTX: "150000", TANDEM_REFRESH_AT: "100000", TANDEM_HARD_AT: "300000" };
  t.after(() => stopDaemon(state, env));
  runPeer(["ask", "PRIME"], { state, env });
  const out = runPeer(["ask", "REAL-TASK"], { state, env });
  assert.match(out, /first=\[ENGINE\]/, "the notice must ride IN the turn — console output is discarded by the autonomous dispatcher");
  assert.match(out, /REAL-TASK/, "and the real task still runs");
});

test("a NON-apex lane is never gated, however large its context", (t) => {
  const state = freshState();
  const env = { TANDEM_LABEL: "plain-lane", FAKE_CTX: "900000", TANDEM_HARD_AT: "300000" };
  t.after(() => stopDaemon(state, env));
  runPeer(["ask", "PRIME"], { state, env });
  const out = runPeer(["ask", "ORDINARY-WORK"], { state, env });
  assert.match(out, /first=ORDINARY-WORK/, "no role recorded means no gate — this must not regress ordinary partners");
});

test("an apex with NO context reading yet is not gated (unmeasured is not a violation)", (t) => {
  const state = freshState();
  const env = { TANDEM_ROLE: "apex", TANDEM_LABEL: "cold-apex", TANDEM_HARD_AT: "300000" }; // no FAKE_CTX
  t.after(() => stopDaemon(state, env));
  const out = runPeer(["ask", "FIRST-EVER-TURN"], { state, env });
  assert.match(out, /first=FIRST-EVER-TURN/, "a cold daemon must deliver the first turn");
  assert.ok(existsSync(join(state, "serve.bound.json")));
});
