#!/usr/bin/env node
// tandem — peer bridge
// Drive the PARTNER agent (default: Codex) from the current session as a true
// co-engineer. Replaces the file-drop relay + hand-rolled rollout-jsonl parsing
// with one clean command: delegate a scoped investigation, get back the
// partner's verdict + a digest of what it actually did (commands, files, tokens).
//
//   node peer.mjs ask "<task>"     delegate a turn to the partner (resumes the
//                                  shared session for continuity); prints verdict
//   node peer.mjs ask -            read the task from stdin (safe for long/multiline)
//   node peer.mjs status           is the partner mid-turn? last turn summary
//   node peer.mjs tail [n]         last n lines of the in-flight/last turn log
//   node peer.mjs result [n]       reprint the last turn's verdict (last n msgs)
//   node peer.mjs new              forget the session (next ask starts fresh)
//
// Long turns: run this via your harness's background mechanism (it blocks until
// the partner's turn completes), then read the printed verdict.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { recordGroup, readGroups, readDetached, markDetached, jobKey, stateDir, setLabel } from "./groups.mjs";
import {
  DispatchBusyError,
  acquireDispatch,
  finishDispatch,
  forceFinishDispatch,
  inspectDispatch,
  isPidAlive,
  jobPaths,
  leaseFrom,
  markDispatchActivity,
  startHeartbeat,
  updateDispatch,
} from "./jobs.mjs";
import {
  describeGracefulStop,
  hardKillProcessTree,
  supervisionDecision,
} from "./process-control.mjs";
import { attachLaneWorktree, ensureLaneWorktree, readLaneMetadata } from "./worktrees.mjs";
import {
  findSwarmLane,
  inspectSwarm,
  laneEnvironment,
  listSwarms,
  prepareSwarm,
  readSwarm,
  updateSwarm,
} from "./swarm.mjs";
import { partnerEnv, scrubbedClaudeEnv } from "./claudeEnv.mjs";
import { createProviderPolicy } from "./shared/provider-policy/index.mjs";
import { classifyProviderSignal } from "./limit-signals.mjs";
import { provenanceWarning } from "./provenance.mjs";
import { spawnDebug, spawnDetachedWorker } from "./spawn-escape.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
// This driving session's id → its OWN state folder (tandems/<label-or-id>), so unrelated tandems
// never share state, timeline, or ledger. Name it with `peer.mjs label`. TANDEM_STATE overrides
// (tests); no-driver CLI uses .state.
const DRIVER_ID = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_CONVERSATION_ID || "";
// What KIND of agent is driving (for truthful timeline/group records — a Codex driver used to be
// hardcoded as "claude"). Same detection signals as detectPartner().
const DRIVER_KIND = process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_CODE_ENTRYPOINT ? "claude" : DRIVER_ID ? "codex" : "claude";
const STATE = stateDir(ROOT, DRIVER_ID);
const SESSION_FILE = join(STATE, "peer.session");
const DETACHED = join(STATE, "detached.json"); // drivers reset by `new` → start fresh next turn
const USAGE = join(STATE, "usage.json"); // per-session context size (input tokens) → compaction trigger
const SK = jobKey(DRIVER_ID); // per-driver suffix (still isolates within a shared TANDEM_STATE / .state)
const LASTMSG = join(STATE, `last-${SK}.txt`);
const LEDGER = join(STATE, "TANDEM.md"); // per-tandem ledger (never shared across pairs)
const COMPACT_OUT = join(STATE, "compact.out"); // handoff-summary turns write HERE, not LASTMSG (keep the real verdict clean)
const CODEX_SEED = join(STATE, "codex.seed"); // handoff summary the next fresh codex turn prepends

// ---- compaction: hand a near-full session off to a fresh one so it never breaks ----
const COMPACT_PROMPT =
  "You are about to hand this work off to a FRESH session because this one is near its context limit. Write a complete HANDOFF SUMMARY so nothing is lost: the goal, key decisions and constraints, what's already done, the EXACT current task and state, open questions, and the important files/paths/identifiers. Output ONLY the summary.";
const handoffSeed = (s) =>
  "[Handoff from a previous session that reached its context limit — treat this as your background context, then continue.]\n\n" +
  (s || "(no summary was available)") +
  "\n\n---\nContinue from here.\n\n";
function readUsage() {
  try {
    return JSON.parse(readFileSync(USAGE, "utf8"));
  } catch {
    return {};
  }
}
function setUsage(sid, n) {
  if (!sid) return;
  const u = readUsage();
  u[sid] = n;
  try {
    writeFileSync(USAGE, JSON.stringify(u));
  } catch {
    /* ignore */
  }
}
function isContextError(text) {
  return /context (length|limit|window)|maximum context|context.{0,12}exceed|too many tokens|token.{0,4}limit|prompt is too long|413 |payload too large/i.test(text || "");
}
// The driver-facing "passenger is running low" notice (null until the threshold is crossed).
function lowContextNote(sid, limit) {
  if (!sid || !limit) return null;
  const used = readUsage()[sid] || 0;
  if (used < limit) return null;
  return (
    `\n⚠ tandem: the partner (codex ${String(sid).slice(0, 8)}) is running low on context — ~${used} tokens used (limit ${limit}).\n` +
    `   Hand off to a fresh thread, crafting what to preserve:\n` +
    `     node bin/peer.mjs compact "Summarize X, Y, Z so a fresh session continues seamlessly"\n` +
    `   (or just \`peer.mjs compact\` for the default summary). The pair re-couples to the fresh thread automatically.`
  );
}
const TURNLOG = join(STATE, "turn.jsonl");
const TANDEM_LOG = join(STATE, "tandem.log.jsonl"); // collaboration timeline for the watcher

function logEvent(e) {
  try {
    ensureState();
    appendFileSync(TANDEM_LOG, JSON.stringify(e) + "\n");
  } catch {
    /* ignore */
  }
}

// Auto-detect which agent is DRIVING (this process's session) → the partner is
// the other model. Claude Code sets CLAUDECODE/CLAUDE_CODE_*; Codex sets CODEX_*.
function detectPartner() {
  if (process.env.TANDEM_PARTNER) return process.env.TANDEM_PARTNER; // explicit override
  const isClaude = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_CODE_ENTRYPOINT);
  const isCodex = Object.keys(process.env).some((k) => k.startsWith("CODEX_"));
  if (isClaude && !isCodex) return "codex"; // Claude is driving → partner Codex
  if (isCodex && !isClaude) return "claude"; // Codex is driving → partner Claude
  return "codex"; // fallback (assume Claude driver)
}

// The UNIFIED tier view both loadConfig (tier resolution) and the provider policy consume: for
// each family, the flat model/effort keys become the `default` tier, and any explicit
// tiers.<fam>.<tier> presets are layered on top (config presets win). This is the single mapping
// from tandem's config shape to the shared package's { family: { tier: {model, effort} } } shape.
function unifyTiers(c) {
  const mk = (model, effort, extra) => ({ default: { model: model || "", effort: effort || "" }, ...(extra || {}) });
  const tiers = c.tiers || {};
  return {
    codex: mk(c.codexModel, c.codexEffort, tiers.codex),
    claude: mk(c.claudeModel, c.claudeEffort, tiers.claude),
  };
}

function loadConfig() {
  const defaults = {
    // PARTNER = the model the driver pairs with. Auto-detected from the session
    // (Claude driving → codex; Codex driving → claude). Override via TANDEM_PARTNER.
    partner: detectPartner(),
    codexBin: process.env.CEERELAY_CODEX_BIN || process.env.TANDEM_CODEX_BIN || "codex",
    claudeBin: process.env.CEERELAY_CLAUDE_BIN || process.env.TANDEM_CLAUDE_BIN || "claude",
    // working directory the partner operates in (the shared project)
    cwd: process.env.TANDEM_CWD || process.cwd(),
    // codex posture: "config" (your never-ask config) | "read" | "workspace" | "yolo"
    posture: process.env.TANDEM_POSTURE || "config",
    // claude partner: max seconds to wait for a turn, and quiet window to call it done
    claudeMaxSec: 900,
    claudeQuietSec: 6,
    // compaction: when a partner session's context (input tokens) reaches this, the driver
    // is NOTIFIED that the passenger is running low and should hand off to a fresh session
    // (via `peer.mjs compact "<your handoff prompt>"`). Set near ~80% of the partner model's
    // context window. 0 disables the notice.
    compactAtTokens: Number(process.env.TANDEM_COMPACT_AT) || 300000,
    // if true, the bridge compacts automatically (default summary) instead of just notifying.
    autoCompact: process.env.TANDEM_AUTO_COMPACT === "1" || false,
    // Stop only after a full quiet window; output and tool events refresh activity. The optional
    // absolute backstop is off by default. Both paths request graceful shutdown before tree-kill.
    stallSec: 240,
    maxTurnSec: 0,
    stopGraceSec: 5,
    // A live worker writes an independent heartbeat. If the PID dies, status reports WEDGED
    // immediately; if the PID survives but its heartbeat stops for this long, status also
    // reports WEDGED. 0 disables heartbeat-age detection (dead-PID detection remains).
    wedgeAfterSec: 60,
    // partner model selection. codexModel/codexEffort apply per-ask (fresh AND resume both
    // accept -m / -c model_reasoning_effort). claudeModel/claudeEffort bind when the serve
    // daemon starts — `stop` first to change. Empty = defer to each CLI's own config.
    codexModel: "",
    codexEffort: "",
    claudeModel: "",
    claudeEffort: "",
    // tier presets — tiers.<partner>.<tier> = { model, effort }. The ONLY place model names
    // live; docs/doctrine speak in tiers (TANDEM_TIER) so they survive model generations.
    // The flat keys above are the "default" tier.
    tiers: {},
  };
  let cfg = defaults;
  for (const p of [join(ROOT, "tandem.config.json"), join(process.cwd(), "tandem.config.json")]) {
    if (existsSync(p)) {
      try {
        cfg = { ...defaults, ...JSON.parse(readFileSync(p, "utf8")) };
        break;
      } catch (e) {
        console.error(`tandem: bad config ${p}: ${e.message}`);
      }
    }
  }
  // Explicit env overrides win over the config file (standard precedence; also lets tests
  // point the partner bin at a fake without touching the file). A persisted lane cwd is
  // applied last below because worktree isolation is a lane invariant, not a soft default.
  const envBin = process.env.CEERELAY_CODEX_BIN || process.env.TANDEM_CODEX_BIN;
  if (envBin) cfg.codexBin = envBin;
  const envClaude = process.env.CEERELAY_CLAUDE_BIN || process.env.TANDEM_CLAUDE_BIN;
  if (envClaude) cfg.claudeBin = envClaude;
  if (process.env.TANDEM_CWD) cfg.cwd = process.env.TANDEM_CWD;
  if (process.env.TANDEM_PARTNER) cfg.partner = process.env.TANDEM_PARTNER;
  if (process.env.TANDEM_POSTURE) cfg.posture = process.env.TANDEM_POSTURE;
  // TANDEM_TIER resolves a tier preset for the active partner (routed AFTER the TANDEM_PARTNER
  // override above). Resolution goes through the UNIFIED tier view (see unifyTiers): the flat
  // codexModel/codexEffort (claudeModel/claudeEffort) keys are the `default` tier, and explicit
  // tiers.<fam>.<tier> presets win. Existing behavior is preserved exactly: efficient/deep resolve
  // from the config as before; an unknown tier still warns and keeps the flat defaults; the new
  // TANDEM_TIER=default is additive and resolves to the flat keys (a no-op override).
  if (process.env.TANDEM_TIER) {
    const tierName = process.env.TANDEM_TIER;
    const fam = unifyTiers(cfg)[cfg.partner] || {};
    // "Known" = the flat-key default, or an explicit preset in tiers.<fam>. Anything else warns.
    if (tierName !== "default" && !((cfg.tiers || {})[cfg.partner] || {})[tierName]) {
      console.error(`tandem: unknown tier "${tierName}" for partner "${cfg.partner}" (no tiers entry in tandem.config.json) — using defaults`);
    } else {
      const t = fam[tierName] || fam.default || {};
      if (cfg.partner === "claude") {
        if (t.model) cfg.claudeModel = t.model;
        if (t.effort) cfg.claudeEffort = t.effort;
      } else {
        if (t.model) cfg.codexModel = t.model;
        if (t.effort) cfg.codexEffort = t.effort;
      }
    }
  }
  // TANDEM_MODEL / TANDEM_EFFORT target whichever partner is active. codex: -m /
  // -c model_reasoning_effort per ask. claude: --model / --effort at daemon start.
  if (process.env.TANDEM_MODEL) {
    if (cfg.partner === "claude") cfg.claudeModel = process.env.TANDEM_MODEL;
    else cfg.codexModel = process.env.TANDEM_MODEL;
  }
  if (process.env.TANDEM_EFFORT) {
    if (cfg.partner === "claude") cfg.claudeEffort = process.env.TANDEM_EFFORT;
    else cfg.codexEffort = process.env.TANDEM_EFFORT;
  }
  if (process.env.TANDEM_COMPACT_AT) cfg.compactAtTokens = Number(process.env.TANDEM_COMPACT_AT);
  if (process.env.TANDEM_AUTO_COMPACT) cfg.autoCompact = process.env.TANDEM_AUTO_COMPACT === "1";
  if (process.env.TANDEM_STALL_SEC !== undefined) cfg.stallSec = Number(process.env.TANDEM_STALL_SEC) || 0;
  if (process.env.TANDEM_MAX_TURN_SEC !== undefined) cfg.maxTurnSec = Number(process.env.TANDEM_MAX_TURN_SEC) || 0;
  if (process.env.TANDEM_STOP_GRACE_SEC !== undefined) cfg.stopGraceSec = Number(process.env.TANDEM_STOP_GRACE_SEC) || 0;
  if (process.env.TANDEM_WEDGE_AFTER_SEC !== undefined) cfg.wedgeAfterSec = Number(process.env.TANDEM_WEDGE_AFTER_SEC) || 0;
  cfg.stallSec = Math.max(0, Number(cfg.stallSec) || 0);
  cfg.maxTurnSec = Math.max(0, Number(cfg.maxTurnSec) || 0);
  cfg.stopGraceSec = Math.max(0, Number(cfg.stopGraceSec) || 0);
  cfg.wedgeAfterSec = Math.max(0, Number(cfg.wedgeAfterSec) || 0);
  const laneMetadata = readLaneMetadata(STATE);
  if (laneMetadata.cwd) cfg.cwd = laneMetadata.cwd;
  return cfg;
}

