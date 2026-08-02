// Contract tests for session branding: the stable [TANDEM ...] first-line brand + the fleet
// sessions manifest that lets chat tooling hide bridge-spawned sessions by ID. Modelless.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRAND_PREFIX,
  brandLine,
  brandTask,
  readSpawnedSessions,
  recordSpawnedSession,
  sessionsManifestPath,
} from "../bin/brand.mjs";

test("brandLine: stable prefix, label and lane included when present", () => {
  const bare = brandLine();
  assert.ok(bare.startsWith(`${BRAND_PREFIX} session`));
  assert.ok(bare.endsWith("safe to filter from chat backlogs]"));
  const full = brandLine({ kind: "codex-partner", label: "fleet-a--fl-scope", laneId: "fleet-a/fl-scope" });
  assert.ok(full.includes("codex-partner"));
  assert.ok(full.includes("label=fleet-a--fl-scope"));
  assert.ok(full.includes("lane=fleet-a/fl-scope"));
});

test("brandTask: brand is the FIRST line (it titles the session), task preserved below", () => {
  const branded = brandTask("[tandem-coupling:abc; internal continuity marker - ignore this line]\ndo the work", {
    kind: "codex-partner",
    label: "x",
  });
  const lines = branded.split("\n");
  assert.ok(lines[0].startsWith(BRAND_PREFIX));
  assert.ok(lines[1].startsWith("[tandem-coupling:abc"), "coupling marker survives untouched below the brand");
  assert.equal(lines[2], "do the work");
});

test("brandTask: idempotent — an already-branded task is returned untouched", () => {
  const once = brandTask("work", { label: "a" });
  const twice = brandTask(once, { label: "b" });
  assert.equal(twice, once);
});

test("sessions manifest: append + read roundtrip, ts stamped, last-n, missing file empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "brand-manifest-"));
  assert.deepEqual(readSpawnedSessions(0, dir), []);
  const rec = recordSpawnedSession(
    { provider: "codex", sessionId: "sid-1", kind: "lane", label: "sw--a", laneId: "sw/a", cwd: "c:/x" },
    dir,
  );
  assert.ok(rec.ts > 0);
  recordSpawnedSession({ provider: "claude", sessionId: "sid-2", kind: "claude-partner" }, dir);
  const all = readSpawnedSessions(0, dir);
  assert.equal(all.length, 2);
  assert.equal(all[0].sessionId, "sid-1");
  assert.equal(all[0].laneId, "sw/a");
  const last = readSpawnedSessions(1, dir);
  assert.equal(last[0].sessionId, "sid-2");
  assert.ok(sessionsManifestPath(dir).endsWith("sessions.jsonl"));
});

test("recordSpawnedSession never throws — a bad dir returns null instead of breaking a spawn", () => {
  const result = recordSpawnedSession({ provider: "codex", sessionId: "x" }, "\0invalid\0path");
  assert.equal(result, null);
});
