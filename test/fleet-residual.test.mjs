// The three defects the second real campaign left behind. Tests written BEFORE the fixes.
//
// F8 a mind forked by plain `peer.mjs ask` never enters `fleet tree`. Root cause found by
//    inspection: the CHILD's identity was resolved from the CALLER's env, so with the apex
//    exporting TANDEM_SELF_ID=apex (as its own charter instructs) every child resolved its own
//    id as "apex", found that node present, and was swallowed.
// F1 write-scope is enforced at DISPATCH and never at COLLECTION, so a lane that writes outside
//    its declared scope is not caught by the gate — wave 1 only noticed because it hashed its
//    seeded files. A package-wide `cargo fmt` in a brief forces this structurally.
// F3 an interrupted lane lands `finished-error`; its own dead self then blocks re-dispatch via
//    the live-scope gate, and `reap` REFUSES it ("only valid for WEDGED"), so the lane is wedged
//    by the very guard meant to protect it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChildIdentity } from "../bin/fleet-identity.mjs";
import { auditLaneScope, reportedLaneChanges } from "../bin/write-scope.mjs";
import { reapDisposition } from "../bin/fleet-doctor.mjs";

const fresh = (p) => mkdtempSync(join(tmpdir(), p));

// ---- F8 -------------------------------------------------------------------------------------

test("F8: a child's identity is ITS OWN — the caller's self id becomes the PARENT, never the child", () => {
  const callerEnv = { TANDEM_SELF_ID: "apex", TANDEM_LABEL: "w1-recon", TANDEM_FLEET_DIR: "/f" };
  const child = resolveChildIdentity(callerEnv, "sess-123");
  assert.equal(child.selfId, "w1-recon", "the label the caller gave this child names the child");
  assert.equal(child.parentId, "apex", "the caller becomes the parent");
  assert.notEqual(child.selfId, "apex", "the child must never inherit the caller's identity");
});

test("F8: with no label, the child falls back to its own session id — still never the caller's", () => {
  const child = resolveChildIdentity({ TANDEM_SELF_ID: "apex" }, "sess-abc");
  assert.equal(child.selfId, "sess-abc");
  assert.equal(child.parentId, "apex");
});

test("F8: a swarm lane keeps its lane id as identity, and its role", () => {
  const child = resolveChildIdentity({ TANDEM_SELF_ID: "apex", TANDEM_LANE_ID: "w1a/conv", TANDEM_ROLE: "junior" }, "s1");
  assert.equal(child.selfId, "w1a/conv");
  assert.equal(child.kind, "junior");
});

// ---- F1 -------------------------------------------------------------------------------------

test("F1: collection-time audit catches a lane that wrote outside its declared scope", () => {
  const v = auditLaneScope({
    changed: ["crates/x/src/alu.rs", "crates/x/src/accept_alu.rs"],
    writes: ["crates/x/src/alu.rs"],
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.outside, ["crates/x/src/accept_alu.rs"], "the apex-owned acceptance file is NOT the lane's to touch");
});

test("F1: a lane that stayed inside its scope passes, and path style does not matter", () => {
  const v = auditLaneScope({ changed: ["crates\\x\\src\\alu.rs"], writes: ["crates/x/src/alu.rs"] });
  assert.equal(v.ok, true);
  assert.equal(v.outside.length, 0);
});

test("F1: a formatting-only excursion is reported SEPARATELY, not as a scope breach", () => {
  // `cargo fmt` is package-wide, so a brief demanding fmt-clean forces the lane out of scope by
  // construction. That is a brief defect, not a rogue lane — report it as its own class so the
  // driver can tell them apart.
  const v = auditLaneScope({
    changed: ["crates/x/src/other.rs"],
    writes: ["crates/x/src/alu.rs"],
    formattingOnly: ["crates/x/src/other.rs"],
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.formatting, ["crates/x/src/other.rs"]);
  assert.equal(v.outside.length, 0, "formatting churn is not counted as a content breach");
});

test("F1: no declared writes means nothing can be audited — say so rather than passing silently", () => {
  const v = auditLaneScope({ changed: ["a.rs"], writes: [] });
  assert.equal(v.ok, false);
  assert.match(v.detail, /no declared writes/i);
});

test("F1: collection attributes writes from the lane's own completed file_change telemetry", () => {
  const stream = [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "file_change",
        status: "completed",
        changes: [{ path: "C:\\repo\\src\\owned.mjs", kind: "add" }],
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "file_change",
        status: "completed",
        changes: [{ path: "C:\\repo\\src\\owned.mjs", kind: "update" }],
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "file_change",
        status: "completed",
        changes: [{ path: "C:\\repo\\src\\outside.mjs", kind: "add" }],
      },
    }),
  ].join("\n");

  assert.deepEqual(reportedLaneChanges(stream), [
    "C:\\repo\\src\\owned.mjs",
    "C:\\repo\\src\\outside.mjs",
  ]);
  const audit = auditLaneScope({
    changed: reportedLaneChanges(stream),
    writes: ["C:\\repo\\src\\owned.mjs"],
  });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.outside, ["C:\\repo\\src\\outside.mjs"]);
});

test("F1: absent file_change telemetry is explicit, never an empty green scope proof", () => {
  assert.deepEqual(
    reportedLaneChanges('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n'),
    [],
  );
});

// ---- F3 -------------------------------------------------------------------------------------

test("F3: reap on a TERMINAL lane syncs the registry instead of refusing", () => {
  for (const status of ["done", "error"]) {
    const d = reapDisposition(status);
    assert.equal(d.refuse, false, `${status} must not be refused — refusing is what wedges re-dispatch`);
    assert.equal(d.registryStatus, "gone");
    assert.match(d.reason, /terminal/i);
  }
});

test("F3: reap on a WEDGED lane still force-finishes it (the original purpose)", () => {
  const d = reapDisposition("WEDGED");
  assert.equal(d.refuse, false);
  assert.equal(d.forceFinish, true);
});

test("F3: reap on a genuinely RUNNING lane is still refused", () => {
  const d = reapDisposition("running");
  assert.equal(d.refuse, true);
  assert.match(d.reason, /running/i);
});
