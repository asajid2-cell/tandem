#!/usr/bin/env node
// tandem watch — live split-view of the two minds.
// Opens a local web dashboard (auto-launches the browser) showing the DRIVER's
// chain-of-thought and the PARTNER's, side by side, updating in real time, plus
// the collaboration timeline (each delegation + verdict). Read-only; tails files.
//
//   node bin/watch.mjs            # serves + opens browser (port 8799)
//   node bin/watch.mjs 9000       # custom port

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, utimesSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { readGroups } from "./groups.mjs";
import { scrubbedClaudeEnv, apiRoutingVarsPresent } from "./claudeEnv.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const STATE = process.env.TANDEM_STATE ? resolve(process.env.TANDEM_STATE) : join(ROOT, ".state"); // override for isolated tests
const TANDEM_LOG = join(STATE, "tandem.log.jsonl");
const CLAUDE_SESSION = join(STATE, "claude.session");
const PEER_SESSION = join(STATE, "peer.session"); // current codex partner (for live synthesis)
const GROUPS = join(STATE, "groups.json");
const LIVE_MS = 60 * 60 * 1000; // a tandem is "live/active" if either session was written within this window (or daemon held); older → history
const SERVE_PID = join(STATE, "serve.pid");
const META = join(STATE, "session_meta.json"); // local rename / star / archive per session
const PORT = Number(process.argv[2]) || 8799;

function readMeta() {
  try {
    return JSON.parse(readFileSync(META, "utf8"));
  } catch {
    return {};
  }
}
function setMeta(kind, id, patch) {
  const m = readMeta();
  const k = kind + ":" + id;
  m[k] = { ...(m[k] || {}), ...patch };
  if (!m[k].name) delete m[k].name; // empty name → revert to title
  try {
    writeFileSync(META, JSON.stringify(m));
  } catch {
    /* ignore */
  }
  return m[k];
}

// ---- projects: group chats into named collections ----
const PROJECTS = join(STATE, "projects.json");
function readProjects() {
  try {
    return JSON.parse(readFileSync(PROJECTS, "utf8"));
  } catch {
    return {};
  }
}
function writeProjects(p) {
  try {
    writeFileSync(PROJECTS, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
function newId() {
  return "p" + Math.abs(Date.now() % 1e9).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// ---- bump up: bring an old chat back to the top + remind us of its context ----
// Two parts, so it NEVER just fails: (1) RESURFACE by touching the session file's mtime —
// works for any chat regardless of project, and surfaces it in the watcher AND the native
// CLI resume list; (2) BEST-EFFORT summary by resuming it in ITS OWN cwd (claude --resume is
// project-scoped, so resuming from the wrong folder is exactly what was erroring before).
const BUMP_PROMPT =
  "Briefly (3-5 sentences) summarize what we were last working on in this session and where we left off, so I can pick it back up. Don't take any actions.";
// derive a session's own working dir from its transcript so `--resume` can find it
function sessionCwd(kind, file) {
  const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head(file, 16384));
  if (!m) return "";
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch {
    return m[1];
  }
}
function bump(kind, id) {
  let f = SESS_CACHE[kind][id];
  if (!f) {
    listSessions(kind);
    f = SESS_CACHE[kind][id];
  }
  if (!f) return Promise.resolve({ ok: false, error: "session file not found" });
  // (1) RESURFACE — guaranteed: touch mtime so it sorts to the very top everywhere.
  let resurfaced = false;
  try {
    const now = new Date();
    utimesSync(f, now, now);
    resurfaced = true;
  } catch {
    /* ignore */
  }
  // (2) BEST-EFFORT summary — resume in the session's own cwd; if it errors/times out the
  // bump still succeeded (already resurfaced).
  return new Promise((resolveP) => {
    const c = cfg();
    const cwd = sessionCwd(kind, f) || c.cwd || process.cwd();
    let bin, args, env;
    if (kind === "claude") {
      bin = process.env.TANDEM_CLAUDE_BIN || c.claudeBin || "claude";
      args = ["-p", BUMP_PROMPT, "--output-format", "json", "--dangerously-skip-permissions", "--resume", id];
      env = scrubbedClaudeEnv(process.env);
    } else {
      bin = process.env.TANDEM_CODEX_BIN || c.codexBin || "codex";
      args = ["exec", "resume", id, "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", BUMP_PROMPT];
      env = process.env;
    }
    const done = (summary) => resolveP({ ok: true, resurfaced, summary });
    let out = "";
    let child;
    try {
      child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return done("(resurfaced to the top — summary unavailable: " + (e.code || e.message) + ")");
    }
    const killer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, 90000);
    child.on("error", (e) => {
      clearTimeout(killer);
      done("(resurfaced to the top — summary unavailable: " + (e.code || e.message) + ")");
    });
    child.stdout.on("data", (b) => (out += b.toString()));
    child.on("exit", () => {
      clearTimeout(killer);
      let summary = "";
      try {
        if (kind === "claude") {
          const arr = JSON.parse(out);
          const r = (Array.isArray(arr) ? arr : [arr]).find((o) => o && o.type === "result") || (Array.isArray(arr) ? arr : [arr]).reverse().find((o) => o && o.result);
          summary = (r && (r.result || r.text)) || "";
        } else {
          for (const line of out.split(/\r?\n/)) {
            if (!line.trim().startsWith("{")) continue;
            const o = JSON.parse(line);
            if (o.item?.type === "agent_message" && o.item.text) summary = o.item.text;
          }
        }
      } catch {
        /* fall through */
      }
      if (!summary) summary = out.split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 600) || "(resurfaced to the top — no summary returned; the session may be in another project)";
      done(summary);
    });
  });
}

function cfg() {
  for (const p of [join(ROOT, "tandem.config.json"), join(process.cwd(), "tandem.config.json")]) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        /* ignore */
      }
    }
  }
  return {};
}

function read(f) {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + " …" : s);
// drop harness-injected text so "inputs" = what a human/driver actually typed
function isSystemInjected(t) {
  const s = (t || "").trim();
  return !s || s.startsWith("<") || s.startsWith("Caveat:") || s.startsWith("[Request interrupted") || s.startsWith("[The user");
}

