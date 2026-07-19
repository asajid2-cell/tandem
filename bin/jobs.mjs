import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const DEFAULT_WEDGE_AFTER_SEC = 60;
const DEFAULT_SPAWN_GRACE_SEC = 5;
const RENAME_RETRY_CELL = new Int32Array(new SharedArrayBuffer(4));

export function jobPaths(state, sk) {
  return {
    job: join(state, `job-${sk}.json`),
    lock: join(state, `dispatch-${sk}.lock`),
    heartbeat: join(state, `heartbeat-${sk}.json`),
  };
}

export function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (!["EACCES", "EBUSY", "EPERM"].includes(error.code)) {
        try {
          rmSync(tmp);
        } catch {
          /* ignore cleanup failure; preserve the original write error */
        }
        throw error;
      }
      lastError = error;
      Atomics.wait(RENAME_RETRY_CELL, 0, 0, Math.min(5 * (attempt + 1), 50));
    }
  }
  try {
    rmSync(tmp);
  } catch {
    /* ignore cleanup failure; preserve the replacement error */
  }
  throw lastError;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function matchingHeartbeat(paths, dispatchId) {
  const heartbeat = readJson(paths.heartbeat);
  return heartbeat?.dispatchId === dispatchId ? heartbeat : null;
}

export function inspectDispatch(
  state,
  sk,
  {
    wedgeAfterSec = DEFAULT_WEDGE_AFTER_SEC,
    stallSec = 0,
    spawnGraceSec = DEFAULT_SPAWN_GRACE_SEC,
  } = {},
) {
  const paths = jobPaths(state, sk);
  const job = readJson(paths.job);
  const lock = readJson(paths.lock);
  const finishedLeaseMismatch =
    job &&
    job.status !== "running" &&
    lock &&
    (!job.dispatchId || !lock.dispatchId || job.dispatchId !== lock.dispatchId);

  if (job && job.status !== "running" && !finishedLeaseMismatch) {
    return {
      ...job,
      lockPresent: !!lock,
      state,
      sk,
    };
  }
  if (!job && !lock) return null;

  const now = Date.now();
  const dispatchId = job?.dispatchId || lock?.dispatchId || "";
  const startedTs = job?.startedTs || job?.ts || lock?.startedTs || lock?.ts || now;
  const elapsedMs = Math.max(0, now - startedTs);
  const elapsedSec = Math.round(elapsedMs / 1000);
  const workerPid = Number(job?.workerPid || lock?.ownerPid || 0) || 0;
  const partnerPid = Number(job?.partnerPid || 0) || 0;
  const heartbeat = matchingHeartbeat(paths, dispatchId);
  let heartbeatTs = heartbeat?.ts || 0;
  if (!heartbeatTs && existsSync(paths.heartbeat)) {
    try {
      heartbeatTs = statSync(paths.heartbeat).mtimeMs;
    } catch {
      heartbeatTs = 0;
    }
  }
  const heartbeatAgeSec = heartbeatTs ? Math.max(0, Math.round((now - heartbeatTs) / 1000)) : null;
  const lastActivityTs = job?.lastActivityTs || heartbeat?.activityTs || startedTs;
  const activityAgeSec = lastActivityTs
    ? Math.max(0, Math.round((now - lastActivityTs) / 1000))
    : null;

  let reason = "";
  if (finishedLeaseMismatch) {
    reason = "finished job/lease dispatch IDs disagree";
  } else if (job && lock && job.dispatchId && lock.dispatchId && job.dispatchId !== lock.dispatchId) {
    reason = "job/lease dispatch IDs disagree";
  } else if (!workerPid && elapsedSec > spawnGraceSec) {
    reason = "no worker PID was recorded before the spawn grace expired";
  } else if (workerPid && !isPidAlive(workerPid)) {
    reason = `worker pid ${workerPid} is not alive`;
  } else if (
    wedgeAfterSec > 0 &&
    elapsedSec > Math.max(spawnGraceSec, wedgeAfterSec) &&
    (!heartbeatTs || now - heartbeatTs > wedgeAfterSec * 1000)
  ) {
    reason = heartbeatTs
      ? `worker heartbeat is ${heartbeatAgeSec}s old (limit ${wedgeAfterSec}s)`
      : `worker heartbeat was never recorded (limit ${wedgeAfterSec}s)`;
  } else if (
    stallSec > 0 &&
    !job?.terminationPending &&
    elapsedMs > stallSec * 1000 &&
    lastActivityTs &&
    now - lastActivityTs > stallSec * 1000
  ) {
    reason = `partner activity stalled ${activityAgeSec}s ago (limit ${stallSec}s)`;
  }

  return {
    ...(job || {}),
    status: reason ? "WEDGED" : "running",
    rawStatus: job?.status || (lock ? "starting" : ""),
    dispatchId,
    workerPid,
    partnerPid,
    startedTs,
    ts: job?.ts || startedTs,
    elapsedSec,
    heartbeatAgeSec,
    lastActivityTs,
    activityAgeSec,
    activityKind: job?.activityKind || heartbeat?.activityKind || "",
    reason,
    lockPresent: !!lock,
    partner: job?.partner || lock?.partner || "",
    mode: job?.mode || lock?.mode || "",
    state,
    sk,
  };
}

