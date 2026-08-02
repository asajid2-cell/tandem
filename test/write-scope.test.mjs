import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkAgainstLive,
  checkLaneScopes,
  normalizeScopePath,
  scopesOverlap,
} from "../bin/write-scope.mjs";

const cliPath = fileURLToPath(new URL("../bin/write-scope.mjs", import.meta.url));

test("normalizes separators and case", () => {
  assert.equal(normalizeScopePath("Src\\Foo//Bar.JS/"), "src/foo/bar.js");
});

test("resolves dot and dot-dot segments lexically", () => {
  assert.equal(normalizeScopePath("a/b/../c"), "a/c");
});

test("keeps dot-dot segments that escape the starting point", () => {
  assert.equal(normalizeScopePath("../a/../../b"), "../../b");
});

test("throws for an empty path", () => {
  assert.throws(() => normalizeScopePath(""), { message: "empty scope path" });
});

test("matches a directory prefix at a segment boundary", () => {
  assert.equal(scopesOverlap("src/foo", "src/foo/bar.js"), true);
});

test("does not match a partial segment prefix", () => {
  assert.equal(scopesOverlap("src/foo", "src/foobar"), false);
});

test("matches equal paths after normalization", () => {
  assert.equal(scopesOverlap("SRC\\FOO", "src/foo"), true);
});

test("reports a missing or empty writes array", () => {
  assert.deepEqual(checkLaneScopes([{ name: "one", writes: [] }]), {
    ok: false,
    errors: [{ lane: "one", error: "writes[] required" }],
    conflicts: [],
  });
});

test("reports an invalid entry in an otherwise non-empty writes array", () => {
  assert.deepEqual(checkLaneScopes([{ name: "one", writes: ["src/a", ""] }]), {
    ok: false,
    errors: [{ lane: "one", error: "invalid write path" }],
    conflicts: [],
  });
});

test("reports one conflict when two lanes write the same file", () => {
  const result = checkLaneScopes([
    { name: "one", writes: ["src/file.js"] },
    { name: "two", writes: ["SRC\\FILE.JS"] },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0], {
    a: "one",
    b: "two",
    pathA: "src/file.js",
    pathB: "SRC\\FILE.JS",
  });
});

test("allows disjoint lanes", () => {
  assert.deepEqual(
    checkLaneScopes([
      { name: "one", writes: ["src/one.js"] },
      { name: "two", writes: ["src/two.js"] },
    ]),
    { ok: true, errors: [], conflicts: [] },
  );
});

test("does not report self-overlap within one lane", () => {
  assert.deepEqual(
    checkLaneScopes([{ name: "one", writes: ["src", "src/file.js"] }]),
    { ok: true, errors: [], conflicts: [] },
  );
});

test("reports duplicate lane names", () => {
  const result = checkLaneScopes([
    { name: "one", writes: ["src/one.js"] },
    { name: "one", writes: ["src/two.js"] },
  ]);

  assert.deepEqual(result.errors, [{ lane: "one", error: "duplicate lane name" }]);
  assert.equal(result.ok, false);
});

test("checks new lanes against live scopes", () => {
  const result = checkAgainstLive(
    [{ name: "new", writes: ["src/file.js"] }],
    [{ owner: "running", writes: ["src"] }],
  );

  assert.deepEqual(result, {
    ok: false,
    conflicts: [
      {
        lane: "new",
        owner: "running",
        pathA: "src/file.js",
        pathB: "src",
      },
    ],
  });
});

test("skips malformed live entries", () => {
  assert.deepEqual(
    checkAgainstLive(
      [{ name: "new", writes: ["src/file.js"] }],
      [{ owner: "partial" }, { owner: "other", writes: ["docs/readme.md"] }],
    ),
    { ok: true, conflicts: [] },
  );
});

test("CLI emits the combined result and failure status", () => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "check", "-"],
    {
      input: JSON.stringify({
        lanes: [
          { name: "one", writes: ["src/file.js"] },
          { name: "two", writes: ["src/file.js"] },
        ],
      }),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    errors: [],
    conflicts: [
      {
        a: "one",
        b: "two",
        pathA: "src/file.js",
        pathB: "src/file.js",
      },
    ],
    liveConflicts: [],
  });
});