function postureArgs(posture, fresh) {
  // The peer must NEVER stop for approval (no human in its turn). exec mode has no
  // TTY so approvals are inert; sandbox just bounds what it may do. "config" passes
  // nothing → uses your ~/.codex/config.toml (never-ask). resume inherits the
  // session's sandbox, so per-turn sandbox flags only apply on a fresh session.
  if (posture === "yolo") return ["--dangerously-bypass-approvals-and-sandbox"];
  if (fresh && posture === "read") return ["--sandbox", "read-only"];
  if (fresh && posture === "workspace") return ["--sandbox", "workspace-write"];
  return []; // "config" (or resume): defer to the user's codex config
}

function ensureState() {
  if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
}

function codexSessionsRoot() {
  if (process.env.TANDEM_CODEX_SESSIONS) return resolve(process.env.TANDEM_CODEX_SESSIONS);
  const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
  return join(codexHome, "sessions");
}

function filePrefixContains(file, marker, maxBytes = 2 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = Math.min(statSync(file).size, maxBytes);
    const buffer = Buffer.alloc(size);
    const read = readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).includes(Buffer.from(marker));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function rolloutMatches(marker, startedAt) {
  const root = codexSessionsRoot();
  if (!existsSync(root)) return [];
  const matches = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(dir, name);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(file, depth + 1);
      } else if (
        /^rollout-.*\.jsonl$/i.test(name) &&
        stat.mtimeMs >= startedAt - 2000 &&
        filePrefixContains(file, marker)
      ) {
        matches.push(file);
      }
    }
  };
  walk(root, 0);
  return matches;
}

async function rolloutForMarker(marker, startedAt) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const matches = rolloutMatches(marker, startedAt);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
    await sleep(100);
  }
  return null;
}

function idFromRolloutName(p) {
  // rollout-2026-06-09T00-49-03-019eab24-4ca1-7780-b8f4-05badf42a28f.jsonl
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(p);
  return m ? m[1] : null;
}

// Find the rollout file whose FILENAME ends with <codexId>.jsonl (the session uuid is the filename
// suffix). Bounded walk like rolloutMatches (depth ≤ 6, honors TANDEM_CODEX_SESSIONS). The newest
// match wins so a re-used session id resolves to its latest file.
function findRolloutById(codexId) {
  const root = codexSessionsRoot();
  if (!codexId || !existsSync(root)) return null;
  const target = `${String(codexId).toLowerCase()}.jsonl`;
  let best = null;
  let bestMtime = -1;
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(dir, name);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(file, depth + 1);
      } else if (/^rollout-.*\.jsonl$/i.test(name) && name.toLowerCase().endsWith(target) && stat.mtimeMs > bestMtime) {
        best = file;
        bestMtime = stat.mtimeMs;
      }
    }
  };
  walk(root, 0);
  return best;
}

// Read only the tail of a (possibly large) file — bounded so provenance never loads a huge rollout.
function readFileTail(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buffer = Buffer.alloc(len);
    const read = readSync(fd, buffer, 0, len, start);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

// The model/effort the codex rollout PROVES ran this turn. The exec --json stream carries no model
// field; provenance lives in the rollout's turn_context lines (one per turn). Take the LAST one, but
// only if its timestamp is at/after this turn's start (minus a small skew) — otherwise it belongs to
// a PRIOR turn and the fields stay "" (records must not lie). Any failure returns empty strings.
function rolloutProvenance(codexId, startedAt) {
  const empty = { modelActual: "", effortActual: "" };
  try {
    const file = findRolloutById(codexId);
    if (!file) return empty;
    const lines = readFileTail(file, 256 * 1024).split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t.startsWith("{") || !t.includes('"turn_context"')) continue;
      let o;
      try {
        o = JSON.parse(t);
      } catch {
        continue;
      }
      if (o.type !== "turn_context") continue;
      const ts = Date.parse(o.timestamp);
      if (!Number.isFinite(ts) || ts < startedAt - 5000) return empty; // a prior turn's context
      const p = o.payload || {};
      return {
        modelActual: typeof p.model === "string" ? p.model : "",
        effortActual: typeof p.effort === "string" ? p.effort : "",
      };
    }
  } catch {
    /* provenance is best-effort — never fail the turn */
  }
  return empty;
}

function readSession() {
  return existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, "utf8").trim() : "";
}

// A tandem is the IMMUTABLE pair (claude id, codex id). Find the codex partner already
// paired with this Claude driver so we always resume the same coupled session.
function codexPartnerFor(driverId) {
  if (!driverId) return "";
  const g = readGroups(GROUPS);
  const since = readDetached(DETACHED)[driverId] || 0; // ignore pairings reset by `new`
  const m = Object.values(g.groups || {})
    .filter((r) => r.claudeId === driverId && r.codexId && (r.lastTs || 0) > since)
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return m[0]?.codexId || "";
}
// Point .state/peer.session at this driver's coupled codex (or clear it so a new
// driver starts a fresh codex = a new tandem). Returns the driver id.
function pairCodexForDriver() {
  const driverId = DRIVER_ID; // any driver kind — a Codex driver resumes its codex partner too
  const paired = codexPartnerFor(driverId);
  if (paired) writeFileSync(SESSION_FILE, paired);
  else if (existsSync(SESSION_FILE)) rmSync(SESSION_FILE);
  return driverId;
}

/** Parse the captured --json stream into a compact digest of what the partner did. */
function digest(jsonlText) {
  const commands = [];
  const files = new Set();
  let tokens = null;
  for (const line of jsonlText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const blob = JSON.stringify(o);
    // command executions (field names drift across codex versions — match broadly)
    const cmd = o.command ?? o.item?.command ?? o.payload?.command;
    if (cmd) commands.push(Array.isArray(cmd) ? cmd.join(" ") : String(cmd));
    // file changes
    const ch = o.changes ?? o.item?.changes ?? o.fileChanges ?? o.item?.fileChanges;
    if (ch && typeof ch === "object") for (const f of Object.keys(ch)) files.add(f);
    if (o.item?.path) files.add(o.item.path);
    // token usage
    const u = o.usage ?? o.item?.usage ?? (o.turn && o.turn.usage);
    if (u && (u.input_tokens || u.inputTokens || u.output_tokens || u.outputTokens)) {
      tokens = {
        in: u.input_tokens ?? u.inputTokens ?? 0,
        out: u.output_tokens ?? u.outputTokens ?? 0,
      };
    }
    if (blob.includes("apply_patch") && cmd) files.add("(apply_patch)");
  }
  return { commands: commands.slice(-12), files: [...files].slice(0, 20), tokens };
}

function acquireLaneDispatch(cfg, mode) {
  try {
    return acquireDispatch(STATE, SK, {
      partner: cfg.partner,
      mode,
      wedgeAfterSec: cfg.wedgeAfterSec,
      stallSec: cfg.stallSec,
    });
  } catch (error) {
    if (error instanceof DispatchBusyError) {
      console.error(`tandem: ${error.message}`);
      process.exitCode = 3;
      return null;
    }
    throw error;
  }
}

function codexLeaseHooks(lease, cfg) {
  const persistEveryMs = Math.max(
    20,
    Math.min(1000, cfg.stallSec > 0 ? (cfg.stallSec * 1000) / 4 : 1000),
  );
  let lastPersistedActivity = 0;
  return {
    onSpawn: (partnerPid) => updateDispatch(lease, { partnerPid }),
    onActivity: ({ ts, kind }) => {
      if (kind !== "spawn" && ts - lastPersistedActivity < persistEveryMs) return;
      lastPersistedActivity = ts;
      markDispatchActivity(lease, {
        pid: process.pid,
        ts,
        kind,
      });
    },
    onTermination: (termination) =>
      updateDispatch(lease, {
        terminationPending: termination,
      }),
  };
}

// ONE truthful clause about the stop CHANNEL, derived from the termination record — never a guess
// about what the partner did. deliveryProven distinguishes a signal we can PROVE was delivered
// (posix kill) from one we cannot (win32 WM_CLOSE to a hidden console child); hardKilled says
// whether the force tree-kill was actually needed. Absent record → a neutral, non-committal clause.
function stopChannelClause(stop) {
  if (!stop) return "a stop was requested before tree-kill";
  const first = stop.stopDeliveryProven
    ? "a non-forced stop was delivered first"
    : "a non-forced stop was issued first (win32: delivery to a hidden console child is unprovable)";
  return `${first}; hard tree-kill ${stop.hardKilled ? "followed" : "was not needed"}`;
}

function supervisedStopError(res) {
  const stop = res?.termination;
  if (!stop) return "";
  const warm = res.codexId
    ? `session ${res.codexId} remains coupled; continue resumes it warm`
    : "no session id was captured; inspect the turn log before continuing";
  if (stop.kind === "stall") {
    return `turn STALLED/WEDGED after ${stop.idleSec}s with no partner activity; ${stopChannelClause(stop)}; ${warm}`;
  }
  return `turn stopped at the optional maxTurnSec backstop after ${stop.elapsedSec}s; ${stopChannelClause(stop)}; ${warm}`;
}

// ---- provider-limit awareness --------------------------------------------------------------
// tandem drives a coupled partner CLI. When that partner's subscription hits a 5h/weekly cap, the
// CLI either exits nonzero with the cause buried, or — worse for the claude -p partner — returns
// the limit BANNER as an ordinary exit-0 result that the lane would otherwise store as the
// partner's VERDICT. The shared provider-policy package supplies the (real-string-anchored)
// classifier + reset parser + park/resolve engine; here we wire it into every codex turn (the
// claude daemon does the same in serve.mjs). We NEVER auto-reroute a coupled lane — that would
// violate the coupling invariant — but we classify, park the provider, fast-fail future asks, and
// surface the reset time + live alternates. Opt-in `--failover` starts a FRESH alternate lane.

const tierOf = () => process.env.TANDEM_TIER || "default";
// Escape hatch: --no-limit-classify flag (normalized into this env at dispatch) or the env directly
// skips ALL pre-flight + post-turn classification, restoring the pre-feature behavior verbatim.
const limitClassifyEnabled = () => process.env.TANDEM_NO_LIMIT_CLASSIFY !== "1";

// Classify a codex turn's result, caching the verdict on `res` so the printer and the job-record
// builder agree without re-scanning. The gate lives in limit-signals.mjs: res.error (the stderr
// tail, populated only on a nonzero exit) is loose-scanned only when the process genuinely failed;
// res.verdict (the model's ANSWER) is only ever strict whole-result matched — an answer that
// merely DISCUSSES limit banners is a normal verdict. Never reads res.raw (the event stream).
function providerLimitHit(res) {
  if (!res) return null;
  if (res.__limitHit !== undefined) return res.__limitHit;
  const hit = limitClassifyEnabled()
    ? classifyProviderSignal(policy, {
        finalMessage: res.verdict,
        stderrTail: res.error,
        exitFailed: !!res.killed || res.code !== 0,
      })
    : null;
  res.__limitHit = hit;
  return hit;
}

// The LOUD replacement line that stands in for a banner-as-verdict everywhere a verdict is shown.
function loudProviderLine(family, hit, until, alternates) {
  // Show the reset in UTC AND local: a bare "…Z" ISO was misread in production as a past local time.
  const when = `${new Date(until).toISOString()} (${new Date(until).toLocaleString()} local)`;
  const alt = alternates ? `${alternates.family}/${alternates.model}` : "none available (all providers capped)";
  return (
    `(provider limit hit — ${family} parked until ${when}; this is NOT a task verdict. ` +
    `Alternate: ${alt} — or wait and re-ask. See --failover.)`
  );
}

const isProviderLimitState = (s) => !!s && (s.errorKind === "provider-limit" || s.errorKind === "provider-auth");

