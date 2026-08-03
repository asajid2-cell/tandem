// Driver-side contract tests for the fleet layer of swarm.mjs:
// fleetDir resolution, TANDEM_FLEET_DIR / TANDEM_PROFILE propagation, and the prepareSwarm
// gates (sealed-brief lint, write-scope vs manifest AND vs live registry, registry stamping).
// prepareSwarm never dispatches, so all of this runs modelless and offline.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fleetDir, laneEnvironment, prepareSwarm } from "../bin/swarm.mjs";
import { registerSession } from "../bin/fleet-registry.mjs";

const SEALED_BRIEF = `You are a junior implementation agent. Build ONE tiny module to this frozen contract.
Do NOT read or modify any existing file. Create exactly the one DELIVERABLE file.

DELIVERABLE: out.mjs
VERIFY: node -e "process.exit(0)"

## FROZEN CONTRACT
The file out.mjs exports exactly: export const OK = true; nothing else, no side effects.

## SELF-CHECK
Run the VERIFY command; it must exit 0.

## REPORT FORMAT
VERDICT: BUILT|FAILED
AMBIGUITIES: list every judgment call this contract did not decide (or "none")
`;

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

function writeManifest(dir, manifest) {
  const file = join(dir, "swarm.json");
  // these fixtures predate the verifier-custody gate and exercise OTHER contracts (registry
  // stamping, parent links, scope overlap), so they opt out the way a throwaway harness does.
  // The gate itself is covered in test/custody-gates.test.mjs and by the test below.
  writeFileSync(file, JSON.stringify({ custody: false, ...manifest }));
  return file;
}

function sealedLane(name, extra = {}) {
  return {
    name,
    task: SEALED_BRIEF,
    writes: [`${name}-out.mjs`],
    verify: 'node -e "process.exit(0)"',
    ...extra,
  };
}

function prep(root, state, manifestPath, name = "t") {
  return prepareSwarm({
    root,
    parentState: state,
    driverId: "drv-1",
    name,
    manifestPath,
    baseCwd: root,
  });
}

test("fleetDir: env override > TANDEM_STATE isolation > repo default", () => {
  const root = freshTmp("fleetdir-");
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: undefined }, () => {
    assert.equal(fleetDir(root), join(root, "tandems", ".fleet"));
  });
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: join(root, "st") }, () => {
    assert.equal(fleetDir(root), join(resolve(join(root, "st")), "fleet"));
  });
  withEnv({ TANDEM_FLEET_DIR: join(root, "pinned") }, () => {
    assert.equal(fleetDir(root), join(root, "pinned"));
  });
});

test("laneEnvironment: propagates parent TANDEM_FLEET_DIR verbatim and TANDEM_PROFILE per lane", () => {
  const root = freshTmp("laneenv-");
  const lane = {
    state: join(root, "tandems", "s--lane"),
    label: "s--lane",
    laneId: "s/lane",
    cwd: root,
    profile: "deepseek-flash",
  };
  const withParent = laneEnvironment(lane, { TANDEM_FLEET_DIR: join(root, "pinned") });
  assert.equal(withParent.TANDEM_FLEET_DIR, join(root, "pinned"));
  assert.equal(withParent.TANDEM_PROFILE, "deepseek-flash");
  // role flows into lane env: juniors by default (runtime lanes always carry a role),
  // branch-mind when the manifest says so
  assert.equal(laneEnvironment({ ...lane, role: "junior" }, {}).TANDEM_ROLE, "junior");
  assert.equal(laneEnvironment({ ...lane, role: "branch-mind" }, {}).TANDEM_ROLE, "branch-mind");
  const noProfile = laneEnvironment({ ...lane, profile: "" }, { TANDEM_FLEET_DIR: join(root, "pinned") });
  assert.equal(noProfile.TANDEM_PROFILE, undefined);
  // without a parent value the fallback still lands on ONE shared fleet dir for the tree
  const derived = withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: undefined }, () =>
    laneEnvironment(lane, {}),
  );
  assert.equal(derived.TANDEM_FLEET_DIR, join(root, "tandems", ".fleet"));
});

test("prepareSwarm: gates pass, registry stamped with driver->junior edge, charter, state, profile-as-model", () => {
  const root = freshTmp("prep-ok-");
  const state = join(root, "st");
  mkdirSync(state, { recursive: true });
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: state }, () => {
    const manifestPath = writeManifest(root, {
      lanes: [sealedLane("a"), sealedLane("b", { profile: "deepseek-flash" })],
    });
    const record = prep(root, state, manifestPath, "ok");
    assert.equal(record.setupStatus, "ready");
    assert.equal(record.lanes[1].profile, "deepseek-flash");
    assert.equal(record.lanes[0].role, "junior", "lanes default to the junior role");
    const registry = JSON.parse(readFileSync(join(state, "fleet", "registry.json"), "utf8"));
    const sessions = registry.sessions;
    assert.equal(sessions["drv-1"].kind, "branch");
    assert.equal(sessions["ok/a"].parent, "drv-1");
    assert.equal(sessions["ok/a"].kind, "junior");
    assert.ok(sessions["ok/a"].charter.includes("FROZEN CONTRACT"));
    assert.ok(sessions["ok/a"].state.length > 0, "lane state dir recorded for fleet-doctor");
    assert.equal(sessions["ok/b"].model, "deepseek-flash", "profile wins as the recorded model");
  });
});

