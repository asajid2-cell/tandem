// Session branding — every session the bridge starts announces itself in its FIRST message.
//
// Why: bridge-spawned workers (codex partner sessions, claude partner daemons, swarm lanes) show
// up in the owner's chat backlogs as anonymous 1–2 message sessions and drown the real history.
// Chat tooling titles a session from its first message, so a stable machine-greppable first line
// makes the whole fleet filterable everywhere at once — and a sessions manifest maps provider
// session ids to their tandem identity so tools can hide by ID without content parsing.
//
// The brand prefix below is a STABLE public contract for filters; never reword it casually.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultFleetDir } from "./fleet-inbox.mjs";

export const BRAND_PREFIX = "[TANDEM";

export function brandLine({ kind = "session", label = "", laneId = "" } = {}) {
  const parts = [`${BRAND_PREFIX} ${kind}`];
  if (label) parts.push(`label=${label}`);
  if (laneId) parts.push(`lane=${laneId}`);
  return `${parts.join(" ")} — bridge-managed worker session; safe to filter from chat backlogs]`;
}

// Prepend the brand as the very first line of a session's FIRST message. Idempotent: a task that
// already carries a brand line is returned untouched (re-dispatch, seed-prepend paths).
export function brandTask(task, opts = {}) {
  const text = String(task ?? "");
  if (text.startsWith(BRAND_PREFIX)) return text;
  return `${brandLine(opts)}\n${text}`;
}

export function sessionsManifestPath(dir = defaultFleetDir()) {
  return join(dir, "sessions.jsonl");
}

// Advisory manifest: {ts, provider: "claude"|"codex", sessionId, kind, label, laneId, cwd}.
// A failed append must never break a spawn.
export function recordSpawnedSession(rec, dir = defaultFleetDir()) {
  try {
    mkdirSync(dir, { recursive: true });
    const record = { ts: Date.now(), ...rec };
    appendFileSync(sessionsManifestPath(dir), `${JSON.stringify(record)}\n`);
    return record;
  } catch {
    return null;
  }
}

export function readSpawnedSessions(lastN = 0, dir = defaultFleetDir()) {
  const file = sessionsManifestPath(dir);
  if (!existsSync(file)) return [];
  const records = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* torn tail line mid-append — skip */
    }
  }
  return lastN > 0 ? records.slice(-lastN) : records;
}
