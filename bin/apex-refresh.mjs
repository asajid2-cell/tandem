// The refresh PRIMITIVE — the mechanism behind clear-and-reload.
//
// None of the pre-existing commands is this primitive:
//   `stop`    is the ANTI-primitive: the session persists and the next ask RESUMES it warm,
//             reloading the very context the refresh exists to shed.
//   `compact` has the right teardown but seeds the successor from the dying session's own
//             narration — the generation-loss path being replaced.
//   `new`     is the right forget, but it is gated by refuseLaneMutationWhileActive, and the hard
//             backstop fires precisely when lanes ARE active — so as coded the backstop could
//             never execute.
//
// refresh = compact's teardown, MINUS the seed, PLUS seat succession, PLUS a lane-guard bypass
// that only the backstop may use and only after a dump turn.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSession } from "./fleet-registry.mjs";
import { refreshDecision } from "./apex-memory.mjs";

// What a refresh actually performs, in order. "dump" externalizes in-flight state BEFORE a
// mid-sweep clear; "rehydrate-on-next-ask" is deliberately last and deliberately lazy — the brief
// is DERIVED from the ledger when the next ask happens, never written to a seed file that can be
// consumed once and lost if that first turn fails.
const SEAM_STEPS = ["dump-skip", "stop-daemon", "forget-session", "mark-detached", "succeed-seat", "rehydrate-on-next-ask"];
const BACKSTOP_STEPS = ["dump", "stop-daemon", "forget-session", "mark-detached", "succeed-seat", "rehydrate-on-next-ask"];

export function planRefresh(opts = {}) {
  const d = refreshDecision(opts);
  if (!d.refresh) {
    return { act: false, defer: !!d.defer, bypassLaneGuard: false, dumpFirst: false, steps: [], reason: d.reason, warning: d.warning || "" };
  }
  const backstop = !!d.requiresDump;
  return {
    act: true,
    defer: false,
    // ONLY the backstop may proceed while lanes are live. A seam refresh has no lanes to guard
    // against, so it never needs the bypass — which keeps the dangerous path narrow and named.
    bypassLaneGuard: backstop,
    dumpFirst: backstop,
    steps: backstop ? [...BACKSTOP_STEPS] : [...SEAM_STEPS],
    reason: d.reason,
    warning: d.warning || "",
  };
}

// ---- seat succession -------------------------------------------------------------------------
// FLEET-DESIGN §6 says the apex seat is "a resumable identity, not a process". A refresh gives the
// seat a new BODY (session id) while the SEAT id stays put, so `fleet tree` does not fracture and
// stale pairing records can be spotted rather than silently re-coupling a driver to a dead mind.

function seatFile(dir) {
  return join(dir, "seats.json");
}

function readSeats(dir) {
  try {
    const f = seatFile(dir);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { version: 1, seats: {} };
  } catch {
    return { version: 1, seats: {} };
  }
}

function writeSeats(dir, value) {
  mkdirSync(dir, { recursive: true });
  const file = seatFile(dir);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function succeedSeat(dir, seatId, sessionId) {
  if (!seatId || !sessionId) return null;
  try {
    // an unknown seat is not fatal — succession is bookkeeping, never a gate on a refresh
    const known = getSession(dir, seatId);
    const store = readSeats(dir);
    const seat = store.seats[seatId] || { sessions: [], registered: !!known };
    if (seat.sessions[seat.sessions.length - 1] !== sessionId) seat.sessions.push(sessionId);
    seat.registered = !!known;
    store.seats[seatId] = seat;
    writeSeats(dir, store);
    return seat;
  } catch {
    return null; // identity bookkeeping must never break a refresh
  }
}

export function seatHistory(dir, seatId) {
  const seat = readSeats(dir).seats[seatId] || { sessions: [] };
  return {
    sessions: seat.sessions,
    current: seat.sessions[seat.sessions.length - 1] || "",
    rebirths: Math.max(0, seat.sessions.length - 1),
  };
}

// ---- auto-compact detection -------------------------------------------------------------------
// Prevention is not enough because the failure is INVISIBLE by construction: if the CLI compacts
// first, context DROPS, so the refresh trigger never fires and the session quietly becomes a
// summary of a summary — precisely what this design exists to prevent. So the bridge must be able
// to SEE it and record an invariant violation.

export const COMPACT_MARKERS = ["compact_boundary", "compact_metadata", "conversation was compacted", "context low · compact"];

// A context fall of this fraction between consecutive calls is not normal accumulation.
const DROP_RATIO = 0.5;
const DROP_FLOOR = 50_000; // ignore small sessions where a drop is meaningless

export function detectCompactBoundary(streamText) {
  const text = typeof streamText === "string" ? streamText : "";
  if (!text) return { compacted: false, evidence: "" };
  for (const marker of COMPACT_MARKERS) {
    if (text.includes(marker)) return { compacted: true, evidence: `compaction marker in stream: ${marker}` };
  }
  // belt and braces — an unexplained cliff in context is itself evidence
  let prev = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "assistant" || !o.message?.usage) continue;
    const u = o.message.usage;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (prev >= DROP_FLOOR && ctx < prev * DROP_RATIO) {
      return { compacted: true, evidence: `unexplained context drop ${prev} -> ${ctx} mid-session` };
    }
    prev = ctx;
  }
  return { compacted: false, evidence: "" };
}
