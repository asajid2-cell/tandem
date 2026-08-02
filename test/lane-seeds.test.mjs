// Seeded files — the apex places acceptance tests and a lib.rs edit INTO a lane's worktree,
// uncommitted, so the lane is graded by assertions it does not own. That recipe is what made the
// two real campaigns trustworthy, and it collides with two things:
//
//  1. the collection-time scope audit reads `git status --porcelain`, which lists those seeds;
//     they are outside every lane's declared writes[], so EVERY lane would report SCOPE-BREACH
//     spuriously — training an operator to wave through the one breach that is real;
//  2. detecting a lane that EDITS its grader was done by hand (a text file of hashes maintained
//     by the apex), so the single most important custody check had no automation at all.
//
// One mechanism fixes both: record the seeds and their hashes at dispatch, exclude them from the
// scope audit at collection, and re-hash them to prove the lane did not touch its own grader.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSeeds, recheckSeeds } from "../bin/lane-seeds.mjs";
import { auditLaneScope } from "../bin/write-scope.mjs";

function laneDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(d, "src"), { recursive: true });
  return d;
}

test("hashSeeds records each seed's digest; recheck passes when the lane leaves them alone", () => {
  const cwd = laneDir("seed-ok-");
  writeFileSync(join(cwd, "src", "accept_alu.rs"), "assert_eq!(emit(), vec![0x6a]);");
  writeFileSync(join(cwd, "src", "lib.rs"), "pub mod alu;");
  const stamped = hashSeeds(cwd, ["src/accept_alu.rs", "src/lib.rs"]);
  assert.equal(stamped.seeds.length, 2);
  assert.ok(stamped.seeds.every((s) => s.sha256.length === 64));
  const r = recheckSeeds(cwd, stamped);
  assert.equal(r.ok, true);
  assert.equal(r.tampered.length, 0);
});

test("recheckSeeds CATCHES a lane that edited the assertions grading it", () => {
  const cwd = laneDir("seed-tamper-");
  writeFileSync(join(cwd, "src", "accept_alu.rs"), "assert_eq!(emit(), vec![0x6a]);");
  const stamped = hashSeeds(cwd, ["src/accept_alu.rs"]);
  writeFileSync(join(cwd, "src", "accept_alu.rs"), "assert!(true); // much easier");
  const r = recheckSeeds(cwd, stamped);
  assert.equal(r.ok, false);
  assert.deepEqual(r.tampered, ["src/accept_alu.rs"]);
  assert.match(r.detail, /grader|tamper|edited/i);
});

test("recheckSeeds catches a DELETED seed, not just a modified one", () => {
  const cwd = laneDir("seed-del-");
  writeFileSync(join(cwd, "src", "accept_alu.rs"), "x");
  const stamped = hashSeeds(cwd, ["src/accept_alu.rs"]);
  const r = recheckSeeds(cwd, { seeds: [...stamped.seeds, { path: "src/gone.rs", sha256: "0".repeat(64) }] });
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes("src/gone.rs"));
});

test("the scope audit EXCLUDES declared seeds — the false positive that would cry wolf every lane", () => {
  // exactly the proven recipe: the lane wrote its own file; the apex's seeds are also dirty
  const v = auditLaneScope({
    changed: ["crates/x/src/alu.rs", "crates/x/src/accept_alu.rs", "crates/x/src/lib.rs"],
    writes: ["crates/x/src/alu.rs"],
    seeds: ["crates/x/src/accept_alu.rs", "crates/x/src/lib.rs"],
  });
  assert.equal(v.ok, true, "seeded files are the apex's, not a lane breach");
  assert.equal(v.outside.length, 0);
});

test("a real breach is STILL caught when seeds are declared", () => {
  const v = auditLaneScope({
    changed: ["crates/x/src/alu.rs", "crates/x/src/accept_alu.rs", "crates/x/src/sneaky.rs"],
    writes: ["crates/x/src/alu.rs"],
    seeds: ["crates/x/src/accept_alu.rs"],
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.outside, ["crates/x/src/sneaky.rs"]);
});
