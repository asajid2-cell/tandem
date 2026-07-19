#!/usr/bin/env node
// tandem serve — keep the PARTNER session OPEN and interactive (the T6-relay model).
//
// Holds ONE persistent `claude -p --input-format stream-json` process on the
// claude.ai SUBSCRIPTION (apiKeySource = none) in bypass mode, so the driver
// (Codex) can converse with a single continuous Claude session turn after turn —
// full context, live streaming, kept open — instead of fire-and-forget headless
// queries. IPC is a file relay in .state (inbox/status/job), same shape as the
// proven codex_relay. Run once; peer.mjs auto-starts it on the first Claude turn.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, openSync, closeSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { scrubbedClaudeEnv, apiRoutingVarsPresent } from "./claudeEnv.mjs";
import { recordGroup, readGroups, readDetached, jobKey, stateDir } from "./groups.mjs";
import {
  finishDispatch,
  isPidAlive,
  jobPaths,
  leaseFrom,
  leaseIsOwned,
  markDispatchActivity,
  startHeartbeat,
  updateDispatch,
} from "./jobs.mjs";
import {
  hardKillProcessTree,
  requestGracefulStop,
  supervisionDecision,
} from "./process-control.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
// Same per-driver state folder as peer.mjs (TANDEM_STATE, passed by the spawning peer, overrides).
const STATE = stateDir(ROOT, process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_CONVERSATION_ID || "");
const INBOX = join(STATE, "inbox.txt");
const STATUS = join(STATE, "status.txt");
const TURNLOG = join(STATE, "turn.jsonl");
const PID = join(STATE, "serve.pid");
const CLAUDE_SESSION = join(STATE, "claude.session");
const TANDEM_LOG = join(STATE, "tandem.log.jsonl");
const GROUPS = join(STATE, "groups.json");
const DETACHED = join(STATE, "detached.json"); // drivers reset by `new` → start fresh next turn
const USAGE = join(STATE, "usage.json"); // per-session context size → low-context notice
const CLAUDE_SEED = join(STATE, "claude.seed"); // handoff summary to prepend on a fresh session's first turn
const COMPACT_AT = Number(process.env.TANDEM_COMPACT_AT) || cfg().compactAtTokens || 300000;
const STALL_SEC =
  process.env.TANDEM_STALL_SEC !== undefined
    ? Math.max(0, Number(process.env.TANDEM_STALL_SEC) || 0)
    : Math.max(0, Number(cfg().stallSec ?? 240) || 0);
const MAX_TURN_SEC =
  process.env.TANDEM_MAX_TURN_SEC !== undefined
    ? Math.max(0, Number(process.env.TANDEM_MAX_TURN_SEC) || 0)
    : Math.max(0, Number(cfg().maxTurnSec) || 0);
const STOP_GRACE_SEC =
  process.env.TANDEM_STOP_GRACE_SEC !== undefined
    ? Math.max(0, Number(process.env.TANDEM_STOP_GRACE_SEC) || 0)
    : Math.max(0, Number(cfg().stopGraceSec ?? 5) || 0);
const ACTIVITY_PERSIST_MS = Math.max(
  20,
  Math.min(1000, STALL_SEC > 0 ? (STALL_SEC * 1000) / 4 : 1000),
);
const CODEX_DRIVER_ID =
  process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_CONVERSATION_ID || "";
// Per-driver verdict/status files so concurrent tandems don't clobber each other. MUST use the
// same driver-id precedence as peer.mjs DRIVER_ID (Claude session id first), or a Claude driver
// with a Claude partner writes jobs under one key and reads them under another (status/wait/
// verdict never return — the tandem looks hung while the partner worked fine).
const SK = jobKey(process.env.CLAUDE_CODE_SESSION_ID || CODEX_DRIVER_ID);
const LASTMSG = join(STATE, `last-${SK}.txt`);
const JOB = jobPaths(STATE, SK).job;

