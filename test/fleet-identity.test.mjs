// D3 — fleet identity: who a session IS, who forked it, and what it may pass to its own children.
// Written BEFORE the implementation (TDD). The live wave-0 campaign proved three defects here:
//   - a mind forked by plain `peer.mjs ask` never entered the registry, so `fleet tree` — the
//     surface doctrine tells minds to consult — under-reported the fleet;
//   - the apex appeared TWICE (its own registered id + its raw session id from prepareSwarm);
//   - TANDEM_ROLE / TANDEM_LABEL leaked by env inheritance, so a child that declared no role
//     inherited its parent's ("apex").
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, ensureRegistered, resolveIdentity } from "../bin/fleet-identity.mjs";
import { getSession, registerSession, renderTree } from "../bin/fleet-registry.mjs";

const fresh = (p) => mkdtempSync(join(tmpdir(), p));

test("resolveIdentity: explicit role wins; a lane defaults to junior; otherwise the partner default", () => {
  assert.equal(resolveIdentity({ TANDEM_ROLE: "branch-mind" }, "codex-partner").kind, "branch-mind");
  assert.equal(resolveIdentity({ TANDEM_LANE_ID: "sw/a" }, "codex-partner").kind, "junior");
  assert.equal(resolveIdentity({}, "claude-partner").kind, "claude-partner");
});

test("resolveIdentity: selfId prefers TANDEM_SELF_ID, then lane id, then the session id", () => {
  assert.equal(resolveIdentity({ TANDEM_SELF_ID: "apex", TANDEM_LANE_ID: "s/a" }, "x", "sid-1").selfId, "apex");
  assert.equal(resolveIdentity({ TANDEM_LANE_ID: "s/a" }, "x", "sid-1").selfId, "s/a");
  assert.equal(resolveIdentity({}, "x", "sid-1").selfId, "sid-1");
  assert.equal(resolveIdentity({ TANDEM_PARENT_ID: "apex" }, "x", "sid").parentId, "apex");
});

test("childEnv: identity vars do NOT leak to children; lineage and config DO", () => {
  const parent = {
    PATH: "/bin",
    TANDEM_ROLE: "apex",
    TANDEM_SELF_ID: "apex",
    TANDEM_LABEL: "wasm360-apex",
    TANDEM_LANE_ID: "sw/a",
    TANDEM_PARENT_ID: "grandparent",
    TANDEM_FLEET_DIR: "/fleet",
  };
  const child = childEnv(parent, { selfId: "apex" });
  // identity of the PARENT must not become the identity of the CHILD
  assert.equal(child.TANDEM_ROLE, undefined, "role must not leak");
  assert.equal(child.TANDEM_SELF_ID, undefined, "self id must not leak");
  assert.equal(child.TANDEM_LABEL, undefined, "label must not leak");
  assert.equal(child.TANDEM_LANE_ID, undefined, "lane id must not leak");
  // lineage + config MUST propagate, and the child's parent is the CALLER, not the caller's parent
  assert.equal(child.TANDEM_PARENT_ID, "apex", "the child's parent is whoever spawned it");
  assert.equal(child.TANDEM_FLEET_DIR, "/fleet");
  assert.equal(child.PATH, "/bin");
});

test("partnerEnv (the live spawn path) strips role/self-id and installs the caller as parent", async () => {
  const { partnerEnv } = await import("../bin/claudeEnv.mjs");
  const out = partnerEnv({
    TANDEM_ROLE: "apex",
    TANDEM_SELF_ID: "apex",
    TANDEM_LABEL: "wasm360-apex",
    TANDEM_LANE_ID: "sw/a",
    TANDEM_FLEET_DIR: "/fleet",
  });
  assert.equal(out.TANDEM_ROLE, undefined, "a partner must not inherit its driver's role");
  assert.equal(out.TANDEM_SELF_ID, undefined);
  assert.equal(out.TANDEM_LABEL, undefined);
  assert.equal(out.TANDEM_PARENT_ID, "apex", "the partner's parent is the session that spawned it");
  assert.equal(out.TANDEM_FLEET_DIR, "/fleet", "fleet config still propagates");
  assert.equal(out.TANDEM_NESTED_AGENT, "1");
});

test("ensureRegistered: registers a non-swarm fork so `fleet tree` sees it", () => {
  const dir = fresh("ident-reg-");
  registerSession(dir, { id: "apex", kind: "apex", label: "apex" });
  const rec = ensureRegistered(dir, {
    selfId: "wasm360-compose",
    parentId: "apex",
    kind: "branch-mind",
    label: "wasm360-compose",
    model: "gpt-5.6-sol",
  });
  assert.equal(rec.parent, "apex");
  assert.equal(getSession(dir, "wasm360-compose").kind, "branch", "branch-mind maps to registry kind 'branch'");
  assert.match(renderTree(dir), /wasm360-compose/, "the branch mind is visible in the tree");
});

test("ensureRegistered: idempotent — a second call never duplicates and never throws", () => {
  const dir = fresh("ident-idem-");
  registerSession(dir, { id: "apex", kind: "apex" });
  const a = ensureRegistered(dir, { selfId: "bm", parentId: "apex", kind: "branch-mind" });
  const b = ensureRegistered(dir, { selfId: "bm", parentId: "apex", kind: "branch-mind" });
  assert.equal(a.id, b.id);
  const lines = renderTree(dir).split("\n").filter((l) => l.includes("bm"));
  assert.equal(lines.length, 1, "exactly one node — no double registration");
});

test("ensureRegistered: an already-registered self id is REUSED, not duplicated (the apex-twice bug)", () => {
  const dir = fresh("ident-apex-");
  registerSession(dir, { id: "apex", kind: "apex", label: "wasm360-apex" });
  // the apex later dispatches a swarm; its raw session id must NOT become a second node
  const rec = ensureRegistered(dir, { selfId: "apex", sessionId: "65050507-raw", parentId: null, kind: "apex" });
  assert.equal(rec.id, "apex");
  assert.equal(getSession(dir, "65050507-raw"), null, "the raw session id must not be registered separately");
  assert.equal(renderTree(dir).split("\n").filter(Boolean).length, 1);
});

test("ensureRegistered: unknown parent fails SAFE (registers as root, never throws)", () => {
  const dir = fresh("ident-ghost-");
  const rec = ensureRegistered(dir, { selfId: "orphan", parentId: "ghost", kind: "branch-mind" });
  assert.equal(rec.parent, null);
});

test("ensureRegistered: never throws on a corrupt/unwritable registry — identity is advisory", () => {
  assert.doesNotThrow(() => ensureRegistered("\0bad\0dir", { selfId: "x", kind: "junior" }));
});
