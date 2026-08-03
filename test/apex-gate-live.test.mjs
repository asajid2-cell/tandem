// The apex gate running inside a REAL serve daemon, against the fake Claude.
//
// The unit tests prove the decision function. These prove the WIRING — which is where every
// defect in this system has actually lived: a gate that reads the wrong directory, a check placed
// after the file it reads is deleted, an enforcement keyed on an env var that doctrine forbids
// setting. The live campaign failure was never a wrong decision; it was a decision nothing
// consumed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

test("the dump fires ONCE — a gate that re-injects is a loop, not a guard", (t) => {
  const state = freshState();
  const env = { TANDEM_ROLE: "apex", TANDEM_LABEL: "once-apex", FAKE_CTX: "800000", TANDEM_HARD_AT: "300000" };
  t.after(() => stopDaemon(state, env));
  runPeer(["ask", "PRIME"], { state, env });
  runPeer(["ask", "TASK-A"], { state, env }); // consumed by the dump
  const third = runPeer(["ask", "TASK-B-MUST-RUN"], { state, env });
  assert.match(third, /TASK-B-MUST-RUN/, `work must proceed after the dump; got: ${third.slice(-400)}`);
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
