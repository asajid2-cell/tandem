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

// ---- defects found by the live wave-0 campaign (written BEFORE the fix, TDD) ----------------

test("D1: a verifier that asserts NOTHING is VACUOUS, not PASS-PROVEN (exit codes are not proof)", () => {
  const { cwd } = gitRepo();
  writeFileSync(join(cwd, "out.txt"), "WORK\n");
  // The wave-0 hole: the lane's file is needed to COMPILE (so withholding is red) but the test
  // filter matches nothing, so green is exit-0 with zero assertions run. Old code: PASS-PROVEN.
  const verify = `node -e "if(!require('fs').existsSync('out.txt'))process.exit(1);console.log('test result: ok. 0 passed; 0 failed; 0 filtered out')"`;
  const r = proveRedLane({ cwd, writes: ["out.txt"], verify, timeoutSec: 60 });
  assert.equal(r.ok, false, "a zero-assertion green must never certify");
  assert.equal(r.vacuous, true);
  assert.match(r.detail, /no assertions|0 passed|zero tests/i);
});

test("D1b: expectGreen pins WHAT the green must prove; a green that misses it does not certify", () => {
  const { cwd } = gitRepo();
  writeFileSync(join(cwd, "out.txt"), "WORK\n");
  const verify = `node -e "process.exit(require('fs').existsSync('out.txt')?0:1)"`;
  const miss = proveRedLane({ cwd, writes: ["out.txt"], verify, timeoutSec: 60, expectGreen: /12 passed/ });
  assert.equal(miss.ok, false);
  assert.match(miss.detail, /expectGreen/i);
  const hit = proveRedLane({
    cwd,
    writes: ["out.txt"],
    verify: `node -e "if(!require('fs').existsSync('out.txt'))process.exit(1);console.log('12 passed')"`,
    timeoutSec: 60,
    expectGreen: /12 passed/,
  });
  assert.equal(hit.ok, true, hit.detail);
});

test("D2: a red caused by a TIMEOUT is INCONCLUSIVE — can't-measure is not proof-of-red", () => {
  const { cwd } = gitRepo();
  writeFileSync(join(cwd, "out.txt"), "WORK\n");
  // hangs while the file is withheld (red phase), passes fast once restored — the exact shape
  // that used to certify PASS-PROVEN off an infrastructure failure
  const verify = `node -e "const fs=require('fs');if(!fs.existsSync('out.txt')){setTimeout(()=>{},60000)}else{console.log('1 passed');process.exit(0)}"`;
  const r = proveRedLane({ cwd, writes: ["out.txt"], verify, timeoutSec: 2 });
  assert.equal(r.ok, false, "an unmeasurable red must never certify");
  assert.equal(r.inconclusive, true);
  assert.equal(r.vacuous, false, "inconclusive is NOT the same as vacuous");
  assert.match(r.detail, /INCONCLUSIVE|timed out|could not measure/i);
});

test("D2b: expectRed pins the red's CAUSE — a red for the wrong reason does not certify", () => {
  const { cwd } = gitRepo();
  writeFileSync(join(cwd, "out.txt"), "WORK\n");
  const verify = `node -e "if(!require('fs').existsSync('out.txt')){console.error('some unrelated failure');process.exit(1)}console.log('1 passed')"`;
  const wrong = proveRedLane({ cwd, writes: ["out.txt"], verify, timeoutSec: 60, expectRed: /E0583|file not found for module/ });
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /expectRed/i);
  const right = proveRedLane({ cwd, writes: ["out.txt"], verify, timeoutSec: 60, expectRed: /unrelated failure/ });
  assert.equal(right.ok, true, right.detail);
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
