import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { inspectDispatch, readJson, writeJsonAtomic } from "./jobs.mjs";
import { jobKey, sanitizeLabel } from "./groups.mjs";
import { ensureLaneWorktree, writeLaneMetadata } from "./worktrees.mjs";
import { checkAgainstLive, checkLaneScopes, checkVerifyCustody } from "./write-scope.mjs";
import { fleetDirFor } from "./fleet-inbox.mjs";
import { lintBrief } from "./brief-lint.mjs";
import { getSession, liveWriteScopes, registerSession, updateStatus } from "./fleet-registry.mjs";
import { ensureRegistered } from "./fleet-identity.mjs";
import { hashSeeds } from "./lane-seeds.mjs";
import { heal } from "./fleet-doctor.mjs";


// One fleet registry per driver context. TANDEM_FLEET_DIR (propagated into every lane env by
// laneEnvironment) pins nested swarms — a lane that opens its own swarm — into the SAME family
// tree instead of forking a private registry per nesting level. Without it, TANDEM_STATE keeps
// test/CI harnesses isolated in their own registry, and the default is the repo-level fleet.
// Resolution logic lives in fleet-inbox.mjs (jobs.mjs needs it too, and importing swarm.mjs
// from jobs.mjs would be a cycle).
export function fleetDir(root) {
  return fleetDirFor(root);
}

function storage(root, parentState) {
  if (process.env.TANDEM_STATE) {
    const base = resolve(parentState);
    return {
      registry: join(base, "swarms"),
      lanes: join(base, "lanes"),
    };
  }
  return {
    registry: join(root, "tandems", ".swarms"),
    lanes: join(root, "tandems"),
  };
}

export function swarmFile(root, parentState, name) {
  return join(storage(root, parentState).registry, `${sanitizeLabel(name)}.json`);
}

export function readSwarm(root, parentState, name) {
  return readJson(swarmFile(root, parentState, name));
}

function resolveFrom(base, value) {
  if (!value) return "";
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function laneTask(lane, manifestDir) {
  if (typeof lane.task === "string" && lane.task.trim()) return lane.task;
  if (lane.taskFile) return readFileSync(resolveFrom(manifestDir, lane.taskFile), "utf8");
  throw new Error(`lane "${lane.name || lane.label || "?"}" needs a non-empty task or taskFile`);
}

function scopedLaneLabel(swarmName, laneName) {
  const combined = `${swarmName}--${laneName}`;
  if (combined.length <= 60) return combined;
  const hash = createHash("sha256").update(combined).digest("hex").slice(0, 8);
  const prefix = combined.slice(0, 51).replace(/^[-.]+|[-.]+$/g, "") || "swarm-lane";
  return `${prefix}-${hash}`;
}

function reserveSwarm(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, JSON.stringify(record), { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`swarm "${record.name}" already exists; use its status/ask commands or choose a new name`);
    }
    throw error;
  }
}

function claimLaneState(state, laneId) {
  mkdirSync(dirname(state), { recursive: true });
  try {
    mkdirSync(state);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`lane state already exists for ${laneId}: ${state}; refusing to reuse a possibly coupled lane`);
    }
    throw error;
  }
}

