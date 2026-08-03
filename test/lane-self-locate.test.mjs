// Self-location: a partner session finding out WHICH LANE IT IS.
//
// This is the gap that made the whole apex protocol dead from the inside. `partnerEnv` scrubs
// TANDEM_STATE/TANDEM_LABEL before spawning a partner, and the CLI re-sets
// CLAUDE_CODE_SESSION_ID in the partner's Bash children — so when the apex ran `fleet context`
// or `fleet refresh` per doctrine, peer.mjs derived a state dir from the apex's OWN session id,
// landed on a directory that does not exist, measured 0, and did nothing. Silently.
//
// Recorded identity makes the reverse lookup possible: serve writes its session id into its lane
// state dir, so a session can find its own lane by matching that id.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateOwnLane } from "../bin/apex-gate.mjs";

function lanesRoot() {
  return mkdtempSync(join(tmpdir(), "selfloc-"));
}

function makeLane(root, label, sessionId, extra = {}) {
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  if (sessionId) writeFileSync(join(dir, "claude.session"), sessionId);
  writeFileSync(join(dir, "serve.bound.json"), JSON.stringify({ label, role: "apex", fleetDir: `/fleet/${label}`, stateDir: dir, ...extra }));
  return dir;
}

test("a session finds its own lane by the session id serve recorded", () => {
  const root = lanesRoot();
  makeLane(root, "other-lane", "1111-aaaa");
  const mine = makeLane(root, "astro-apex", "35f74aad-81e0-40fc-a1c4-17e49b506fb8");
  const found = locateOwnLane("35f74aad-81e0-40fc-a1c4-17e49b506fb8", root);
  assert.equal(found.stateDir, mine);
  assert.equal(found.label, "astro-apex");
  assert.equal(found.fleetDir, "/fleet/astro-apex", "and its LEDGER — the wrong-directory bug, closed at the source");
  assert.equal(found.role, "apex");
});

test("an unknown session id locates nothing — and says so rather than guessing a directory", () => {
  const root = lanesRoot();
  makeLane(root, "some-lane", "aaaa-bbbb");
  const found = locateOwnLane("not-a-known-session", root);
  assert.equal(found.stateDir, "");
  assert.equal(found.found, false);
});

test("no session id at all locates nothing (never falls back to a shared default)", () => {
  const root = lanesRoot();
  makeLane(root, "some-lane", "aaaa-bbbb");
  // the .state fallback is exactly how one campaign ended up with two apex bodies sharing a ledger
  assert.equal(locateOwnLane("", root).found, false);
  assert.equal(locateOwnLane(null, root).found, false);
});

test("a lane whose recorded session does not match is not claimed", () => {
  const root = lanesRoot();
  makeLane(root, "lane-a", "aaaa");
  makeLane(root, "lane-b", "bbbb");
  assert.equal(locateOwnLane("aaaa", root).label, "lane-a");
  assert.equal(locateOwnLane("bbbb", root).label, "lane-b");
});

test("a lane directory with no recorded session is skipped, not crashed on", () => {
  const root = lanesRoot();
  mkdirSync(join(root, "empty-lane"), { recursive: true });
  makeLane(root, "real-lane", "cccc");
  assert.equal(locateOwnLane("cccc", root).label, "real-lane");
});

test("a missing lanes root yields nothing found, never a throw", () => {
  assert.equal(locateOwnLane("anything", join(tmpdir(), "no-such-root-98765")).found, false);
});