// Build the additive error record for a classified codex limit: parks the provider (markDown =
// the single authoritative state write) and returns a job record whose status is still the frozen
// "error" but which carries the extra provider-limit fields watch/wait/ceerelay ignore harmlessly.
function providerLimitRecordFor(family, hit, res) {
  const { until } = policy.markDown(family, hit.msg);
  const errorKind = hit.kind === "auth" ? "provider-auth" : "provider-limit";
  const alternates = policy.resolve(family === "codex" ? "claude" : "codex", tierOf());
  const iso = new Date(until).toISOString();
  return {
    status: "error",
    partner: family,
    errorKind,
    provider: family,
    resetAt: until,
    providerMessage: String(hit.msg).slice(0, 300),
    alternates,
    verdict: loudProviderLine(family, hit, until, alternates), // NEVER the banner
    error: `${errorKind === "provider-auth" ? "provider auth failure" : "provider usage limit"} on ${family}: ${String(hit.msg).slice(0, 300)} (resets ~${iso})`,
    durSec: res?.dur,
    commands: res?.d?.commands || [],
    files: res?.d?.files || [],
    tokens: res?.d?.tokens || null,
    modelRequested: res?.modelRequested || "",
    effortRequested: res?.effortRequested || "",
    modelActual: res?.modelActual || "",
    effortActual: res?.effortActual || "",
    warning: provenanceWarning(res || {}) || null,
    termination: res?.termination || null,
    terminationPending: null,
    workerPid: process.pid,
    partnerPid: res?.partnerPid || 0,
  };
}

// Pre-flight error record from ALREADY-parked provider state (no new turn was run).
function parkedPreflightRecord(family) {
  const p = policy.state()[family] || {};
  const until = p.until || Date.now() + 3600_000;
  const errorKind = p.kind === "auth" ? "provider-auth" : "provider-limit";
  const alternates = policy.resolve(family === "codex" ? "claude" : "codex", tierOf());
  const iso = new Date(until).toISOString();
  const alt = alternates ? `${alternates.family}/${alternates.model}` : "none available (all providers capped)";
  return {
    status: "error",
    partner: family,
    errorKind,
    provider: family,
    resetAt: until,
    providerMessage: String(p.reason || "").slice(0, 300),
    alternates,
    verdict: `(provider parked — ${family} until ${iso}; this is NOT a task verdict. Alternate: ${alt} — wait or use --failover.)`,
    error: `provider parked: ${family} ${errorKind === "provider-auth" ? "auth failure" : "usage limit"} resets ~${iso}`,
  };
}

// The loud stderr guidance printed alongside a parked/limit record: reset time, live alternate,
// and the two LAWFUL moves (wait, or --failover) — never an implicit auto-reroute.
function parkedStderr(family, rec) {
  // UTC ISO kept (tests + logs match it) with the local rendering appended — a bare "…Z" was misread.
  const iso = `${new Date(rec.resetAt).toISOString()} (${new Date(rec.resetAt).toLocaleString()} local)`;
  const alt = rec.alternates
    ? `${rec.alternates.family}/${rec.alternates.model}${rec.alternates.effort ? ` (${rec.alternates.effort})` : ""}`
    : "none available — every provider is currently capped";
  return [
    `tandem: ${family} provider ${rec.errorKind === "provider-auth" ? "AUTH FAILURE" : "USAGE LIMIT"} — lane parked (this is NOT a task failure).`,
    `   resets ~${iso}`,
    `   alternate now: ${alt}`,
    `   lawful moves: (1) wait and re-ask after the reset, or (2) re-run with --failover to start a FRESH alternate lane` +
      ` — the coupled ${family} session stays untouched and resumable.`,
  ].join("\n");
}

// --failover (opt-in): the partner is parked (pre-flight) or just hit a limit (post-turn). Resolve
// the alternate family at the current tier and run ONE fresh turn there, in-process, reusing the
// existing ask machinery. The failed lease is already finished by the caller; we acquire a new one
// the normal way. The old coupled session is deliberately left untouched (no detach) so it resumes
// warm once its window rolls. Never runs without the flag.
async function runFailover(cfg, task, fromFamily) {
  const toFamily = fromFamily === "codex" ? "claude" : "codex";
  const alt = policy.resolve(toFamily, tierOf());
  if (!alt) {
    const iso = new Date(policy.earliestReset()).toISOString();
    console.error(`tandem: FAILOVER blocked — every provider is capped (earliest reset ~${iso}). Wait and re-ask.`);
    logEvent({ type: "failover", ts: Date.now(), from: fromFamily, to: null, blocked: "all-capped" });
    process.exitCode = 1;
    return;
  }
  const parkedUntil = policy.state()[fromFamily]?.until || Date.now();
  console.error(
    `tandem: FAILOVER — ${fromFamily} parked (resets ~${new Date(parkedUntil).toISOString()}); starting a FRESH ` +
      `${alt.family}/${alt.model} lane; the old coupled session is untouched and resumable`,
  );
  logEvent({ type: "failover", ts: Date.now(), from: fromFamily, to: alt.family, model: alt.model, tier: tierOf() });
  // Switch cfg to the alternate. A different family has no prior coupling on this driver in the
  // common case, so the alternate lane is naturally fresh (codex↔claude use separate session state).
  cfg.partner = alt.family;
  if (alt.family === "claude") {
    cfg.claudeModel = alt.model;
    if (alt.effort) cfg.claudeEffort = alt.effort;
  } else {
    cfg.codexModel = alt.model;
    if (alt.effort) cfg.codexEffort = alt.effort;
  }
  const lease = acquireLaneDispatch(cfg, "foreground");
  if (!lease) return;
  if (cfg.partner === "claude") {
    updateDispatch(lease, { workerPid: process.pid, partner: "claude", mode: "foreground" });
    try {
      if (!(await askUnlocked(task, cfg, lease))) {
        finishDispatch(lease, { status: "error", partner: "claude", error: "persistent Claude daemon did not become ready" });
        process.exitCode = 1;
      } else {
        process.exitCode = 0; // the alternate turn is the authoritative result of the failover
      }
    } catch (error) {
      finishDispatch(lease, { status: "error", partner: "claude", error: String(error) });
      console.error(`tandem: FAILOVER claude dispatch failed - ${error.message || error}`);
      process.exitCode = 1;
    }
    return;
  }
  updateDispatch(lease, { workerPid: process.pid, partner: "codex", mode: "foreground" });
  const stopHeartbeat = startHeartbeat(lease, { pid: process.pid });
  try {
    const res = await askUnlocked(task, cfg, lease);
    const finalState = codexJobRecord(res); // no nested failover — runFailover never re-enters
    finishDispatch(lease, finalState);
    process.exitCode = finalState.status === "error" ? 1 : 0;
    if (isProviderLimitState(finalState)) console.error(parkedStderr("codex", finalState));
  } catch (error) {
    finishDispatch(lease, { status: "error", partner: "codex", error: String(error) });
    console.error(`tandem: FAILOVER codex dispatch failed - ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    stopHeartbeat();
  }
}

function codexJobRecord(res) {
  if (!res) return { status: "error", partner: "codex", error: "partner returned no result" };
  // Provider-limit classification happens FIRST: a capped subscription can surface as a nonzero
  // exit (stderr banner) OR — the silent-failure case — an exit-0 turn whose verdict IS the banner.
  // Either way it is NOT a task result. Classify verdict + stderr tail only (providerLimitHit).
  const hit = providerLimitHit(res);
  if (hit) return providerLimitRecordFor("codex", hit, res);
  const failed = res.killed || res.code !== 0;
  return {
    status: failed ? "error" : "done",
    error: res.killed
      ? supervisedStopError(res)
      : res.code !== 0
        ? `codex exited with code ${res.code}${res.error ? ` - ${res.error}` : ""}`
        : undefined,
    partner: "codex",
    durSec: res.dur,
    verdict: res.verdict,
    commands: res.d?.commands || [],
    files: res.d?.files || [],
    tokens: res.d?.tokens || null,
    lowContext: res.lowContext || null,
    modelRequested: res.modelRequested || "",
    effortRequested: res.effortRequested || "",
    modelActual: res.modelActual || "",
    effortActual: res.effortActual || "",
    warning: provenanceWarning(res, res.couplingWarning || "") || null,
    termination: res.termination || null,
    terminationPending: null,
    stalled: res.termination?.kind === "stall",
    workerPid: process.pid,
    partnerPid: res.partnerPid || 0,
  };
}

async function askUnlocked(task, cfg, lease) {
  ensureState();
  if (!task || !task.trim()) {
    console.error("tandem: empty task");
    process.exit(2);
  }
  // Claude partner → persistent, resumable session via the daemon (logs its own events)
  if (cfg.partner === "claude") return askClaudeDaemon(task, cfg, false, lease);
  // Codex partner → durable, resumable `codex exec resume`, coupled to this driver.
  // The resume target comes from the IMMUTABLE recorded pair (codexPartnerFor), never the
  // shared global — so concurrent tandems can't cross-wire to each other's Codex.
  const driverId = DRIVER_ID;
  const resumeSid = codexPartnerFor(driverId);
  pairCodexForDriver(); // keep the global peer.session current for the watcher's display only
  logEvent({ type: "delegate", ts: Date.now(), driver: DRIVER_KIND, partner: "codex", driverId, partnerId: resumeSid, task });
  // record now if the pair is already known (resumed); a fresh pair records after askCodex
  if (driverId && resumeSid) recordGroup(GROUPS, { claudeId: driverId, codexId: resumeSid, claudeRole: "driver", codexRole: "partner", direction: DRIVER_KIND + "->codex" });
  const res = await askCodex(task, cfg, resumeSid, codexLeaseHooks(lease, cfg));
  if (res) {
    const hit = providerLimitHit(res);
    if (hit) {
      // The partner's "verdict" IS a provider-limit banner (or its stderr carried one). NEVER
      // surface it as a task verdict — print the loud park line and log the RAW banner for
      // forensics. The authoritative park (markDown) happens in codexJobRecord, called next by
      // ask()/runJob; here we only parse the reset time for display (no state write).
      const until = policy.parseResetTime(hit.msg);
      const alternates = policy.resolve("claude", tierOf());
      console.log("\n" + loudProviderLine("codex", hit, until, alternates) + "\n");
      logEvent({ type: "provider-limit", ts: Date.now(), partner: "codex", kind: hit.kind, providerMessage: hit.msg, raw: res.verdict });
    } else {
      printVerdict("codex", res.verdict, res.d, res.dur, res.raw || "");
      logEvent({
        type: "verdict",
        ts: Date.now(),
        partner: "codex",
        durSec: res.dur,
        verdict: res.verdict,
        commands: res.d?.commands || [],
        files: res.d?.files || [],
        tokens: res.d?.tokens || null,
      });
    }
    // register/refresh this exact pair — codexId is the ACTUAL codex this turn used/created
    const cdx = res.codexId || resumeSid;
    if (driverId && cdx) recordGroup(GROUPS, { claudeId: driverId, codexId: cdx, claudeRole: "driver", codexRole: "partner", direction: DRIVER_KIND + "->codex" });
    if (res.lowContext) console.log(res.lowContext); // notify the driver the passenger is running low
    if (res.couplingWarning) console.error(`tandem: WARNING - ${res.couplingWarning}`);
  }
  return res;
}

async function ask(task, cfg) {
  ensureState();
  if (!task || !task.trim()) {
    console.error("tandem: empty task");
    process.exitCode = 2;
    return;
  }
  const lease = acquireLaneDispatch(cfg, "foreground");
  if (!lease) return;

  // Pre-flight fast-fail: a PRIOR turn parked this partner (provider-state.json), so spawning it
  // again would just burn time re-hitting the same wall. Fail here — after the lease, before ANY
  // spawn/daemon-ensure — with the reset time + live alternates. --failover instead starts a fresh
  // alternate lane. Both partners; both lawful moves surfaced; ZERO spawns.
  if (limitClassifyEnabled() && !policy.available(cfg.partner)) {
    const parkedFamily = cfg.partner;
    const rec = parkedPreflightRecord(parkedFamily);
    finishDispatch(lease, rec);
    if (failoverFlag) return await runFailover(cfg, task, parkedFamily);
    console.error(parkedStderr(parkedFamily, rec));
    process.exitCode = 1;
    return;
  }

  if (cfg.partner === "claude") {
    try {
      if (!(await askUnlocked(task, cfg, lease))) {
        finishDispatch(lease, { status: "error", partner: "claude", error: "persistent Claude daemon did not become ready" });
        process.exitCode = 1;
        return;
      }
      // The serve daemon writes the claude job record (error-shaped on a limit). If it parked and
      // --failover is set, run one fresh alternate turn; otherwise leave the exit code waitJob set.
      const j = jobState(cfg);
      if (failoverFlag && isProviderLimitState(j)) {
        process.exitCode = 0;
        return await runFailover(cfg, task, "claude");
      }
    } catch (error) {
      finishDispatch(lease, { status: "error", partner: "claude", error: String(error) });
      console.error(`tandem: Claude dispatch failed - ${error.message || error}`);
      process.exitCode = 1;
    }
    return;
  }

  updateDispatch(lease, { workerPid: process.pid, partner: "codex", mode: "foreground" });
  const stopHeartbeat = startHeartbeat(lease, { pid: process.pid });
  try {
    const res = await askUnlocked(task, cfg, lease);
    const finalState = codexJobRecord(res);
    finishDispatch(lease, finalState);
    if (failoverFlag && isProviderLimitState(finalState)) {
      stopHeartbeat();
      return await runFailover(cfg, task, "codex");
    }
    if (finalState.status === "error") {
      if (isProviderLimitState(finalState)) console.error(parkedStderr("codex", finalState));
      process.exitCode = 1;
    }
  } catch (error) {
    finishDispatch(lease, { status: "error", partner: "codex", error: String(error) });
    console.error(`tandem: codex dispatch failed - ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    stopHeartbeat();
  }
}

const CLAUDE_SESSION = join(STATE, "claude.session"); // dedicated partner session id
const CLAUDE_VERDICT = join(STATE, "claude_verdict.txt");
const JOB_FILES = jobPaths(STATE, SK);
const JOB = JOB_FILES.job; // foreground/background turn state, per-driver
const JOB_TASK = join(STATE, "job.task");
const GROUPS = join(STATE, "groups.json"); // matched tandem pairs (claude id ↔ codex id)
const INBOX = join(STATE, "inbox.txt"); // file relay → persistent Claude daemon
const STATUS_FILE = join(STATE, "status.txt");
const SERVE_PID = join(STATE, "serve.pid");
const SERVE_BOUND = join(STATE, "serve.bound.json"); // the supervision/model values the daemon BOUND at startup
const CLAUDE_PID_FILE = join(STATE, "claude.pid"); // daemon's claude child — powers the self-ask guard
const CLAUDE_SEED = join(STATE, "claude.seed"); // handoff summary the fresh daemon prepends on its first turn
const SERVE_SCRIPT = join(HERE, "serve.mjs");

// Definitively shut the serve daemon down and reset its state. On Windows process.kill
// terminates without running the daemon's cleanup handler — leaving a stale serve.pid/STATUS
// and an ORPHANED claude child that can re-process the next turn on the wrong session. So we
// tree-kill (parent + child), force STATUS=DOWN, and remove the pid file ourselves. After this
// the next ask is guaranteed to spawn a clean daemon (no reuse, no orphan, no re-glue).
function killDaemon() {
  const pid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
  if (pid && isPidAlive(pid)) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      else process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  try {
    writeFileSync(STATUS_FILE, "DOWN");
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(SERVE_PID)) rmSync(SERVE_PID);
  } catch {
    /* ignore */
  }
}