// ---- session browser: list ALL Claude + Codex sessions, flip through any ----
function allFiles(dir, re, depth = 6) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (d, lvl) => {
    if (lvl > depth) return;
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, lvl + 1);
      else if (re.test(n)) out.push({ p, mtime: st.mtimeMs });
    }
  };
  walk(dir, 0);
  return out;
}
function head(p, bytes = 49152) {
  try {
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    closeSync(fd);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  }
}
function sessionIdOf(kind, p) {
  if (kind === "codex") {
    const m = /([0-9a-f-]{36})\.jsonl$/i.exec(p);
    return m ? m[1] : p.split(/[\\/]/).pop();
  }
  return p.split(/[\\/]/).pop().replace(/\.jsonl$/, "");
}
const TITLE_CACHE = new Map();
function sessionTitle(kind, p, mtime) {
  if (mtime == null) {
    try {
      mtime = statSync(p).mtimeMs;
    } catch {
      mtime = 0;
    }
  }
  const c = TITLE_CACHE.get(p);
  if (c && c.mtime === mtime) return c.title;
  const title = computeTitle(kind, p);
  TITLE_CACHE.set(p, { mtime, title });
  return title;
}
function computeTitle(kind, p) {
  for (const line of head(p).split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (kind === "claude") {
      const m = o.message || o;
      if (m.role === "user") {
        const c = m.content;
        const t = typeof c === "string" ? c : Array.isArray(c) ? (c.find((x) => x.type === "text") || {}).text : "";
        if (t && t.trim() && !t.trim().startsWith("<")) return clip(t.replace(/\s+/g, " "), 64);
      }
    } else {
      const pl = o.payload || {};
      if (pl.type === "agent_message" && pl.message && pl.message !== "STDIN_OK") return clip(pl.message.replace(/\s+/g, " "), 64);
      if ((pl.type === "user_message" || pl.type === "user") && pl.message) return clip(String(pl.message).replace(/\s+/g, " "), 64);
    }
  }
  return "(session)";
}
const SESS_CACHE = { claude: {}, codex: {} };
function listSessions(kind, limit = 5000) {
  const roots =
    kind === "claude"
      ? [join(homedir(), ".claude", "projects")]
      : [
          join(homedir(), ".codex", "sessions"),
          join(homedir(), ".codex", "archived_sessions"),
          join(homedir(), ".codex", "repair-backups"), // older chats backed up by cleanup runs
        ];
  const re = kind === "claude" ? /\.jsonl$/ : /^rollout-.*\.jsonl$/;
  const byId = new Map(); // dedupe by session id (keep newest copy)
  for (const root of roots)
    for (const f of allFiles(root, re)) {
      const id = sessionIdOf(kind, f.p);
      const ex = byId.get(id);
      if (!ex || f.mtime > ex.mtime) byId.set(id, { p: f.p, mtime: f.mtime, id });
    }
  const uniq = [...byId.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  SESS_CACHE[kind] = {};
  return uniq.map((f) => {
    SESS_CACHE[kind][f.id] = f.p;
    return { id: f.id, mtime: f.mtime, title: sessionTitle(kind, f.p, f.mtime) };
  });
}
const PARSE_CACHE = new Map(); // path -> {mtime, msgs}; avoids re-parsing unchanged files each tick
function sessionMessages(kind, id) {
  let f = SESS_CACHE[kind][id];
  if (!f) {
    listSessions(kind);
    f = SESS_CACHE[kind][id];
  }
  if (!f) return [];
  let mtime = 0;
  try {
    mtime = statSync(f).mtimeMs;
  } catch {
    /* ignore */
  }
  const c = PARSE_CACHE.get(f);
  if (c && c.mtime === mtime) return c.msgs;
  const msgs = kind === "claude" ? parseClaudeTranscript(f, 100000) : parseCodexRollout(f, 100000); // ENTIRE transcript
  if (PARSE_CACHE.size > 40) PARSE_CACHE.clear();
  PARSE_CACHE.set(f, { mtime, msgs });
  return msgs;
}

function titleFor(kind, id) {
  if (!id) return "(unknown)";
  if (!SESS_CACHE[kind][id]) listSessions(kind);
  const f = SESS_CACHE[kind][id];
  return f ? sessionTitle(kind, f) : "(" + String(id).slice(0, 8) + ")";
}
// A tandem is LIVE while its bridge is connected: the Claude daemon is alive holding
// this pair's session, OR there was activity in the last few minutes. When the bridge
// closes, the group stays in the list (idle) and remains resumable by its pair.
function serveAlive() {
  try {
    const pid = Number(read(SERVE_PID).trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
// mtime of a session's file = when it was last written = real "is it active" signal
function sessionMtime(kind, id) {
  if (!id) return 0;
  let f = SESS_CACHE[kind][id];
  if (!f) {
    listSessions(kind);
    f = SESS_CACHE[kind][id];
  }
  if (!f) return 0;
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}
function groupsList() {
  const g = readGroups(GROUPS);
  const claudeNow = read(CLAUDE_SESSION).trim();
  const codexNow = read(PEER_SESSION).trim();
  const alive = serveAlive();
  const now = Date.now();
  const out = Object.values(g.groups || {}).map((r) => {
    // LIVE = either of the pair's session files was written within the window (the
    // sessions are actively working) OR a recent delegation OR the daemon holds it.
    const activity = Math.max(r.lastTs || 0, r.firstTs || 0, sessionMtime("claude", r.claudeId), sessionMtime("codex", r.codexId));
    const recent = now - activity < LIVE_MS;
    const daemonLive = alive && r.claudeId && r.claudeId === claudeNow;
    return {
      n: r.n,
      claudeId: r.claudeId || null,
      codexId: r.codexId || null,
      direction: r.direction || "",
      label: r.label || "",
      lastTs: activity, // real activity (session mtime or last delegation) → correct live/sort
      live: recent || daemonLive,
      claudeTitle: titleFor("claude", r.claudeId),
      codexTitle: titleFor("codex", r.codexId),
    };
  });
  // Live synthesis: a fresh pair is "live" the instant a delegation happens, before the
  // group is fully recorded (codex id only known after the first turn). Build it from the
  // last tandem.log delegate + the current .state session ids, and merge with recorded.
  let lastDel = null;
  for (const l of read(TANDEM_LOG).split(/\r?\n/)) {
    if (!l.trim()) continue;
    try {
      const e = JSON.parse(l);
      if (e.type === "delegate") lastDel = e;
    } catch {
      /* ignore */
    }
  }
  if (lastDel && now - (lastDel.ts || 0) < LIVE_MS) {
    // Use the REAL ids the delegation recorded — NEVER "auto"/newest, which would glue the
    // wrong Claude to the wrong Codex (the immutable-pair violation). Each delegate event
    // carries driverId (the driving session) + partnerId (its coupled partner).
    let cId = null;
    let xId = null;
    if (lastDel.partner === "codex") {
      cId = lastDel.driverId || null; // the actual Claude driver
      xId = lastDel.partnerId || codexNow || null;
    } else if (lastDel.partner === "claude") {
      cId = lastDel.partnerId || claudeNow || null;
      xId = lastDel.driverId || null; // the actual Codex driver
    }
    // Only show a forming entry when we know BOTH halves of a real pair. If the delegate
    // predates id-logging, skip — the recorded (immutable) group surfaces it via mtime instead.
    if (cId && xId) {
      const match = out.find((r) => r.claudeId === cId && r.codexId === xId); // exact immutable pair
      if (match) {
        match.live = true;
        match.lastTs = Math.max(match.lastTs, lastDel.ts);
      } else {
        out.push({
          n: 0, // synthesized "forming" pair (not yet recorded)
          claudeId: cId,
          codexId: xId,
          direction: (lastDel.driver || "?") + "->" + (lastDel.partner || "?"),
          label: "forming…",
          lastTs: lastDel.ts,
          live: true,
          claudeTitle: titleFor("claude", cId),
          codexTitle: titleFor("codex", xId),
        });
      }
    }
  }
  return out.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.lastTs - a.lastTs);
}

// ---- Claude Code session transcript → messages ----
function parseClaudeTranscript(file, limit = 70) {
  const out = [];
  for (const line of read(file).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message || o;
    const role = m.role; // only real user/assistant messages (skip summary/queue/etc.)
    if (role !== "user" && role !== "assistant") continue;
    const isUser = role === "user";
    const pushText = (t) => {
      if (!t || !t.trim()) return;
      if (isUser) {
        if (!isSystemInjected(t)) out.push({ role: "input", text: clip(t, 4000) }); // what was typed in
      } else out.push({ role: "assistant", text: clip(t, 4000) });
    };
    const content = m.content;
    if (typeof content === "string") pushText(content);
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "text") pushText(c.text);
        else if (c.type === "thinking" && c.thinking?.trim()) out.push({ role: "reasoning", text: clip(c.thinking, 3000) });
        else if (c.type === "tool_use") out.push({ role: "tool", text: "→ " + c.name + " " + clip(JSON.stringify(c.input || {}), 200) });
        // tool_result intentionally omitted — too noisy for a thought view
      }
    }
  }
  return out.slice(-limit);
}

