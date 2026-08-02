import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { updateStatus } from "./fleet-registry.mjs";

const JOB_FILE = /^job-.*\.json$/;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function resumeFor(id) {
  const match = typeof id === "string" ? /^([^/]+)\/([^/]+)$/.exec(id) : null;
  return match ? `peer.mjs swarm continue ${match[1]} ${match[2]}` : "";
}

function newestJob(state) {
  let names;
  try {
    names = fs.readdirSync(state).filter((name) => JOB_FILE.test(name));
  } catch {
    return null;
  }

  let newest = null;
  for (const name of names) {
    const file = path.join(state, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { file, mtimeMs: stat.mtimeMs };
    }
  }

  if (!newest) return null;

  try {
    const job = JSON.parse(fs.readFileSync(newest.file, "utf8"));
    return job && typeof job === "object" && !Array.isArray(job) ? job : null;
  } catch {
    return null;
  }
}

function sessionJob(state) {
  if (!state) return null;

  try {
    if (!fs.statSync(state).isDirectory()) return null;
  } catch {
    return null;
  }

  return newestJob(state);
}

export function diagnoseSession(rec) {
  const resume = resumeFor(rec.id);
  const base = {
    id: rec.id,
    kind: rec.kind,
    label: rec.label,
    status: rec.status,
    resume,
  };

  if (rec.status !== "live") {
    return {
      ...base,
      verdict: "settled",
      jobStatus: null,
      pid: null,
      pidAlive: false,
    };
  }

  const job = sessionJob(rec.state);
  if (!job) {
    return {
      ...base,
      verdict: "untracked",
      jobStatus: null,
      pid: null,
      pidAlive: false,
    };
  }

  const jobStatus = job.status ?? null;
  const pid = job.workerPid ?? null;
  const alive = pid === null ? false : pidAlive(pid);
  let verdict = "untracked";

  if (jobStatus === "done") {
    verdict = "finished-ok";
  } else if (jobStatus === "error") {
    verdict = "finished-error";
  } else if (jobStatus === "running") {
    verdict = alive ? "live" : "dead";
  }

  return {
    ...base,
    verdict,
    jobStatus,
    pid,
    pidAlive: alive,
  };
}

export function diagnose(dir) {
  const registryPath = path.join(dir, "registry.json");
  let raw;

  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { sessions: [] };
    throw error;
  }

  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw new Error(`registry corrupt: ${registryPath}`);
  }

  const records = Object.values(registry.sessions ?? {});
  records.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return { sessions: records.map(diagnoseSession) };
}

export function heal(dir, opts = {}) {
  const result = diagnose(dir);
  const targets = {
    "finished-ok": "done",
    "finished-error": "error",
    dead: "gone",
  };
  const applied = !!opts.apply;
  const transitions = [];

  for (const session of result.sessions) {
    const to = targets[session.verdict];
    if (!to) continue;

    const transition = {
      id: session.id,
      from: "live",
      to,
      verdict: session.verdict,
    };

    if (applied) {
      try {
        updateStatus(dir, session.id, to);
      } catch (error) {
        transition.error = error?.message ?? String(error);
      }
    }

    transitions.push(transition);
  }

  return { applied, transitions };
}

function isMainModule() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    const [dir, ...args] = process.argv.slice(2);
    if (!dir) {
      throw new Error("usage: node bin/fleet-doctor.mjs <dir> [--heal] [--apply]");
    }

    const result = args.includes("--heal")
      ? heal(dir, { apply: args.includes("--apply") })
      : diagnose(dir);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