// Ensure the persistent, RESUMABLE Claude partner session is open. Auto-starts the
// daemon if needed; the daemon resumes the stored session id, so closing/reopening
// always continues the same durable session (never an ephemeral subagent).
async function ensureClaudeDaemon(cfg) {
  const pid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
  const status = existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, "utf8").trim() : "";
  spawnDebug(
    `ensureClaudeDaemon state=${STATE} servePid=${pid} alive=${isPidAlive(pid)} status=${status || "(none)"} ` +
      `nested=${process.env.TANDEM_NESTED_AGENT || "(unset)"} tandemStateEnv=${process.env.TANDEM_STATE || "(unset)"}`,
  );
  // Self-ask guard: if THIS process is a tool call of the very claude partner
  // this lane's daemon is driving (the daemon records its claude child pid, and
  // the claude CLI stamps CLAUDE_PID into its tool calls), then relaying here
  // would feed the "new" task back into the caller's own session. That means a
  // stale lane identity leaked into the caller's environment — refuse loudly
  // instead of silently self-injecting.
  const lanePartnerPid = existsSync(CLAUDE_PID_FILE) ? Number(readFileSync(CLAUDE_PID_FILE, "utf8").trim()) : 0;
  if (isPidAlive(pid) && lanePartnerPid > 0 && Number(process.env.CLAUDE_PID) === lanePartnerPid) {
    spawnDebug(`ensureClaudeDaemon decision=REFUSE-SELF-ASK partnerPid=${lanePartnerPid}`);
    console.error(
      "tandem: refusing to relay into this lane — this peer.mjs is running INSIDE the lane's own Claude partner " +
        `(CLAUDE_PID ${lanePartnerPid} is the partner this daemon drives), so the task would be fed back into your own session. ` +
        "A sub-lane needs its own state: unset the inherited TANDEM_STATE/TANDEM_LABEL (or set TANDEM_STATE to a fresh directory) and re-run.",
    );
    return false;
  }
  if (isPidAlive(pid) && (status === "IDLE" || status === "RUNNING")) {
    spawnDebug(`ensureClaudeDaemon decision=REUSE-EXISTING-DAEMON pid=${pid} (no spawn attempted)`);
    return true;
  }
  if (isPidAlive(pid)) {
    let exitedWhileWaiting = false;
    for (let i = 0; i < 70; i++) {
      await sleep(500);
      const current = existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, "utf8").trim() : "";
      if ((current === "IDLE" || current === "RUNNING") && isPidAlive(pid)) return true;
      if (!isPidAlive(pid)) {
        exitedWhileWaiting = true;
        break;
      }
    }
    if (!exitedWhileWaiting) {
      console.error("tandem: existing serve daemon did not become ready");
      return false;
    }
  }
  console.error("tandem: opening persistent Claude session (serve)…");
  // spawnDetachedWorker instead of a bare detached spawn: when THIS process is
  // running inside a nested caller's kill-on-close job, the daemon must be
  // launched outside that job chain or it dies with the caller's tool call.
  let servePid = 0;
  try {
    ({ pid: servePid } = await spawnDetachedWorker({
      argv: [SERVE_SCRIPT],
      env: { ...process.env, TANDEM_STATE: STATE, TANDEM_CWD: cfg.cwd },
      cwd: process.cwd(),
      stateDir: STATE,
      tag: "serve",
    }));
  } catch (error) {
    console.error(`tandem: cannot spawn serve daemon - ${error.message || error}`);
    return false;
  }
  for (let i = 0; i < 70; i++) {
    await sleep(500);
    const s = existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, "utf8").trim() : "";
    if ((s === "IDLE" || s === "RUNNING") && isPidAlive(existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0)) return true;
    if (!isPidAlive(servePid)) {
      console.error("tandem: serve exited before the Claude partner became ready");
      return false;
    }
  }
  console.error("tandem: serve did not become ready (check: node bin/serve.mjs)");
  return false;
}

// Send a turn to the OPEN Claude session via the relay; daemon logs delegate/verdict.
async function askClaudeDaemon(task, cfg, bg, lease) {
  for (const file of [LASTMSG, TURNLOG]) {
    try {
      if (existsSync(file)) rmSync(file);
    } catch {
      /* ignore */
    }
  }
  const stopStartingHeartbeat = startHeartbeat(lease, { pid: process.pid });
  const ok = await ensureClaudeDaemon(cfg);
  stopStartingHeartbeat();
  if (!ok) return false;
  const daemonPid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
  updateDispatch(lease, {
    workerPid: daemonPid,
    partner: "claude",
    mode: bg ? "background" : "foreground",
  });
  // Envelope carries OUR job key so the daemon answers under it even if the daemon was started
  // by an earlier driver session (restart re-key) or a different driver id derivation.
  writeFileSync(INBOX, JSON.stringify({ __tandem: 1, sk: SK, dispatchId: lease.dispatchId, task }));
  if (bg) {
    console.log("tandem: sent to the open Claude session (bg). poll: peer.mjs status  ·  block: peer.mjs wait");
    return true;
  }
  await waitJob(cfg.claudeMaxSec || 1800, cfg);
  return true;
}

// Driver-crafted compaction of the Claude partner: take a handoff summary from the open
// session, close it, then reopen a FRESH session seeded with that summary (the daemon
// prepends the seed on its first turn). Re-couples via the detached-stamp + recency.
async function compactClaude(prompt, cfg, lease) {
  const stopHeartbeat = startHeartbeat(lease, { pid: process.pid });
  try {
    if (!(await ensureClaudeDaemon(cfg))) throw new Error("persistent Claude daemon did not become ready");
    const daemonPid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
    updateDispatch(lease, {
      workerPid: process.pid,
      partnerPid: daemonPid,
      partner: "claude",
      mode: "compact",
    });
    writeFileSync(
      INBOX,
      JSON.stringify({
        __tandem: 1,
        sk: SK,
        dispatchId: lease.dispatchId,
        holdLease: true,
        controllerPid: process.pid,
        task: prompt && prompt.trim() ? prompt : COMPACT_PROMPT,
      }),
    );
    console.error("tandem: asking the Claude partner for a handoff summary…");
    const deadline = Date.now() + (cfg.claudeMaxSec || 1800) * 1000;
    let summary = "";
    while (Date.now() < deadline) {
      const job = jobState(cfg);
      if (job?.status === "WEDGED") throw new Error(`Claude compaction WEDGED: ${job.reason || "worker liveness failed"}`);
      if (job?.dispatchId === lease.dispatchId && job.resultReady) {
        summary = job.verdict || "";
        break;
      }
      if (daemonPid && !isPidAlive(daemonPid)) throw new Error("persistent Claude daemon exited before returning the handoff summary");
      await sleep(500);
    }
    if (!summary) throw new Error("Claude compaction timed out without a handoff summary");

    killDaemon();
    if (existsSync(CLAUDE_SESSION)) rmSync(CLAUDE_SESSION);
    markDetached(DETACHED, DRIVER_ID);
    writeFileSync(CLAUDE_SEED, handoffSeed(summary));
    logEvent({ type: "compact", ts: Date.now(), partner: "claude", reason: "manual" });
    finishDispatch(lease, {
      status: "done",
      partner: "claude",
      verdict: "Claude handoff captured; the next ask opens a fresh seeded session.",
    });
    console.log("\ntandem: Claude partner compacted — closed and reseeded; the next ask opens a FRESH session with your handoff.");
    console.log("\n----- handoff summary -----\n" + summary.slice(0, 2000));
  } catch (error) {
    finishDispatch(lease, { status: "error", partner: "claude", error: String(error) });
    throw error;
  } finally {
    stopHeartbeat();
  }
}

// Launch a turn in a DETACHED child so long delegations don't block (or time out)
// the driver's shell. The driver then polls `status` (instant) or blocks on `wait`.
async function startJob(task, cfg) {
  ensureState();
  if (!task || !task.trim()) {
    console.error("tandem: empty task");
    process.exitCode = 2;
    return;
  }
  const lease = acquireLaneDispatch(cfg, "background");
  if (!lease) return;
  // Pre-flight fast-fail (same doctrine as ask): a parked partner never gets spawned. Without
  // --failover, fail loudly with reset + alternates. With --failover, switch cfg to the alternate
  // family and dispatch THIS bg turn there instead (the fresh alternate lane; the coupled session
  // is left untouched). Background post-turn failover is intentionally not attempted — the detached
  // worker classifies + records, but re-dispatch is a foreground (ask/continue) concern.
  if (limitClassifyEnabled() && !policy.available(cfg.partner)) {
    const parkedFamily = cfg.partner;
    if (failoverFlag) {
      const alt = policy.resolve(parkedFamily === "codex" ? "claude" : "codex", tierOf());
      if (!alt) {
        const iso = new Date(policy.earliestReset()).toISOString();
        finishDispatch(lease, { status: "error", partner: parkedFamily, errorKind: "provider-limit", provider: parkedFamily, resetAt: policy.earliestReset(), error: `every provider is capped (earliest reset ~${iso})` });
        console.error(`tandem: FAILOVER blocked — every provider is capped (earliest reset ~${iso}). Wait and re-ask.`);
        process.exitCode = 1;
        return;
      }
      console.error(
        `tandem: FAILOVER — ${parkedFamily} parked; starting a FRESH ${alt.family}/${alt.model} background lane; ` +
          `the old coupled session is untouched and resumable`,
      );
      logEvent({ type: "failover", ts: Date.now(), from: parkedFamily, to: alt.family, model: alt.model, tier: tierOf(), mode: "background" });
      cfg.partner = alt.family;
      if (alt.family === "claude") {
        cfg.claudeModel = alt.model;
        if (alt.effort) cfg.claudeEffort = alt.effort;
      } else {
        cfg.codexModel = alt.model;
        if (alt.effort) cfg.codexEffort = alt.effort;
      }
      updateDispatch(lease, { partner: alt.family });
      // fall through: dispatch the alternate on this same lease
    } else {
      const rec = parkedPreflightRecord(parkedFamily);
      finishDispatch(lease, rec);
      console.error(parkedStderr(parkedFamily, rec));
      process.exitCode = 1;
      return;
    }
  }
  // Claude partner → relay into the persistent open session (daemon does the work)
  if (cfg.partner === "claude") {
    try {
      if (!(await askClaudeDaemon(task, cfg, true, lease))) {
        finishDispatch(lease, { status: "error", partner: "claude", error: "persistent Claude daemon did not become ready" });
        process.exitCode = 1;
      }
    } catch (error) {
      finishDispatch(lease, { status: "error", partner: "claude", error: String(error) });
      console.error(`tandem: Claude dispatch failed - ${error.message || error}`);
      process.exitCode = 1;
    }
    return;
  }
  // Codex partner → detached exec-resume worker (resumable session, survives shell timeouts).
  // Pass the driver id + IMMUTABLE resume id (from the recorded pair) + task path by ARGV so
  // concurrent bg tandems are fully isolated and can NEVER cross-wire via shared global files.
  const driverId = DRIVER_ID;
  const resumeSid = codexPartnerFor(driverId);
  pairCodexForDriver(); // keep the global peer.session current for the watcher's display only
  // record on delegate if the pair is already known (resumed) so it shows live DURING the turn
  if (driverId && resumeSid) recordGroup(GROUPS, { claudeId: driverId, codexId: resumeSid, claudeRole: "driver", codexRole: "partner", direction: DRIVER_KIND + "->codex" });
  for (const f of [TURNLOG, LASTMSG]) if (existsSync(f)) rmSync(f);
  const taskFile = join(STATE, `job-${lease.dispatchId}.task`);
  writeFileSync(taskFile, task);
  updateDispatch(lease, { driverId, partner: "codex", mode: "background", workerPid: process.pid });
  try {
    // spawnDetachedWorker instead of a bare detached spawn: a nested caller's
    // shell tool runs inside a kill-on-close Job Object, and DETACHED_PROCESS
    // does not leave the job — the worker must be launched outside that chain
    // to survive the caller's teardown.
    const { pid, mode } = await spawnDetachedWorker({
      argv: [fileURLToPath(import.meta.url), "__runjob", driverId, resumeSid, taskFile, lease.dispatchId],
      env: process.env,
      cwd: process.cwd(),
      stateDir: STATE,
      tag: "runjob",
    });
    updateDispatch(lease, { workerPid: pid });
    console.log(`tandem: codex turn started in background (pid ${pid}${mode === "escape" ? ", job-escaped" : ""}). poll: peer.mjs status  ·  block: peer.mjs wait`);
  } catch (error) {
    try {
      if (existsSync(taskFile)) rmSync(taskFile);
    } catch {
      /* ignore */
    }
    finishDispatch(lease, { status: "error", partner: "codex", error: `cannot spawn background worker: ${error.message || error}` });
    console.error(`tandem: cannot spawn background worker - ${error.message || error}`);
    process.exitCode = 1;
  }
}

