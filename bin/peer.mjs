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

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { recordGroup, readGroups, readDetached, markDetached } from "./groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STATE = join(ROOT, ".state");
const SESSION_FILE = join(STATE, "peer.session");
const DETACHED = join(STATE, "detached.json"); // drivers reset by `new` → start fresh next turn
const USAGE = join(STATE, "usage.json"); // per-session context size (input tokens) → compaction trigger
const LASTMSG = join(STATE, "last.txt");

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
  };
  for (const p of [join(ROOT, "tandem.config.json"), join(process.cwd(), "tandem.config.json")]) {
    if (existsSync(p)) {
      try {
        return { ...defaults, ...JSON.parse(readFileSync(p, "utf8")) };
      } catch (e) {
        console.error(`tandem: bad config ${p}: ${e.message}`);
      }
    }
  }
  return defaults;
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

// Newest codex rollout file (so we can recover the session id from its filename).
function newestRollout() {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  let best = null;
  const walk = (d, depth) => {
    if (depth > 5) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(name) && (!best || st.mtimeMs > best.mtime)) best = { path: p, mtime: st.mtimeMs };
    }
  };
  walk(root, 0);
  return best?.path ?? null;
}

function idFromRolloutName(p) {
  // rollout-2026-06-09T00-49-03-019eab24-4ca1-7780-b8f4-05badf42a28f.jsonl
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(p);
  return m ? m[1] : null;
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
  const driverId = process.env.CLAUDE_CODE_SESSION_ID || "";
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

async function ask(task, cfg) {
  ensureState();
  if (!task || !task.trim()) {
    console.error("tandem: empty task");
    process.exit(2);
  }
  // Claude partner → persistent, resumable session via the daemon (logs its own events)
  if (cfg.partner === "claude") return askClaudeDaemon(task, cfg, false);
  // Codex partner → durable, resumable `codex exec resume`, coupled to this driver.
  // The resume target comes from the IMMUTABLE recorded pair (codexPartnerFor), never the
  // shared global — so concurrent tandems can't cross-wire to each other's Codex.
  const driverId = process.env.CLAUDE_CODE_SESSION_ID || "";
  const resumeSid = codexPartnerFor(driverId);
  pairCodexForDriver(); // keep the global peer.session current for the watcher's display only
  logEvent({ type: "delegate", ts: Date.now(), driver: "claude", partner: "codex", driverId, partnerId: resumeSid, task });
  // record now if the pair is already known (resumed); a fresh pair records after askCodex
  if (driverId && resumeSid) recordGroup(GROUPS, { claudeId: driverId, codexId: resumeSid, claudeRole: "driver", codexRole: "partner", direction: "claude->codex" });
  const res = await askCodex(task, cfg, resumeSid);
  if (res) {
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
    // register/refresh this exact pair — codexId is the ACTUAL codex this turn used/created
    const cdx = res.codexId || resumeSid;
    if (driverId && cdx) recordGroup(GROUPS, { claudeId: driverId, codexId: cdx, claudeRole: "driver", codexRole: "partner", direction: "claude->codex" });
    if (res.lowContext) console.log(res.lowContext); // notify the driver the passenger is running low
  }
}

const CLAUDE_SESSION = join(STATE, "claude.session"); // dedicated partner session id
const CLAUDE_VERDICT = join(STATE, "claude_verdict.txt");
const JOB = join(STATE, "job.json"); // background turn state (for --bg + status/wait)
const JOB_TASK = join(STATE, "job.task");
const GROUPS = join(STATE, "groups.json"); // matched tandem pairs (claude id ↔ codex id)
const INBOX = join(STATE, "inbox.txt"); // file relay → persistent Claude daemon
const STATUS_FILE = join(STATE, "status.txt");
const SERVE_PID = join(STATE, "serve.pid");
const CLAUDE_SEED = join(STATE, "claude.seed"); // handoff summary the fresh daemon prepends on its first turn
const SERVE_SCRIPT = join(HERE, "serve.mjs");

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Ensure the persistent, RESUMABLE Claude partner session is open. Auto-starts the
// daemon if needed; the daemon resumes the stored session id, so closing/reopening
// always continues the same durable session (never an ephemeral subagent).
async function ensureClaudeDaemon() {
  const pid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
  const status = existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, "utf8").trim() : "";
  if (isAlive(pid) && status !== "DOWN") return true;
  console.error("tandem: opening persistent Claude session (serve)…");
  const child = spawn(process.execPath, [SERVE_SCRIPT], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  for (let i = 0; i < 70; i++) {
    await sleep(500);
    const s = existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, "utf8").trim() : "";
    if ((s === "IDLE" || s === "RUNNING") && isAlive(existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0)) return true;
  }
  console.error("tandem: serve did not become ready (check: node bin/serve.mjs)");
  return false;
}