function removeIfOwned(file, dispatchId) {
  const value = readJson(file);
  if (!value || value.dispatchId !== dispatchId) return false;
  try {
    rmSync(file);
    return true;
  } catch {
    return false;
  }
}

function clearFinishedLease(paths) {
  const lock = readJson(paths.lock);
  const job = readJson(paths.job);
  if (!lock || !job || job.status === "running" || lock.dispatchId !== job.dispatchId) return false;
  removeIfOwned(paths.heartbeat, lock.dispatchId);
  return removeIfOwned(paths.lock, lock.dispatchId);
}

export class DispatchBusyError extends Error {
  constructor(snapshot) {
    const state = snapshot?.status || "running";
    const guidance =
      state === "WEDGED"
        ? "run `peer.mjs status`, then `peer.mjs reap` before replacing it"
        : "wait for it, inspect `peer.mjs status`, or interrupt it with `peer.mjs cancel`";
    super(`lane dispatch refused: existing job is ${state}; ${guidance}`);
    this.name = "DispatchBusyError";
    this.code = "TANDEM_DISPATCH_BUSY";
    this.snapshot = snapshot;
  }
}

export function acquireDispatch(state, sk, meta = {}) {
  mkdirSync(state, { recursive: true });
  const paths = jobPaths(state, sk);

  for (let attempt = 0; attempt < 2; attempt++) {
    const dispatchId = randomUUID();
    const startedTs = Date.now();
    const lock = {
      dispatchId,
      ownerPid: Number(meta.workerPid || process.pid),
      partner: meta.partner || "",
      mode: meta.mode || "",
      startedTs,
    };
    let fd;
    try {
      fd = openSync(paths.lock, "wx");
      writeFileSync(fd, JSON.stringify(lock));
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      if (error.code !== "EEXIST") throw error;
      if (clearFinishedLease(paths)) continue;
      throw new DispatchBusyError(inspectDispatch(state, sk, meta));
    }

    const lease = { state, sk, dispatchId, paths, startedTs };
    writeJsonAtomic(paths.job, {
      status: "running",
      dispatchId,
      partner: meta.partner || "",
      mode: meta.mode || "",
      workerPid: lock.ownerPid,
      startedTs,
      lastActivityTs: startedTs,
      activityKind: "dispatch",
      ts: startedTs,
    });
    touchHeartbeat(lease, lock.ownerPid);
    return lease;
  }

  throw new DispatchBusyError(inspectDispatch(state, sk, meta));
}

export function leaseFrom(state, sk, dispatchId) {
  return { state, sk, dispatchId, paths: jobPaths(state, sk) };
}

