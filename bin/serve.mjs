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
import { scrubbedClaudeEnv, apiRoutingVarsPresent, partnerEnv } from "./claudeEnv.mjs";
import {
  CLAUDE_HEADLESS_POSTURE,
  createProviderPolicy,
} from "./shared/provider-policy/index.mjs";
import { classifyProviderSignal, wholeResultBanner } from "./limit-signals.mjs";
import { provenanceWarning } from "./provenance.mjs";
import { brandTask, recordSpawnedSession } from "./brand.mjs";
import { ensureRegistered, resolveIdentity } from "./fleet-identity.mjs";
import { fleetDirFor } from "./fleet-inbox.mjs";
import { recordGroup, readGroups, readDetached, jobKey, stateDir } from "./groups.mjs";
import {
  clearDoneSignal,
  finishDispatch,
  isPidAlive,
  jobPaths,
  leaseFrom,
  leaseIsOwned,
  markDispatchActivity,
  signalDone,
  startHeartbeat,
  updateDispatch,
} from "./jobs.mjs";
import {
  CAPTURE_PROMPT,
  describeGracefulStop,
  hardKillProcessTree,
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
const BOUND = join(STATE, "serve.bound.json"); // the supervision/model values this daemon bound at startup
const PARTNER_PID = join(STATE, "claude.pid"); // the claude child — lets a nested peer.mjs detect a self-ask
const CLAUDE_SESSION = join(STATE, "claude.session");
const TANDEM_LOG = join(STATE, "tandem.log.jsonl");
const GROUPS = join(STATE, "groups.json");
const DETACHED = join(STATE, "detached.json"); // drivers reset by `new` → start fresh next turn
const USAGE = join(STATE, "usage.json"); // per-session context size → low-context notice
const CLAUDE_SEED = join(STATE, "claude.seed"); // handoff summary to prepend on a fresh session's first turn
const RATE_LIMIT = join(STATE, "rate-limit.json"); // last rate_limit_event seen (groundwork for a predictive-warning item)
const COMPACT_AT = Number(process.env.TANDEM_COMPACT_AT) || cfg().compactAtTokens || 300000;
const STALL_SEC =
  process.env.TANDEM_STALL_SEC !== undefined
    ? Math.max(0, Number(process.env.TANDEM_STALL_SEC) || 0)
    : Math.max(0, Number(cfg().stallSec ?? 240) || 0);
// Optional LOOSE turn-time limit in HOURS — a convenience alias for maxTurnSec (mirrors peer.mjs).
const MAX_TURN_HOURS =
  process.env.TANDEM_MAX_TURN_HOURS !== undefined
    ? Math.max(0, Number(process.env.TANDEM_MAX_TURN_HOURS) || 0)
    : Math.max(0, Number(cfg().maxTurnHours) || 0);
const MAX_TURN_SEC =
  // An explicit maxTurnSec (env or config, >0) ALWAYS wins; maxTurnHours only fills an unset seconds
  // value (hours*3600), never double-bounds — the same precedence loadConfig applies on the codex side.
  (process.env.TANDEM_MAX_TURN_SEC !== undefined
    ? Math.max(0, Number(process.env.TANDEM_MAX_TURN_SEC) || 0)
    : Math.max(0, Number(cfg().maxTurnSec) || 0)) || (MAX_TURN_HOURS > 0 ? MAX_TURN_HOURS * 3600 : 0);
const STOP_GRACE_SEC =
  process.env.TANDEM_STOP_GRACE_SEC !== undefined
    ? Math.max(0, Number(process.env.TANDEM_STOP_GRACE_SEC) || 0)
    : Math.max(0, Number(cfg().stopGraceSec ?? 5) || 0);
// Protocol grace: a stop mid-turn no longer relies on a WM_CLOSE no-op + tree-kill. It writes a
// stream-json `interrupt` control_request over the SAME live stdin pipe user turns arrive on; the
// CLI ends the turn (a `result` event, error_during_execution) WITHOUT dying, so the persistent
// session stays warm — a CHECKPOINT, not a kill. This is the window we wait for that terminal
// result before the hard-kill backstop fires. STOP_GRACE_SEC now bounds only the throw-fallback path.
const INTERRUPT_GRACE_SEC =
  process.env.TANDEM_INTERRUPT_GRACE_SEC !== undefined
    ? Math.max(0, Number(process.env.TANDEM_INTERRUPT_GRACE_SEC) || 0)
    : Math.max(0, Number(cfg().interruptGraceSec ?? 75) || 0);
// T5 progress capture: a CHECKPOINTED stop (T4) leaves the partner alive with the stopped turn's
// partial work in its warm context. Before finishing the dispatch, run ONE bounded follow-up turn
// on that same warm session asking for a factual progress report, and attach it ADDITIVELY to the
// job record the driver is waiting on. Capture happens only when the partner survived (a hard-killed
// partner has no session to ask); a capture that itself stalls/errors is recorded ok:false and is
// NEVER retried — structural, not judgment: the capture path cannot re-enter itself.
const CAPTURE_ON_STOP =
  process.env.TANDEM_CAPTURE_ON_STOP !== undefined
    ? process.env.TANDEM_CAPTURE_ON_STOP !== "0"
    : cfg().captureOnStop !== false;
const CAPTURE_MAX_SEC =
  process.env.TANDEM_CAPTURE_MAX_SEC !== undefined
    ? Math.max(0, Number(process.env.TANDEM_CAPTURE_MAX_SEC) || 0)
    : Math.max(0, Number(cfg().captureMaxSec ?? 90) || 0);
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
// Persist EVERY rate_limit_event (allowed too) — additive groundwork for a later predictive-warning
// item. Never throws: it must not be able to crash a turn.
function persistRateLimit(info) {
  try {
    writeFileSync(RATE_LIMIT, JSON.stringify({ ts: Date.now(), info }));
  } catch {
    /* groundwork only */
  }
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
// partnerEnv: the Claude partner runs tool calls in ephemeral harness contexts
// (kill-on-close Job Objects on Windows), so it gets TANDEM_NESTED_AGENT=1 —
// any peer.mjs it invokes job-escapes ITS spawns. Equally important, the lane's
// own identity (TANDEM_STATE/LABEL/PARTNER/MODEL…, driver session ids) is
// SCRUBBED: inherited, a partner's `peer.mjs ask` would resolve to THIS lane's
// state, find THIS daemon alive, and relay the "sub-lane" task straight back
// into the partner's own session instead of spawning anything.
const env = scrubbedClaudeEnv(partnerEnv(process.env));

// ---- provider-limit awareness (see peer.mjs for the full doctrine) ----------------------------
// The daemon drives a claude -p partner on the claude.ai subscription. When that account hits a
// 5h/weekly cap, the WORST case is the CLI returning the limit banner as an ordinary exit-0
// `result` — which without this guard the lane would store as the partner's VERDICT. We classify
// genuine CLI signals only (whole-result banner / stderr of a DEAD process — limit-signals.mjs),
// park the provider, and write an error-shaped job record with the loud line instead of the banner.
const LIMIT_ENABLED = process.env.TANDEM_NO_LIMIT_CLASSIFY !== "1";
const tierOf = () => process.env.TANDEM_TIER || "default";
// Unified tier view: the flat config keys are the `default` tier; tiers.<fam>.<tier> presets win.
// Used only to resolve ALTERNATES for the parked-provider message (never to route this lane).
const policyTiers = {
  codex: { default: { model: C.codexModel || "", effort: C.codexEffort || "" }, ...((C.tiers || {}).codex || {}) },
  claude: { default: { model: C.claudeModel || "", effort: C.claudeEffort || "" }, ...((C.tiers || {}).claude || {}) },
};
const policy = createProviderPolicy({
  stateDir: STATE, // per-lane provider state, same file peer.mjs reads/writes
  tiers: policyTiers,
  families: {},
  now: Date.now,
  log: (m) => log({ type: "provider", ts: Date.now(), message: m }),
});
// Classification is gated in limit-signals.mjs: an exit-0 `result` is only a limit when it IS
// the whole banner (strict anchored match) — the partner's ANSWER is never loose-scanned, so a
// turn that merely discusses limit strings can't self-park. The stderr tail is classified only
// in the exit handler (a dead partner CLI is the genuine failure signal; transient 429 retry
// notices on a SURVIVING turn never classify).
function loudProviderLine(family, hit, until, alternates) {
  // Show the reset in UTC AND local: a bare "…Z" ISO was misread in production as a past local time.
  const when = `${new Date(until).toISOString()} (${new Date(until).toLocaleString()} local)`;
  const alt = alternates ? `${alternates.family}/${alternates.model}` : "none available (all providers capped)";
  return (
    `(provider limit hit — ${family} parked until ${when}; this is NOT a task verdict. ` +
    `Alternate: ${alt} — or wait and re-ask. See --failover.)`
  );
}

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
// A FRESH claude session (no --resume) gets the fleet brand as the first line of its first turn,
// so the session is filterable in chat backlogs from birth. Resumed sessions were branded at birth.
let brandPending = !sessionId;
// CLAUDE_HEADLESS_POSTURE (the "never stop to ask a human who isn't here" flag) comes from the
// shared package so orch and tandem agree on the one posture a headless Claude child runs under.
let args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", CLAUDE_HEADLESS_POSTURE, "--verbose"];
// Partner model/effort bind at daemon start (`stop` then re-ask to change). Env is inherited
// from the driver that spawned us. Resolution mirrors peer.mjs: explicit TANDEM_MODEL/EFFORT >
// TANDEM_TIER preset (tiers.claude.<tier> in the config) > flat config defaults.
const tier = (process.env.TANDEM_TIER && C.tiers && C.tiers.claude && C.tiers.claude[process.env.TANDEM_TIER]) || {};
const claudeModel = process.env.TANDEM_MODEL || tier.model || C.claudeModel || "";
if (claudeModel) args.push("--model", claudeModel);
const claudeEffort = process.env.TANDEM_EFFORT || tier.effort || C.claudeEffort || "";
if (claudeEffort) args.push("--effort", claudeEffort);
// A long-lived APEX must never auto-compact: compaction is generation loss, and its failure mode
// is INVISIBLE — context drops, so the fleet's refresh trigger never fires and the session quietly
// becomes a summary of a summary. Prevention here; detection in apex-refresh.detectCompactBoundary.
// Opt in by role (an apex) or explicitly, so ordinary short-lived partners are unaffected.
const noAutoCompact = process.env.TANDEM_ROLE === "apex" || process.env.TANDEM_NO_AUTOCOMPACT === "1";
if (noAutoCompact) {
  const settingsFile = resolve(ROOT, "runtime", "apex-settings.json");
  if (existsSync(settingsFile)) {
    args.push("--settings", settingsFile);
    console.error("tandem: apex partner — auto-compact DISABLED (clear-and-reload owns context, not compaction)");
  } else {
    console.error(`tandem: WARNING — apex partner requested but ${settingsFile} is missing; auto-compact may fire and silently degrade fidelity`);
  }
}
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
// Bound-config visibility: record the supervision windows + model/effort this daemon BOUND at
// startup. A running daemon keeps enforcing these until it is stopped and re-asked — editing
// tandem.config.json changes nothing for it — so `peer.mjs status` reads this to reveal DRIFT.
// Best-effort (try/caught): a visibility file must never block the daemon from coming up.
try {
  writeFileSync(
    BOUND,
    JSON.stringify({
      pid: process.pid,
      startedTs: Date.now(),
      stallSec: STALL_SEC,
      maxTurnSec: MAX_TURN_SEC,
      stopGraceSec: STOP_GRACE_SEC,
      interruptGraceSec: INTERRUPT_GRACE_SEC,
      captureOnStop: CAPTURE_ON_STOP,
      captureMaxSec: CAPTURE_MAX_SEC,
      model: claudeModel,
      effort: claudeEffort,
      bin,
      cwd,
    }),
  );
} catch {
  /* visibility only */
}

let buf = "";
let turnStart = 0;
let inTurn = false;
// Per-turn output targets: each ask's envelope carries the SENDER's job key, so verdicts land
// under the asking driver's files even across driver restarts. Startup SK is the fallback.
let curJob = JOB;
let curLast = LASTMSG;
let curSk = SK; // the job key for the CURRENT dispatch — names its `job-<sk>.done` signal (no-lease path)
let curLease = null;
let stopTurnHeartbeat = null;
let curHoldLease = false;
let curControllerPid = 0;
let terminalHandled = false;
let turnLastActivity = 0;
let lastPersistedActivity = 0;
let stderrTail = ""; // rolling tail of the claude child's stderr (last 4KB) for limit classification
let turnModelActual = ""; // the model the stream PROVED ran this turn (reset per dispatch); "" = unproven
let turnRateLimitInfo = null; // rate_limit_info of the LAST rate_limit_event this turn — PRIMARY limit evidence
let turnDidWork = false; // a tool_use appeared this turn → the turn executed real work (a capped turn cannot)
let turnTermination = null;
let turnHardStopTimer = null;
let supervisionTimer = null;
// T5: non-null while the ONE bounded post-checkpoint capture turn is in flight. Holds the stopped
// turn's fully-built (but unwritten) job record plus the deferred output targets, so the capture's
// outcome can be attached ADDITIVELY before the single finishDispatch the driver is waiting on.
// While set, inTurn stays true (the inbox loop cannot race a new ask into the capture) and the
// result handler routes the next `result` event here instead of the normal turn path.
let capture = null;

// The single exit point of a capture: write the stopped turn's record with the capture outcome
// attached, release the lease/heartbeat, and return the daemon to a clean IDLE. `capture` is nulled
// FIRST so no ordering (timer, exit, second result) can finalize twice.
function finishWithCapture(progressCapture) {
  const c = capture;
  if (!c) return;
  capture = null;
  if (c.capTimer) clearTimeout(c.capTimer);
  try {
    if (!c.lease || leaseIsOwned(c.lease)) writeFileSync(c.last, c.verdict);
    if (c.lease) finishDispatch(c.lease, { ...c.record, progressCapture });
    else {
      // Legacy no-lease finish bypasses finishDispatch → signal explicitly (the lease path signals inside it).
      writeFileSync(c.job, JSON.stringify({ ...c.record, progressCapture, ts: Date.now() }));
      signalDone(STATE, curSk, { dispatchId: "", status: c.record.status || "error" });
    }
  } catch {
    /* ignore — same tolerance as the normal finish path */
  }
  if (stopTurnHeartbeat) stopTurnHeartbeat();
  stopTurnHeartbeat = null;
  curLease = null;
  curHoldLease = false;
  curControllerPid = 0;
  log({ type: "progress-capture", ts: Date.now(), partner: "claude", ok: !!progressCapture.ok, durSec: progressCapture.durSec || 0, error: progressCapture.error || null });
  inTurn = false;
  clearTurnSupervision();
  writeFileSync(STATUS, "IDLE");
  console.log(
    progressCapture.ok
      ? `  ◂ progress captured (${progressCapture.durSec || 0}s) — recovery report attached to the stopped turn's record`
      : `  ◂ progress capture failed: ${progressCapture.error || "unknown"}`,
  );
}

// Provenance fields for the current turn: what tandem asked the CLI to run (claudeModel/claudeEffort,
// bound at daemon start) vs what the stream proved (turnModelActual). The claude stream carries no
// effort, so effortActual stays "". Additive job-record fields only — never changes an outcome.
function turnProvenance() {
  return {
    modelRequested: claudeModel,
    effortRequested: claudeEffort,
    modelActual: turnModelActual,
    effortActual: "",
  };
}

// ONE truthful clause about the stop CHANNEL, derived from the termination record — never a guess
// about partner behavior. deliveryProven separates a signal we can PROVE was delivered (posix kill)
// from one we cannot (win32 WM_CLOSE to a hidden console child); hardKilled says whether the force
// tree-kill was actually needed. Absent record → a neutral, non-committal clause.
function stopChannelClause(stop) {
  if (!stop) return "a stop was requested before tree-kill";
  const first = stop.stopDeliveryProven
    ? "a non-forced stop was delivered first"
    : "a non-forced stop was issued first (win32: delivery to a hidden console child is unprovable)";
  return `${first}; hard tree-kill ${stop.hardKilled ? "followed" : "was not needed"}`;
}

function stopError(stop) {
  const warm = sessionId
    ? `session ${sessionId} remains persisted; the next ask resumes it warm`
    : "no session id was captured; inspect the turn log before continuing";
  if (stop?.kind === "stall") {
    return `turn STALLED/WEDGED after ${stop.idleSec}s with no partner activity; ${stopChannelClause(stop)}; ${warm}`;
  }
  return `turn stopped at the optional maxTurnSec backstop after ${stop?.elapsedSec || 0}s; ${stopChannelClause(stop)}; ${warm}`;
}

// The CHECKPOINT phrasing: a stream-json interrupt landed a terminal result before the hard-kill
// backstop, so the partner process was NOT killed and the session stays warm. Keeps the pinned
// per-kind fragments existing tests match (STALLED/WEDGED for a stall; maxTurnSec backstop for the
// cap) and appends the truthful checkpoint clause.
function checkpointError(stop) {
  const sid = sessionId || "(unknown)";
  const tail = `; turn CHECKPOINTED via stream-json interrupt — the partner process was NOT killed; session ${sid} stays open and warm; continue resumes it`;
  if (stop?.kind === "stall") {
    return `turn STALLED/WEDGED after ${stop.idleSec}s with no partner activity${tail}`;
  }
  return `turn stopped at the optional maxTurnSec backstop after ${stop?.elapsedSec || 0}s${tail}`;
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
  const interruptRequestId = `tandem-stop-${now}`;
  // PRIMARY path: write a stream-json `interrupt` control_request over the SAME stdin pipe we feed
  // user turns to. The CLI accepts it mid-turn and ends the turn with a `result` event WITHOUT dying,
  // so we can CHECKPOINT instead of tree-killing. A throw (stdin already gone) falls back below to the
  // old graceful-then-hard-kill path at STOP_GRACE_SEC.
  let interruptWritten = false;
  try {
    claude.stdin.write(
      JSON.stringify({ type: "control_request", request_id: interruptRequestId, request: { subtype: "interrupt" } }) + "\n",
    );
    interruptWritten = true;
  } catch {
    interruptWritten = false;
  }
  if (interruptWritten) {
    turnTermination = {
      ...decision,
      triggeredTs: now,
      graceSec: INTERRUPT_GRACE_SEC,
      gracefulAttempted: true,
      // The stop CHANNEL: the interrupt request was written to the live protocol pipe. callAccepted =
      // the stdin write succeeded; deliveryProven starts false and is upgraded to true only when the
      // CLI acks THIS request_id with a control_response (the truthful, provable channel T3 wanted).
      stopChannel: "stream-json-interrupt",
      stopCallAccepted: true,
      stopDeliveryProven: false,
      interruptRequestId,
      checkpoint: false,
      // Kept for backward compat: the channel CALL succeeded — NOT proof the partner observed it.
      gracefulSignalAccepted: true,
      hardKilled: false,
    };
    if (curLease) updateDispatch(curLease, { terminationPending: turnTermination });
    // Hard-kill BACKSTOP: if no terminal outcome (result/exit) lands within the interrupt grace, the
    // interrupt was ignored (or the CLI wedged) — tree-kill as the final backstop.
    const hardStop = () => {
      if (terminalHandled || claude.exitCode !== null) return;
      turnTermination.hardStopFired = true;
      turnTermination.hardKilled = hardKillProcessTree(claude.pid);
    };
    if (INTERRUPT_GRACE_SEC > 0) turnHardStopTimer = setTimeout(hardStop, INTERRUPT_GRACE_SEC * 1000);
    else hardStop();
    return;
  }
  // FALLBACK: the stdin write threw — use the old graceful-then-hard-kill path at STOP_GRACE_SEC.
  const stop = describeGracefulStop(claude.pid);
  turnTermination = {
    ...decision,
    triggeredTs: now,
    graceSec: STOP_GRACE_SEC,
    gracefulAttempted: true,
    // The stop CHANNEL, described truthfully (see describeGracefulStop).
    stopChannel: stop.channel,
    stopCallAccepted: stop.callAccepted,
    stopDeliveryProven: stop.deliveryProven,
    interruptRequestId,
    checkpoint: false,
    // Kept for backward compat: the channel CALL succeeded — NOT proof the partner observed it.
    gracefulSignalAccepted: stop.callAccepted,
    hardKilled: false,
  };
  if (curLease) updateDispatch(curLease, { terminationPending: turnTermination });
  const hardStop = () => {
    if (terminalHandled || claude.exitCode !== null) return;
    turnTermination.hardStopFired = true;
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
  try {
    writeFileSync(PARTNER_PID, String(claude.pid));
  } catch {
    /* self-ask guard degrades to env-scrub protection only */
  }
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
      // fleet sessions manifest — chat tooling can hide bridge sessions by ID (advisory)
      recordSpawnedSession({
        provider: "claude",
        sessionId,
        kind: process.env.TANDEM_ROLE || (process.env.TANDEM_LANE_ID ? "junior" : "claude-partner"),
        label: process.env.TANDEM_LABEL || "",
        laneId: process.env.TANDEM_LANE_ID || "",
        cwd,
      });
      // D3 — also enter the FLEET TREE, not just the sessions manifest: a claude partner forked
      // as a branch mind used to be invisible to `fleet tree`, the surface doctrine tells minds
      // to consult. Advisory; never throws into the dispatch path.
      try {
        // seat succession: the SEAT id is stable across rebirths, the session id is the current
        // BODY. Stamp it HERE, where the new body is first proven — at refresh time it does not
        // exist yet, so stamping there could only record a placeholder.
        if (process.env.TANDEM_ROLE === "apex" && process.env.TANDEM_SELF_ID) {
          import("./apex-refresh.mjs")
            .then((m) => m.succeedSeat(fleetDirFor(ROOT), process.env.TANDEM_SELF_ID, sessionId))
            .catch(() => {});
        }
        const id = resolveIdentity(process.env, "claude-partner", sessionId);
        ensureRegistered(fleetDirFor(ROOT), {
          selfId: id.selfId || sessionId,
          sessionId,
          parentId: id.parentId,
          kind: id.kind,
          label: id.label || id.selfId || sessionId,
          cwd,
          state: STATE,
        });
      } catch {
        /* identity bookkeeping is advisory */
      }
    }
    // Provenance: the claude stream stamps the model id on EVERY assistant event (and on the init
    // system event). Keep the LAST seen value — it's what actually ran this turn.
    if (o.type === "assistant" && typeof o.message?.model === "string" && o.message.model) {
      turnModelActual = o.message.model;
    } else if (o.type === "system" && o.subtype === "init" && typeof o.model === "string" && o.model) {
      turnModelActual = o.model;
    }
    // Structural limit evidence (PRIMARY, see the ladder on the result event): the claude stream
    // carries a machine-readable rate_limit_event every turn, and a tool_use proves the turn ran
    // real work (a genuinely capped turn cannot). Both reset per dispatch alongside stderrTail.
    try {
      if (o.type === "rate_limit_event" && o.rate_limit_info && typeof o.rate_limit_info === "object") {
        turnRateLimitInfo = o.rate_limit_info;
        persistRateLimit(o.rate_limit_info);
      } else if (
        o.type === "assistant" &&
        Array.isArray(o.message?.content) &&
        o.message.content.some((c) => c && c.type === "tool_use")
      ) {
        turnDidWork = true;
      }
    } catch {
      /* never let a malformed structural signal crash the turn */
    }
    // control_response to our stream-json interrupt: proves the CLI RECEIVED the stop. Upgrade the
    // pending termination's deliveryProven — this is the provable channel T3 could not have on win32.
    // Idle-interrupt safety: a control_response with no pending termination (or a mismatched id) is
    // ignored. Every field access is guarded so a malformed response can't crash the turn.
    if (o.type === "control_response") {
      try {
        const tt = turnTermination;
        const resp = o.response || {};
        const rid = resp.request_id ?? o.request_id;
        if (tt && tt.stopChannel === "stream-json-interrupt" && resp.subtype === "success" && rid === tt.interruptRequestId) {
          tt.stopDeliveryProven = true;
          if (curLease) updateDispatch(curLease, { terminationPending: tt });
        }
      } catch {
        /* an unparseable control_response never affects the turn */
      }
      continue;
    }
    if (o.type === "result" && capture) {
      // The CAPTURE turn's terminal result. This routes BEFORE the normal turn path (and before the
      // provider-limit ladder — the light banner check below is the only classification a capture
      // needs: a banner answer parks the provider and fails the capture, never poses as progress).
      const capStopped = turnTermination; // set only if the capture turn was itself supervision-stopped
      if (capStopped && capStopped.hardStopFired) continue; // backstop already fired — the exit handler owns the record (mirrors T4)
      const capVerdict = o.result || "";
      const capDur = Math.round((Date.now() - capture.startedTs) / 1000);
      let pc;
      const banner = LIMIT_ENABLED && !capStopped && wholeResultBanner(capVerdict);
      if (capStopped) {
        pc = { attempted: true, ok: false, durSec: capDur, error: `the capture turn was itself stopped (${capStopped.kind}) after ${capDur}s` };
      } else if (banner) {
        try {
          policy.markDown("claude", capVerdict.trim());
        } catch {
          /* a park that can't be recorded never hides the capture failure */
        }
        pc = { attempted: true, ok: false, durSec: capDur, error: `provider limit during the capture turn: ${capVerdict.trim().slice(0, 200)}` };
      } else if (o.is_error === true || !capVerdict.trim()) {
        pc = { attempted: true, ok: false, durSec: capDur, error: o.is_error === true ? "the capture turn returned an error result" : "the capture turn returned an empty answer" };
      } else {
        pc = { attempted: true, ok: true, durSec: capDur, verdict: capVerdict };
      }
      finishWithCapture(pc);
      continue;
    }
    if (o.type === "result") {
      const stopped = turnTermination;
      // CHECKPOINT: a stream-json interrupt produced this terminal result BEFORE the hard-kill
      // backstop fired, so the partner process is still alive. Disarm the backstop, mark the turn a
      // checkpoint, and (below) return to a clean IDLE — the next ask dispatches into the SAME warm
      // session with no kill and no respawn. If the backstop already fired (hardStopFired), the exit
      // handler owns the record with the truthful hardKilled/checkpoint:false fields instead.
      const checkpoint = !!(stopped && stopped.stopChannel === "stream-json-interrupt" && !stopped.hardStopFired);
      if (checkpoint) {
        if (turnHardStopTimer) clearTimeout(turnHardStopTimer);
        turnHardStopTimer = null;
        stopped.checkpoint = true;
      }
      const verdict = o.result || "";
      const dur = Math.round((Date.now() - turnStart) / 1000);
      const u = o.usage || {};
      const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (used) setUsage(sessionId, used);
      const low = lowNote(sessionId, used);
      // Provenance stamped onto every result shape below: what tandem asked for vs what the stream
      // proved, plus a loud warning on a proven mismatch (never flips the outcome).
      const provenance = turnProvenance();
      const provenanceWarn = provenanceWarning(provenance);

      // Provider-limit guard (T2 classification ladder). STRUCTURAL evidence is PRIMARY; banner
      // text drops to last-resort. `park` → an ERROR-shaped record replaces the verdict; a set
      // `keepVerdictPark` (a real verdict from a turn that DID work) survives untouched but parks
      // the provider for FUTURE asks. LIMIT_ENABLED gates the whole ladder; every parse is caught.
      let park = null; // { msg, kind, signal } → error-shaped park
      let keepVerdictPark = null; // { msg, signal } → verdict survives; park future asks only
      let proximityWarn = null; // W3: a warn-shaped rate_limit_event → additive headroom notice, NEVER a park
      if (LIMIT_ENABLED) {
        try {
          const rli = turnRateLimitInfo;
          const status = rli && typeof rli.status === "string" ? rli.status.trim() : "";
          if (status) {
            // 1. PRIMARY — the CLI's own rate_limit_event. A refusal status is the strongest signal.
            if (/reject|block|exceed|denied/i.test(status)) {
              const type = rli.rateLimitType || "unknown";
              const resetsAt = rli.resetsAt;
              const hasEpoch = typeof resetsAt === "number" && /^\d{10}$/.test(String(resetsAt));
              const msg = `rate_limit_event: status=${status} type=${type}` + (hasEpoch ? ` resets_at:${resetsAt}` : "");
              // No real verdict (error/banner/empty/no-work) → error-shaped park; a real verdict from
              // a turn that DID work → keep the verdict and park only the future.
              const worthless = o.is_error === true || wholeResultBanner(verdict) || !verdict.trim() || !turnDidWork;
              if (worthless) park = { msg, kind: "limit", signal: "rate_limit_event" };
              else keepVerdictPark = { msg, signal: "rate_limit_event" };
            } else if (/warn/i.test(status)) {
              // PROXIMITY (e.g. allowed_warning): NEVER a park. Cash the persisted groundwork into an
              // ADDITIVE, driver-facing headroom warning built from the event's OWN fields only —
              // status, rateLimitType, and resetsAt when it is a plausible epoch (the same hasEpoch
              // guard the reject branch uses). It never blocks, error-shapes, or reshapes the verdict.
              const type = rli.rateLimitType || "unknown";
              const resetsAt = rli.resetsAt;
              const hasEpoch = typeof resetsAt === "number" && /^\d{10}$/.test(String(resetsAt));
              proximityWarn =
                `claude usage headroom warning (${type}): approaching the limit; status ${status}` +
                (hasEpoch ? `; resets ~${new Date(resetsAt * 1000).toISOString()}` : "");
              console.error(`tandem serve: ${proximityWarn}`);
              log({ type: "usage-headroom-warning", ts: Date.now(), partner: "claude", status, rateLimitType: type, resetsAt: hasEpoch ? resetsAt : null });
            } else if (status !== "allowed") {
              // unrecognized non-allowed status: forensics only, prefer false-negative per the doctrine.
              log({ type: "rate-limit-status-unknown", ts: Date.now(), status });
            }
          }
          // 2. SECONDARY — an error-shaped result is CLI failure output, so loose-scanning is admissible.
          if (!park && !keepVerdictPark && (o.is_error === true || o.api_error_status === 429 || o.api_error_status === 529)) {
            const msg = policy.extractFailure(String(verdict).slice(-4000));
            const kind = msg ? policy.classify(msg)?.kind : null;
            if (kind) park = { msg, kind, signal: "result-error" };
          }
          // 3. LAST-RESORT — whole-banner text, but a banner AFTER real tool work is an ordinary verdict.
          if (!park && !keepVerdictPark && !turnDidWork) {
            const hit = classifyProviderSignal(policy, { finalMessage: verdict });
            if (hit) park = { msg: hit.msg, kind: hit.kind, signal: "banner" };
          }
        } catch {
          /* an unclassifiable turn is never a park — fall through to the normal verdict */
        }
      }
      if (park) {
        const { until } = policy.markDown("claude", park.msg);
        const errorKind = park.kind === "auth" ? "provider-auth" : "provider-limit";
        const alternates = policy.resolve("codex", tierOf());
        const iso = new Date(until).toISOString();
        const loud = loudProviderLine("claude", park, until, alternates);
        // Additive fields only — status stays within the frozen enum; wait/watch/ceerelay unaffected.
        const errRecord = {
          partner: "claude",
          workerPid: curHoldLease ? curControllerPid : process.pid,
          partnerPid: claude.pid || 0,
          durSec: dur,
          verdict: loud, // the LOUD line, never the raw banner
          lowContext: low,
          ...provenance,
          warning: provenanceWarn || null,
          status: "error",
          errorKind,
          provider: "claude",
          resetAt: until,
          providerMessage: park.msg.slice(0, 300),
          limitSignal: park.signal,
          alternates,
          error: `${errorKind === "provider-auth" ? "provider auth failure" : "provider usage limit"} on claude: ${park.msg.slice(0, 300)} (resets ~${iso})`,
        };
        try {
          // LASTMSG must be the loud line, not the bare banner (this is what `result`/`status` echo).
          if (!curHoldLease && (!curLease || leaseIsOwned(curLease))) writeFileSync(curLast, loud);
          if (curLease) {
            if (curHoldLease) updateDispatch(curLease, { ...errRecord, resultReady: true });
            else finishDispatch(curLease, errRecord);
          } else {
            writeFileSync(curJob, JSON.stringify({ ...errRecord, ts: Date.now() }));
            signalDone(STATE, curSk, { dispatchId: "", status: "error" }); // legacy no-lease finish → signal explicitly
          }
        } catch {
          /* ignore */
        }
        if (stopTurnHeartbeat) stopTurnHeartbeat();
        stopTurnHeartbeat = null;
        curLease = null;
        curHoldLease = false;
        curControllerPid = 0;
        // forensics: keep the RAW banner in the timeline even though the verdict is replaced.
        log({ type: "provider-limit", ts: Date.now(), partner: "claude", kind: park.kind, providerMessage: park.msg, raw: verdict, signal: park.signal });
        recordGroup(GROUPS, { claudeId: sessionId, codexId: CODEX_DRIVER_ID || null, claudeRole: "partner", codexRole: "driver", direction: "codex->claude" });
        inTurn = false;
        if (!stopped) clearTurnSupervision();
        writeFileSync(STATUS, stopped ? "STOPPING" : "IDLE");
        console.log(`  ◂ turn PROVIDER-LIMIT (${dur}s): parked claude until ${iso}`);
        continue;
      }

      // A refusal signal alongside a REAL verdict from a turn that did work: keep the verdict, but
      // park the provider so FUTURE asks fast-fail, and stamp the record so it tells both truths.
      let verdictParkFields = null;
      let verdictParkWarn = null;
      if (keepVerdictPark) {
        try {
          const { until } = policy.markDown("claude", keepVerdictPark.msg);
          const parkWarn = `provider limit signaled — claude parked until ${new Date(until).toISOString()}; future asks fast-fail until the reset`;
          verdictParkWarn = provenanceWarn ? `${provenanceWarn}; ${parkWarn}` : parkWarn;
          verdictParkFields = {
            provider: "claude",
            resetAt: until,
            providerMessage: keepVerdictPark.msg.slice(0, 300),
            limitSignal: keepVerdictPark.signal,
          };
        } catch {
          /* a park that can't be recorded never destroys the verdict */
        }
      }

      // W3: compose the driver-facing warning ADDITIVELY. A proximity headroom notice rides ALONGSIDE
      // whatever provenance/park warning the turn already carries — a warn-shaped event is never a
      // park, never error-shaped, and never blocks the verdict; it only annotates the record.
      const turnWarn = [proximityWarn, verdictParkWarn || provenanceWarn || null].filter(Boolean).join("; ") || null;

      // T5: a CHECKPOINTED stop leaves the partner ALIVE with the stopped turn's work in its warm
      // context — capture progress BEFORE finishing the dispatch, so the record the driver is
      // waiting on already carries the recovery report. Held-lease (compact) dispatches are
      // excluded: their controller polls resultReady and owns the outcome. The stopped turn's
      // side effects (usage, group, verdict log) happen HERE; only the record write is deferred.
      if (checkpoint && !curHoldLease && CAPTURE_ON_STOP) {
        const record = {
          partner: "claude",
          workerPid: process.pid,
          partnerPid: claude.pid || 0,
          durSec: dur,
          verdict,
          lowContext: low,
          ...provenance,
          ...(verdictParkFields || {}),
          warning: turnWarn,
          status: "error",
          error: checkpointError(stopped),
          termination: stopped,
          terminationPending: null,
          stalled: stopped?.kind === "stall",
        };
        // curLease may be null (legacy bare-text dispatch) — the deferred write then targets curJob.
        capture = { lease: curLease, job: curJob, last: curLast, verdict, record, startedTs: Date.now(), capTimer: null };
        log({ type: "verdict", ts: Date.now(), partner: "claude", durSec: dur, verdict });
        if (low) console.log(low);
        recordGroup(GROUPS, { claudeId: sessionId, codexId: CODEX_DRIVER_ID || null, claudeRole: "partner", codexRole: "driver", direction: "codex->claude" });
        // Supervise the capture like any turn: reset the clocks so the global stall/max windows
        // measure the CAPTURE turn, plus its own absolute captureMaxSec bound. inTurn stays true,
        // so the inbox loop cannot race a queued ask into the middle of the capture. STATUS stays
        // RUNNING — deliberately NOT a new state: ensureClaudeDaemon treats only IDLE/RUNNING as a
        // ready daemon, and the daemon IS mid-turn.
        clearTurnSupervision();
        turnStart = Date.now();
        turnLastActivity = turnStart;
        capture.startedTs = turnStart;
        stderrTail = ""; // per-turn resets, same as a dispatch — a prior turn's signals never bleed in
        turnModelActual = "";
        turnRateLimitInfo = null;
        turnDidWork = false;
        console.log(`  ◂ turn CHECKPOINTED (${dur}s) — capturing progress from the warm session (bounded ${CAPTURE_MAX_SEC > 0 ? CAPTURE_MAX_SEC + "s" : "by the lane windows only"})`);
        if (CAPTURE_MAX_SEC > 0) {
          capture.capTimer = setTimeout(() => {
            // The capture's own absolute bound. beginTurnStop re-guards on turnTermination; the
            // resulting interrupt flows back through the capture-result intercept as ok:false.
            if (!capture || turnTermination) return;
            beginTurnStop({
              kind: "capture-max",
              elapsedSec: Number(((Date.now() - turnStart) / 1000).toFixed(3)),
              idleSec: Number(((Date.now() - turnLastActivity) / 1000).toFixed(3)),
            });
          }, CAPTURE_MAX_SEC * 1000);
        }
        try {
          claude.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: CAPTURE_PROMPT }] } }) + "\n");
        } catch {
          finishWithCapture({ attempted: true, ok: false, error: "the partner's stdin was gone before the capture prompt could be written" });
        }
        continue;
      }
      // Stopped turns that CANNOT capture say why, additively; successful turns carry nothing new.
      const progressCaptureNote = !stopped
        ? null
        : !checkpoint
          ? { attempted: false, reason: "the partner was hard-killed — no warm session to capture from" }
          : curHoldLease
            ? { attempted: false, reason: "held-lease dispatch — the controller owns the outcome" }
            : { attempted: false, reason: "captureOnStop disabled" };
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
            ...provenance,
            ...(verdictParkFields || {}),
            warning: turnWarn,
          };
          if (curHoldLease) updateDispatch(curLease, { ...result, resultReady: true });
          else {
            finishDispatch(curLease, {
              ...result,
              status: stopped ? "error" : "done",
              error: stopped ? (checkpoint ? checkpointError(stopped) : stopError(stopped)) : undefined,
              termination: stopped,
              terminationPending: null,
              stalled: stopped?.kind === "stall",
              ...(progressCaptureNote ? { progressCapture: progressCaptureNote } : {}),
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
              ...provenance,
              ...(verdictParkFields || {}),
              warning: turnWarn,
              error: stopped ? (checkpoint ? checkpointError(stopped) : stopError(stopped)) : undefined,
              termination: stopped,
              stalled: stopped?.kind === "stall",
              ...(progressCaptureNote ? { progressCapture: progressCaptureNote } : {}),
              ts: Date.now(),
            }),
          );
          signalDone(STATE, curSk, { dispatchId: "", status: stopped ? "error" : "done" }); // legacy no-lease finish
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
      // A checkpoint clears supervision and returns to IDLE (warm session, next ask reuses it); a
      // non-checkpoint stop leaves STOPPING for the exit handler as before.
      if (!stopped || checkpoint) clearTurnSupervision();
      writeFileSync(STATUS, stopped && !checkpoint ? "STOPPING" : "IDLE");
      console.log(
        checkpoint
          ? `  ◂ turn CHECKPOINTED (${dur}s): stream-json interrupt — partner NOT killed, session warm`
          : `  ◂ turn done (${dur}s): ${verdict.replace(/\s+/g, " ").slice(0, 80)}`,
      );
    }
  }
});
claude.stderr.on("data", (b) => {
  noteTurnActivity("stderr");
  stderrTail = (stderrTail + b.toString()).slice(-4000); // keep the last 4KB for limit classification
  process.stderr.write(b);
});
claude.on("exit", (code) => {
  if (terminalHandled) return;
  terminalHandled = true;
  const stopped = turnTermination;
  console.error(`tandem serve: claude session ended (${code})`);
  // A dead partner CLI is the one GENUINE failure signal under which the stderr tail may be
  // loose-classified (never on a surviving turn — see limit-signals.mjs). On a hit, park claude
  // and carry the additive provider fields on the error record.
  const limitHit =
    LIMIT_ENABLED && !stopped && code ? classifyProviderSignal(policy, { stderrTail, exitFailed: true }) : null;
  let limitFields = null;
  if (limitHit) {
    const { until } = policy.markDown("claude", limitHit.msg);
    const errorKind = limitHit.kind === "auth" ? "provider-auth" : "provider-limit";
    limitFields = {
      errorKind,
      provider: "claude",
      resetAt: until,
      providerMessage: limitHit.msg.slice(0, 300),
      limitSignal: "stderr",
      alternates: policy.resolve("codex", tierOf()),
    };
    log({ type: "provider-limit", ts: Date.now(), partner: "claude", kind: limitHit.kind, providerMessage: limitHit.msg, raw: "", signal: "stderr" });
  }
  // T5: the partner died MID-CAPTURE — the ORIGINAL stopped record is what must land, with the
  // capture recorded as the honest failure it was. Written directly (not via finishWithCapture,
  // which would repaint STATUS as IDLE while the daemon is in fact exiting).
  if (capture) {
    const c = capture;
    capture = null;
    if (c.capTimer) clearTimeout(c.capTimer);
    const pc = { attempted: true, ok: false, error: `the partner process exited during the capture turn (code ${code ?? "unknown"})` };
    try {
      if (!c.lease || leaseIsOwned(c.lease)) writeFileSync(c.last, c.verdict);
      if (c.lease) finishDispatch(c.lease, { ...c.record, progressCapture: pc });
      else {
        writeFileSync(c.job, JSON.stringify({ ...c.record, progressCapture: pc, ts: Date.now() }));
        signalDone(STATE, curSk, { dispatchId: "", status: c.record.status || "error" }); // legacy no-lease finish
      }
    } catch {
      /* ignore */
    }
    log({ type: "progress-capture", ts: Date.now(), partner: "claude", ok: false, durSec: 0, error: pc.error });
    if (stopTurnHeartbeat) stopTurnHeartbeat();
    stopTurnHeartbeat = null;
    curLease = null;
  }
  if (curLease) {
    if (stopTurnHeartbeat) stopTurnHeartbeat();
    const exitProvenance = turnProvenance(); // last known actual for the turn that was in flight
    finishDispatch(curLease, {
      status: "error",
      partner: "claude",
      workerPid: process.pid,
      partnerPid: claude.pid || 0,
      error: stopped
        ? stopError(stopped)
        : limitFields
          ? `provider ${limitFields.errorKind === "provider-auth" ? "auth failure" : "usage limit"} on claude — the persistent process exited (code ${code ?? "unknown"}): ${limitFields.providerMessage} (resets ~${new Date(limitFields.resetAt).toISOString()})`
          : `persistent Claude process exited during the turn (code ${code ?? "unknown"})`,
      ...(limitFields || {}),
      ...exitProvenance,
      warning: provenanceWarning(exitProvenance) || null,
      termination: stopped,
      terminationPending: null,
      stalled: stopped?.kind === "stall",
      // A supervised stop whose partner is now DEAD can never capture — say so, additively.
      ...(stopped ? { progressCapture: { attempted: false, reason: "the partner process died before a capture could run — no warm session to ask" } } : {}),
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
    rmSync(BOUND);
  } catch {
    /* ignore */
  }
  try {
    rmSync(PARTNER_PID);
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
  curSk = SK;
  curLease = null;
  curHoldLease = false;
  curControllerPid = 0;
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
  stderrTail = ""; // fresh per turn so a prior turn's banner can't misclassify this one
  turnModelActual = ""; // reset per dispatch — never reuse a prior turn's proven model
  turnRateLimitInfo = null; // structural limit evidence is per-turn — never carry a prior turn's event
  turnDidWork = false; // reset the "this turn ran real work" witness per dispatch
  inTurn = true;
  turnStart = Date.now();
  turnLastActivity = turnStart;
  noteTurnActivity("dispatch");
  writeFileSync(STATUS, "RUNNING");
  try {
    writeFileSync(TURNLOG, ""); // reset the live stream for this turn
    // No-lease legacy path: the lease path clears the done signal in acquireDispatch, but a bare-text
    // dispatch has no lease, so clear it HERE as the running record is first written — same staleness
    // discipline, so a leftover signal from a prior legacy turn can never wake a waiter early.
    if (!curLease) {
      clearDoneSignal(STATE, curSk);
      writeFileSync(curJob, JSON.stringify({ status: "running", partner: "claude", ts: Date.now() }));
    }
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
  // brand goes OUTERMOST (above any seed) — the first line of the session titles it everywhere
  if (brandPending) {
    task = brandTask(task, {
      kind: process.env.TANDEM_ROLE || (process.env.TANDEM_LANE_ID ? "junior" : "claude-partner"),
      label: process.env.TANDEM_LABEL || "",
      laneId: process.env.TANDEM_LANE_ID || "",
    });
    brandPending = false;
  }
  console.log(`  ▸ turn: ${task.replace(/\s+/g, " ").slice(0, 80)}`);
  claude.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: task }] } }) + "\n");
}, 300);
