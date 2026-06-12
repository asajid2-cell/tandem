#!/usr/bin/env node
// tandem serve — keep the PARTNER session OPEN and interactive (the T6-relay model).
//
// Holds ONE persistent `claude -p --input-format stream-json` process on the
// claude.ai SUBSCRIPTION (apiKeySource = none) in bypass mode, so the driver
// (Codex) can converse with a single continuous Claude session turn after turn —
// full context, live streaming, kept open — instead of fire-and-forget headless
// queries. IPC is a file relay in .state (inbox/status/job), same shape as the
// proven codex_relay. Run once; peer.mjs auto-starts it on the first Claude turn.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { scrubbedClaudeEnv, apiRoutingVarsPresent } from "./claudeEnv.mjs";
import { recordGroup, readGroups, readDetached, jobKey } from "./groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STATE = process.env.TANDEM_STATE ? resolve(process.env.TANDEM_STATE) : join(ROOT, ".state"); // override for isolated tests
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
const CODEX_DRIVER_ID =
  process.env.CODEX_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CODEX_CONVERSATION_ID || "";
// Per-driver verdict/status files so concurrent tandems don't clobber each other (matches peer.mjs).
const SK = jobKey(CODEX_DRIVER_ID);
const LASTMSG = join(STATE, `last-${SK}.txt`);
const JOB = join(STATE, `job-${SK}.json`);

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
if (sessionId) args.push("--resume", sessionId);
let bin = process.env.TANDEM_CLAUDE_BIN || C.claudeBin || "claude";
const cwd = process.env.TANDEM_CWD || C.cwd || process.cwd();
// a .mjs/.js bin (e.g. a test fake) runs via node — cross-platform, no shell. Real .exe bins unaffected.
if (/\.[mc]?js$/i.test(bin)) {
  args = [bin, ...args];
  bin = process.execPath;
}

const claude = spawn(bin, args, { env, cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
writeFileSync(PID, String(process.pid));
writeFileSync(STATUS, "IDLE");
console.log(`tandem serve: persistent Claude partner OPEN (pid ${process.pid} / claude ${claude.pid})`);
console.log(`  cwd ${cwd} · subscription · bypass · ${sessionId ? "resumed " + sessionId.slice(0, 8) : "new session"}`);
console.log("  feed it turns with:  peer.mjs ask \"<task>\"   (Ctrl+C to close the session)");

let buf = "";
let turnStart = 0;
let inTurn = false;

claude.stdout.on("data", (b) => {
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
      const verdict = o.result || "";
      const dur = Math.round((Date.now() - turnStart) / 1000);
      const u = o.usage || {};
      const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (used) setUsage(sessionId, used);
      const low = lowNote(sessionId, used);
      try {
        writeFileSync(LASTMSG, verdict);
        writeFileSync(JOB, JSON.stringify({ status: "done", partner: "claude", durSec: dur, verdict, lowContext: low, ts: Date.now() }));
      } catch {
        /* ignore */
      }
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
      writeFileSync(STATUS, "IDLE");
      console.log(`  ◂ turn done (${dur}s): ${verdict.replace(/\s+/g, " ").slice(0, 80)}`);
    }
  }
});
claude.stderr.on("data", (b) => process.stderr.write(b));
claude.on("exit", (code) => {
  console.error(`tandem serve: claude session ended (${code})`);
  cleanup();
  process.exit(code || 0);
});

function cleanup() {
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
  inTurn = true;
  turnStart = Date.now();
  writeFileSync(STATUS, "RUNNING");
  try {
    writeFileSync(TURNLOG, ""); // reset the live stream for this turn
    writeFileSync(JOB, JSON.stringify({ status: "running", partner: "claude", ts: Date.now() }));
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