async function runJob(cfg, jobArgv) {
  // self-contained from argv: [driverId, resumeSid, taskFile, dispatchId]
  const driverId = jobArgv[0] || DRIVER_ID;
  const resumeSid = jobArgv[1] || "";
  const taskFile = jobArgv[2] || JOB_TASK;
  const dispatchId = jobArgv[3] || "";
  const lease = leaseFrom(STATE, SK, dispatchId);
  if (!dispatchId || !updateDispatch(lease, { workerPid: process.pid, partner: "codex", mode: "background" })) {
    try {
      if (taskFile !== JOB_TASK && existsSync(taskFile)) rmSync(taskFile);
    } catch {
      /* ignore */
    }
    return;
  }
  const stopHeartbeat = startHeartbeat(lease, { pid: process.pid });
  let task = "";
  try {
    task = readFileSync(taskFile, "utf8");
  } catch (error) {
    stopHeartbeat();
    finishDispatch(lease, { status: "error", partner: "codex", error: `cannot read queued task: ${error.message || error}` });
    return;
  }
  logEvent({ type: "delegate", ts: Date.now(), driver: DRIVER_KIND, partner: "codex", driverId, partnerId: resumeSid, task });
  let res = null;
  try {
    res = await askCodex(task, cfg, resumeSid, codexLeaseHooks(lease, cfg));
    const finalState = codexJobRecord(res);
    finishDispatch(lease, finalState);
    if (res) {
      const cdx = res.codexId || resumeSid;
      if (driverId && cdx) recordGroup(GROUPS, { claudeId: driverId, codexId: cdx, claudeRole: "driver", codexRole: "partner", direction: DRIVER_KIND + "->codex" });
      logEvent({ type: "verdict", ts: Date.now(), partner: "codex", durSec: res.dur, verdict: res.verdict, commands: res.d?.commands || [], files: res.d?.files || [], tokens: res.d?.tokens || null });
    }
  } catch (error) {
    finishDispatch(lease, { status: "error", partner: "codex", error: String(error) });
  } finally {
    stopHeartbeat();
    try {
      if (taskFile !== JOB_TASK && existsSync(taskFile)) rmSync(taskFile);
    } catch {
      /* ignore */
    }
  }
}

function jobState(cfg) {
  return inspectDispatch(STATE, SK, {
    wedgeAfterSec: cfg?.wedgeAfterSec,
    stallSec: cfg?.stallSec,
  });
}

function killProcessTree(pid) {
  pid = Number(pid) || 0;
  if (!pid || !isPidAlive(pid)) return;
  hardKillProcessTree(pid);
}

function removeQueuedTask(dispatchId) {
  if (!dispatchId) return;
  const taskFile = join(STATE, `job-${dispatchId}.task`);
  try {
    if (existsSync(taskFile)) rmSync(taskFile);
  } catch {
    /* ignore */
  }
}

function cancelJob(cfg) {
  const j = jobState(cfg);
  if (!j) {
    console.log("tandem: no active job to cancel");
    return;
  }
  if (j.status === "WEDGED") {
    console.error("tandem: lane is WEDGED; use `peer.mjs reap` so recovery is explicit");
    process.exitCode = 3;
    return;
  }
  if (j.status !== "running") {
    console.log(`tandem: no active job to cancel (last state: ${j.status})`);
    return;
  }
  if (j.partner === "claude") killDaemon();
  else {
    if (j.partnerPid && j.partnerPid !== j.workerPid) killProcessTree(j.partnerPid);
    killProcessTree(j.workerPid);
  }
  removeQueuedTask(j.dispatchId);
  forceFinishDispatch(STATE, SK, {
    status: "error",
    partner: j.partner,
    error: "turn cancelled by the driver; inspect the working tree for partial edits",
    cancelled: true,
  });
  logEvent({ type: "cancel", ts: Date.now(), partner: j.partner, dispatchId: j.dispatchId });
  console.log("tandem: active turn cancelled; the lane is dispatchable again after you inspect partial edits");
}

function reapJob(cfg) {
  const j = jobState(cfg);
  if (!j) {
    console.log("tandem: no wedged job to reap");
    return;
  }
  if (j.status !== "WEDGED") {
    console.error(`tandem: reap refused - lane state is ${j.status}; reap is only valid for WEDGED jobs`);
    process.exitCode = 3;
    return;
  }
  if (j.partner === "claude") killDaemon();
  else {
    if (j.partnerPid && j.partnerPid !== j.workerPid) killProcessTree(j.partnerPid);
    killProcessTree(j.workerPid);
  }
  removeQueuedTask(j.dispatchId);
  forceFinishDispatch(STATE, SK, {
    status: "error",
    partner: j.partner,
    error: `reaped WEDGED lane: ${j.reason || "worker liveness failed"}; inspect partial edits before replacing the turn`,
    reaped: true,
  });
  logEvent({ type: "reap", ts: Date.now(), partner: j.partner, dispatchId: j.dispatchId, reason: j.reason || "" });
  console.log("tandem: WEDGED lane reaped; inspect partial edits, then dispatch the replacement");
}

function currentLaneLabel() {
  return readLaneMetadata(STATE).label || process.env.TANDEM_LABEL || basename(STATE) || jobKey(DRIVER_ID);
}

function refuseLaneMutationWhileActive(cfg, action) {
  const active = jobState(cfg);
  if (active?.status !== "running" && active?.status !== "WEDGED") return false;
  const recovery =
    active.status === "WEDGED"
      ? "inspect the lane and run `peer.mjs reap` first"
      : "wait for it or run `peer.mjs interrupt` first";
  console.error(`tandem: ${action} refused while lane is ${active.status}; ${recovery}`);
  process.exitCode = 3;
  return true;
}

function worktreeCommand(args, cfg) {
  const action = args[0] || "status";
  const metadata = readLaneMetadata(STATE);
  if (action === "status") {
    if (!metadata.worktree) {
      console.log(`tandem: lane ${currentLaneLabel()} has no configured worktree; cwd ${cfg.cwd}`);
      return;
    }
    console.log(`lane: ${metadata.label || currentLaneLabel()}`);
    console.log(`cwd: ${metadata.cwd}`);
    console.log(`repo: ${metadata.worktree.repo}`);
    console.log(`branch: ${metadata.worktree.branch || "(detached)"}`);
    console.log(`created by tandem: ${metadata.worktree.createdByTandem ? "yes" : "no"}`);
    return;
  }

  if (refuseLaneMutationWhileActive(cfg, "worktree change")) return;

  const coupledCodex = codexPartnerFor(DRIVER_ID);
  const coupledClaude = existsSync(CLAUDE_SESSION) ? readFileSync(CLAUDE_SESSION, "utf8").trim() : "";
  if (coupledCodex || coupledClaude) {
    console.error("tandem: worktree change refused after coupling; run `peer.mjs new` first so the fresh session starts in the isolated cwd");
    process.exitCode = 3;
    return;
  }

  try {
    if (action === "create") {
      const info = ensureLaneWorktree({
        state: STATE,
        label: currentLaneLabel(),
        baseCwd: metadata.worktree?.repo || cfg.cwd,
        path: args[1] || metadata.worktree?.path || undefined,
        branch: args[2] || metadata.worktree?.branch || undefined,
        startPoint: args[3] || "HEAD",
      });
      console.log(`tandem: ${info.created ? "created" : "using"} worktree ${info.path}`);
      console.log(`branch: ${info.branch} | next fresh ask cwd: ${info.cwd}`);
    } else if (action === "attach") {
      if (!args[1]) throw new Error("usage: peer.mjs worktree attach <path>");
      const info = attachLaneWorktree({ state: STATE, label: currentLaneLabel(), path: args[1] });
      console.log(`tandem: attached lane ${info.label} to worktree ${info.cwd}`);
      console.log(`branch: ${info.worktree?.branch || "(detached)"}`);
    } else {
      throw new Error(`unknown worktree action "${action}" (use status, create, or attach)`);
    }
  } catch (error) {
    console.error(`tandem: worktree ${action} failed - ${error.message || error}`);
    process.exitCode = 2;
  }
}

function interactiveSpec(cfg, sid) {
  let bin;
  let args;
  // even an interactively attached partner runs its tool calls in ephemeral
  // harness contexts — partnerEnv marks it nested (job-escape spawning) and
  // scrubs this lane's identity so its own asks open fresh sub-lanes
  let env = partnerEnv(process.env);
  if (cfg.partner === "claude") {
    bin = cfg.claudeBin;
    args = ["--resume", sid];
    if (cfg.claudeModel) args.push("--model", cfg.claudeModel);
    if (cfg.claudeEffort) args.push("--effort", cfg.claudeEffort);
    env = scrubbedClaudeEnv(env);
  } else {
    bin = cfg.codexBin;
    args = ["resume", "-C", cfg.cwd];
    if (cfg.codexModel) args.push("-m", cfg.codexModel);
    if (cfg.codexEffort) args.push("-c", `model_reasoning_effort="${cfg.codexEffort}"`);
    args.push(sid);
  }
  if (/\.[mc]?js$/i.test(bin)) {
    args = [bin, ...args];
    bin = process.execPath;
  }
  return { bin, args, env, cwd: cfg.cwd };
}

