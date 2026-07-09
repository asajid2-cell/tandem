import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PEER = join(ROOT, "bin", "peer.mjs");
const HOOK = join(ROOT, "bin", "drive-stophook.mjs");

function tempDriveDir() {
  return mkdtempSync(join(tmpdir(), "tandem-drive-"));
}

function runNode(script, args, driveDir) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, TANDEM_DRIVE_DIR: driveDir },
  });
}

function runPeer(args, driveDir) {
  const r = runNode(PEER, args, driveDir);
  assert.equal(r.status, 0, r.stderr);
  return r;
}

function runHook(driveDir) {
  const r = runNode(HOOK, [], driveDir);
  assert.equal(r.status, 0, r.stderr);
  return r;
}

test("drive Stop hook consumes directives FIFO and marks progress", () => {
  const dir = tempDriveDir();
  runPeer(["drive", "--start", "--cap", "2", "first directive"], dir);
  runPeer(["drive", "second directive"], dir);

  const one = JSON.parse(runHook(dir).stdout);
  assert.equal(one.decision, "block");
  assert.equal(one.reason, "first directive");

  const two = JSON.parse(runHook(dir).stdout);
  assert.equal(two.decision, "block");
  assert.equal(two.reason, "second directive");

  const status = runPeer(["drive", "--status"], dir).stdout;
  assert.match(status, /counter: 2\/2/);
  assert.match(status, /pending: 0/);
  assert.match(status, /done: 2/);
});

test("drive Stop hook fails open when cap is reached", () => {
  const dir = tempDriveDir();
  runPeer(["drive", "--start", "--cap", "1", "only directive"], dir);

  assert.equal(JSON.parse(runHook(dir).stdout).reason, "only directive");
  const capped = runHook(dir);
  assert.equal(capped.stdout, "");
  assert.match(capped.stderr, /drive cap reached/);
});

test("drive --stop disables the hook and records a stop sentinel", () => {
  const dir = tempDriveDir();
  runPeer(["drive", "--start", "queued directive"], dir);
  runPeer(["drive", "--stop"], dir);

  assert.equal(runHook(dir).stdout, "");
  const status = runPeer(["drive", "--status"], dir).stdout;
  assert.match(status, /enabled: false/);
  assert.match(status, /stops: 1/);
  assert.match(status, /pending: 1/);
});