// Send a turn to the OPEN Claude session via the relay; daemon logs delegate/verdict.
async function askClaudeDaemon(task, cfg, bg) {
  const ok = await ensureClaudeDaemon();
  if (!ok) return;
  try {
    writeFileSync(JOB, JSON.stringify({ status: "running", partner: "claude", ts: Date.now() }));
  } catch {
    /* ignore */
  }
  writeFileSync(INBOX, task);
  if (bg) {
    console.log("tandem: sent to the open Claude session (bg). poll: peer.mjs status  ·  block: peer.mjs wait");
    return;
  }
  await waitJob(cfg.claudeMaxSec || 1800);
}

// Driver-crafted compaction of the Claude partner: take a handoff summary from the open
// session, close it, then reopen a FRESH session seeded with that summary (the daemon
// prepends the seed on its first turn). Re-couples via the detached-stamp + recency.
async function compactClaude(prompt, cfg) {
  if (!(await ensureClaudeDaemon())) return;
  writeFileSync(JOB, JSON.stringify({ status: "running", partner: "claude", ts: Date.now() }));
  writeFileSync(INBOX, prompt && prompt.trim() ? prompt : COMPACT_PROMPT);
  console.error("tandem: asking the Claude partner for a handoff summary…");
  await waitJob(cfg.claudeMaxSec || 1800);
  const summary = existsSync(LASTMSG) ? readFileSync(LASTMSG, "utf8").trim() : "";
  // close the session + detach the old pairing so the next start is genuinely fresh
  const dpid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
  if (isAlive(dpid)) {
    try {
      process.kill(dpid);
    } catch {
      /* ignore */
    }
  }
  if (existsSync(CLAUDE_SESSION)) rmSync(CLAUDE_SESSION);
  const codexDriver = process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_CONVERSATION_ID || "";
  markDetached(DETACHED, codexDriver);
  writeFileSync(CLAUDE_SEED, handoffSeed(summary));
  logEvent({ type: "compact", ts: Date.now(), partner: "claude", reason: "manual" });
  console.log("\ntandem: Claude partner compacted — closed and reseeded; the next ask opens a FRESH session with your handoff.");
  console.log("\n----- handoff summary -----\n" + (summary || "(none returned)").slice(0, 2000));
}

// Launch a turn in a DETACHED child so long delegations don't block (or time out)
// the driver's shell. The driver then polls `status` (instant) or blocks on `wait`.
async function startJob(task, cfg) {
  ensureState();
  // Claude partner → relay into the persistent open session (daemon does the work)
  if (cfg.partner === "claude") return askClaudeDaemon(task, cfg, true);
  // Codex partner → detached exec-resume worker (resumable session, survives shell timeouts).
  // Pass the driver id + IMMUTABLE resume id (from the recorded pair) + task path by ARGV so
  // concurrent bg tandems are fully isolated and can NEVER cross-wire via shared global files.
  const driverId = process.env.CLAUDE_CODE_SESSION_ID || "";
  const resumeSid = codexPartnerFor(driverId);
  pairCodexForDriver(); // keep the global peer.session current for the watcher's display only
  // record on delegate if the pair is already known (resumed) so it shows live DURING the turn
  if (driverId && resumeSid) recordGroup(GROUPS, { claudeId: driverId, codexId: resumeSid, claudeRole: "driver", codexRole: "partner", direction: "claude->codex" });
  for (const f of [TURNLOG, LASTMSG]) if (existsSync(f)) rmSync(f);
  const taskFile = join(STATE, "job-" + (driverId || "anon").replace(/[^a-zA-Z0-9-]/g, "") + ".task");
  writeFileSync(taskFile, task);
  writeFileSync(JOB, JSON.stringify({ status: "running", partner: "codex", driverId, ts: Date.now() }));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__runjob", driverId, resumeSid, taskFile], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  console.log(`tandem: codex turn started in background (pid ${child.pid}). poll: peer.mjs status  ·  block: peer.mjs wait`);
}