async function attachInteractive(args, cfg) {
  const sid =
    cfg.partner === "claude"
      ? existsSync(CLAUDE_SESSION)
        ? readFileSync(CLAUDE_SESSION, "utf8").trim()
        : ""
      : codexPartnerFor(DRIVER_ID) || readSession();
  if (!sid) {
    console.error(`tandem: no ${cfg.partner} session is coupled to this lane yet`);
    process.exitCode = 2;
    return;
  }
  const spec = interactiveSpec(cfg, sid);
  if (args.includes("--command")) {
    console.log(`cwd: ${spec.cwd}`);
    console.log(`command argv: ${JSON.stringify([spec.bin, ...spec.args])}`);
    console.log("run through `peer.mjs attach` to retain lane locking while the interactive session is open");
    return;
  }
  if (!process.stdin.isTTY && !args.includes("--force")) {
    console.error("tandem: attach requires an interactive terminal; use `peer.mjs attach --command` to inspect the command");
    process.exitCode = 2;
    return;
  }

  const lease = acquireLaneDispatch(cfg, "interactive");
  if (!lease) return;
  if (cfg.partner === "claude") killDaemon();
  updateDispatch(lease, { workerPid: process.pid, partner: cfg.partner, mode: "interactive" });
  const stopHeartbeat = startHeartbeat(lease, { pid: process.pid });
  try {
    const code = await new Promise((resolveExit, rejectExit) => {
      const child = spawn(spec.bin, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: "inherit",
        windowsHide: false,
      });
      child.once("spawn", () => updateDispatch(lease, { partnerPid: child.pid || 0 }));
      child.once("error", rejectExit);
      child.once("exit", (exitCode) => resolveExit(exitCode ?? 0));
    });
    finishDispatch(lease, {
      status: code === 0 ? "done" : "error",
      partner: cfg.partner,
      error: code === 0 ? undefined : `interactive continuation exited with code ${code}`,
      verdict: `Interactive ${cfg.partner} continuation closed${code === 0 ? " normally" : ` with code ${code}`}.`,
    });
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    finishDispatch(lease, { status: "error", partner: cfg.partner, error: `interactive continuation failed: ${error.message || error}` });
    console.error(`tandem: attach failed - ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    stopHeartbeat();
  }
}

function runLanePeer(lane, args, input) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd: ROOT,
    env: laneEnvironment(lane, process.env),
    input,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    code: result.status ?? 1,
    out: (result.stdout || "") + (result.stderr || ""),
  };
}

function runLanePeerInteractive(lane, args) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      cwd: ROOT,
      env: laneEnvironment(lane, process.env),
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 0));
  });
}

function swarmSummary(snapshot) {
  const order = ["running", "done", "error", "WEDGED", "idle"];
  return order.filter((state) => snapshot.counts[state]).map((state) => `${state}=${snapshot.counts[state]}`).join(" ");
}

function printSwarmStatus(snapshot) {
  const width = Math.max(4, ...snapshot.lanes.map((lane) => lane.name.length));
  const setup = snapshot.setupStatus && snapshot.setupStatus !== "ready" ? ` | setup=${snapshot.setupStatus}` : "";
  console.log(`swarm: ${snapshot.name} | ${snapshot.lanes.length} lanes | ${swarmSummary(snapshot) || "idle"}${setup}`);
  if (snapshot.setupError) console.log(`  setup error: ${snapshot.setupError}`);
  for (const lane of snapshot.lanes) {
    const pid =
      (lane.status === "running" || lane.status === "WEDGED") && lane.job?.workerPid
        ? ` pid=${lane.job.workerPid}`
        : "";
    const detail =
      lane.status === "WEDGED"
        ? ` - ${lane.job?.reason || "worker liveness failed"}`
        : lane.status === "error"
          ? ` - ${lane.job?.error || lane.lastError || "unknown"}`
          : lane.status === "done" && lane.job?.durSec != null
            ? ` (${lane.job.durSec}s)`
            : "";
    console.log(`  ${lane.name.padEnd(width)}  ${lane.status.padEnd(7)}${pid}${detail}`);
  }
}

function requireSwarm(name) {
  const record = readSwarm(ROOT, STATE, name);
  if (!record) throw new Error(`unknown swarm "${name}"`);
  return record;
}

async function swarmCommand(args, cfg) {
  const action = args[0] || "list";
  try {
    if (action === "list") {
      const records = listSwarms(ROOT, STATE);
      if (!records.length) {
        console.log("tandem: no swarms yet");
        return;
      }
      for (const record of records) printSwarmStatus(inspectSwarm(record));
      return;
    }

    const name = args[1];
    if (!name) throw new Error(`usage: peer.mjs swarm ${action} <name>${action === "start" ? " <manifest.json>" : ""}`);

    if (action === "start") {
      const manifestPath = args[2];
      const record = prepareSwarm({
        root: ROOT,
        parentState: STATE,
        driverId: DRIVER_ID,
        name,
        manifestPath,
        baseCwd: cfg.cwd,
        wedgeAfterSec: cfg.wedgeAfterSec,
        stallSec: cfg.stallSec,
      });
      let failed = false;
      for (const lane of record.lanes) {
        const result = runLanePeer(lane, ["ask", "--bg", "-"], lane.task);
        lane.dispatch = result.code === 0 ? "started" : "error";
        lane.dispatchedTs = Date.now();
        lane.lastError = result.code === 0 ? "" : result.out.trim().slice(-1200);
        updateSwarm(ROOT, STATE, record);
        console.log(`tandem: swarm ${record.name}/${lane.name} ${result.code === 0 ? "started" : "FAILED"}`);
        if (result.code !== 0) {
          failed = true;
          if (result.out.trim()) console.error(result.out.trim());
        }
      }
      printSwarmStatus(inspectSwarm(record));
      if (failed) process.exitCode = 1;
      return;
    }

    const record = requireSwarm(name);
    if (action === "status") {
      printSwarmStatus(inspectSwarm(record));
      return;
    }
    if (action === "wait") {
      if (record.setupStatus && record.setupStatus !== "ready") {
        printSwarmStatus(inspectSwarm(record));
        process.exitCode = 1;
        return;
      }
      const maxSec = Number(args[2]) || 1800;
      const deadline = Date.now() + maxSec * 1000;
      let snapshot = inspectSwarm(record);
      while (snapshot.lanes.some((lane) => lane.status === "running") && Date.now() < deadline) {
        await sleep(1000);
        snapshot = inspectSwarm(record);
      }
      printSwarmStatus(snapshot);
      if (snapshot.lanes.some((lane) => lane.status === "running")) {
        console.error("tandem: swarm wait timed out with lanes still running");
        process.exitCode = 1;
      } else if (snapshot.lanes.some((lane) => lane.status === "error" || lane.status === "WEDGED")) {
        process.exitCode = 1;
      }
      return;
    }
    if (action === "results" || action === "result") {
      const snapshot = inspectSwarm(record);
      const selector = args[2];
      const lanes = selector ? [findSwarmLane(snapshot, selector)].filter(Boolean) : snapshot.lanes;
      if (!lanes.length) throw new Error(`unknown lane "${selector}" in swarm "${record.name}"`);
      for (const lane of lanes) {
        console.log(`\n===== ${record.name}/${lane.name} (${lane.status}) =====`);
        if (lane.status === "done") console.log(lane.job?.verdict || "(empty verdict)");
        else if (lane.status === "WEDGED") console.log(lane.job?.reason || "worker liveness failed");
        else console.log(lane.job?.error || lane.lastError || "(no result yet)");
      }
      return;
    }
    if (action === "tail") {
      const lane = findSwarmLane(record, args[2]);
      if (!lane) throw new Error(`unknown lane "${args[2]}" in swarm "${record.name}"`);
      const result = runLanePeer(lane, ["tail", args[3] || "40"]);
      process.stdout.write(result.out);
      if (result.code !== 0) process.exitCode = result.code;
      return;
    }
    if (action === "attach") {
      const lane = findSwarmLane(record, args[2]);
      if (!lane) throw new Error(`unknown lane "${args[2]}" in swarm "${record.name}"`);
      const attachArgs = args.slice(3);
      if (attachArgs.includes("--command")) {
        const result = runLanePeer(lane, ["attach", ...attachArgs]);
        process.stdout.write(result.out);
        if (result.code !== 0) process.exitCode = result.code;
      } else {
        const code = await runLanePeerInteractive(lane, ["attach", ...attachArgs]);
        if (code !== 0) process.exitCode = code;
      }
      return;
    }
    if (action === "ask" || action === "continue") {
      const lane = findSwarmLane(record, args[2]);
      if (!lane) throw new Error(`unknown lane "${args[2]}" in swarm "${record.name}"`);
      const foreground = args.includes("--fg");
      let task = args.slice(3).filter((arg) => arg !== "--fg" && arg !== "--bg").join(" ");
      if (task === "-" || !task) task = readFileSync(0, "utf8");
      const result = runLanePeer(lane, ["ask", ...(foreground ? [] : ["--bg"]), "-"], task);
      process.stdout.write(result.out);
      if (result.code !== 0) process.exitCode = result.code;
      return;
    }
    if (action === "cancel" || action === "interrupt" || action === "reap") {
      const laneAction = action === "interrupt" ? "interrupt" : action;
      const selector = args[2];
      const targets =
        !selector || selector === "--all"
          ? record.lanes
          : [findSwarmLane(record, selector)].filter(Boolean);
      if (!targets.length) throw new Error(`unknown lane "${selector}" in swarm "${record.name}"`);
      let failed = false;
      for (const lane of targets) {
        const result = runLanePeer(lane, [laneAction]);
        console.log(`\n[${record.name}/${lane.name}]`);
        process.stdout.write(result.out);
        if (result.code !== 0) failed = true;
      }
      if (failed) process.exitCode = 1;
      return;
    }
    throw new Error(`unknown swarm action "${action}"`);
  } catch (error) {
    console.error(`tandem: swarm ${action} failed - ${error.message || error}`);
    process.exitCode = 2;
  }
}

async function waitJob(maxSec, cfg) {
  if (!jobState(cfg)) {
    console.error("tandem: no job exists for this lane");
    process.exitCode = 2;
    return;
  }
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    const j = jobState(cfg);
    if (j && j.status !== "running") {
      if (j.status === "done") {
        printVerdict(j.partner, j.verdict, { commands: j.commands, files: j.files, tokens: j.tokens }, j.durSec, "");
        if (j.lowContext) console.log(j.lowContext);
        if (j.warning) console.error(`tandem: WARNING - ${j.warning}`);
      } else if (j.status === "WEDGED") {
        console.error(`tandem: job WEDGED - ${j.reason || "worker liveness failed"}`);
        console.error("tandem: inspect `peer.mjs status`, then run `peer.mjs reap` before dispatching a replacement");
        process.exitCode = 3;
      } else {
        console.error(`tandem: job ${j.status}${j.error ? " - " + j.error : ""}`);
        process.exitCode = 1;
      }
      return;
    }
    await sleep(2000);
  }
  console.error("tandem: wait timed out — job still running; poll `peer.mjs status`");
  process.exitCode = 1;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run ONE codex turn (fresh if sid is empty, else resume sid). Returns the verdict,
// digest, duration, raw stream, exit code, and the EXACT codex id used/created.
// outFile = where codex writes its last message; handoff/summary turns pass COMPACT_OUT so
// they never overwrite the real verdict in LASTMSG.
function persistCodexCoupling(id) {
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return false;
  }
  ensureState();
  writeFileSync(SESSION_FILE, id);
  if (DRIVER_ID) {
    recordGroup(GROUPS, {
      claudeId: DRIVER_ID,
      codexId: id,
      claudeRole: "driver",
      codexRole: "partner",
      direction: DRIVER_KIND + "->codex",
    });
  }
  return true;
}

async function codexExec(sid, task, cfg, outFile = LASTMSG, hooks = {}) {
  // fresh:  exec [opts] -C <cwd> -
  // resume: exec resume [opts] <sid> -            (resume rejects -C / --sandbox)
  const args = ["exec"];
  if (sid) args.push("resume");
  args.push("--json", "--skip-git-repo-check", "-o", outFile, ...postureArgs(cfg.posture, !sid));
  // model/effort are accepted by both `exec` and `exec resume` (unlike -C/--sandbox). Values are
  // passed via spawn (no shell), so the TOML quotes on the effort value arrive intact.
  if (cfg.codexModel) args.push("-m", cfg.codexModel);
  if (cfg.codexEffort) args.push("-c", `model_reasoning_effort="${cfg.codexEffort}"`);
  if (!sid) args.push("-C", cfg.cwd);
  if (sid) args.push(sid);
  args.push("-");
  const couplingMarker = sid ? "" : `tandem-coupling:${randomUUID()}`;
  const dispatchedTask = couplingMarker
    ? `[${couplingMarker}; internal continuity marker - ignore this line]\n${task}`
    : task;

  try {
    if (existsSync(outFile)) rmSync(outFile); // clear so a failed turn can't leak a stale verdict
  } catch {
    /* ignore */
  }
  const t0 = Date.now();
  let streamedCodexId = sid || "";
  const captureSession = (text) => {
    if (sid || streamedCodexId) return;
    const id = parseSessionId(text);
    if (!id) return;
    streamedCodexId = id;
    persistCodexCoupling(id);
  };
  const {
    stdout: out,
    code,
    killed,
    partnerPid,
    error,
    termination,
  } = await runCodex(cfg.codexBin, args, dispatchedTask, {
    stallSec: cfg.stallSec || 0,
    maxSec: cfg.maxTurnSec || 0,
    graceSec: cfg.stopGraceSec ?? 5,
    onSpawn: hooks.onSpawn,
    onActivity: hooks.onActivity,
    onTermination: hooks.onTermination,
    onStdout: ({ stdout }) => captureSession(stdout),
  });
  const dur = Math.round((Date.now() - t0) / 1000);

  // capture the session id for continuity — only on a successful fresh run, and
  // only from THIS run (parse the stream first; fall back to a rollout created now)
  let codexId = sid || streamedCodexId || "";
  let couplingWarning = "";
  if (!sid && !codexId) {
    let id = parseSessionId(out);
    if (!id) id = idFromRolloutName((await rolloutForMarker(couplingMarker, t0)) || "");
    if (id) {
      codexId = id;
      persistCodexCoupling(id);
    } else if (code === 0) {
      couplingWarning =
        "fresh Codex turn completed, but tandem could not prove its session id; continuity was left uncoupled rather than guessing another lane's rollout";
    } else {
      couplingWarning =
        "fresh Codex turn ended before tandem could prove its session id; inspect the turn log because a warm continuation cannot be guaranteed";
    }
  }

  // Verdict from THIS turn's stream first; fall back to the -o file. Never a stale prior value.
  let verdict = parseVerdict(out) || (existsSync(outFile) ? readFileSync(outFile, "utf8").trim() : "");
  // The session-persistence clause both supervised verdicts share (a stall/cap kill leaves the
  // coupled session warm; if no id was captured the driver must inspect the log before continuing).
  const warmClause = codexId
    ? `Session ${codexId} is persisted; continue resumes it warm.`
    : "No session id was captured; inspect the turn log before continuing.";
  // A maxTurnSec (absolute) kill: state ONLY what the supervisor can know — the cap elapsed. Why it
  // elapsed (oversized ask / spinning partner / idle-but-working) is UNKNOWABLE from here, so we no
  // longer editorialize a cause. The stall branch below overwrites this when the kill was a stall.
  if (killed) verdict = `(turn KILLED after ${dur}s at the maxTurnSec cap — the supervisor knows only that the cap elapsed, not why. Inspect the tree for partial edits; ${warmClause})`;
  if (termination?.kind === "stall") {
    verdict =
      `(turn STALLED/WEDGED after ${termination.idleSec}s with no partner activity. ` +
      `${stopChannelClause(termination)}. ` +
      warmClause +
      ")";
  }
  const d = digest(out);
  // Provenance: the exec stream carries no model; the rollout's turn_context does. Best-effort, and
  // only once codexId is final (fresh turns resolve it above), so we read THIS turn's rollout.
  const provenance = rolloutProvenance(codexId, t0);
  return {
    verdict,
    d,
    dur,
    raw: out,
    code,
    codexId,
    killed,
    partnerPid,
    error,
    couplingWarning,
    termination,
    modelRequested: cfg.codexModel || "",
    effortRequested: cfg.codexEffort || "",
    modelActual: provenance.modelActual,
    effortActual: provenance.effortActual,
  };
}

// Delegate a turn. Compaction keeps the session from breaking at its context limit:
//  - by default the driver is just NOTIFIED when the passenger runs low (so it can craft the
//    handoff via `peer.mjs compact "<prompt>"`); set autoCompact to do it automatically.
//  - REACTIVE net: if a turn still hits the wall, recover on a fresh session seeded with a summary.
async function askCodex(task, cfg, sidOverride, hooks = {}) {
  let sid = sidOverride !== undefined ? sidOverride : readSession();
  const limit = cfg.compactAtTokens || 0;

  if (sid && limit && cfg.autoCompact && (readUsage()[sid] || 0) >= limit) {
    const used = readUsage()[sid] || 0;
    console.error(`tandem: codex ${sid.slice(0, 8)} near context limit (${used} tok) — auto-compacting`);
    logEvent({ type: "compact", ts: Date.now(), partner: "codex", reason: "auto", from: sid, tokens: used });
    const s = await codexExec(sid, COMPACT_PROMPT, cfg, COMPACT_OUT, hooks); // summary → temp file, not the verdict slot
    task = handoffSeed(s.verdict) + task;
    sid = "";
  }

  // a pending driver-crafted handoff (from `peer.mjs compact`) seeds the fresh session's first turn
  if (!sid && existsSync(CODEX_SEED)) {
    try {
      task = readFileSync(CODEX_SEED, "utf8") + task;
      rmSync(CODEX_SEED);
    } catch {
      /* ignore */
    }
  }

  let r = await codexExec(sid, task, cfg, LASTMSG, hooks);

  if (r.code !== 0 && sid && isContextError(r.raw)) {
    console.error(`tandem: codex ${sid.slice(0, 8)} hit its context limit — recovering on a fresh session`);
    logEvent({ type: "compact", ts: Date.now(), partner: "codex", reason: "reactive", from: sid });
    let summary = "";
    try {
      summary = (await codexExec(sid, COMPACT_PROMPT, cfg, COMPACT_OUT, hooks)).verdict; // best-effort; may itself be over the wall
    } catch {
      /* ignore */
    }
    r = await codexExec("", handoffSeed(summary || "(the previous session hit its context limit before it could summarize)") + task, cfg, LASTMSG, hooks);
  }

  if (r.codexId) setUsage(r.codexId, r.d?.tokens?.in || 0); // remember context size for next time
  r.lowContext = lowContextNote(r.codexId, limit); // driver-facing "running low" notice (or null)
  return r;
}

// Driver-crafted compaction: summarize the current codex partner with the driver's prompt, stash
// the summary as a seed, and detach the old pairing. The NEXT ask starts a fresh session with the
// seed prepended and re-couples to it — no wasted "ack" turn, and the real verdict slot stays clean.
async function compactCodex(task, cfg, lease) {
  updateDispatch(lease, { workerPid: process.pid, partner: "codex", mode: "compact" });
  const stopHeartbeat = startHeartbeat(lease, { pid: process.pid });
  const driverId = DRIVER_ID;
  try {
    // Only ever compact THIS driver's own coupled codex. Never fall back to the shared global
    // for a known driver - that could compact an unrelated tandem's session.
    const sid = driverId ? codexPartnerFor(driverId) : readSession();
    if (!sid) {
      const verdict = "No Codex session is coupled to this lane yet; nothing was compacted.";
      finishDispatch(lease, { status: "done", partner: "codex", verdict });
      console.error("tandem: no codex session to compact for this driver (nothing coupled yet)");
      return;
    }
    const prompt = task && task.trim() ? task : COMPACT_PROMPT;
    console.error(`tandem: compacting codex ${sid.slice(0, 8)} (driver-crafted handoff)...`);
    const summaryTurn = await codexExec(
      sid,
      prompt,
      cfg,
      COMPACT_OUT,
      codexLeaseHooks(lease, cfg),
    );
    if (summaryTurn.killed || summaryTurn.code !== 0) {
      throw new Error(
        summaryTurn.killed
          ? supervisedStopError(summaryTurn)
          : `Codex handoff turn exited with code ${summaryTurn.code}${summaryTurn.error ? ` - ${summaryTurn.error}` : ""}`,
      );
    }
    const summary = (summaryTurn.verdict || "").trim();
    if (!summary) throw new Error("Codex handoff turn returned an empty summary; the existing session remains coupled");

    writeFileSync(CODEX_SEED, handoffSeed(summary));
    if (driverId) markDetached(DETACHED, driverId); // next ask won't resume the old thread
    logEvent({ type: "compact", ts: Date.now(), partner: "codex", reason: "manual", from: sid });
    finishDispatch(lease, {
      status: "done",
      partner: "codex",
      verdict: "Codex handoff captured; the next ask opens a fresh seeded session.",
    });
    console.log("\ntandem: compacted - the next ask starts a FRESH codex seeded with your handoff (re-couples automatically).");
    console.log("\n----- handoff summary -----\n" + summary.slice(0, 2000));
  } catch (error) {
    finishDispatch(lease, { status: "error", partner: "codex", error: String(error) });
    console.error(`tandem: Codex compaction failed - ${error.message || error}`);
    process.exitCode = 1;
  } finally {
    stopHeartbeat();
  }
}

function runCodex(
  bin,
  args,
  stdin,
  {
    stallSec = 0,
    maxSec = 0,
    graceSec = 5,
    onSpawn,
    onActivity,
    onTermination,
    onStdout,
  } = {},
) {
  // a .mjs/.js bin (e.g. a test fake) runs via node — cross-platform, no shell. Real .exe bins unaffected.
  if (/\.[mc]?js$/i.test(bin)) {
    args = [bin, ...args];
    bin = process.execPath;
  }
  return new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    let child;
    let termination = null;
    let supervisorTimer = null;
    let hardStopTimer = null;
    let settled = false;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;

    const invoke = (fn, value) => {
      if (!fn) return;
      try {
        fn(value);
      } catch {
        /* observer failures must not take down the supervised partner */
      }
    };
    const noteActivity = (kind, bytes = 0) => {
      lastActivityAt = Date.now();
      invoke(onActivity, { ts: lastActivityAt, kind, bytes });
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (supervisorTimer) clearInterval(supervisorTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      resolveP(value);
    };
    const hardStop = () => {
      if (settled || !child?.pid || child.exitCode !== null) return;
      if (termination) termination.hardKilled = hardKillProcessTree(child.pid);
    };
    const beginStop = (decision) => {
      if (termination || settled || !child?.pid) return;
      const now = Date.now();
      termination = {
        ...decision,
        triggeredTs: now,
        graceSec,
        gracefulAttempted: true,
        // The stop CHANNEL, described truthfully (see describeGracefulStop). Populated after the
        // onTermination notify so a persisted terminationPending never claims more than it knows.
        stopChannel: "",
        stopCallAccepted: false,
        stopDeliveryProven: false,
        // Kept for backward compat: the channel CALL succeeded — NOT proof the partner observed it.
        gracefulSignalAccepted: false,
        hardKilled: false,
      };
      invoke(onTermination, termination);
      const stop = describeGracefulStop(child.pid);
      termination.stopChannel = stop.channel;
      termination.stopCallAccepted = stop.callAccepted;
      termination.stopDeliveryProven = stop.deliveryProven;
      termination.gracefulSignalAccepted = stop.callAccepted;
      if (graceSec > 0) {
        hardStopTimer = setTimeout(hardStop, graceSec * 1000);
      } else {
        hardStop();
      }
    };

    try {
      child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        // The partner agent runs tool calls in EPHEMERAL harness contexts (on
        // Windows: kill-on-close Job Objects). partnerEnv marks it nested so
        // any peer.mjs it invokes job-escapes its workers, and scrubs THIS
        // lane's identity so those asks open fresh sub-lanes instead of
        // relaying back into the partner's own session.
        env: partnerEnv(process.env),
      });
    } catch (error) {
      settle({ stdout, code: 1, killed: false, partnerPid: 0, error: `cannot spawn ${bin}: ${error.message}` });
      return;
    }
    const partnerPid = child.pid || 0;
    invoke(onSpawn, partnerPid);
    noteActivity("spawn");

    child.on("error", (error) => {
      settle({
        stdout,
        code: 1,
        killed: !!termination,
        partnerPid,
        termination,
        error: `partner spawn error: ${error.message} (is codex installed + logged in?)`,
      });
    });

    const enabledWindows = [stallSec, maxSec].filter((seconds) => seconds > 0);
    if (enabledWindows.length) {
      const checkMs = Math.max(20, Math.min(250, ...enabledWindows.map((seconds) => (seconds * 1000) / 4)));
      supervisorTimer = setInterval(() => {
        if (termination || settled) return;
        const now = Date.now();
        const decision = supervisionDecision({
          now,
          startedAt,
          lastActivityAt,
          stallSec,
          maxSec,
        });
        if (decision) beginStop(decision);
      }, checkMs);
    }

    child.stdout.on("data", (b) => {
      const text = b.toString();
      stdout += text;
      noteActivity("stdout", b.length);
      invoke(onStdout, { chunk: text, stdout, ts: lastActivityAt });
      try {
        writeFileSync(TURNLOG, stdout);
      } catch {
        /* ignore */
      }
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
      noteActivity("stderr", b.length);
    });
    child.stdin.on("error", () => {
      /* a supervised stop can close stdin while the initial task is flushing */
    });
    child.stdin.write(stdin);
    child.stdin.end();
    child.on("exit", (code) => {
      if (!termination && code !== 0 && stderr.trim()) console.error(`tandem: partner stderr:\n${stderr.slice(-1500)}`);
      settle({
        stdout,
        code: code ?? 0,
        killed: !!termination,
        partnerPid,
        termination,
        error: !termination && code !== 0 ? stderr.trim().slice(-1500) : "",
      });
    });
  });
}

/** Pull the session/thread UUID out of the --json event stream. */
function parseSessionId(text) {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const cand = o.session_id ?? o.thread_id ?? o.conversation_id ?? o.payload?.session_id;
    if (
      typeof cand === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cand)
    ) {
      return cand;
    }
  }
  return null;
}

// The partner's final message, taken straight from THIS turn's stream (reliable — the `-o`
// file can go stale if a turn errors without rewriting it).
function parseVerdict(text) {
  let v = "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const it = o.item || o;
    if ((it.type === "agent_message" || it.role === "assistant") && (it.text || it.message)) v = it.text || it.message;
    if (typeof o.last_agent_message === "string" && o.last_agent_message) v = o.last_agent_message;
  }
  return v.trim();
}

function printVerdict(partner, verdict, d, dur, raw) {
  // defensive: the claude-daemon job record carries no digest (commands/files/tokens), so
  // never assume these exist — printing the verdict must not crash the driver's process.
  d = d || {};
  const commands = d.commands || [];
  const files = d.files || [];
  console.log(`\n===== PARTNER VERDICT (${partner}, ${dur}s) =====\n`);
  console.log(verdict || "(no final message — see digest/log)");
  console.log(`\n----- what ${partner} did -----`);
  if (commands.length) console.log("commands:\n  " + commands.join("\n  "));
  if (files.length) console.log("files: " + files.join(", "));
  if (d.tokens) console.log(`tokens: in ${d.tokens.in} / out ${d.tokens.out}`);
  if (!commands.length && !files.length) {
    // fall back: show a hint of the raw stream if nothing parsed
    const tailRaw = (raw || "").split(/\r?\n/).slice(-3).join("\n").slice(0, 300);
    if (tailRaw.trim()) console.log("(no parsed actions; raw tail: " + tailRaw.replace(/\s+/g, " ") + ")");
  }
  console.log("");
}

function status(cfg) {
  const sid =
    cfg.partner === "claude"
      ? existsSync(CLAUDE_SESSION)
        ? readFileSync(CLAUDE_SESSION, "utf8").trim()
        : ""
      : codexPartnerFor(DRIVER_ID) || readSession();
  const lane = readLaneMetadata(STATE);
  const laneName = lane.laneId || lane.label || currentLaneLabel();
  console.log(`partner: ${cfg.partner} | session: ${sid || "(none — next ask starts fresh)"} | cwd: ${cfg.cwd} | posture: ${cfg.posture}`);
  console.log(
    `supervision: stall ${cfg.stallSec > 0 ? `${cfg.stallSec}s` : "off"} | absolute max ${cfg.maxTurnSec > 0 ? `${cfg.maxTurnSec}s` : "off"}`,
  );
  console.log(`lane: ${laneName}`);
  // Bound-config visibility: a LIVE serve daemon enforces the supervision windows + model/effort it
  // BOUND at startup, NOT whatever tandem.config.json says now — `maxTurnSec:0` in the config changes
  // nothing for a running daemon. Surface what it bound, and DRIFT loudly per field when the config
  // has since diverged. A bound file whose pid isn't the live daemon (a crashed daemon) is ignored so
  // it can't paint drift onto a fresh one. All reads are try/caught — status must never crash.
  if (cfg.partner === "claude") {
    try {
      const servePid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
      const bound = servePid && isPidAlive(servePid) && existsSync(SERVE_BOUND) ? JSON.parse(readFileSync(SERVE_BOUND, "utf8")) : null;
      if (bound && Number(bound.pid) === servePid) {
        console.log(
          `daemon: pid ${servePid} | bound stall ${bound.stallSec}s | bound max ${bound.maxTurnSec}s | bound model ${bound.model || "(cli default)"} (${bound.effort || "-"})`,
        );
        const drift = [];
        if (Number(bound.stallSec) !== Number(cfg.stallSec)) drift.push(`stallSec ${bound.stallSec} != config ${cfg.stallSec}`);
        if (Number(bound.maxTurnSec) !== Number(cfg.maxTurnSec)) drift.push(`maxTurnSec ${bound.maxTurnSec} != config ${cfg.maxTurnSec}`);
        if ((bound.model || "") !== (cfg.claudeModel || "")) drift.push(`model ${bound.model || "(cli default)"} != config ${cfg.claudeModel || "(cli default)"}`);
        if ((bound.effort || "") !== (cfg.claudeEffort || "")) drift.push(`effort ${bound.effort || "-"} != config ${cfg.claudeEffort || "-"}`);
        for (const d of drift) {
          console.log(`daemon DRIFT: bound ${d} — the daemon keeps enforcing its startup values; \`peer.mjs stop\` then re-ask to apply the current config`);
        }
      }
    } catch {
      /* bound-config visibility is best-effort — never crash the status command */
    }
  }
  const j = jobState(cfg);
  if (j) {
    const age = j.elapsedSec ?? Math.max(0, Math.round((Date.now() - (j.startedTs || j.ts || Date.now())) / 1000));
    console.log(`job: ${j.status}${j.status === "running" || j.status === "WEDGED" ? ` (${age}s elapsed)` : j.durSec != null ? ` (${j.durSec}s)` : ""}`);
    if (j.workerPid) {
      console.log(
        `worker: pid ${j.workerPid}${j.partnerPid ? ` | partner pid ${j.partnerPid}` : ""}${j.heartbeatAgeSec != null ? ` | heartbeat ${j.heartbeatAgeSec}s ago` : ""}${j.activityAgeSec != null ? ` | partner activity ${j.activityAgeSec}s ago` : ""}`,
      );
    }
    if (j.status === "done") console.log(`\nverdict:\n${(j.verdict || "").slice(0, 1500)}`);
    else if (j.status === "error") console.log(`error: ${j.error || "unknown"}`);
    else if (j.status === "WEDGED") {
      console.log(`reason: ${j.reason || "worker liveness failed"}`);
      console.log("recovery: run `peer.mjs reap`; only then dispatch a replacement");
    }
    if (j.modelRequested || j.modelActual) {
      const part = (m, e) => (m || "(unspecified)") + (e ? ` (${e})` : "");
      console.log(`model: requested ${part(j.modelRequested, j.effortRequested)} -> actual ${part(j.modelActual, j.effortActual)}`);
    }
    if (j.warning) console.log(`warning: ${j.warning}`);
  } else if (existsSync(LASTMSG)) {
    console.log(`\nlast verdict:\n${readFileSync(LASTMSG, "utf8").trim().slice(0, 1200)}`);
  }
  if (cfg.partner === "codex") {
    const cur = codexPartnerFor(DRIVER_ID) || readSession();
    const note = lowContextNote(cur, cfg.compactAtTokens || 0);
    if (note) console.log(note);
  }
}