function claimDaemonPid() {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(PID, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      if (error.code !== "EEXIST") throw error;
      const existingPid = existsSync(PID) ? Number(readFileSync(PID, "utf8").trim()) : 0;
      if (isPidAlive(existingPid)) {
        throw new Error(`another tandem serve daemon already owns this lane (pid ${existingPid})`);
      }
      try {
        rmSync(PID);
      } catch {
        /* retry or fail on the next exclusive open */
      }
    }
  }
  throw new Error("could not claim the tandem serve daemon pid file");
}

function cfg() {
  const p = join(ROOT, "tandem.config.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* ignore */
    }
  }
  return {};
}
function log(e) {
  try {
    appendFileSync(TANDEM_LOG, JSON.stringify(e) + "\n");
  } catch {
    /* ignore */
  }
}

function setUsage(sid, n) {
  if (!sid) return;
  let u = {};
  try {
    u = JSON.parse(readFileSync(USAGE, "utf8"));
  } catch {
    /* ignore */
  }
  u[sid] = n;
  try {
    writeFileSync(USAGE, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}
function lowNote(sid, used) {
  if (!sid || !COMPACT_AT || used < COMPACT_AT) return null;
  return (
    `\n⚠ tandem: the partner (claude ${String(sid).slice(0, 8)}) is running low on context — ~${used} tokens used (limit ${COMPACT_AT}).\n` +
    `   Hand off to a fresh thread, crafting what to preserve:\n` +
    `     node bin/peer.mjs compact "Summarize X, Y, Z so a fresh session continues seamlessly"\n` +
    `   (or just \`peer.mjs compact\` for the default summary).`
  );
}

const C = cfg();
if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
try {
  claimDaemonPid();
} catch (error) {
  console.error(`tandem serve: ${error.message || error}`);
  process.exit(2);
}
const present = apiRoutingVarsPresent(process.env);
if (present.length) console.error(`tandem serve: scrubbing ${present.join(", ")} (subscription only)`);
const env = scrubbedClaudeEnv(process.env);

// Resume the Claude partner COUPLED to this Codex driver (immutable pair); fall
// back to the last claude session only if this driver has no tandem yet.
function claudePartnerFor(codexId) {
  if (!codexId) return "";
  const g = readGroups(GROUPS);
  const since = readDetached(DETACHED)[codexId] || 0; // ignore pairings reset by `new`
  const m = Object.values(g.groups || {})
    .filter((r) => r.codexId === codexId && r.claudeId && (r.lastTs || 0) > since)
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return m[0]?.claudeId || "";
}
let sessionId =
  claudePartnerFor(CODEX_DRIVER_ID) || (existsSync(CLAUDE_SESSION) ? readFileSync(CLAUDE_SESSION, "utf8").trim() : "");
let args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions", "--verbose"];
// Partner model/effort bind at daemon start (`stop` then re-ask to change). Env is inherited
// from the driver that spawned us. Resolution mirrors peer.mjs: explicit TANDEM_MODEL/EFFORT >
// TANDEM_TIER preset (tiers.claude.<tier> in the config) > flat config defaults.
const tier = (process.env.TANDEM_TIER && C.tiers && C.tiers.claude && C.tiers.claude[process.env.TANDEM_TIER]) || {};
const claudeModel = process.env.TANDEM_MODEL || tier.model || C.claudeModel || "";
if (claudeModel) args.push("--model", claudeModel);
const claudeEffort = process.env.TANDEM_EFFORT || tier.effort || C.claudeEffort || "";
if (claudeEffort) args.push("--effort", claudeEffort);
if (sessionId) args.push("--resume", sessionId);
let bin = process.env.TANDEM_CLAUDE_BIN || C.claudeBin || "claude";
const cwd = process.env.TANDEM_CWD || C.cwd || process.cwd();
// a .mjs/.js bin (e.g. a test fake) runs via node — cross-platform, no shell. Real .exe bins unaffected.
if (/\.[mc]?js$/i.test(bin)) {
  args = [bin, ...args];
  bin = process.execPath;
}

const claude = spawn(bin, args, {
  env,
  cwd,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
writeFileSync(STATUS, "STARTING");

let buf = "";
let turnStart = 0;
let inTurn = false;
// Per-turn output targets: each ask's envelope carries the SENDER's job key, so verdicts land
// under the asking driver's files even across driver restarts. Startup SK is the fallback.
let curJob = JOB;
let curLast = LASTMSG;
let curLease = null;
let stopTurnHeartbeat = null;
let curHoldLease = false;
let curControllerPid = 0;
let terminalHandled = false;
let turnLastActivity = 0;
let lastPersistedActivity = 0;
let turnTermination = null;
let turnHardStopTimer = null;
let supervisionTimer = null;

function stopError(stop) {
  const warm = sessionId
    ? `session ${sessionId} remains persisted; the next ask resumes it warm`
    : "no session id was captured; inspect the turn log before continuing";
  if (stop?.kind === "stall") {
    return `turn STALLED/WEDGED after ${stop.idleSec}s with no partner activity; graceful stop requested before tree-kill; ${warm}`;
  }
  return `turn stopped at the optional maxTurnSec backstop after ${stop?.elapsedSec || 0}s; graceful stop requested before tree-kill; ${warm}`;
}

function clearTurnSupervision() {
  if (turnHardStopTimer) clearTimeout(turnHardStopTimer);
  turnHardStopTimer = null;
  turnTermination = null;
  turnLastActivity = 0;
  lastPersistedActivity = 0;
}

function noteTurnActivity(kind) {
  if (!inTurn) return;
  turnLastActivity = Date.now();
  if (
    curLease &&
    (kind === "dispatch" || turnLastActivity - lastPersistedActivity >= ACTIVITY_PERSIST_MS)
  ) {
    lastPersistedActivity = turnLastActivity;
    markDispatchActivity(curLease, {
      pid: curHoldLease && curControllerPid ? curControllerPid : process.pid,
      ts: turnLastActivity,
      kind,
    });
  }
}

function beginTurnStop(decision) {
  if (!inTurn || turnTermination || terminalHandled || !claude.pid) return;
  const now = Date.now();
  turnTermination = {
    ...decision,
    triggeredTs: now,
    graceSec: STOP_GRACE_SEC,
    gracefulAttempted: true,
    gracefulSignalAccepted: requestGracefulStop(claude.pid),
    hardKilled: false,
  };
  if (curLease) updateDispatch(curLease, { terminationPending: turnTermination });
  const hardStop = () => {
    if (terminalHandled || claude.exitCode !== null) return;
    turnTermination.hardKilled = hardKillProcessTree(claude.pid);
  };
  if (STOP_GRACE_SEC > 0) turnHardStopTimer = setTimeout(hardStop, STOP_GRACE_SEC * 1000);
  else hardStop();
}

const supervisionWindows = [STALL_SEC, MAX_TURN_SEC].filter((seconds) => seconds > 0);
if (supervisionWindows.length) {
  const checkMs = Math.max(
    20,
    Math.min(250, ...supervisionWindows.map((seconds) => (seconds * 1000) / 4)),
  );
  supervisionTimer = setInterval(() => {
    if (!inTurn || turnTermination) return;
    const now = Date.now();
    const decision = supervisionDecision({
      now,
      startedAt: turnStart,
      lastActivityAt: turnLastActivity,
      stallSec: STALL_SEC,
      maxSec: MAX_TURN_SEC,
    });
    if (decision) beginTurnStop(decision);
  }, checkMs);
}

claude.once("spawn", () => {
  writeFileSync(STATUS, "IDLE");
  console.log(`tandem serve: persistent Claude partner OPEN (pid ${process.pid} / claude ${claude.pid})`);
  console.log(`  cwd ${cwd} · subscription · bypass · ${sessionId ? "resumed " + sessionId.slice(0, 8) : "new session"}`);
  console.log("  feed it turns with:  peer.mjs ask \"<task>\"   (Ctrl+C to close the session)");
});

claude.on("error", (error) => {
  if (terminalHandled) return;
  terminalHandled = true;
  console.error(`tandem serve: cannot spawn Claude partner - ${error.message || error}`);
  if (curLease) {
    finishDispatch(curLease, {
      status: "error",
      partner: "claude",
      workerPid: process.pid,
      error: `cannot spawn Claude partner: ${error.message || error}`,
    });
    curLease = null;
  }
  cleanup();
  process.exit(1);
});

claude.stdout.on("data", (b) => {
  noteTurnActivity("stdout");
  buf += b.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      appendFileSync(TURNLOG, line + "\n"); // live stream for the watcher
    } catch {
      /* ignore */
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.session_id && o.session_id !== sessionId) {
      sessionId = o.session_id;
      try {
        writeFileSync(CLAUDE_SESSION, sessionId);
      } catch {
        /* ignore */
      }
      // register the pair the moment the (possibly fresh) session id is known
      recordGroup(GROUPS, { claudeId: sessionId, codexId: CODEX_DRIVER_ID || null, claudeRole: "partner", codexRole: "driver", direction: "codex->claude" });
    }
    if (o.type === "result") {
      const stopped = turnTermination;
      const verdict = o.result || "";
      const dur = Math.round((Date.now() - turnStart) / 1000);
      const u = o.usage || {};
      const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (used) setUsage(sessionId, used);
      const low = lowNote(sessionId, used);
      try {
        if (!curHoldLease && (!curLease || leaseIsOwned(curLease))) writeFileSync(curLast, verdict);
        if (curLease) {
          const result = {
            partner: "claude",
            workerPid: curHoldLease ? curControllerPid : process.pid,
            partnerPid: claude.pid || 0,
            durSec: dur,
            verdict,
            lowContext: low,
          };
          if (curHoldLease) updateDispatch(curLease, { ...result, resultReady: true });
          else {
            finishDispatch(curLease, {
              ...result,
              status: stopped ? "error" : "done",
              error: stopped ? stopError(stopped) : undefined,
              termination: stopped,
              terminationPending: null,
              stalled: stopped?.kind === "stall",
            });
          }
        } else {
          writeFileSync(
            curJob,
            JSON.stringify({
              status: stopped ? "error" : "done",
              partner: "claude",
              durSec: dur,
              verdict,
              lowContext: low,
              error: stopped ? stopError(stopped) : undefined,
              termination: stopped,
              stalled: stopped?.kind === "stall",
              ts: Date.now(),
            }),
          );
        }
      } catch {
        /* ignore */
      }
      if (stopTurnHeartbeat) stopTurnHeartbeat();
      stopTurnHeartbeat = null;
      curLease = null;
      curHoldLease = false;
      curControllerPid = 0;
      log({ type: "verdict", ts: Date.now(), partner: "claude", durSec: dur, verdict });
      if (low) console.log(low);
      // register this Codex→Claude pair as a tandem group (codex driver id best-effort)
      recordGroup(GROUPS, {
        claudeId: sessionId,
        codexId: CODEX_DRIVER_ID || null,
        claudeRole: "partner",
        codexRole: "driver",
        direction: "codex->claude",
      });
      inTurn = false;
      if (!stopped) clearTurnSupervision();
      writeFileSync(STATUS, stopped ? "STOPPING" : "IDLE");
      console.log(`  ◂ turn done (${dur}s): ${verdict.replace(/\s+/g, " ").slice(0, 80)}`);
    }
  }
});
claude.stderr.on("data", (b) => {
  noteTurnActivity("stderr");
  process.stderr.write(b);
});
claude.on("exit", (code) => {
  if (terminalHandled) return;
  terminalHandled = true;
  const stopped = turnTermination;
  console.error(`tandem serve: claude session ended (${code})`);
  if (curLease) {
    if (stopTurnHeartbeat) stopTurnHeartbeat();
    finishDispatch(curLease, {
      status: "error",
      partner: "claude",
      workerPid: process.pid,
      partnerPid: claude.pid || 0,
      error: stopped
        ? stopError(stopped)
        : `persistent Claude process exited during the turn (code ${code ?? "unknown"})`,
      termination: stopped,
      terminationPending: null,
      stalled: stopped?.kind === "stall",
    });
    curLease = null;
    stopTurnHeartbeat = null;
  }
  cleanup();
  process.exit(code || 0);
});

function cleanup() {
  if (stopTurnHeartbeat) stopTurnHeartbeat();
  stopTurnHeartbeat = null;
  if (supervisionTimer) clearInterval(supervisionTimer);
  supervisionTimer = null;
  clearTurnSupervision();
  try {
    rmSync(PID);
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(STATUS, "DOWN");
  } catch {
    /* ignore */
  }
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    try {
      claude.kill();
    } catch {
      /* ignore */
    }
    cleanup();
    process.exit(0);
  });
}