async function runJob(cfg, jobArgv) {
  // self-contained from argv (race-free): [driverId, resumeSid, taskFile]
  const driverId = jobArgv[0] || process.env.CLAUDE_CODE_SESSION_ID || "";
  const resumeSid = jobArgv[1] || "";
  const taskFile = jobArgv[2] || JOB_TASK;
  let task = "";
  try {
    task = readFileSync(taskFile, "utf8");
  } catch {
    return;
  }
  // background worker is codex-only (claude bg goes through the persistent daemon)
  logEvent({ type: "delegate", ts: Date.now(), driver: "claude", partner: "codex", driverId, partnerId: resumeSid, task });
  let res = null;
  try {
    res = await askCodex(task, cfg, resumeSid);
  } catch (e) {
    writeFileSync(JOB, JSON.stringify({ status: "error", partner: "codex", error: String(e), ts: Date.now() }));
    return;
  }
  const job = res
    ? { status: "done", partner: "codex", durSec: res.dur, verdict: res.verdict, commands: res.d?.commands || [], files: res.d?.files || [], tokens: res.d?.tokens || null, lowContext: res.lowContext || null, ts: Date.now() }
    : { status: "error", partner: "codex", ts: Date.now() };
  writeFileSync(JOB, JSON.stringify(job));
  if (res) {
    // Register the EXACT pair: the real driver ↔ the actual codex this turn used/created.
    const cdx = res.codexId || resumeSid;
    if (driverId && cdx) recordGroup(GROUPS, { claudeId: driverId, codexId: cdx, claudeRole: "driver", codexRole: "partner", direction: "claude->codex" });
    logEvent({ type: "verdict", ts: Date.now(), partner: "codex", durSec: res.dur, verdict: res.verdict, commands: res.d?.commands || [], files: res.d?.files || [], tokens: res.d?.tokens || null });
  }
  try {
    if (taskFile !== JOB_TASK) rmSync(taskFile);
  } catch {
    /* ignore */
  }
}

function jobState() {
  if (!existsSync(JOB)) return null;
  try {
    return JSON.parse(readFileSync(JOB, "utf8"));
  } catch {
    return null;
  }
}