function tail(n) {
  if (!existsSync(TURNLOG)) return console.log("(no turn log yet)");
  const lines = readFileSync(TURNLOG, "utf8").split(/\r?\n/).filter(Boolean);
  console.log(lines.slice(-n).join("\n"));
}

function result(cfg) {
  if (existsSync(LASTMSG)) {
    console.log(readFileSync(LASTMSG, "utf8").trim());
    return;
  }
  const job = jobState(cfg);
  if (!job) {
    console.log("(no result yet)");
    return;
  }
  if (job.status === "error") {
    console.error(`tandem: job error - ${job.error || "unknown"}`);
    process.exitCode = 1;
  } else if (job.status === "WEDGED") {
    console.error(`tandem: job WEDGED - ${job.reason || "worker liveness failed"}`);
    process.exitCode = 3;
  } else if (job.status === "running") {
    console.log(`(no result yet - job running for ${job.elapsedSec || 0}s)`);
  } else {
    console.log(job.verdict || "(empty verdict)");
  }
}

// Per-tandem ledger (this pair's own TANDEM.md, in its state folder — never shared across pairs).
function ledger(text) {
  if (text && text.trim()) {
    ensureState();
    appendFileSync(LEDGER, `\n### ${new Date().toISOString()}\n${text.trim()}\n`);
    console.log(`tandem: recorded to this tandem's ledger → ${LEDGER}`);
  } else {
    console.log(`ledger: ${LEDGER}`);
    console.log(existsSync(LEDGER) ? "\n" + readFileSync(LEDGER, "utf8") : "(empty)");
  }
}