test("prepareSwarm: TANDEM_PARENT_ID links a forked mind under its parent; unknown parent falls back to root", () => {
  const root = freshTmp("prep-parent-");
  const state = join(root, "st");
  mkdirSync(state, { recursive: true });
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: state }, () => {
    const fleet = join(state, "fleet");
    registerSession(fleet, { id: "apex-1", kind: "apex", label: "apex" });
    const manifestPath = writeManifest(root, { lanes: [sealedLane("a")] });
    // a branch mind forked BY the apex knows its parent
    withEnv({ TANDEM_PARENT_ID: "apex-1", TANDEM_ROLE: "branch-mind", TANDEM_LABEL: "bm-1" }, () => {
      prepareSwarm({ root, parentState: state, driverId: "bm-drv", name: "bm", manifestPath, baseCwd: root });
    });
    const sessions = JSON.parse(readFileSync(join(fleet, "registry.json"), "utf8")).sessions;
    assert.equal(sessions["bm-drv"].parent, "apex-1", "branch mind hangs under the apex, not as a root");
    assert.equal(sessions["bm-drv"].label, "bm-1");
    assert.equal(sessions["bm/a"].parent, "bm-drv", "its juniors hang under it — one connected tree");
    // a stale/unknown parent must not refuse the swarm: register as a root instead
    const dir2 = join(root, "x2");
    mkdirSync(dir2, { recursive: true });
    const manifest2 = writeManifest(dir2, { lanes: [sealedLane("b")] });
    withEnv({ TANDEM_PARENT_ID: "ghost-id" }, () => {
      prepareSwarm({ root, parentState: state, driverId: "orphan-drv", name: "orph", manifestPath: manifest2, baseCwd: root });
    });
    const after = JSON.parse(readFileSync(join(fleet, "registry.json"), "utf8")).sessions;
    assert.equal(after["orphan-drv"].parent, null, "unknown parent fails SAFE (root), never refuses dispatch");
  });
});

test("laneEnvironment: a lane's own id becomes TANDEM_PARENT_ID for anything it forks", () => {
  const root = freshTmp("lane-parent-");
  const env = laneEnvironment({ state: join(root, "s"), label: "s--l", laneId: "s/l", cwd: root }, {});
  assert.equal(env.TANDEM_PARENT_ID, "s/l");
});

test("prepareSwarm: missing writes[] refused before reserving anything", () => {
  const root = freshTmp("prep-neg1-");
  const state = join(root, "st");
  mkdirSync(state, { recursive: true });
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: state }, () => {
    const lane = sealedLane("a");
    delete lane.writes;
    const manifestPath = writeManifest(root, { lanes: [lane] });
    assert.throws(() => prep(root, state, manifestPath, "neg1"), /writes\[\] required/);
    assert.ok(!existsSync(join(state, "swarms", "neg1.json")), "no swarm record reserved");
  });
});

test("prepareSwarm: cross-lane overlap refused even across declaration styles", () => {
  const root = freshTmp("prep-neg2-");
  const state = join(root, "st");
  mkdirSync(state, { recursive: true });
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: state }, () => {
    const manifestPath = writeManifest(root, {
      lanes: [
        sealedLane("a", { writes: ["shared.mjs"] }),
        sealedLane("b", { writes: ["./SHARED.MJS"] }),
      ],
    });
    assert.throws(() => prep(root, state, manifestPath, "neg2"), /write-scope gate failed/);
  });
});

test("prepareSwarm: overlap with a LIVE registry session refused; a done session does not block", () => {
  const root = freshTmp("prep-neg3-");
  const state = join(root, "st");
  mkdirSync(state, { recursive: true });
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: state }, () => {
    const fleet = join(state, "fleet");
    registerSession(fleet, {
      id: "other-branch",
      kind: "branch",
      writes: [resolve(root, "taken.mjs")],
    });
    const manifestPath = writeManifest(root, {
      lanes: [sealedLane("a", { writes: ["taken.mjs"], cwd: root })],
    });
    assert.throws(() => prep(root, state, manifestPath, "neg3"), /LIVE sessions/);
  });
});

test("prepareSwarm: non-sealed brief refused with rule ids; gates:false bypasses loudly", () => {
  const root = freshTmp("prep-neg4-");
  const state = join(root, "st");
  mkdirSync(state, { recursive: true });
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: state }, () => {
    const badLane = { name: "bad", task: "just wing it", writes: ["x.mjs"], verify: "node -e 1" };
    const refused = writeManifest(root, { lanes: [badLane] });
    assert.throws(() => prep(root, state, refused, "neg4"), /R1-contract/);
    const bypassed = writeManifest(root, { gates: false, lanes: [badLane] });
    const record = prep(root, state, bypassed, "neg4b");
    assert.equal(record.setupStatus, "ready");
  });
});

test("the verifier-custody gate is ON by default: a lane with no apex-owned grader is refused", () => {
  const root = freshTmp("prep-custody-");
  const state = join(root, "st");
  mkdirSync(state, { recursive: true });
  withEnv({ TANDEM_FLEET_DIR: undefined, TANDEM_STATE: state }, () => {
    const file = join(root, "custody.json");
    // note: NO "custody": false here — this is what a real manifest looks like
    writeFileSync(file, JSON.stringify({ lanes: [sealedLane("a")] }));
    assert.throws(() => prep(root, state, file, "custody"), /verifier custody gate failed/);
  });
});