async function waitJob(maxSec) {
  const deadline = Date.now() + maxSec * 1000;
  while (Date.now() < deadline) {
    const j = jobState();
    if (j && j.status !== "running") {
      if (j.status === "done") {
        printVerdict(j.partner, j.verdict, { commands: j.commands, files: j.files, tokens: j.tokens }, j.durSec, "");
        if (j.lowContext) console.log(j.lowContext);
      } else console.error(`tandem: job ${j.status}${j.error ? " — " + j.error : ""}`);
      return;
    }
    await sleep(2000);
  }
  console.error("tandem: wait timed out — job still running; poll `peer.mjs status`");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run ONE codex turn (fresh if sid is empty, else resume sid). Returns the verdict,
// digest, duration, raw stream, exit code, and the EXACT codex id used/created.
async function codexExec(sid, task, cfg) {
  // fresh:  exec [opts] -C <cwd> -
  // resume: exec resume [opts] <sid> -            (resume rejects -C / --sandbox)
  const args = ["exec"];
  if (sid) args.push("resume");
  args.push("--json", "--skip-git-repo-check", "-o", LASTMSG, ...postureArgs(cfg.posture, !sid));
  if (!sid) args.push("-C", cfg.cwd);
  if (sid) args.push(sid);
  args.push("-");

  const t0 = Date.now();
  const { stdout: out, code } = await runCodex(cfg.codexBin, args, task);
  const dur = Math.round((Date.now() - t0) / 1000);

  // capture the session id for continuity — only on a successful fresh run, and
  // only from THIS run (parse the stream first; fall back to a rollout created now)
  let codexId = sid || "";
  if (!sid && code === 0) {
    let id = parseSessionId(out);
    if (!id) {
      const roll = newestRollout();
      if (roll && statSync(roll).mtimeMs >= t0 - 1000) id = idFromRolloutName(roll);
    }
    if (id) {
      codexId = id;
      writeFileSync(SESSION_FILE, id); // global, for the watcher's display only
    }
  }

  const verdict = existsSync(LASTMSG) ? readFileSync(LASTMSG, "utf8").trim() : "";
  const d = digest(out);
  return { verdict, d, dur, raw: out, code, codexId };
}

// Delegate a turn. Compaction keeps the session from breaking at its context limit:
//  - by default the driver is just NOTIFIED when the passenger runs low (so it can craft the
//    handoff via `peer.mjs compact "<prompt>"`); set autoCompact to do it automatically.
//  - REACTIVE net: if a turn still hits the wall, recover on a fresh session seeded with a summary.
async function askCodex(task, cfg, sidOverride) {
  let sid = sidOverride !== undefined ? sidOverride : readSession();
  const limit = cfg.compactAtTokens || 0;

  if (sid && limit && cfg.autoCompact && (readUsage()[sid] || 0) >= limit) {
    const used = readUsage()[sid] || 0;
    console.error(`tandem: codex ${sid.slice(0, 8)} near context limit (${used} tok) — auto-compacting`);
    logEvent({ type: "compact", ts: Date.now(), partner: "codex", reason: "auto", from: sid, tokens: used });
    const s = await codexExec(sid, COMPACT_PROMPT, cfg); // old session still has room to summarize
    task = handoffSeed(s.verdict) + task;
    sid = "";
  }

  let r = await codexExec(sid, task, cfg);

  if (r.code !== 0 && sid && isContextError(r.raw)) {
    console.error(`tandem: codex ${sid.slice(0, 8)} hit its context limit — recovering on a fresh session`);
    logEvent({ type: "compact", ts: Date.now(), partner: "codex", reason: "reactive", from: sid });
    let summary = "";
    try {
      summary = (await codexExec(sid, COMPACT_PROMPT, cfg)).verdict; // best-effort; may itself be over the wall
    } catch {
      /* ignore */
    }
    r = await codexExec("", handoffSeed(summary || "(the previous session hit its context limit before it could summarize)") + task, cfg);
  }

  if (r.codexId) setUsage(r.codexId, r.d?.tokens?.in || 0); // remember context size for next time
  r.lowContext = lowContextNote(r.codexId, limit); // driver-facing "running low" notice (or null)
  return r;
}

// Driver-crafted compaction: summarize the current codex partner with the driver's prompt,
// then start a FRESH session seeded with that summary and re-couple to it.
async function compactCodex(task, cfg) {
  const driverId = process.env.CLAUDE_CODE_SESSION_ID || "";
  // Only ever compact THIS driver's own coupled codex. Never fall back to the shared global
  // for a known driver — that could compact an unrelated tandem's session.
  const sid = driverId ? codexPartnerFor(driverId) : readSession();
  if (!sid) {
    console.error("tandem: no codex session to compact for this driver (nothing coupled yet)");
    return;
  }
  const prompt = task && task.trim() ? task : COMPACT_PROMPT;
  console.error(`tandem: compacting codex ${sid.slice(0, 8)} → fresh session (driver-crafted handoff)`);
  const s = await codexExec(sid, prompt, cfg);
  const fresh = await codexExec("", handoffSeed(s.verdict) + "Reply in one line that you have this context and are ready to continue.", cfg);
  if (driverId && fresh.codexId)
    recordGroup(GROUPS, { claudeId: driverId, codexId: fresh.codexId, claudeRole: "driver", codexRole: "partner", direction: "claude->codex" });
  if (fresh.codexId) setUsage(fresh.codexId, fresh.d?.tokens?.in || 0);
  logEvent({ type: "compact", ts: Date.now(), partner: "codex", reason: "manual", from: sid, to: fresh.codexId });
  console.log(`\ntandem: compacted — fresh codex ${String(fresh.codexId).slice(0, 8)} seeded with your handoff; the next ask continues there.`);
  console.log("\n----- handoff summary -----\n" + (s.verdict || "(none returned)").slice(0, 2000));
}

function runCodex(bin, args, stdin) {
  return new Promise((resolveP) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      console.error(`tandem: cannot spawn ${bin}: ${e.message}`);
      process.exit(1);
    }
    child.on("error", (e) => {
      console.error(`tandem: partner spawn error: ${e.message} (is codex installed + logged in?)`);
      process.exit(1);
    });
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      try {
        writeFileSync(TURNLOG, stdout);
      } catch {
        /* ignore */
      }
    });
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.stdin.write(stdin);
    child.stdin.end();
    child.on("exit", (code) => {
      if (code !== 0 && stderr.trim()) console.error(`tandem: partner stderr:\n${stderr.slice(-1500)}`);
      resolveP({ stdout, code: code ?? 0 });
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
    const cand =
      o.session_id ?? o.thread_id ?? o.conversation_id ?? o.payload?.session_id ?? o.payload?.id ?? o.id;
    if (typeof cand === "string" && /^[0-9a-f-]{36}$/i.test(cand)) return cand;
  }
  return null;
}