const cfg = loadConfig();
// ONE provider policy per invocation, over the lane's OWN state dir (per-lane provider state is
// deliberate — a machine-global store is a deferred follow-up). The unified tier view (flat keys =
// the `default` tier) lets resolve()/tierSpec() name the live alternate for a parked provider.
const policy = createProviderPolicy({
  stateDir: STATE,
  tiers: unifyTiers(cfg),
  families: {},
  now: Date.now,
  log: (m) => logEvent({ type: "provider", ts: Date.now(), message: m }),
});
const cmd = process.argv[2];
const argv = process.argv.slice(3);
const bg = argv.includes("--bg");
// --failover: opt-in, ask/continue only. --no-limit-classify (or TANDEM_NO_LIMIT_CLASSIFY=1): skip
// ALL classification. We NORMALIZE the flag into the env immediately so the setting also reaches
// the detached __runjob worker (startJob spawns it with env: process.env) — the driver-side flags
// (--failover, pre-flight) act in this process and need not survive into __runjob.
const failoverFlag = argv.includes("--failover");
if (argv.includes("--no-limit-classify")) process.env.TANDEM_NO_LIMIT_CLASSIFY = "1";
const stripFlags = (a) => a !== "--bg" && a !== "--failover" && a !== "--no-limit-classify";
if (cmd === "ask" || cmd === "continue") {
  let task = argv.filter(stripFlags).join(" ");
  if (task === "-" || !task) task = readFileSync(0, "utf8"); // stdin
  if (bg) await startJob(task, cfg);
  else await ask(task, cfg);
} else if (cmd === "compact") {
  // hand the near-full partner off to a fresh session, with a driver-crafted handoff prompt
  let prompt = argv.join(" ");
  if (prompt === "-") prompt = readFileSync(0, "utf8");
  const lease = acquireLaneDispatch(cfg, "compact");
  if (lease) {
    if (cfg.partner === "claude") {
      try {
        await compactClaude(prompt, cfg, lease);
      } catch (error) {
        console.error(`tandem: Claude compaction failed - ${error.message || error}`);
        process.exitCode = 1;
      }
    } else {
      await compactCodex(prompt, cfg, lease);
    }
  }
} else if (cmd === "__runjob") {
  await runJob(cfg, argv); // internal: the detached background worker (codex) — argv = [driverId, resumeSid, taskFile]
} else if (cmd === "serve") {
  // Open the persistent, resumable Claude session in the foreground (Ctrl+C to close).
  const daemonPid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
  if (isPidAlive(daemonPid)) {
    console.log(`tandem: persistent Claude session is already open (daemon pid ${daemonPid})`);
  } else {
    killDaemon();
    spawn(process.execPath, [SERVE_SCRIPT], {
      stdio: "inherit",
      env: { ...process.env, TANDEM_STATE: STATE, TANDEM_CWD: cfg.cwd },
    }).on("exit", (c) => process.exit(c || 0));
  }
} else if (cmd === "stop") {
  const active = jobState(cfg);
  if (active?.status === "WEDGED") {
    console.error("tandem: stop refused while lane is WEDGED; inspect it and run `peer.mjs reap`");
    process.exitCode = 3;
  } else if (active?.status === "running" && active.partner === "claude") {
    cancelJob(cfg);
  } else {
    const wasAlive = existsSync(SERVE_PID) && isPidAlive(Number(readFileSync(SERVE_PID, "utf8").trim()));
    killDaemon(); // tree-kill + reset state (Windows-safe), so a later ask spawns a clean daemon
    console.log(wasAlive ? "tandem: closed the persistent session. The session id persists — reopen anytime with the same context." : "tandem: no persistent session running");
  }
} else if (cmd === "group") {
  // peer.mjs group <claudeSessionId> <codexSessionId> [label]  — pin a matched pair
  const rec = recordGroup(GROUPS, {
    claudeId: argv[0],
    codexId: argv[1],
    claudeRole: "?",
    codexRole: "?",
    direction: "manual",
    label: argv.slice(2).join(" ") || undefined,
  });
  console.log(`tandem: group ${rec.n} = claude ${String(argv[0]).slice(0, 8)} ↔ codex ${String(argv[1]).slice(0, 8)}`);
} else if (cmd === "resume") {
  if (!refuseLaneMutationWhileActive(cfg, "resume")) {
    // peer.mjs resume [groupN] — reopen a tandem by its pair; no arg = most recent
    // (for the current Claude driver if known, else the latest tandem overall).
    const g = readGroups(GROUPS);
    const all = Object.values(g.groups || {}).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    let rec;
    if (argv[0]) rec = all.find((r) => String(r.n) === String(argv[0]));
    else {
      const drv = DRIVER_ID;
      rec = (drv && all.find((r) => r.claudeId === drv)) || all[0];
    }
    if (!rec) console.log(`tandem: ${argv[0] ? "no group " + argv[0] : "no tandems yet"}`);
    else {
      if (rec.codexId) writeFileSync(SESSION_FILE, rec.codexId);
      if (rec.claudeId) writeFileSync(CLAUDE_SESSION, rec.claudeId);
      recordGroup(GROUPS, { claudeId: rec.claudeId, codexId: rec.codexId, direction: rec.direction, label: rec.label });
      console.log(`tandem: resumed group ${rec.n} — claude ${String(rec.claudeId).slice(0, 8)} ↔ codex ${String(rec.codexId).slice(0, 8)}. Next ask continues it.`);
    }
  }
} else if (cmd === "groups") {
  const g = readGroups(GROUPS);
  Object.values(g.groups || {}).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).forEach((r) =>
    console.log(`  group ${r.n} | ${r.direction} | claude ${String(r.claudeId).slice(0, 8)} ↔ codex ${String(r.codexId).slice(0, 8)}${r.label ? " | " + r.label : ""}`),
  );
} else if (cmd === "wait") {
  await waitJob(Number(argv[0]) || 1800, cfg);
} else if (cmd === "status") status(cfg);
else if (cmd === "cancel" || cmd === "interrupt") cancelJob(cfg);
else if (cmd === "reap") reapJob(cfg);
else if (cmd === "worktree") worktreeCommand(argv, cfg);
else if (cmd === "swarm") await swarmCommand(argv, cfg);
else if (cmd === "attach") await attachInteractive(argv, cfg);
else if (cmd === "tail") tail(Number(argv[0]) || 40);
else if (cmd === "result") result(cfg);
else if (cmd === "ledger") {
  let t = argv.join(" ");
  if (t === "-") t = readFileSync(0, "utf8");
  ledger(t);
} else if (cmd === "label") {
  const name = argv.join(" ");
  if (!name.trim()) {
    console.log(`this tandem's folder: ${STATE}`);
  } else if (refuseLaneMutationWhileActive(cfg, "label change")) {
    // Renaming a state directory under a live worker would split the lane.
  } else if (!DRIVER_ID) {
    console.error("tandem: can't label — no driving session id in the environment");
  } else {
    const clean = setLabel(ROOT, DRIVER_ID, name);
    console.log(`tandem: named this session's tandem "${clean}" → tandems/${clean}/ (its state + ledger live here; run this BEFORE your first ask)`);
  }
}
else if (cmd === "new") {
  if (!refuseLaneMutationWhileActive(cfg, "new session")) {
    // Tree-kill + reset the daemon (Windows-safe) so the next ask spawns a clean one — otherwise
    // an orphaned/racing daemon re-processes the next turn on the old session and re-glues the pair.
    killDaemon();
    for (const f of [SESSION_FILE, CLAUDE_SESSION, CLAUDE_VERDICT, JOB, JOB_TASK]) if (existsSync(f)) rmSync(f);
    // The coupling lives in groups.json (codexPartnerFor / claudePartnerFor), not just the
    // files above — so detach this driver too, or the next ask re-resumes the same thread.
    const driverId = DRIVER_ID; // any driver kind — same-model tandems detach correctly too
    markDetached(DETACHED, driverId);
    console.log(
      driverId
        ? `tandem: forgotten + daemon closed; driver ${String(driverId).slice(0, 8)} detached — next ask starts a genuinely fresh thread`
        : "tandem: session forgotten + daemon closed; next ask starts a fresh session (new tandem group)",
    );
  }
} else {
  console.log(
    "tandem peer bridge — persistent, resumable pair sessions both ways\n" +
      "  ask \"<task>\" [--bg]   delegate a turn (Claude partner = open session; --bg = background)\n" +
      "  continue \"<task>\"      explicit alias for another turn on the same coupled session\n" +
      "  ask -                 read task from stdin (long/multiline)\n" +
      "  compact [\"<prompt>\"]  hand the near-full partner off to a FRESH thread, seeded with a\n" +
      "                        handoff summary you craft (omit prompt for the default summary)\n" +
      "  label \"<name>\"        name THIS session's tandem → tandems/<name>/ (run before the first ask)\n" +
      "  ledger [\"<entry>\"]    append to / print THIS tandem's own ledger (per-pair TANDEM.md)\n" +
      "  serve | stop          open / close the persistent Claude session (id persists, resumable)\n" +
      "  groups | resume <N>   list tandems / reopen a tandem by its pair\n" +
      "  worktree status | create [path] [branch] [start] | attach <path>\n" +
      "  swarm start <name> <manifest.json> | status/wait/results <name>\n" +
      "  swarm continue/tail/attach/interrupt/reap <name> <lane> [...]\n" +
      "  attach [--command]    resume the exact partner session in a human terminal (lane-locked)\n" +
      "  wait [sec] | status | cancel/interrupt | reap | tail [n] | result | new",
  );
}
