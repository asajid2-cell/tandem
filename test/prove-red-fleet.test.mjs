// Contract tests for the fleet-native prove-red probe: withhold the lane's declared writes,
// demand RED, restore, demand GREEN. Modelless; uses throwaway git repos.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proveRedLane } from "../bin/prove-red.mjs";

function gitRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "prove-red-fx-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t.invalid");
  git("config", "user.name", "t");
  writeFileSync(join(cwd, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-qm", "base");
  return { cwd, git };
}

const CHECK_OUT = `node -e "process.exit(require('fs').existsSync('out.txt') && require('fs').readFileSync('out.txt','utf8').includes('WORK') ? 0 : 1)"`;

test("created-file lane: red when withheld, green restored — ok", () => {
  const { cwd } = gitRepo();
  writeFileSync(join(cwd, "out.txt"), "WORK\n");
  const r = proveRedLane({ cwd, writes: ["out.txt"], verify: CHECK_OUT, timeoutSec: 60 });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.vacuous, false);
  assert.equal(readFileSync(join(cwd, "out.txt"), "utf8"), "WORK\n", "work restored after probe");
});

test("vacuous verifier: passes with the work withheld — detected, work restored", () => {
  const { cwd } = gitRepo();
  writeFileSync(join(cwd, "out.txt"), "WORK\n");
  const r = proveRedLane({ cwd, writes: ["out.txt"], verify: 'node -e "process.exit(0)"', timeoutSec: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.vacuous, true);
  assert.match(r.detail, /VACUOUS/);
  assert.ok(existsSync(join(cwd, "out.txt")), "work restored even on a vacuous verdict");
});

test("modified tracked file: withhold = restore HEAD content, then work restored", () => {
  const { cwd } = gitRepo();
  writeFileSync(join(cwd, "base.txt"), "base\nWORK\n");
  const verify = `node -e "process.exit(require('fs').readFileSync('base.txt','utf8').includes('WORK')?0:1)"`;
  const r = proveRedLane({ cwd, writes: ["base.txt"], verify, timeoutSec: 60 });
  assert.equal(r.ok, true, r.detail);
  assert.equal(readFileSync(join(cwd, "base.txt"), "utf8"), "base\nWORK\n");
});

test("work already committed: refused — withholding would restore the work itself", () => {
  const { cwd, git } = gitRepo();
  writeFileSync(join(cwd, "base.txt"), "base\nWORK\n");
  git("add", "base.txt");
  git("commit", "-qm", "lane work committed too early");
  const r = proveRedLane({ cwd, writes: ["base.txt"], verify: 'node -e "process.exit(0)"', timeoutSec: 60 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /BEFORE the lane's work is committed/);
});

test("degenerate inputs: no verify / no writes / nothing on disk — refused with reasons", () => {
  const { cwd } = gitRepo();
  assert.match(proveRedLane({ cwd, writes: ["x"], verify: "" }).detail, /no verify/);
  assert.match(proveRedLane({ cwd, writes: [], verify: "node -e 1" }).detail, /no writes/);
  assert.match(proveRedLane({ cwd, writes: ["ghost.txt"], verify: "node -e 1" }).detail, /wrote nothing/);
});

test("green-fails-after-restore is reported as FAIL, not vacuous", () => {
  const { cwd } = gitRepo();
  writeFileSync(join(cwd, "out.txt"), "WORK\n");
  // verifier red both with and without the work
  const r = proveRedLane({ cwd, writes: ["out.txt"], verify: 'node -e "process.exit(1)"', timeoutSec: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.red, true);
  assert.equal(r.green, false);
  assert.equal(r.vacuous, false);
  assert.match(r.detail, /GREEN failed/);
});
