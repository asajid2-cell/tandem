import { spawnSync } from "node:child_process";

// T5 progress capture: the ONE bounded follow-up turn dispatched on the same durable session right
// after a supervised stop. The stopped turn's partial work lives only in the partner's context —
// this prompt asks for a factual report of it WITHOUT resuming the work (a capture that started
// new work would just be stopped again). Shared here so peer.mjs (codex resume) and serve.mjs
// (warm checkpointed claude) send the identical prompt.
export const CAPTURE_PROMPT =
  "Your previous turn was interrupted by tandem turn supervision before it finished. " +
  "Do NOT resume the work and do NOT run any tools. In a few sentences, report factually: " +
  "(1) what you completed, (2) what was in progress when the turn stopped, " +
  "(3) the next concrete step a fresh turn should take.";

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

// The TRUTHFUL account of a graceful-stop attempt. requestGracefulStop returns only "did the call
// succeed" — which on win32 conflates a taskkill exit status with the partner actually observing
// anything, and it doesn't. This reports the channel plus two separate facts: callAccepted (the OS
// accepted the stop call) and deliveryProven (we can PROVE the partner received the signal).
//   win32: a non-forced `taskkill /T` posts WM_CLOSE to the target's windows, but a windowsHide
//          console child has none — the post is a structural no-op, so delivery is NEVER provable.
//   posix: a successful kill(2) genuinely delivers the signal, so deliveryProven === callAccepted.
export function describeGracefulStop(pid) {
  pid = Number(pid) || 0;
  if (!pid) return { attempted: true, channel: "none", callAccepted: false, deliveryProven: false };
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T"], {
      windowsHide: true,
      stdio: "ignore",
    });
    // callAccepted may be true (taskkill exited 0), but delivery to a hidden console child is unprovable.
    return { attempted: true, channel: "taskkill-no-force", callAccepted: result.status === 0, deliveryProven: false };
  }
  // Prefer the process group so the whole partner tree gets SIGTERM; fall back to the direct pid.
  try {
    process.kill(-pid, "SIGTERM");
    return { attempted: true, channel: "SIGTERM-group", callAccepted: true, deliveryProven: true };
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return { attempted: true, channel: "SIGTERM-pid", callAccepted: true, deliveryProven: true };
    } catch {
      return { attempted: true, channel: "none", callAccepted: false, deliveryProven: false };
    }
  }
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