function printVerdict(partner, verdict, d, dur, raw) {
  console.log(`\n===== PARTNER VERDICT (${partner}, ${dur}s) =====\n`);
  console.log(verdict || "(no final message — see digest/log)");
  console.log(`\n----- what ${partner} did -----`);
  if (d.commands.length) console.log("commands:\n  " + d.commands.join("\n  "));
  if (d.files.length) console.log("files: " + d.files.join(", "));
  if (d.tokens) console.log(`tokens: in ${d.tokens.in} / out ${d.tokens.out}`);
  if (!d.commands.length && !d.files.length) {
    // fall back: show a hint of the raw stream if nothing parsed
    const tailRaw = raw.split(/\r?\n/).slice(-3).join("\n").slice(0, 300);
    if (tailRaw.trim()) console.log("(no parsed actions; raw tail: " + tailRaw.replace(/\s+/g, " ") + ")");
  }
  console.log("");
}

function status(cfg) {
  const sid = readSession();
  console.log(`partner: ${cfg.partner} | session: ${sid || "(none — next ask starts fresh)"} | cwd: ${cfg.cwd} | posture: ${cfg.posture}`);
  const j = jobState();
  if (j) {
    const age = Math.round((Date.now() - j.ts) / 1000);
    console.log(`job: ${j.status}${j.status === "running" ? ` (${age}s elapsed)` : j.durSec != null ? ` (${j.durSec}s)` : ""}`);
    if (j.status === "done") console.log(`\nverdict:\n${(j.verdict || "").slice(0, 1500)}`);
    else if (j.status === "error") console.log(`error: ${j.error || "unknown"}`);
  } else if (existsSync(LASTMSG)) {
    console.log(`\nlast verdict:\n${readFileSync(LASTMSG, "utf8").trim().slice(0, 1200)}`);
  }
  if (cfg.partner === "codex") {
    const cur = codexPartnerFor(process.env.CLAUDE_CODE_SESSION_ID || "") || readSession();
    const note = lowContextNote(cur, cfg.compactAtTokens || 0);
    if (note) console.log(note);
  }
}

function tail(n) {
  if (!existsSync(TURNLOG)) return console.log("(no turn log yet)");
  const lines = readFileSync(TURNLOG, "utf8").split(/\r?\n/).filter(Boolean);
  console.log(lines.slice(-n).join("\n"));
}

function result(n) {
  if (!existsSync(LASTMSG)) return console.log("(no result yet)");
  console.log(readFileSync(LASTMSG, "utf8").trim());
  void n;
}

