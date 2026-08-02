// Contract tests for the fleet inbox: the push channel that replaces per-swarm polling waits.
// All modelless. The signalDone integration proves the choke-point wiring: ANY terminal job
// record (finishDispatch / forceFinishDispatch / serve's legacy finishes — all call signalDone)
// lands one turn-done event in the fleet inbox.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, defaultFleetDir, fleetDirFor, inboxPath, readEvents, waitForEvent } from "../bin/fleet-inbox.mjs";
import { forceFinishDispatch } from "../bin/jobs.mjs";

function freshTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("fleetDirFor: env pin > TANDEM_STATE isolation > repo default", () => {
  const root = freshTmp("inboxdir-");
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: undefined }, () => {
    assert.equal(fleetDirFor(root), join(root, "tandems", ".fleet"));
  });
  withEnv({ TANDEM_FLEET_DIR: join(root, "pin") }, () => {
    assert.equal(fleetDirFor(root), join(root, "pin"));
    assert.equal(defaultFleetDir(), join(root, "pin"));
  });
});

test("append/read roundtrip, ts stamped, torn tail line skipped, last-n", () => {
  const dir = freshTmp("inbox-rw-");
  const first = appendEvent(dir, { kind: "turn-done", laneId: "s/a" });
  assert.ok(first.ts > 0);
  appendEvent(dir, { kind: "turn-done", laneId: "s/b" });
  appendEvent(dir, { kind: "turn-done", laneId: "s/c" });
  // simulate a torn mid-append tail
  appendFileSync(inboxPath(dir), '{"kind":"turn-do');
  const all = readEvents(dir);
  assert.equal(all.length, 3);
  assert.deepEqual(readEvents(dir, 2).map((e) => e.laneId), ["s/b", "s/c"]);
});

test("waitForEvent: resolves on a FUTURE append (push), ignores events at/before sinceTs", async () => {
  const dir = freshTmp("inbox-wait-");
  appendEvent(dir, { kind: "turn-done", laneId: "old/1" });
  const since = Date.now();
  const pending = waitForEvent(dir, { sinceTs: since, timeoutSec: 10, pollMs: 100 });
  setTimeout(() => appendEvent(dir, { kind: "turn-done", laneId: "new/1" }), 150);
  const event = await pending;
  assert.equal(event?.laneId, "new/1");
});

test("waitForEvent: filter scopes the wake (swarm prefix), non-matching events don't wake", async () => {
  const dir = freshTmp("inbox-filter-");
  const since = Date.now();
  const pending = waitForEvent(dir, {
    sinceTs: since,
    timeoutSec: 10,
    pollMs: 100,
    filter: (e) => typeof e.laneId === "string" && e.laneId.startsWith("wanted/"),
  });
  setTimeout(() => appendEvent(dir, { kind: "turn-done", laneId: "other/x" }), 100);
  setTimeout(() => appendEvent(dir, { kind: "turn-done", laneId: "wanted/y" }), 300);
  const event = await pending;
  assert.equal(event?.laneId, "wanted/y");
});

test("waitForEvent: timeout resolves null, never throws", async () => {
  const dir = freshTmp("inbox-timeout-");
  const event = await waitForEvent(dir, { timeoutSec: 1, pollMs: 100 });
  assert.equal(event, null);
});

test("signalDone choke point: a terminal job record lands a turn-done inbox event with lane identity", async () => {
  const root = freshTmp("inbox-choke-");
  const state = join(root, "lane-state");
  mkdirSync(state, { recursive: true });
  const fleet = join(root, "fleet");
  await withEnvAsync(
    { TANDEM_FLEET_DIR: fleet, TANDEM_LANE_ID: "sw/lane-1", TANDEM_LABEL: "sw--lane-1" },
    async () => {
      const since = Date.now() - 1;
      forceFinishDispatch(state, "sk1", { status: "done", verdict: "ok" });
      const event = await waitForEvent(fleet, { sinceTs: since, timeoutSec: 5, pollMs: 100 });
      assert.equal(event?.kind, "turn-done");
      assert.equal(event?.laneId, "sw/lane-1");
      assert.equal(event?.status, "done");
      assert.equal(event?.sk, "sk1");
    },
  );
});

async function withEnvAsync(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
