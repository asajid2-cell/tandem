import { spawnSync } from "node:child_process";

export function supervisionDecision({
  now = Date.now(),
  startedAt,
  lastActivityAt,
  stallSec = 0,
  maxSec = 0,
}) {
  const elapsedMs = Math.max(0, now - startedAt);
  const idleMs = Math.max(0, now - lastActivityAt);
  if (stallSec > 0 && idleMs >= stallSec * 1000) {
    return {
      kind: "stall",
      elapsedSec: Number((elapsedMs / 1000).toFixed(3)),
      idleSec: Number((idleMs / 1000).toFixed(3)),
    };
  }
  if (maxSec > 0 && elapsedMs >= maxSec * 1000) {
    return {
      kind: "absolute",
      elapsedSec: Number((elapsedMs / 1000).toFixed(3)),
      idleSec: Number((idleMs / 1000).toFixed(3)),
    };
  }
  return null;
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function requestGracefulStop(pid) {
  pid = Number(pid) || 0;
  if (!pid) return false;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return result.status === 0;
  }
  return signalProcessGroup(pid, "SIGTERM");
}

export function hardKillProcessTree(pid) {
  pid = Number(pid) || 0;
  if (!pid) return false;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return result.status === 0;
  }
  return signalProcessGroup(pid, "SIGKILL");
}