// ---- Codex rollout (~/.codex/sessions) → messages ----
function parseCodexRollout(file, limit = 70) {
  const out = [];
  for (const line of read(file).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const pl = o.payload || {};
    const t = pl.type;
    if (t === "user_message" && pl.message && pl.message !== "STDIN_OK") {
      if (!isSystemInjected(pl.message)) out.push({ role: "input", text: clip(pl.message, 4000) }); // what was sent to Codex
    } else if (t === "agent_message" && pl.message && pl.message !== "STDIN_OK") out.push({ role: "assistant", text: clip(pl.message, 4000) });
    else if ((t === "agent_reasoning" || t === "reasoning") && (pl.text || pl.message)) out.push({ role: "reasoning", text: clip(pl.text || pl.message, 3000) });
    else if (t === "function_call") {
      let cmd = "";
      try {
        cmd = JSON.parse(pl.arguments || "{}").command || "";
      } catch {
        cmd = pl.arguments || "";
      }
      if (Array.isArray(cmd)) cmd = cmd.join(" ");
      if (cmd) out.push({ role: "tool", text: "→ " + clip(String(cmd).replace(/\s+/g, " "), 200) });
    }
  }
  return out.slice(-limit);
}

function parseTimeline(limit = 40) {
  const out = [];
  for (const line of read(TANDEM_LOG).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }
  return out.slice(-limit);
}

// /state: just the live timeline + cwd (columns load via /session; groups via /groups)
function snapshot() {
  const c = cfg();
  return { ts: Date.now(), cwd: c.cwd || process.cwd(), timeline: parseTimeline() };
}