export function prepareSwarm({
  root,
  parentState,
  driverId,
  name,
  manifestPath,
  baseCwd,
  wedgeAfterSec = 60,
  stallSec = 240,
}) {
  if (!name || !name.trim()) throw new Error("swarm name is required");
  if (!manifestPath) throw new Error("manifest path is required");
  const cleanName = sanitizeLabel(name);
  const file = swarmFile(root, parentState, cleanName);

  const absoluteManifest = resolve(manifestPath);
  const manifestDir = dirname(absoluteManifest);
  const source = JSON.parse(readFileSync(absoluteManifest, "utf8"));
  if (!Array.isArray(source.lanes) || source.lanes.length === 0) {
    throw new Error("manifest must contain a non-empty lanes array");
  }

  const seen = new Set();
  const laneRoot = storage(root, parentState).lanes;
  const runtime = source.lanes.map((lane, index) => {
    const laneName = sanitizeLabel(lane.name || lane.label || `lane-${index + 1}`);
    const label = scopedLaneLabel(cleanName, laneName);
    if (seen.has(label)) {
      throw new Error(`duplicate lane label after sanitization: "${label}"`);
    }
    seen.add(label);
    const state = join(laneRoot, label);
    const cwd = resolveFrom(manifestDir, lane.cwd) || resolve(baseCwd);
    const writes = Array.isArray(lane.writes) ? lane.writes : lane.writes == null ? [] : null;
    return {
      index,
      name: laneName,
      label,
      laneId: `${cleanName}/${laneName}`,
      state,
      sk: jobKey(driverId),
      task: laneTask(lane, manifestDir),
      cwd,
      partner: lane.partner || "",
      tier: lane.tier || "",
      model: lane.model || "",
      effort: lane.effort || "",
      profile: lane.profile || "",
      // fleet ROLE for branding/registry: juniors by default; a manifest may declare a lane a
      // "branch-mind" (persistent sub-problem owner) so backlog filters can treat roles apart
      role: lane.role || "junior",
      posture: lane.posture || "",
      stallSec: lane.stallSec ?? stallSec,
      maxTurnSec: lane.maxTurnSec ?? null,
      wedgeAfterSec: lane.wedgeAfterSec ?? wedgeAfterSec,
      worktree: lane.worktree || null,
      writes,
      // resolved against the lane's cwd so "bin/x.mjs" and an absolute spelling of the same file
      // still collide in the overlap gate regardless of declaration style
      writesResolved: (writes || []).map((w) => (typeof w === "string" && w.trim() ? resolveFrom(cwd, w) : w)),
      verify: typeof lane.verify === "string" ? lane.verify : "",
      verifyTimeoutSec: lane.verifyTimeoutSec ?? 300,
      // optional prove-red evidence pins (regex source strings)
      expectRed: typeof lane.expectRed === "string" ? lane.expectRed : "",
      expectGreen: typeof lane.expectGreen === "string" ? lane.expectGreen : "",
      // files the APEX seeds into this lane's worktree so the lane is graded by assertions it
      // does not own. Hashed at dispatch, re-checked at collection, and excluded from the scope
      // audit (they are outside the lane's writes[] by design).
      seeds: Array.isArray(lane.seeds) ? lane.seeds.filter((s) => typeof s === "string" && s.trim()) : [],
    };
  });

  // ---- fleet gates: fail BEFORE anything is reserved, so a refused swarm leaves no residue ----
  // "gates": false is the DISPOSABLE-HARNESS opt-out (tests, throwaway fakes) — precedented by
  // orch's gitIsolation escape. It is loud, machine-readable, and per-manifest; real fleet
  // manifests never set it. Registry stamping stays on either way.
  const gatesOn = source.gates !== false;
  if (!gatesOn) console.error(`swarm ${cleanName}: GATES DISABLED by manifest — sealed-brief lint and write-scope gate skipped`);
  // G-lint: every lane brief must be a sealed brief (contract, deliverable, verify, ambiguity
  // section, no repo-exploration phrasing). Escape hatch: "lint": false in the manifest.
  if (gatesOn && source.lint !== false) {
    const lintFailures = [];
    for (const lane of runtime) {
      const { ok, violations } = lintBrief(lane.task);
      if (!ok) for (const v of violations) lintFailures.push(`${lane.name}: ${v.rule} — ${v.detail || ""}`);
    }
    if (lintFailures.length) {
      throw new Error(`brief lint failed (sealed-brief contract, set "lint": false to bypass):\n${lintFailures.join("\n")}`);
    }
  }
  // G-custody: a lane must be graded by assertions it does NOT own, and its evidence must be
  // pinned. This was doctrine, and doctrine-only control is exactly what failed in the parked
  // predecessor — the audit walked the path by which a lane writes tests asserting its own wrong
  // behaviour and earns PASS-PROVEN. Escape hatch: "custody": false, for harnesses only.
  if (gatesOn && source.custody !== false) {
    const custodyFailures = [];
    for (const lane of runtime) {
      const c = checkVerifyCustody({ verify: lane.verify, seeds: lane.seeds, expectRed: lane.expectRed, expectGreen: lane.expectGreen });
      if (!c.ok) custodyFailures.push(`${lane.name}: ${c.detail}`);
    }
    if (custodyFailures.length) {
      throw new Error(`verifier custody gate failed (set "custody": false only for throwaway harnesses):\n${custodyFailures.join("\n")}`);
    }
  }

  // G-scope: writes[] is MANDATORY per lane and no two lanes (nor any live fleet session) may
  // overlap. This is the anti-42-writers gate — mechanical, at fork time.
  const fleet = fleetDir(root);
  if (gatesOn) {
    const scopeLanes = runtime.map((lane) => ({ name: lane.name, writes: lane.writes === null ? null : lane.writesResolved }));
    const scoped = checkLaneScopes(scopeLanes);
    if (!scoped.ok) {
      const lines = [
        ...scoped.errors.map((e) => `${e.lane}: ${e.error} — declare the exact files this lane creates/modifies`),
        ...scoped.conflicts.map((c) => `${c.a} ↯ ${c.b}: ${c.pathA} overlaps ${c.pathB}`),
      ];
      throw new Error(`write-scope gate failed:\n${lines.join("\n")}`);
    }
    let live = [];
    try {
      // stale `live` rows from a previous wave block overlapping dispatch forever; settle the
      // finished and the dead first so the gate reflects reality rather than history
      heal(fleet, { apply: true });
    } catch {
      /* healing is hygiene; never let it stop a dispatch */
    }
    try {
      live = liveWriteScopes(fleet, driverId);
    } catch {
      /* a corrupt registry must not wedge dispatch; the in-manifest check above already ran */
    }
    const liveCheck = checkAgainstLive(scopeLanes, live);
    if (!liveCheck.ok) {
      const lines = liveCheck.conflicts.map((c) => `${c.lane} ↯ live ${c.owner}: ${c.pathA} overlaps ${c.pathB}`);
      throw new Error(`write-scope gate failed against LIVE sessions:\n${lines.join("\n")}`);
    }
  }

  const record = {
    version: 1,
    name: cleanName,
    driverId,
    manifestPath: absoluteManifest,
    createdTs: Date.now(),
    setupStatus: "preparing",
    lanes: runtime.map((lane) => ({
      name: lane.name,
      label: lane.label,
      laneId: lane.laneId,
      state: lane.state,
      sk: lane.sk,
      task: lane.task,
      cwd: lane.cwd,
      partner: lane.partner,
      tier: lane.tier,
      model: lane.model,
      effort: lane.effort,
      profile: lane.profile,
      posture: lane.posture,
      stallSec: lane.stallSec,
      maxTurnSec: lane.maxTurnSec,
      wedgeAfterSec: lane.wedgeAfterSec,
      worktree: lane.worktree || null,
      writes: lane.writes,
      writesResolved: lane.writesResolved,
      verify: lane.verify,
      verifyTimeoutSec: lane.verifyTimeoutSec,
      expectRed: lane.expectRed,
      expectGreen: lane.expectGreen,
      seeds: lane.seeds,
      seedStamp: null,
      role: lane.role,
      dispatch: "pending",
    })),
  };
  reserveSwarm(file, record);

  const registered = [];
  try {
    // The driver itself must exist in the family tree before its juniors can name it as parent.
    // TANDEM_SELF_ID is the mind's OWN registry id: a mind that already registered itself (an
    // apex does) must reuse that node instead of adding a second one under its raw session id —
    // the "apex appears twice" defect from the first real campaign. TANDEM_PARENT_ID is how a
    // forked mind learns who forked it; without it every branch mind becomes its own root.
    const selfId = process.env.TANDEM_SELF_ID && getSession(fleet, process.env.TANDEM_SELF_ID)
      ? process.env.TANDEM_SELF_ID
      : driverId;
    ensureRegistered(fleet, {
      selfId,
      sessionId: driverId,
      parentId: process.env.TANDEM_PARENT_ID || null,
      kind: process.env.TANDEM_ROLE || "branch",
      label: process.env.TANDEM_LABEL || "driver",
    });
    for (const lane of runtime) {
      claimLaneState(lane.state, lane.laneId);
      registerSession(fleet, {
        id: lane.laneId,
        parent: selfId,
        kind: lane.role === "branch-mind" ? "branch" : "junior",
        label: lane.label,
        charter: lane.task,
        writes: lane.writesResolved,
        model: lane.profile || lane.model,
        effort: lane.effort,
        cwd: lane.cwd,
        state: lane.state,
      });
      registered.push(lane.laneId);
      if (lane.worktree) {
        const spec = lane.worktree === true ? {} : lane.worktree;
        const info = ensureLaneWorktree({
          state: lane.state,
          label: lane.label,
          baseCwd: lane.cwd,
          path: resolveFrom(manifestDir, spec.path),
          branch: spec.branch || undefined,
          startPoint: spec.startPoint || source.startPoint || "HEAD",
        });
        lane.cwd = info.cwd;
        lane.worktree = info;
      }
      // stamp the apex's seeded graders so a lane editing its own assertions is caught
      // mechanically at collection instead of by a hand-maintained hash file
      if (lane.seeds?.length) {
        try {
          record.lanes[lane.index].seedStamp = hashSeeds(lane.cwd, lane.seeds);
        } catch {
          /* seeding is the apex's business; a failed stamp must not block dispatch */
        }
      }
      writeLaneMetadata(lane.state, {
        version: 1,
        label: lane.label,
        lane: lane.name,
        swarm: cleanName,
        laneId: lane.laneId,
        cwd: lane.cwd,
      });
      const stored = record.lanes[lane.index];
      stored.cwd = lane.cwd;
      stored.worktree = lane.worktree || null;
      stored.setup = "ready";
      writeJsonAtomic(file, record);
    }
    record.setupStatus = "ready";
    record.readyTs = Date.now();
    writeJsonAtomic(file, record);
    return record;
  } catch (error) {
    record.setupStatus = "error";
    record.setupError = String(error.message || error);
    record.setupFailedTs = Date.now();
    writeJsonAtomic(file, record);
    for (const id of registered) {
      try {
        updateStatus(fleet, id, "gone");
      } catch {
        /* best-effort: a failed setup must not be blocked by registry cleanup */
      }
    }
    throw new Error(`${record.setupError}; swarm "${cleanName}" remains reserved for inspection`);
  }
}