// Relay loop: pick up a queued task and feed it into the OPEN session.
setInterval(() => {
  if (inTurn || !existsSync(INBOX)) return;
  let task = "";
  try {
    task = readFileSync(INBOX, "utf8");
  } catch {
    return;
  }
  try {
    rmSync(INBOX);
  } catch {
    /* ignore */
  }
  if (!task.trim()) return;
  // Unwrap the peer envelope (carries the sender's job key); bare text = legacy sender.
  curJob = JOB;
  curLast = LASTMSG;
  curLease = null;
  curHoldLease = false;
  curControllerPid = 0;
  let curSk = SK;
  let dispatchId = "";
  try {
    const env2 = JSON.parse(task);
    if (env2 && env2.__tandem === 1 && typeof env2.task === "string") {
      task = env2.task;
      const sk = String(env2.sk || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (sk) {
        curSk = sk;
        curJob = join(STATE, "job-" + sk + ".json");
        curLast = join(STATE, "last-" + sk + ".txt");
      }
      dispatchId = String(env2.dispatchId || "");
      curHoldLease = env2.holdLease === true;
      curControllerPid = Number(env2.controllerPid || 0) || 0;
    }
  } catch {
    /* bare text task */
  }
  if (!task.trim()) return;
  if (dispatchId) {
    curLease = leaseFrom(STATE, curSk, dispatchId);
    if (
      !updateDispatch(curLease, {
        workerPid: curHoldLease && curControllerPid ? curControllerPid : process.pid,
        partnerPid: claude.pid || 0,
        partner: "claude",
      })
    ) {
      console.error(`tandem serve: discarded stale dispatch ${dispatchId.slice(0, 8)} (lease no longer owned)`);
      curLease = null;
      return;
    }
    if (!curHoldLease) stopTurnHeartbeat = startHeartbeat(curLease, { pid: process.pid });
  }
  clearTurnSupervision();
  inTurn = true;
  turnStart = Date.now();
  turnLastActivity = turnStart;
  noteTurnActivity("dispatch");
  writeFileSync(STATUS, "RUNNING");
  try {
    writeFileSync(TURNLOG, ""); // reset the live stream for this turn
    if (!curLease) writeFileSync(curJob, JSON.stringify({ status: "running", partner: "claude", ts: Date.now() }));
  } catch {
    /* ignore */
  }
  log({ type: "delegate", ts: Date.now(), driver: "codex", partner: "claude", driverId: CODEX_DRIVER_ID || "", partnerId: sessionId || "", task });
  if (sessionId) recordGroup(GROUPS, { claudeId: sessionId, codexId: CODEX_DRIVER_ID || null, claudeRole: "partner", codexRole: "driver", direction: "codex->claude" });
  // a freshly-reseeded session prepends the handoff summary to its very first turn
  if (existsSync(CLAUDE_SEED)) {
    try {
      task = readFileSync(CLAUDE_SEED, "utf8") + task;
      rmSync(CLAUDE_SEED);
    } catch {
      /* ignore */
    }
  }
  console.log(`  ▸ turn: ${task.replace(/\s+/g, " ").slice(0, 80)}`);
  claude.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: task }] } }) + "\n");
}, 300);