const cfg = loadConfig();
const cmd = process.argv[2];
const argv = process.argv.slice(3);
const bg = argv.includes("--bg");
if (cmd === "ask") {
  let task = argv.filter((a) => a !== "--bg").join(" ");
  if (task === "-" || !task) task = readFileSync(0, "utf8"); // stdin
  if (bg) await startJob(task, cfg);
  else await ask(task, cfg);
} else if (cmd === "compact") {
  // hand the near-full partner off to a fresh session, with a driver-crafted handoff prompt
  let prompt = argv.join(" ");
  if (prompt === "-") prompt = readFileSync(0, "utf8");
  if (cfg.partner === "claude") await compactClaude(prompt, cfg);
  else await compactCodex(prompt, cfg);
} else if (cmd === "__runjob") {
  await runJob(cfg, argv); // internal: the detached background worker (codex) — argv = [driverId, resumeSid, taskFile]
} else if (cmd === "serve") {
  // Open the persistent, resumable Claude session in the foreground (Ctrl+C to close).
  spawn(process.execPath, [SERVE_SCRIPT], { stdio: "inherit", env: process.env }).on("exit", (c) => process.exit(c || 0));
} else if (cmd === "stop") {
  const pid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
  if (isAlive(pid)) {
    try {
      process.kill(pid);
    } catch {
      /* ignore */
    }
    console.log(`tandem: closed the persistent session (pid ${pid}). The session id persists — reopen anytime with the same context.`);
  } else console.log("tandem: no persistent session running");
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
  // peer.mjs resume [groupN] — reopen a tandem by its pair; no arg = most recent
  // (for the current Claude driver if known, else the latest tandem overall).
  const g = readGroups(GROUPS);
  const all = Object.values(g.groups || {}).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  let rec;
  if (argv[0]) rec = all.find((r) => String(r.n) === String(argv[0]));
  else {
    const drv = process.env.CLAUDE_CODE_SESSION_ID;
    rec = (drv && all.find((r) => r.claudeId === drv)) || all[0];
  }
  if (!rec) console.log(`tandem: ${argv[0] ? "no group " + argv[0] : "no tandems yet"}`);
  else {
    if (rec.codexId) writeFileSync(SESSION_FILE, rec.codexId);
    if (rec.claudeId) writeFileSync(CLAUDE_SESSION, rec.claudeId);
    recordGroup(GROUPS, { claudeId: rec.claudeId, codexId: rec.codexId, direction: rec.direction, label: rec.label });
    console.log(`tandem: resumed group ${rec.n} — claude ${String(rec.claudeId).slice(0, 8)} ↔ codex ${String(rec.codexId).slice(0, 8)}. Next ask continues it.`);
  }
} else if (cmd === "groups") {
  const g = readGroups(GROUPS);
  Object.values(g.groups || {}).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).forEach((r) =>
    console.log(`  group ${r.n} | ${r.direction} | claude ${String(r.claudeId).slice(0, 8)} ↔ codex ${String(r.codexId).slice(0, 8)}${r.label ? " | " + r.label : ""}`),
  );
} else if (cmd === "wait") {
  await waitJob(Number(argv[0]) || 1800);
} else if (cmd === "status") status(cfg);
else if (cmd === "tail") tail(Number(argv[0]) || 40);
else if (cmd === "result") result(Number(argv[0]) || 4);
else if (cmd === "new") {
  // close the persistent daemon too — otherwise the next ask reuses its in-memory
  // session and no NEW tandem/group forms.
  const dpid = existsSync(SERVE_PID) ? Number(readFileSync(SERVE_PID, "utf8").trim()) : 0;
  if (isAlive(dpid)) {
    try {
      process.kill(dpid);
    } catch {
      /* ignore */
    }
  }
  for (const f of [SESSION_FILE, CLAUDE_SESSION, CLAUDE_VERDICT, JOB, JOB_TASK]) if (existsSync(f)) rmSync(f);
  // The coupling lives in groups.json (codexPartnerFor / claudePartnerFor), not just the
  // files above — so detach this driver too, or the next ask re-resumes the same thread.
  const driverId =
    cfg.partner === "claude"
      ? process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_CONVERSATION_ID || ""
      : process.env.CLAUDE_CODE_SESSION_ID || "";
  markDetached(DETACHED, driverId);
  console.log(
    driverId
      ? `tandem: forgotten + daemon closed; driver ${String(driverId).slice(0, 8)} detached — next ask starts a genuinely fresh thread`
      : "tandem: session forgotten + daemon closed; next ask starts a fresh session (new tandem group)",
  );
} else {
  console.log(
    "tandem peer bridge — persistent, resumable pair sessions both ways\n" +
      "  ask \"<task>\" [--bg]   delegate a turn (Claude partner = open session; --bg = background)\n" +
      "  ask -                 read task from stdin (long/multiline)\n" +
      "  compact [\"<prompt>\"]  hand the near-full partner off to a FRESH thread, seeded with a\n" +
      "                        handoff summary you craft (omit prompt for the default summary)\n" +
      "  serve | stop          open / close the persistent Claude session (id persists, resumable)\n" +
      "  groups | resume <N>   list tandems / reopen a tandem by its pair\n" +
      "  wait [sec] | status | tail [n] | result [n] | new",
  );
}