export function leaseIsOwned(lease) {
  return readJson(lease.paths.lock)?.dispatchId === lease.dispatchId;
}

export function updateDispatch(lease, patch = {}) {
  if (!leaseIsOwned(lease)) return false;
  const lock = readJson(lease.paths.lock) || {};
  const job = readJson(lease.paths.job) || {};
  writeJsonAtomic(lease.paths.lock, {
    ...lock,
    ...(patch.workerPid ? { ownerPid: Number(patch.workerPid) } : {}),
    ...(patch.partner ? { partner: patch.partner } : {}),
    ...(patch.mode ? { mode: patch.mode } : {}),
    dispatchId: lease.dispatchId,
  });
  writeJsonAtomic(lease.paths.job, {
    ...job,
    ...patch,
    status: "running",
    dispatchId: lease.dispatchId,
    startedTs: job.startedTs || lock.startedTs || lease.startedTs || Date.now(),
    ts: job.ts || lock.startedTs || lease.startedTs || Date.now(),
  });
  return true;
}

export function touchHeartbeat(lease, pid = process.pid) {
  if (!leaseIsOwned(lease)) return false;
  const current = matchingHeartbeat(lease.paths, lease.dispatchId) || {};
  writeJsonAtomic(lease.paths.heartbeat, {
    ...current,
    dispatchId: lease.dispatchId,
    pid: Number(pid) || process.pid,
    ts: Date.now(),
  });
  return true;
}

export function markDispatchActivity(
  lease,
  { pid = process.pid, ts = Date.now(), kind = "partner-output" } = {},
) {
  if (!leaseIsOwned(lease)) return false;
  const job = readJson(lease.paths.job) || {};
  writeJsonAtomic(lease.paths.job, {
    ...job,
    dispatchId: lease.dispatchId,
    status: "running",
    lastActivityTs: ts,
    activityKind: kind,
    activityCount: Number(job.activityCount || 0) + 1,
  });
  const heartbeat = matchingHeartbeat(lease.paths, lease.dispatchId) || {};
  writeJsonAtomic(lease.paths.heartbeat, {
    ...heartbeat,
    dispatchId: lease.dispatchId,
    pid: Number(pid) || process.pid,
    ts: Date.now(),
    activityTs: ts,
    activityKind: kind,
  });
  return true;
}

export function startHeartbeat(lease, { pid = process.pid, intervalMs = 2000 } = {}) {
  let timer = null;
  const beat = () => {
    if (!touchHeartbeat(lease, pid) && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  beat();
  timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export function finishDispatch(lease, finalState) {
  if (!leaseIsOwned(lease)) return false;
  const current = readJson(lease.paths.job) || {};
  writeJsonAtomic(lease.paths.job, {
    ...current,
    ...finalState,
    dispatchId: lease.dispatchId,
    status: finalState.status || "done",
    startedTs: current.startedTs || lease.startedTs || Date.now(),
    finishedTs: Date.now(),
    ts: Date.now(),
  });
  removeIfOwned(lease.paths.heartbeat, lease.dispatchId);
  removeIfOwned(lease.paths.lock, lease.dispatchId);
  return true;
}

export function forceFinishDispatch(state, sk, finalState) {
  const paths = jobPaths(state, sk);
  const job = readJson(paths.job) || {};
  const lock = readJson(paths.lock) || {};
  const dispatchId = job.dispatchId || lock.dispatchId || randomUUID();
  writeJsonAtomic(paths.job, {
    ...job,
    ...finalState,
    dispatchId,
    status: finalState.status || "error",
    startedTs: job.startedTs || lock.startedTs || job.ts || Date.now(),
    finishedTs: Date.now(),
    ts: Date.now(),
  });
  for (const file of [paths.lock, paths.heartbeat]) {
    try {
      if (existsSync(file)) rmSync(file);
    } catch {
      /* explicit force-finish leaves the final job record as the recovery evidence */
    }
  }
  return readJson(paths.job);
}