// ---- HTML ----
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>tandem · live</title>
<style>
  :root{--bg:#070708;--panel:#0d0d10;--line:rgba(255,205,222,.10);--rose:#ff6f9f;--rosesoft:#f0a4bd;
        --green:#7ee787;--greensoft:#bdf0c6;--muted:#8b8189;--text:#f2ecef;--gold:#e8c976;--cyan:#8ad7e0;}
  *{box-sizing:border-box} html,body{height:100%}
  [hidden]{display:none!important} /* must beat .overlay/.ddpop display:flex */
  body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 "Cascadia Code",Consolas,ui-monospace,monospace;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:14px;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
  header .brand{font-weight:700;letter-spacing:.5px}
  header .flow{color:var(--muted)} header .flow b{color:var(--rosesoft)}
  header .dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green)}
  header .right{margin-left:auto;color:var(--muted);font-size:12px}
  .cols{flex:1;display:flex;min-height:0}
  .col{flex:1;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--line)}
  .col:last-child{border-right:0}
  .col h2{margin:0;padding:7px 12px;font-size:12px;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}
  .col.claude h2{color:var(--rose)} .col.codex h2{color:var(--green)}
  .col h2 .tag{font-size:10px;color:var(--muted);text-transform:none;letter-spacing:0;margin-left:6px}
  .log{flex:1;overflow:auto;padding:10px 12px}
  .msg{margin:0 0 10px;white-space:pre-wrap;word-break:break-word;border-left:2px solid transparent;padding-left:8px}
  .msg .who{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:2px}
  .assistant{border-left-color:var(--line)}
  .input{border-left-color:var(--rose);background:rgba(255,111,159,.07);padding:7px 8px;border-radius:6px;color:#fff}
  .input .who{color:var(--rose)}
  .reasoning{color:var(--muted);font-style:italic}
  .tool{color:var(--cyan);font-size:12px}
  .user{color:#fff;border-left-color:var(--rosesoft)}
  .meta{color:var(--muted);font-size:11px}
  .verdict{border-left-color:var(--gold);background:rgba(232,201,118,.06);padding:8px;border-radius:6px}
  .verdict .who{color:var(--gold)}
  .timeline{height:150px;border-top:1px solid var(--line);background:var(--panel);overflow:auto;padding:8px 12px}
  .timeline h3{margin:0 0 6px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
  .tl{margin:0 0 5px;font-size:12px}
  .tl .delegate{color:var(--rosesoft)} .tl .verdict2{color:var(--green)}
  .tl .t{color:var(--muted);font-size:10px;margin-right:6px}
  .empty{color:var(--muted);padding:18px;font-style:italic}
  .more{color:var(--rosesoft);cursor:pointer;text-align:center;padding:6px;border:1px dashed var(--line);border-radius:6px;margin-bottom:8px;font-size:11px}
  .more:hover{border-color:var(--rosesoft);background:rgba(255,205,222,.05)}
  .picker{float:right;display:flex;gap:4px;align-items:center;font-weight:400}
  .picker select{background:#15151b;color:var(--text);border:1px solid var(--line);border-radius:5px;font:11px ui-monospace,monospace;min-width:200px;max-width:360px;padding:3px 12px 3px 8px}
  .picker button{background:#15151b;color:var(--muted);border:1px solid var(--line);border-radius:5px;cursor:pointer;padding:1px 7px;font-size:11px}
  .picker button:hover{color:var(--text);border-color:var(--rosesoft)}
  .gsel{background:#15151b;color:var(--rosesoft);border:1px solid var(--line);border-radius:6px;font:12px ui-monospace,monospace;min-width:300px;max-width:680px;padding:4px 14px 4px 10px}
  .cb{color:var(--muted);font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
  .cb input{accent-color:var(--rose);cursor:pointer}
  .starbtn{background:#15151b;color:var(--gold);border:1px solid var(--line);border-radius:6px;cursor:pointer;padding:3px 9px;font:12px ui-monospace,monospace}
  .starbtn:hover{border-color:var(--gold)}
  /* custom dropdown */
  .dd{position:relative;display:inline-block}
  /* native-select look, just bigger + with star/search/archive */
  .ddbtn{position:relative;background:#15151b;color:var(--text);border:1px solid var(--line);border-radius:6px;font:13px ui-monospace,monospace;padding:6px 30px 6px 12px;min-width:300px;max-width:520px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ddbtn:hover{border-color:var(--rosesoft)}
  .ddbtn::after{content:"▾";position:absolute;right:11px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:11px}
  .ddpop{position:absolute;z-index:50;top:34px;right:0;width:560px;max-height:64vh;display:flex;flex-direction:column;background:#0c0c10;border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 34px rgba(0,0,0,.65)}
  .ddtools{display:flex;gap:10px;align-items:center;padding:9px;border-bottom:1px solid var(--line)}
  .ddsearch{flex:1;background:#15151b;color:var(--text);border:1px solid var(--line);border-radius:6px;font:12px ui-monospace,monospace;padding:6px 9px}
  .ddlist{overflow:auto;padding:5px}
  .ddrow{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;cursor:pointer;font-size:13px}
  .ddrow:hover{background:rgba(255,205,222,.06)}
  .ddrow.sel{background:rgba(255,111,159,.12)}
  .ddrow .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ddrow .nm.custom{font-style:italic;color:var(--rosesoft)}
  .ddrow .dt{color:var(--muted);font-size:11px;white-space:nowrap}
  .ddrow .sid{color:var(--muted);font-size:10px;font-family:ui-monospace,monospace;opacity:.65;white-space:nowrap}
  .ddmore{color:var(--muted);font-size:11px;text-align:center;padding:6px;font-style:italic}
  .ddrow .st{color:#4a4a52;font-size:16px;cursor:pointer;padding:0 2px;opacity:0}
  .ddrow:hover .st,.ddrow .st.on{opacity:1}
  .ddrow .st.on{color:var(--gold)}
  .ddrow:hover .st{color:#7a6a4a}
  .ddrow:hover .st.on,.ddrow .st.on{color:var(--gold)}
  .ddrow.arch{opacity:.5}
  .ctxmenu{position:fixed;z-index:100;background:#15151b;border:1px solid var(--line);border-radius:7px;box-shadow:0 8px 30px rgba(0,0,0,.7);padding:4px;min-width:150px}
  .ctxmenu div{padding:6px 12px;border-radius:5px;cursor:pointer;font-size:12px;color:var(--text)}
  .ctxmenu div:hover{background:rgba(255,205,222,.08)}
  .overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
  .obox{width:min(900px,92vw);min-height:160px;max-height:82vh;display:flex;flex-direction:column;background:#0c0c10;border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .ohead{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);color:var(--gold);font-weight:700}
  .ohead button{background:none;border:0;color:var(--muted);font-size:18px;cursor:pointer}
  #starredlist{overflow:auto;padding:10px 16px}
  .scat{color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:1px;margin:10px 0 4px}
  .srow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12px}
  .srow:hover{background:rgba(255,205,222,.06)}
  .srow .nm.custom{font-style:italic;color:var(--rosesoft)}
  .srow .st{color:var(--gold)}
  .toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:300;background:#15151b;border:1px solid var(--rosesoft);color:var(--text);padding:8px 16px;border-radius:8px;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.6)}
  .newproj{display:flex;gap:8px;margin-bottom:14px}
  .newproj input{flex:1;background:#15151b;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:7px 10px;font:12px ui-monospace,monospace}
  .newproj button{background:#15151b;color:var(--rosesoft);border:1px solid var(--line);border-radius:6px;cursor:pointer;padding:7px 12px}
  .proj{margin-bottom:16px}
  .projhd{color:var(--rosesoft);font-weight:700;padding:4px 0 6px;border-bottom:1px solid var(--line);margin-bottom:4px;display:flex;justify-content:space-between;align-items:center}
  .projdel,.projrm{cursor:pointer;color:var(--muted);font-weight:400}
  .projdel:hover,.projrm:hover{color:var(--rose)}
  .srow .projrm{margin-left:auto}
</style></head><body>
<header>
  <span class="dot" id="dot"></span><span class="brand">tandem</span>
  <select id="gsel" class="gsel" title="live tandem groups"></select>
  <span class="flow" id="flow"></span>
  <label class="cb" title="show the prompts/inputs (what was said to each side)"><input type="checkbox" id="showprompts" checked> prompts</label>
  <button id="histbtn" class="starbtn" title="all tandems (history) — read any past pairing">⧉ tandems</button>
  <button id="projbtn" class="starbtn" title="projects — group chats into collections">📁 projects</button>
  <button id="starbtn" class="starbtn" title="view starred chats">★ <span id="starcount">0</span></button>
  <span class="right" id="right"></span>
</header>
<div class="cols">
  <div class="col claude"><h2>Claude <span class="tag" id="ctag"></span>
    <span class="picker"><button id="clink" title="copy deeplink to this chat">🔗</button><button id="cproj" title="add this chat to a project">📁</button><button id="cbump" title="bump up — resume + summarize to resurface an old chat">⤴</button><button id="cprev" title="previous session">◀</button>
      <div class="dd" id="dd-claude"><button class="ddbtn" id="ddbtn-claude">(auto · newest)</button>
        <div class="ddpop" id="ddpop-claude" hidden>
          <div class="ddtools"><input class="ddsearch" id="ddsearch-claude" placeholder="filter by name or id…">
            <label class="cb"><input type="checkbox" id="ddstaronly-claude"> ★</label>
            <label class="cb"><input type="checkbox" id="ddarch-claude"> arch</label></div>
          <div class="ddlist" id="ddlist-claude"></div></div>
      </div><button id="cnext" title="next session">▶</button></span>
  </h2><div class="log" id="claude"></div></div>
  <div class="col codex"><h2>Codex <span class="tag" id="xtag"></span>
    <span class="picker"><button id="xlink" title="copy deeplink to this chat">🔗</button><button id="xproj" title="add this chat to a project">📁</button><button id="xbump" title="bump up — resume + summarize to resurface an old chat">⤴</button><button id="xprev" title="previous session">◀</button>
      <div class="dd" id="dd-codex"><button class="ddbtn" id="ddbtn-codex">(auto · newest)</button>
        <div class="ddpop" id="ddpop-codex" hidden>
          <div class="ddtools"><input class="ddsearch" id="ddsearch-codex" placeholder="filter by name or id…">
            <label class="cb"><input type="checkbox" id="ddstaronly-codex"> ★</label>
            <label class="cb"><input type="checkbox" id="ddarch-codex"> arch</label></div>
          <div class="ddlist" id="ddlist-codex"></div></div>
      </div><button id="xnext" title="next session">▶</button></span>
  </h2><div class="log" id="codex"></div></div>
</div>
<div id="ctxmenu" class="ctxmenu" hidden></div>
<div id="starred" class="overlay" hidden><div class="obox"><div class="ohead">★ Starred chats <button id="starclose">✕</button></div><div id="starredlist"></div></div></div>
<div id="history" class="overlay" hidden><div class="obox"><div class="ohead">⧉ Tandem history — every pairing, readable after it closes <button id="histclose">✕</button></div><div id="historylist"></div></div></div>
<div id="projects" class="overlay" hidden><div class="obox"><div class="ohead">📁 Projects — group chats into collections <button id="projclose">✕</button></div><div id="projectslist"></div></div></div>
<div id="summary" class="overlay" hidden><div class="obox"><div class="ohead" id="summaryhd">⤴ Bumped — context summary <button id="summaryclose">✕</button></div><div id="summarytext" style="padding:16px;white-space:pre-wrap;overflow:auto"></div></div></div>
<div id="toast" class="toast" hidden></div>
<div class="timeline"><h3>tandem timeline — delegations &amp; verdicts</h3><div id="timeline"></div></div>
<script>
const esc=s=>(s||"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const $=id=>document.getElementById(id);
function near(el){return el.scrollHeight-el.scrollTop-el.clientHeight<80}
// Windowed transcript rendering: only a window of messages is loaded/rendered, with
// older pages fetched on scroll-up — so a 7000-message chat never blows up the browser.
const PAGE=200;
const win={claude:null,codex:null};        // {id,kind,total,start,msgs,sig}
const loadingOlder={claude:false,codex:false};
async function fetchWindow(kind,id,end,limit){
  let u="/session?kind="+kind+"&id="+encodeURIComponent(id)+"&limit="+(limit||PAGE);
  if(end!=null)u+="&end="+end;
  try{return await(await fetch(u,{cache:"no-store"})).json();}catch(e){return null;}
}
function renderWin(colId){
  const st=win[colId], el=$(colId);
  if(!st){el.innerHTML='<div class="empty">no session</div>';return;}
  const sp=$("showprompts").checked;
  const list=sp?st.msgs:st.msgs.filter(m=>m.role!=="input");
  const sig=sp+"|"+st.id+"|"+st.start+"|"+st.msgs.length+"|"+((list[list.length-1]||{}).text||"").slice(-40);
  if(st.sig===sig)return; st.sig=sig;
  const stick=near(el);
  let html=st.start>0?'<div class="more">▲ load '+st.start+' older messages (scroll up or click)</div>':'';
  html+=list.length?list.map(m=>'<div class="msg '+m.role+'"><div class="who">'+(m.role==="input"?"input ▸":m.role)+'</div>'+esc(m.text)+'</div>').join(""):'<div class="empty">no activity…</div>';
  el.innerHTML=html;
  if(stick)el.scrollTop=el.scrollHeight;
}
async function ensureCol(colId,kind,view,liveSet){
  if(view==="auto"){const l=sessions[kind];if(!l.length){win[colId]=null;renderWin(colId);return;}view=l[0].id;}
  const st=win[colId];
  if(!st||st.id!==view){ // switched session → load the latest window
    const r=await fetchWindow(kind,view,null,PAGE); if(!r)return;
    win[colId]={id:view,kind,total:r.total,start:r.start,msgs:r.messages,sig:""};
    renderWin(colId); $(colId).scrollTop=$(colId).scrollHeight; return;
  }
  if(liveSet.has(view)&&near($(colId))){ // following live at the bottom → refresh the tail
    const r=await fetchWindow(kind,view,null,Math.min(1000,Math.max(PAGE,st.msgs.length)));
    if(r){st.total=r.total;st.start=r.start;st.msgs=r.messages;renderWin(colId);}
  }
}
async function loadOlder(colId){
  const st=win[colId]; if(!st||st.start<=0||loadingOlder[colId])return;
  loadingOlder[colId]=true;
  const r=await fetchWindow(st.kind,st.id,st.start,PAGE);
  if(r&&r.messages.length){const el=$(colId);const pH=el.scrollHeight,pT=el.scrollTop;
    st.msgs=r.messages.concat(st.msgs);st.start=r.start;st.sig="";renderWin(colId);
    el.scrollTop=el.scrollHeight-pH+pT; // keep the reader's position
  }
  loadingOlder[colId]=false;
}
function fmtT(ts){try{return new Date(ts).toLocaleTimeString()}catch(e){return""}}

let sessions={claude:[],codex:[]}, groups=[], groupsSig="", pinned=false;
let follow=true, leaderKey=null, liveLeader=null; // auto-show the most-recent live tandem
const sh=s=>(s||"").slice(0,22);
const colSel={claude:"auto",codex:"auto"};
const ddOpen={claude:false,codex:false};
const ddF={claude:{q:"",star:false,arch:false},codex:{q:"",star:false,arch:false}};
function findS(kind,id){return sessions[kind].find(s=>s.id===id);}
function visS(kind){const f=ddF[kind];return sessions[kind].filter(s=>{
  if(s.archived&&!f.arch)return false;
  if(f.star&&!s.starred)return false;
  if(f.q){const t=((s.name||s.title||"")+" "+s.id).toLowerCase();if(!t.includes(f.q.toLowerCase()))return false;}
  return true;});}
function selLabel(kind){const v=colSel[kind];if(v==="auto")return"(auto · newest "+kind+")";const s=findS(kind,v);return s?(s.name||s.title||v.slice(0,8)):v.slice(0,8);}
function renderDropdown(kind){
  const btn=$("ddbtn-"+kind);btn.textContent=selLabel(kind);
  const cs=findS(kind,colSel[kind]);btn.style.fontStyle=(cs&&cs.name)?"italic":"normal";
  const vis=visS(kind);const CAP=1000;const shown=vis.slice(0,CAP);
  let html='<div class="ddrow'+(colSel[kind]==="auto"?" sel":"")+'" data-id="auto"><span class="nm">(auto · newest)</span></div>';
  html+=shown.map(s=>'<div class="ddrow'+(s.id===colSel[kind]?" sel":"")+(s.archived?" arch":"")+'" data-id="'+s.id+'" title="'+esc(s.id)+' — right-click to rename/star/archive/add-to-project/bump">'
    +'<span class="nm'+(s.name?" custom":"")+'">'+esc(s.name||s.title||"(session)")+'</span>'
    +'<span class="sid">'+esc(s.id.slice(0,8))+'</span>'
    +'<span class="dt">'+fmtT(s.mtime)+'</span>'
    +'<span class="st'+(s.starred?" on":"")+'" data-star="'+s.id+'" title="star">'+(s.starred?"★":"☆")+'</span></div>').join("");
  if(vis.length>CAP)html+='<div class="ddmore">+'+(vis.length-CAP)+' more — type a name or id to filter</div>';
  $("ddlist-"+kind).innerHTML=html;
}
function openDD(kind,on){ddOpen[kind]=on;$("ddpop-"+kind).hidden=!on;if(on)renderDropdown(kind);}
function applyGroup(g){colSel.claude=g.claudeId||"auto";colSel.codex=g.codexId||"auto";renderDropdown("claude");renderDropdown("codex");}
function updateStarCount(){$("starcount").textContent=sessions.claude.filter(s=>s.starred).length+sessions.codex.filter(s=>s.starred).length;}
const gKey=g=>g?g.n+"|"+g.claudeId+"|"+g.codexId:"";
function gLabel(g){const arrow=g.direction==="codex->claude"?" ◂ ":" ▸ "; // arrow points driver→partner
  return "Claude: "+sh(g.claudeTitle||"?")+arrow+"Codex: "+sh(g.codexTitle||"?")
    +(g.label&&g.label!=="forming…"?"  ["+g.label+"]":"")+(g.label==="forming…"?"  (forming…)":"");}
function fillGroups(){const sel=$("gsel");const cur=sel.value;
  // picker shows ONLY live/connected tandems — past/dead ones live in ⧉ tandems (history)
  const live=groups.filter(g=>g.live).sort((a,b)=>b.lastTs-a.lastTs);
  liveLeader=live[0]||null;
  let html=live.map(g=>'<option value="'+g.n+'">● '+esc(gLabel(g))+'</option>').join("");
  if(!live.length)html+='<option value="none" disabled>— no live tandem · start one, or browse ⧉ tandems —</option>';
  html+='<option value="manual">— manual / browse a session —</option>';
  sel.innerHTML=html;
  if(follow&&liveLeader){
    sel.value=String(liveLeader.n);
    if(leaderKey!==gKey(liveLeader)){leaderKey=gKey(liveLeader);applyGroup(liveLeader);}
  } else if(cur&&[...sel.options].some(o=>o.value===cur)) sel.value=cur;
  else sel.value=live.length?String(live[0].n):"manual";}
async function loadMeta(){try{
  sessions=await(await fetch("/sessions",{cache:"no-store"})).json();
  renderDropdown("claude");renderDropdown("codex");updateStarCount();
}catch(e){}}

async function tick(){
  try{const ng=await(await fetch("/groups",{cache:"no-store"})).json();
    const sig=JSON.stringify(ng.map(g=>[g.n,g.live,g.lastTs,g.codexId,g.claudeId]));
    if(sig!==groupsSig){groups=ng;groupsSig=sig;fillGroups();}
  }catch(e){}
  try{const s=await(await fetch("/state",{cache:"no-store"})).json();
    const gv=$("gsel").value, g=groups.find(x=>String(x.n)===gv);
    $("flow").innerHTML=g?("<b>tandem group "+g.n+"</b> · "+esc(g.label||g.direction||"")):"manual view";
    $("right").textContent=s.cwd;
    const cv=colSel.claude, xv=colSel.codex;
    const liveSet=new Set();
    groups.forEach(g=>{if(g.live){if(g.claudeId)liveSet.add(g.claudeId);if(g.codexId)liveSet.add(g.codexId);}});
    if(cv==="auto"&&sessions.claude[0])liveSet.add(sessions.claude[0].id);
    if(xv==="auto"&&sessions.codex[0])liveSet.add(sessions.codex[0].id);
    $("ctag").textContent=cv==="auto"?"(newest)":"("+cv.slice(0,8)+")";
    $("xtag").textContent=xv==="auto"?"(newest)":"("+xv.slice(0,8)+")";
    await ensureCol("claude","claude",cv,liveSet);
    await ensureCol("codex","codex",xv,liveSet);
    const tl=$("timeline");
    tl.innerHTML=s.timeline.length?s.timeline.slice().reverse().map(e=>{
      if(e.type==="delegate")return '<div class="tl"><span class="t">'+fmtT(e.ts)+'</span><span class="delegate">▸ '+esc(e.driver)+' → '+esc(e.partner)+':</span> '+esc((e.task||"").slice(0,160))+'</div>';
      if(e.type==="verdict")return '<div class="tl"><span class="t">'+fmtT(e.ts)+'</span><span class="verdict2">✓ '+esc(e.partner)+' ('+(e.durSec||0)+'s):</span> '+esc((e.verdict||"").replace(/\\s+/g," ").slice(0,160))+'</div>';
      return ""}).join(""):'<div class="empty">no delegations yet — run a tandem ask</div>';
    $("dot").style.background=(Date.now()-s.ts<4000)?"var(--green)":"var(--muted)";
  }catch(e){$("dot").style.background="var(--rose)"}
}
function step(kind,d){const vis=visS(kind);if(!vis.length)return;let i=vis.findIndex(s=>s.id===colSel[kind]);i=(i+d+vis.length)%vis.length;follow=false;colSel[kind]=vis[i].id;$("gsel").value="manual";renderDropdown(kind);tick();}
async function setMetaQ(kind,id,qs){try{await fetch("/setmeta?kind="+kind+"&id="+encodeURIComponent(id)+"&"+qs,{cache:"no-store"});}catch(e){}}
async function toggleStar(kind,id){const s=findS(kind,id);const on=!(s&&s.starred);await setMetaQ(kind,id,"op=star&on="+(on?1:0));if(s)s.starred=on;renderDropdown(kind);updateStarCount();}
function hideCtx(){$("ctxmenu").hidden=true;}
function showCtx(kind,id,x,y){const s=findS(kind,id)||{};const m=$("ctxmenu");
  m.innerHTML='<div data-act="rename">✎ Rename…</div>'
    +'<div data-act="star">'+(s.starred?"★ Unstar":"☆ Star")+'</div>'
    +'<div data-act="archive">'+(s.archived?"⊡ Unarchive":"⊟ Archive")+'</div>'
    +'<div data-act="link">🔗 Copy deeplink</div>'
    +'<div data-act="resume">⌨ Copy resume command</div>'
    +'<div data-act="proj">📁 Add to project…</div>'
    +'<div data-act="bump">⤴ Bump up (resurface)</div>';
  m.style.left=Math.min(x,innerWidth-200)+"px";m.style.top=Math.min(y,innerHeight-230)+"px";m.hidden=false;
  m.onclick=async(e)=>{const act=e.target.dataset.act;if(!act)return;
    if(act==="proj"){projectMenu(kind,id,e.clientX,e.clientY);return;}
    hideCtx();
    if(act==="rename"){const nm=prompt("Local name for this chat:",s.name||s.title||"");if(nm!==null){await setMetaQ(kind,id,"op=rename&name="+encodeURIComponent(nm));s.name=nm||undefined;renderDropdown(kind);}}
    else if(act==="star")toggleStar(kind,id);
    else if(act==="archive"){const on=!s.archived;await setMetaQ(kind,id,"op=archive&on="+(on?1:0));s.archived=on;renderDropdown(kind);}
    else if(act==="link")copyText(deeplink(kind,id),"deeplink copied");
    else if(act==="resume")copyText(resumeCmd(kind,id),"resume command copied");
    else if(act==="bump")doBump(kind,id);};}
const curId=kind=>colSel[kind]!=="auto"?colSel[kind]:((sessions[kind][0]||{}).id||"");
const deeplink=(kind,id)=>location.origin+"/?"+kind+"="+id;
const resumeCmd=(kind,id)=>kind==="claude"?("claude --resume "+id):("codex exec resume "+id);
let toastT;function toast(msg){const el=$("toast");el.textContent=msg;el.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>el.hidden=true,2400);}
function copyText(t,msg){if(navigator.clipboard)navigator.clipboard.writeText(t).then(()=>toast(msg||"copied"),()=>toast("copy failed"));else toast(t);}
async function doBump(kind,id){if(!id)return;toast("bumping "+kind+" "+id.slice(0,8)+" to the top…");
  try{const r=await(await fetch("/bump?kind="+kind+"&id="+encodeURIComponent(id),{cache:"no-store"})).json();
    if(r.ok){toast("✓ resurfaced "+kind+" "+id.slice(0,8)+" to the top");$("summaryhd").firstChild.textContent="⤴ Bumped "+kind+" "+id.slice(0,8)+" — context summary  ";$("summarytext").textContent=r.summary;$("summary").hidden=false;loadMeta();}
    else toast("bump failed: "+(r.error||"?"));}catch(e){toast("bump failed");}}
function projectMenu(kind,id,x,y){fetch("/projects",{cache:"no-store"}).then(r=>r.json()).then(p=>{const m=$("ctxmenu");
  const ent=Object.entries(p);
  m.innerHTML=(ent.length?ent.map(([pid,pr])=>'<div data-padd="'+pid+'">📁 '+esc(pr.name)+'</div>').join(""):'<div style="color:var(--muted);padding:6px 12px">no projects yet</div>')+'<div data-pnew="1">＋ New project…</div>';
  m.style.left=Math.min(x,innerWidth-200)+"px";m.style.top=Math.min(y,innerHeight-230)+"px";m.hidden=false;
  m.onclick=async(e)=>{const padd=e.target.dataset.padd,pnew=e.target.dataset.pnew;if(!padd&&!pnew)return;hideCtx();
    let pid=padd;
    if(pnew){const name=prompt("New project name:");if(!name)return;const r=await(await fetch("/project?op=create&name="+encodeURIComponent(name))).json();pid=r.id;}
    await fetch("/project?op=add&pid="+pid+"&kind="+kind+"&sid="+encodeURIComponent(id));toast("added to project");};});}
async function openProjects(){const p=await(await fetch("/projects",{cache:"no-store"})).json();const box=$("projectslist");
  const ent=Object.entries(p).sort((a,b)=>(b[1].created||0)-(a[1].created||0));
  box.innerHTML='<div class="newproj"><input id="newprojname" placeholder="new project name…"><button id="newprojbtn">＋ create</button></div>'
    +(ent.length?ent.map(([pid,pr])=>'<div class="proj"><div class="projhd"><span>📁 '+esc(pr.name)+'</span><span class="projdel" data-del="'+pid+'">🗑 delete</span></div>'
      +((pr.chats||[]).length?(pr.chats||[]).map(c=>{const s=findS(c.kind,c.id)||{};return '<div class="srow" data-kind="'+c.kind+'" data-id="'+c.id+'"><span class="st" style="color:'+(c.kind==="claude"?"var(--rose)":"var(--green)")+'">'+(c.kind==="claude"?"C":"X")+'</span><span class="nm'+(s.name?" custom":"")+'">'+esc(s.name||s.title||c.id.slice(0,8))+'</span><span class="projrm" data-rm="'+pid+'|'+c.kind+'|'+c.id+'">✕</span></div>';}).join(""):'<div class="empty">no chats — right-click a session → Add to project</div>')
      +'</div>').join(""):'<div class="empty">no projects yet — create one above</div>');
  $("projects").hidden=false;
  $("newprojbtn").onclick=async()=>{const n=$("newprojname").value.trim();if(!n)return;await fetch("/project?op=create&name="+encodeURIComponent(n));openProjects();};
  box.onclick=async(e)=>{const del=e.target.dataset.del;if(del){if(confirm("Delete this project? (chats are not deleted)")){await fetch("/project?op=delete&pid="+del);openProjects();}return;}
    const rm=e.target.dataset.rm;if(rm){const a=rm.split("|");await fetch("/project?op=remove&pid="+a[0]+"&kind="+a[1]+"&sid="+encodeURIComponent(a[2]));openProjects();return;}
    const row=e.target.closest(".srow");if(row&&row.dataset.id){follow=false;colSel[row.dataset.kind]=row.dataset.id;$("projects").hidden=true;$("gsel").value="manual";renderDropdown(row.dataset.kind);tick();}};}
function openStarred(){const box=$("starredlist");openDD("claude",false);openDD("codex",false);
  const sec=(kind)=>{const st=sessions[kind].filter(s=>s.starred);if(!st.length)return"";
    return '<div class="scat">'+kind+' ('+st.length+')</div>'+st.map(s=>'<div class="srow" data-kind="'+kind+'" data-id="'+s.id+'"><span class="st">★</span><span class="nm'+(s.name?" custom":"")+'">'+esc(s.name||s.title)+'</span><span class="dt">'+fmtT(s.mtime)+'</span></div>').join("");};
  box.innerHTML=(sec("claude")+sec("codex"))||'<div class="empty">no starred chats yet — click ☆ on any session</div>';
  $("starred").hidden=false;
  box.onclick=e=>{const row=e.target.closest(".srow");if(!row)return;follow=false;colSel[row.dataset.kind]=row.dataset.id;$("starred").hidden=true;$("gsel").value="manual";renderDropdown(row.dataset.kind);tick();};}
["claude","codex"].forEach(kind=>{
  $("ddbtn-"+kind).addEventListener("click",ev=>{ev.stopPropagation();openDD(kind,!ddOpen[kind]);});
  $("ddlist-"+kind).addEventListener("click",e=>{
    const star=e.target.closest(".st[data-star]");if(star){e.stopPropagation();toggleStar(kind,star.dataset.star);return;}
    const row=e.target.closest(".ddrow");if(!row)return;follow=false;colSel[kind]=row.dataset.id;openDD(kind,false);$("gsel").value="manual";renderDropdown(kind);tick();});
  $("ddlist-"+kind).addEventListener("contextmenu",e=>{const row=e.target.closest(".ddrow");if(!row||row.dataset.id==="auto")return;e.preventDefault();showCtx(kind,row.dataset.id,e.clientX,e.clientY);});
  $("ddsearch-"+kind).addEventListener("input",e=>{ddF[kind].q=e.target.value;renderDropdown(kind);});
  $("ddstaronly-"+kind).addEventListener("change",e=>{ddF[kind].star=e.target.checked;renderDropdown(kind);});
  $("ddarch-"+kind).addEventListener("change",e=>{ddF[kind].arch=e.target.checked;renderDropdown(kind);});
});
$("cprev").onclick=()=>step("claude",-1);$("cnext").onclick=()=>step("claude",1);
$("xprev").onclick=()=>step("codex",-1);$("xnext").onclick=()=>step("codex",1);
$("gsel").onchange=()=>{const v=$("gsel").value;const g=groups.find(x=>String(x.n)===v);
  follow=!!(g&&liveLeader&&g.n===liveLeader.n); // following only if you picked the current live leader
  if(g)applyGroup(g);tick();};
$("showprompts").onchange=()=>{if(win.claude){win.claude.sig="";renderWin("claude");}if(win.codex){win.codex.sig="";renderWin("codex");}};
function openHistory(){const box=$("historylist");openDD("claude",false);openDD("codex",false);
  box.innerHTML=groups.length?groups.map(g=>'<div class="srow" data-n="'+g.n+'"><span class="st" style="color:'+(g.live?"var(--green)":"var(--muted)")+'">'+(g.live?"●":"○")+'</span><span class="nm'+(g.label?" custom":"")+'">group '+g.n+' · '+esc(g.label||(sh(g.claudeTitle)+" ↔ "+sh(g.codexTitle)))+'</span><span class="dt">'+(g.live?"live · ":"")+fmtT(g.lastTs)+'</span></div>').join(""):'<div class="empty">no tandems yet</div>';
  $("history").hidden=false;
  box.onclick=e=>{const row=e.target.closest(".srow");if(!row)return;const n=row.dataset.n;const g=groups.find(x=>String(x.n)===n);if(g){follow=false;$("gsel").value=n;applyGroup(g);}$("history").hidden=true;tick();};}
$("starbtn").onclick=openStarred;
$("starclose").onclick=()=>$("starred").hidden=true;
$("starred").addEventListener("click",e=>{if(e.target===$("starred"))$("starred").hidden=true;}); // backdrop closes
$("histbtn").onclick=openHistory;
$("histclose").onclick=()=>$("history").hidden=true;
$("history").addEventListener("click",e=>{if(e.target===$("history"))$("history").hidden=true;});
$("projbtn").onclick=openProjects;
$("projclose").onclick=()=>$("projects").hidden=true;
$("projects").addEventListener("click",e=>{if(e.target===$("projects"))$("projects").hidden=true;});
$("summaryclose").onclick=()=>$("summary").hidden=true;
$("summary").addEventListener("click",e=>{if(e.target===$("summary"))$("summary").hidden=true;});
[["claude","c"],["codex","x"]].forEach(([kind,pre])=>{
  $(pre+"link").onclick=()=>{const id=curId(kind);if(id)copyText(deeplink(kind,id),"deeplink copied");else toast("no session");};
  $(pre+"proj").onclick=ev=>{const id=curId(kind);if(id)projectMenu(kind,id,ev.clientX,ev.clientY);};
  $(pre+"bump").onclick=()=>{const id=curId(kind);if(id)doBump(kind,id);else toast("no session");};
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){["starred","history","projects","summary"].forEach(o=>$(o).hidden=true);hideCtx();["claude","codex"].forEach(k=>openDD(k,false));}});
// deeplink: ?claude=<id>&codex=<id> preselects sessions
(function(){const q=new URLSearchParams(location.search);const c=q.get("claude"),x=q.get("codex");if(c){colSel.claude=c;pinned=true;follow=false;}if(x){colSel.codex=x;pinned=true;follow=false;}})();
$("claude").addEventListener("scroll",()=>{if($("claude").scrollTop<60)loadOlder("claude");});
$("codex").addEventListener("scroll",()=>{if($("codex").scrollTop<60)loadOlder("codex");});
$("claude").addEventListener("click",e=>{if(e.target.classList.contains("more"))loadOlder("claude");});
$("codex").addEventListener("click",e=>{if(e.target.classList.contains("more"))loadOlder("codex");});
document.addEventListener("click",e=>{["claude","codex"].forEach(kind=>{if(ddOpen[kind]&&!$("dd-"+kind).contains(e.target))openDD(kind,false);});if(!$("ctxmenu").contains(e.target))hideCtx();});
loadMeta().then(tick);setInterval(tick,1200);setInterval(loadMeta,10000);
</script></body></html>`;

const json = (res, obj) => {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/state") json(res, snapshot());
  else if (u.pathname === "/sessions") {
    const meta = readMeta();
    const enrich = (kind) => listSessions(kind).map((s) => ({ ...s, ...(meta[kind + ":" + s.id] || {}) }));
    json(res, { claude: enrich("claude"), codex: enrich("codex") });
  } else if (u.pathname === "/setmeta") {
    const kind = u.searchParams.get("kind") === "claude" ? "claude" : "codex";
    const id = u.searchParams.get("id") || "";
    const op = u.searchParams.get("op");
    const patch = {};
    if (op === "rename") patch.name = (u.searchParams.get("name") || "").slice(0, 80);
    else if (op === "star") patch.starred = u.searchParams.get("on") === "1";
    else if (op === "archive") patch.archived = u.searchParams.get("on") === "1";
    json(res, { ok: true, meta: id ? setMeta(kind, id, patch) : null });
  } else if (u.pathname === "/groups") json(res, groupsList());
  else if (u.pathname === "/projects") json(res, readProjects());
  else if (u.pathname === "/project") {
    const op = u.searchParams.get("op");
    const p = readProjects();
    const pid = u.searchParams.get("pid") || "";
    if (op === "create") {
      const id = newId();
      p[id] = { name: (u.searchParams.get("name") || "Untitled").slice(0, 60), chats: [], created: Date.now() };
      writeProjects(p);
      json(res, { ok: true, id });
    } else if (op === "rename" && p[pid]) {
      p[pid].name = (u.searchParams.get("name") || p[pid].name).slice(0, 60);
      writeProjects(p);
      json(res, { ok: true });
    } else if (op === "delete") {
      delete p[pid];
      writeProjects(p);
      json(res, { ok: true });
    } else if ((op === "add" || op === "remove") && p[pid]) {
      const kind = u.searchParams.get("kind") === "claude" ? "claude" : "codex";
      const sid = u.searchParams.get("sid") || "";
      p[pid].chats = (p[pid].chats || []).filter((c) => !(c.kind === kind && c.id === sid));
      if (op === "add" && sid) p[pid].chats.push({ kind, id: sid });
      writeProjects(p);
      json(res, { ok: true });
    } else json(res, { ok: false });
  } else if (u.pathname === "/bump") {
    const kind = u.searchParams.get("kind") === "claude" ? "claude" : "codex";
    const id = u.searchParams.get("id") || "";
    json(res, id ? await bump(kind, id) : { ok: false, error: "no id" });
  } else if (u.pathname === "/session") {
    // paginated: returns a window [start,end) of the full transcript + total
    const kind = u.searchParams.get("kind") === "claude" ? "claude" : "codex";
    const id = u.searchParams.get("id") || "";
    const full = sessionMessages(kind, id);
    const total = full.length;
    const limit = Math.min(Number(u.searchParams.get("limit")) || 200, 1000);
    let end = u.searchParams.get("end") != null ? Number(u.searchParams.get("end")) : total;
    if (!Number.isFinite(end)) end = total;
    end = Math.max(0, Math.min(end, total));
    const start = Math.max(0, end - limit);
    json(res, { kind, id, total, start, end, messages: full.slice(start, end) });
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  }
});

server.on("error", (e) => {
  console.error(`tandem watch: ${e.code === "EADDRINUSE" ? `port ${PORT} in use — try: node bin/watch.mjs <other-port>` : e.message}`);
  process.exit(1);
});

// Only stand up the server when run directly; importing this module (e.g. tests) just exposes
// its pure functions like groupsList.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`tandem watch → ${url}  (Ctrl+C to stop)`);
    if (process.env.TANDEM_NO_OPEN) return;
    const p = platform();
    try {
      if (p === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      else if (p === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* user can open manually */
    }
  });
}

export { groupsList };
