// Contract tests for the fleet inbox: the push channel that replaces per-swarm polling waits.
// All modelless. The signalDone integration proves the choke-point wiring: ANY terminal job
// record (finishDispatch / forceFinishDispatch / serve's legacy finishes — all call signalDone)
// lands one turn-done event in the fleet inbox.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

// D5 (live wave-0 finding): a turn-done event fired for a job that was still running. The event
// is a HINT; the job record is truth. A confirmed wait must re-read the record and ignore any
// event whose job is not actually terminal.
test("D5: waitForEvent with confirm ignores an event whose job record is still running", async () => {
  const root = freshTmp("inbox-confirm-");
  const state = join(root, "lane");
  mkdirSync(state, { recursive: true });
  const fleet = join(root, "fleet");
  // a RUNNING job record, and a (false) turn-done event pointing at it
  writeFileSync(join(state, "job-sk1.json"), JSON.stringify({ status: "running", dispatchId: "d1" }));
  const since = Date.now() - 1;
  appendEvent(fleet, { kind: "turn-done", state, sk: "sk1", dispatchId: "d1", status: "done", laneId: "s/a" });
  const ignored = await waitForEvent(fleet, { sinceTs: since, timeoutSec: 1, pollMs: 100, confirm: true });
  assert.equal(ignored, null, "a false turn-done must not wake a confirmed waiter");
  // now the job really finishes; the same event becomes valid
  writeFileSync(join(state, "job-sk1.json"), JSON.stringify({ status: "done", dispatchId: "d1" }));
  const woken = await waitForEvent(fleet, { sinceTs: since, timeoutSec: 3, pollMs: 100, confirm: true });
  assert.equal(woken?.laneId, "s/a");
});

test("D4: one verify run appends exactly ONE ledger record per lane, and dedupe keeps the last", async () => {
  const { readLedger, appendLedger } = await import("../bin/lane-ledger.mjs");
  const { dedupeLedger } = await import("../bin/lane-ledger.mjs");
  const dir = freshTmp("ledger-dedupe-");
  const file = join(dir, "ledger.jsonl");
  // the wave-0 symptom: 8 records for 4 verified lanes → any $/proven-leaf is 2x off
  appendLedger(file, { swarm: "w", lane: "a", dispatchId: "d1", verify: "fail", output_tokens: 1 });
  appendLedger(file, { swarm: "w", lane: "a", dispatchId: "d1", verify: "pass-proven", output_tokens: 2 });
  appendLedger(file, { swarm: "w", lane: "b", dispatchId: "d2", verify: "pass-proven", output_tokens: 3 });
  assert.equal(readLedger(file).length, 3, "the raw ledger stays append-only (audit trail)");
  const deduped = dedupeLedger(readLedger(file));
  assert.equal(deduped.length, 2, "one row per (swarm,lane,dispatchId)");
  assert.equal(deduped.find((r) => r.lane === "a").verify, "pass-proven", "last write wins");
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
