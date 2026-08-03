// Multi-account codex capacity. A second authed account is not a fallback — it is concurrent
// capacity, and the pool that actually ran out today (codex primary at 90% with 6.5 days to
// reset) is per-account. Lanes must be able to name which account they spend, and `fleet quota`
// must report every account rather than only whichever one happens to be the default.
//
// Accounts are directories: `codex` reads credentials, config and history from $CODEX_HOME, so
// switching accounts is choosing a directory and two accounts can run AT THE SAME TIME.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountHome, checkAccountPolicy, listCodexAccounts } from "../bin/codex-accounts.mjs";
import { laneEnvironment } from "../bin/swarm.mjs";

function accountsRoot() {
  const root = mkdtempSync(join(tmpdir(), "cxacct-"));
  for (const label of ["main", "review"]) {
    mkdirSync(join(root, label, "sessions"), { recursive: true });
    writeFileSync(join(root, label, "auth.json"), "{}");
  }
  mkdirSync(join(root, "not-an-account"), { recursive: true }); // no auth.json
  return root;
}

test("listCodexAccounts: only directories that are actually signed in count as accounts", () => {
  const root = accountsRoot();
  const accounts = listCodexAccounts(root);
  assert.deepEqual(accounts.map((a) => a.label).sort(), ["main", "review"]);
  assert.ok(accounts.every((a) => a.sessionsDir.endsWith("sessions")));
});

test("listCodexAccounts: a missing accounts dir yields an empty list, never a throw", () => {
  assert.deepEqual(listCodexAccounts(join(tmpdir(), "definitely-not-here-12345")), []);
});

test("accountHome: resolves a label to its CODEX_HOME, and refuses a traversal", () => {
  const root = accountsRoot();
  assert.equal(accountHome("review", root), join(root, "review"));
  assert.equal(accountHome("../escape", root), "");
  assert.equal(accountHome("", root), "");
});

test("a lane can name the account it spends, and it lands as CODEX_HOME", () => {
  const root = accountsRoot();
  const lane = { state: "/s", label: "l", laneId: "s/l", cwd: "/c", account: join(root, "review") };
  const env = laneEnvironment(lane, {});
  assert.equal(env.CODEX_HOME, join(root, "review"), "the lane spends the account it named");
});

test("a lane with no account inherits the ambient one — the default stays the default", () => {
  const env = laneEnvironment({ state: "/s", label: "l", laneId: "s/l", cwd: "/c" }, { CODEX_HOME: "/ambient" });
  assert.equal(env.CODEX_HOME, "/ambient");
});

// The owner bought the second account as CHEAP BUILDER capacity. Enforced, not documented.
const LUNA_ONLY = { review: { allow: ["gpt-5.6-luna"] } };

test("account policy: luna is permitted on the cheap-builder account", () => {
  assert.equal(checkAccountPolicy({ account: "review", model: "gpt-5.6-luna", policy: LUNA_ONLY }).ok, true);
});

test("account policy: sol and terra are REFUSED on the cheap-builder account", () => {
  for (const model of ["gpt-5.6-sol", "gpt-5.6-terra"]) {
    const r = checkAccountPolicy({ account: "review", model, policy: LUNA_ONLY });
    assert.equal(r.ok, false, model);
    assert.match(r.detail, /cheap builder capacity/i);
  }
});

test("account policy: a lane naming the restricted account with NO model is refused, not defaulted", () => {
  assert.equal(checkAccountPolicy({ account: "review", policy: LUNA_ONLY }).ok, false);
});

test("account policy: an unpoliced account and the ambient default are unaffected", () => {
  assert.equal(checkAccountPolicy({ account: "main", model: "gpt-5.6-sol", policy: LUNA_ONLY }).ok, true);
  assert.equal(checkAccountPolicy({ model: "gpt-5.6-sol", policy: LUNA_ONLY }).ok, true);
});

test("account policy is CONFIG-owned: a manifest cannot grant itself permission", async () => {
  // the manifest is authored by a MIND. If policy came from there, a lane could widen its own
  // permissions — the gate would be decoration. Live validation caught exactly this: the gate
  // read source.accounts and a sol lane sailed onto the luna-only account.
  const { accountPolicyFromConfig } = await import("../bin/codex-accounts.mjs");
  const cfgDir = mkdtempSync(join(tmpdir(), "cxpolicy-"));
  writeFileSync(join(cfgDir, "tandem.config.json"), JSON.stringify({ accounts: { review: { allow: ["gpt-5.6-luna"] } } }));
  const policy = accountPolicyFromConfig(join(cfgDir, "tandem.config.json"));
  assert.deepEqual(policy.review.allow, ["gpt-5.6-luna"]);
  // and the enforcement uses THAT, so a permissive manifest changes nothing
  assert.equal(checkAccountPolicy({ account: "review", model: "gpt-5.6-sol", policy }).ok, false);
});

test("accountPolicyFromConfig: a missing or broken config yields no policy, never a throw", async () => {
  const { accountPolicyFromConfig } = await import("../bin/codex-accounts.mjs");
  assert.deepEqual(accountPolicyFromConfig(join(tmpdir(), "nope-12345.json")), {});
});
