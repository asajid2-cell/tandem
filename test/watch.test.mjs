// Tests for the watcher's group/liveness logic — especially the live "synthesis" that mispaired
// the wrong Claude with the wrong Codex in the field. Isolated via TANDEM_STATE (set before import
// so watch.mjs binds its state dir to a temp). watch.mjs is imported (not served) thanks to its
// main-guard, so no port is bound and no browser opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "tandem-watch-"));
process.env.TANDEM_STATE = STATE;
process.env.TANDEM_NO_OPEN = "1";
const { groupsList } = await import("../bin/watch.mjs");
process.on("exit", () => {
  try {
    rmSync(STATE, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const writeGroups = (g) => writeFileSync(join(STATE, "groups.json"), JSON.stringify(g));
const writeLog = (lines) => writeFileSync(join(STATE, "tandem.log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const now = Date.now();

test("synthesis pairs the REAL driver from the delegate, never auto/newest (the mispairing bug)", () => {
  writeGroups({ seq: 1, groups: {} }); // nothing recorded yet — only an in-flight delegation
  writeLog([{ type: "delegate", driver: "claude", partner: "codex", driverId: "realClaudeDrv", partnerId: "realCodex", ts: now }]);
  const forming = groupsList().find((x) => x.n === 0);
  assert.ok(forming, "an in-flight pair should show as a forming entry");
  assert.equal(forming.claudeId, "realClaudeDrv", "must use the actual driver, not the newest session");
  assert.equal(forming.codexId, "realCodex");
});

test("synthesis refuses to guess when the delegate carries no ids (no auto mispairing)", () => {
  writeGroups({ seq: 1, groups: {} });
  writeLog([{ type: "delegate", driver: "claude", partner: "codex", ts: now }]); // old-style: no driverId/partnerId
  assert.equal(groupsList().find((x) => x.n === 0), undefined, "must NOT invent an auto-paired forming entry");
});

test("a recorded pair with recent activity is marked live", () => {
  writeGroups({ seq: 2, groups: { "C1|X1": { n: 1, claudeId: "C1", codexId: "X1", direction: "claude->codex", firstTs: now, lastTs: now } } });
  writeLog([]);
  const rec = groupsList().find((x) => x.claudeId === "C1");
  assert.ok(rec);
  assert.equal(rec.live, true);
});

test("an old recorded pair is NOT live (belongs to history)", () => {
  const old = now - 3 * 60 * 60 * 1000; // 3h ago, well past the live window
  writeGroups({ seq: 2, groups: { "C2|X2": { n: 1, claudeId: "C2", codexId: "X2", direction: "claude->codex", firstTs: old, lastTs: old } } });
  writeLog([]);
  const rec = groupsList().find((x) => x.claudeId === "C2");
  assert.ok(rec);
  assert.equal(rec.live, false);
});