export function updateSwarm(root, parentState, record) {
  writeJsonAtomic(swarmFile(root, parentState, record.name), record);
  return record;
}

export function laneEnvironment(lane, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    TANDEM_STATE: lane.state,
    TANDEM_LABEL: lane.label,
    TANDEM_LANE_ID: lane.laneId,
    TANDEM_CWD: lane.cwd,
    // nested swarms opened by this lane register into the SAME family tree
    TANDEM_FLEET_DIR: baseEnv.TANDEM_FLEET_DIR || fleetDir(resolve(dirname(dirname(lane.state)))),
  };
  if (lane.partner) env.TANDEM_PARTNER = lane.partner;
  if (lane.tier) env.TANDEM_TIER = lane.tier;
  if (lane.model) env.TANDEM_MODEL = lane.model;
  if (lane.effort) env.TANDEM_EFFORT = lane.effort;
  if (lane.profile) env.TANDEM_PROFILE = lane.profile;
  if (lane.role) env.TANDEM_ROLE = lane.role;
  // a lane that forks its own swarm registers UNDER this lane, keeping one connected family tree
  env.TANDEM_PARENT_ID = lane.laneId;
  if (lane.posture) env.TANDEM_POSTURE = lane.posture;
  if (lane.stallSec != null) env.TANDEM_STALL_SEC = String(lane.stallSec);
  if (lane.maxTurnSec != null) env.TANDEM_MAX_TURN_SEC = String(lane.maxTurnSec);
  if (lane.wedgeAfterSec != null) env.TANDEM_WEDGE_AFTER_SEC = String(lane.wedgeAfterSec);
  return env;
}

export function inspectSwarm(record) {
  const lanes = record.lanes.map((lane) => {
    const job = inspectDispatch(lane.state, lane.sk, {
      wedgeAfterSec: lane.wedgeAfterSec,
      stallSec: lane.stallSec,
    });
    return {
      ...lane,
      job,
      status: job?.status || (lane.dispatch === "error" ? "error" : "idle"),
    };
  });
  const counts = {};
  for (const lane of lanes) counts[lane.status] = (counts[lane.status] || 0) + 1;
  return { ...record, lanes, counts };
}

export function findSwarmLane(record, name) {
  const clean = sanitizeLabel(name);
  return record.lanes.find((lane) => lane.name === clean || lane.label === clean || lane.laneId === name) || null;
}

export function listSwarms(root, parentState) {
  const dir = storage(root, parentState).registry;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(dir, name)))
    .filter(Boolean)
    .sort((a, b) => (b.createdTs || 0) - (a.createdTs || 0));
}
