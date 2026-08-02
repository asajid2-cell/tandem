import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  family,
  getSession,
  liveWriteScopes,
  registerSession,
  renderTree,
  updateStatus,
} from "../bin/fleet-registry.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fleetreg-"));
}

test("register and get apply defaults", () => {
  const dir = tempDir();
  const stored = registerSession(dir, { id: "root", kind: "apex" });
  const fetched = getSession(dir, "root");

  assert.deepEqual(fetched, stored);
  assert.deepEqual(
    { parent: stored.parent, label: stored.label, charter: stored.charter, writes: stored.writes,
      model: stored.model, effort: stored.effort, cwd: stored.cwd, status: stored.status, endTs: stored.endTs },
    { parent: null, label: "", charter: "", writes: [], model: "", effort: "", cwd: "", status: "live", endTs: null },
  );
  assert.equal(stored.id, "root");
  assert.equal(stored.kind, "apex");
  assert.equal(typeof stored.ts, "number");
});

test("duplicate ids throw", () => {
  const dir = tempDir();
  registerSession(dir, { id: "same", kind: "branch" });
  assert.throws(
    () => registerSession(dir, { id: "same", kind: "junior" }),
    new Error("duplicate session id: same"),
  );
});

test("unknown parents throw", () => {
  assert.throws(
    () => registerSession(tempDir(), { id: "child", kind: "junior", parent: "missing" }),
    new Error("unknown parent: missing"),
  );
});

test("invalid kinds throw", () => {
  assert.throws(
    () => registerSession(tempDir(), { id: "bad", kind: "worker" }),
    new Error("invalid kind: worker"),
  );
});

test("charters are truncated to 2000 characters", () => {
  const dir = tempDir();
  const stored = registerSession(dir, {
    id: "charter",
    kind: "other",
    charter: "x".repeat(2001),
  });
  assert.equal(stored.charter.length, 2000);
  assert.equal(stored.charter, "x".repeat(2000));
});

test("terminal status sets endTs and live clears it", () => {
  const dir = tempDir();
  registerSession(dir, { id: "session", kind: "branch" });
  const done = updateStatus(dir, "session", "done");
  assert.equal(done.status, "done");
  assert.equal(typeof done.endTs, "number");

  const live = updateStatus(dir, "session", "live");
  assert.equal(live.status, "live");
  assert.equal(live.endTs, null);
});

test("family returns root-first ancestors and depth-first descendants", () => {
  const dir = tempDir();
  registerSession(dir, { id: "root", kind: "apex" });
  registerSession(dir, { id: "branch-a", kind: "branch", parent: "root" });
  registerSession(dir, { id: "junior-a", kind: "junior", parent: "branch-a" });
  registerSession(dir, { id: "branch-b", kind: "branch", parent: "root" });

  const result = family(dir, "junior-a");
  assert.deepEqual(result.ancestors.map((record) => record.id), ["root", "branch-a"]);
  assert.deepEqual(result.descendants, []);

  const rootFamily = family(dir, "root");
  assert.deepEqual(rootFamily.ancestors, []);
  assert.deepEqual(
    rootFamily.descendants.map((record) => record.id),
    ["branch-a", "junior-a", "branch-b"],
  );
});

test("family rejects an unknown id", () => {
  assert.throws(() => family(tempDir(), "missing"), new Error("unknown session id: missing"));
});

test("live write scopes exclude non-live records and the requested owner", () => {
  const dir = tempDir();
  registerSession(dir, { id: "first", kind: "branch", writes: ["a.js"] });
  registerSession(dir, { id: "second", kind: "junior", writes: ["b.js"] });
  registerSession(dir, { id: "empty", kind: "other" });
  updateStatus(dir, "second", "done");

  assert.deepEqual(liveWriteScopes(dir), [{ owner: "first", writes: ["a.js"] }]);
  assert.deepEqual(liveWriteScopes(dir, "first"), []);
});

test("renderTree indents a three-level tree", () => {
  const dir = tempDir();
  registerSession(dir, { id: "root", kind: "apex", model: "large", label: "Root" });
  registerSession(dir, { id: "branch", kind: "branch", parent: "root", label: "Branch" });
  registerSession(dir, { id: "junior", kind: "junior", parent: "branch", model: "small", label: "Junior" });

  assert.equal(
    renderTree(dir),
    [
      "root [apex/large] live — Root",
      "  branch [branch/-] live — Branch",
      "    junior [junior/small] live — Junior",
    ].join("\n"),
  );
});

test("missing registry reads as an empty fleet", () => {
  const dir = tempDir();
  assert.equal(getSession(dir, "missing"), null);
  assert.deepEqual(liveWriteScopes(dir), []);
  assert.equal(renderTree(dir), "(empty fleet)");
});

test("corrupt registry JSON throws a registry corrupt error", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "registry.json"), "{not json", "utf8");
  assert.throws(() => getSession(dir, "anything"), new RegExp(`registry corrupt: ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[/\\\\]registry\\.json`));
});

test("invalid statuses and unknown session ids throw", () => {
  const dir = tempDir();
  registerSession(dir, { id: "session", kind: "other" });
  assert.throws(() => updateStatus(dir, "session", "paused"), new Error("invalid status: paused"));
  assert.throws(() => updateStatus(dir, "missing", "live"), new Error("unknown session id: missing"));
});
