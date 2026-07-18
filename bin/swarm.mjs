import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { inspectDispatch, readJson, writeJsonAtomic } from "./jobs.mjs";
import { jobKey, sanitizeLabel } from "./groups.mjs";
import { ensureLaneWorktree, writeLaneMetadata } from "./worktrees.mjs";

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
      posture: lane.posture || "",
      maxTurnSec: lane.maxTurnSec ?? null,
      wedgeAfterSec: lane.wedgeAfterSec ?? wedgeAfterSec,
      worktree: lane.worktree || null,
    };
  });

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
      posture: lane.posture,
      maxTurnSec: lane.maxTurnSec,
      wedgeAfterSec: lane.wedgeAfterSec,
      worktree: lane.worktree || null,
      dispatch: "pending",
    })),
  };
  reserveSwarm(file, record);

  try {
    for (const lane of runtime) {
      claimLaneState(lane.state, lane.laneId);
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
  };
  if (lane.partner) env.TANDEM_PARTNER = lane.partner;
  if (lane.tier) env.TANDEM_TIER = lane.tier;
  if (lane.model) env.TANDEM_MODEL = lane.model;
  if (lane.effort) env.TANDEM_EFFORT = lane.effort;
  if (lane.posture) env.TANDEM_POSTURE = lane.posture;
  if (lane.maxTurnSec != null) env.TANDEM_MAX_TURN_SEC = String(lane.maxTurnSec);
  if (lane.wedgeAfterSec != null) env.TANDEM_WEDGE_AFTER_SEC = String(lane.wedgeAfterSec);
  return env;
}

export function inspectSwarm(record) {
  const lanes = record.lanes.map((lane) => {
    const job = inspectDispatch(lane.state, lane.sk, { wedgeAfterSec: lane.wedgeAfterSec });
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
