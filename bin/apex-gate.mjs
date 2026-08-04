// The apex context gate.
//
// WHY THIS SHAPE. A live campaign put an apex at 790,372 tokens against a 300,000 backstop with
// zero refreshes. The obvious reading — "the mind ignored its doctrine" — was wrong, and an
// adversarial review proved it: `partnerEnv` scrubs TANDEM_STATE/TANDEM_LABEL from the apex's own
// environment, and the Claude CLI re-sets CLAUDE_CODE_SESSION_ID inside its Bash children. So when
// the apex ran `fleet context` exactly as doctrine instructs, the state dir resolved to a
// directory that does not exist, the meter read 0, and `fleet refresh` was a silent no-op. The
// self-check verbs were dead from inside the session.
//
// Three consequences shaped everything here:
//
//  1. IDENTITY IS RECORDED, NEVER RE-DERIVED. Which lane, which ledger — stamped at spawn and read
//     back. Ambient-env derivation is what produced two apex bodies writing one ledger, each blind
//     to the other, and it is what would have made a "safety" check refuse a refresh the ledger
//     had already earned.
//  2. THE METER LIVES WHERE THE STREAM IS. serve holds exactly one session, wrote the stream, and
//     sees every turn from every dispatcher. Metering at a peer-side dispatch path reads a
//     per-turn file that is deleted moments later — one statement-ordering mistake from
//     certifying "under the limit" forever.
//  3. THE HARD LIMIT ACTUATES. It does not merely refuse — a refusal stalls an autonomous campaign
//     into a log nobody reads (measured: an hour of nudges logging "sent" into /dev/null) — and it
//     does not merely ASK, which is worse: the first version dumped correctly and then requested a
//     self-refresh from a mind at 320k, and 29 dead turns followed. So it injects a fixed
//     engine-authored dump turn (precedent: the T5 progress capture is already one), verifies the
//     ledger was written, and then the ENGINE performs the refresh itself. Fixed text is mechanism,
//     not judgment; the recovery is mechanism too, and belongs to nobody's judgment at all.
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// FIXED TEXT. The engine may compel externalization; it may never tell a mind what to conclude.
export const DUMP_PROMPT =
  "[ENGINE] Your context has passed the campaign's hard limit, so this turn is reserved: the " +
  "engine will refresh you (clear and reload from your ledger) immediately after it. Nothing you " +
  "have not written down survives.\n\n" +
  "Write out now, using `peer.mjs fleet note` and `peer.mjs fleet current`:\n" +
  "  - anything in flight: what you were doing, and the next concrete step\n" +
  "  - working hypotheses, and any you have RULED OUT (with the evidence that killed them)\n" +
  "  - calibrated distrust: which tools, signals or files you have learned not to believe\n" +
  "  - what you deliberately did NOT check\n" +
  "  - `fleet current` last, so orientation and verified state are the freshest thing on disk\n\n" +
  "Do no other work this turn. Reply DUMPED when the ledger is written.";

// ---- recorded identity ------------------------------------------------------------------------

export function recordBoundIdentity(boundFile, identity = {}) {
  let existing = {};
  try {
    existing = existsSync(boundFile) ? JSON.parse(readFileSync(boundFile, "utf8")) : {};
  } catch {
    existing = {};
  }
  const merged = {
    ...existing,
    stateDir: identity.stateDir || existing.stateDir || "",
    fleetDir: identity.fleetDir || existing.fleetDir || "",
    label: identity.label || existing.label || "",
    role: identity.role || existing.role || "",
  };
  const tmp = `${boundFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged));
  renameSync(tmp, boundFile); // a reader never sees a torn identity
  return merged;
}

export function readBoundIdentity(boundFile) {
  try {
    if (!existsSync(boundFile)) return {};
    const o = JSON.parse(readFileSync(boundFile, "utf8"));
    const out = {};
    for (const k of ["stateDir", "fleetDir", "label", "role"]) if (o[k]) out[k] = o[k];
    return out;
  } catch {
    return {}; // identity bookkeeping must never throw into a dispatch path
  }
}

// ---- self-location ------------------------------------------------------------------------------
// The gap that made the apex protocol dead from the inside. A partner session has its lane
// identity SCRUBBED from its environment (partnerEnv) and the CLI re-sets CLAUDE_CODE_SESSION_ID
// in its Bash children — so `fleet context` / `fleet refresh` run from inside the session derived
// a state dir from the session's OWN id, landed somewhere that does not exist, measured 0, and
// did nothing. Silently, for 790,000 tokens.
//
// Recorded identity makes the reverse lookup possible: serve writes its session id into its lane,
// so a session can ask "which lane am I?" and get a truthful answer. Returns found:false rather
// than guessing — a wrong directory is how one campaign ran two apex bodies against one ledger.
export function locateOwnLane(sessionId, lanesRoot) {
  const empty = { found: false, stateDir: "", fleetDir: "", label: "", role: "" };
  if (!sessionId || typeof sessionId !== "string") return empty;
  try {
    if (!existsSync(lanesRoot)) return empty;
    for (const entry of readdirSync(lanesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(lanesRoot, entry.name);
      const sessionFile = join(dir, "claude.session");
      if (!existsSync(sessionFile)) continue;
      let recorded = "";
      try {
        recorded = readFileSync(sessionFile, "utf8").trim();
      } catch {
        continue;
      }
      if (recorded !== sessionId) continue;
      const identity = readBoundIdentity(join(dir, "serve.bound.json"));
      return {
        found: true,
        stateDir: identity.stateDir || dir,
        fleetDir: identity.fleetDir || "",
        label: identity.label || entry.name,
        role: identity.role || "",
      };
    }
  } catch {
    /* locating is advisory; never throw into a command path */
  }
  return empty;
}

// ---- the gate -----------------------------------------------------------------------------------

export function meterNotice({ context = 0, threshold = 100_000, hard = 300_000 } = {}) {
  return (
    `[ENGINE] apex context ${context} tokens (refresh threshold ${threshold}, hard limit ${hard}). ` +
    "Reasoning degrades well before the window fills. Run `peer.mjs fleet refresh` at your next " +
    "clean seam — write anything unrecorded to the ledger first."
  );
}

// DID THE DUMP LAND? The engine believes the FILE, never the answer. A mind at 320k that replies
// "DUMPED" without writing anything would otherwise latch the gate permanently open — which is the
// exact shape of the failure this module exists to prevent, one level up.
export function ledgerWrittenSince(ledgerDir, sinceTs) {
  try {
    if (!ledgerDir) return false;
    const f = join(ledgerDir, "CURRENT.md");
    if (!existsSync(f)) return false;
    return statSync(f).mtimeMs > sinceTs;
  } catch {
    return false; // evidence-gathering must never throw into a dispatch path
  }
}

// ---- the pump breaker ---------------------------------------------------------------------------
//
// The heartbeat nudges whenever the lane is idle and has no idea whether the last nudge achieved
// anything. On the live incident that turned it into a pump: 29 nudges, 29 replies of "Nothing
// done. Same state.", zero tool calls between them. Context exhaustion was why it stalled that
// time; the context gate now handles that. A body reborn at 20k that stalls for any OTHER reason
// would pump just as long and trip no limit for hours.
//
// So a nudge loop gets a termination condition. One refresh — a stall is often degradation the
// meter has not caught yet, and a rebirth is cheap. If that does not take, PARK: refuse further
// dispatch, say so loudly, and wait for a human. Bounded, so it can never become a rebirth loop,
// which would just be a slower pump.
export function stallDecision({ idleStreak = 0, stallRefreshes = 0, threshold = 3, maxStallRefreshes = 1 } = {}) {
  if (idleStreak < threshold) return { action: "", reason: "" };
  if (stallRefreshes < maxStallRefreshes) {
    return {
      action: "refresh",
      reason: `${idleStreak} consecutive turns made no tool calls — refreshing this body once before parking the lane`,
    };
  }
  return {
    action: "park",
    reason: `${idleStreak} consecutive turns did no work after ${stallRefreshes} stall refresh(es) — parking the lane for a human`,
  };
}

// allow      — may the REQUESTED task run this turn? (false does not mean "stall": see action)
// action     — what the ENGINE must do: "" | "dump" | "refresh"
// injectDump — replace this turn with the fixed DUMP_PROMPT
// notice     — in-band text to prepend to the turn (never a console warning: the autonomous
//              dispatcher discards console output, which is how an hour of failures went unseen)
//
// THE BACKSTOP ACTUATES; IT DOES NOT ASK. The first version detected the limit correctly, injected
// the dump correctly, the apex complied correctly — and then the gate latched open and returned
// "allow, please refresh yourself" to a mind whose judgment was impaired by the very condition
// being detected. Twenty-nine turns and 86 minutes of zero-tool-call replies followed, ending only
// because a human intervened. Past the hard limit there is now NO dump state that yields an
// ordinary turn: every path terminates in a dump or a refresh, and the refresh is the engine's job.
export function apexGateDecision({
  role = "",
  context = 0,
  threshold = 100_000,
  hard = 300_000,
  dump = {},
  maxDumpAttempts = 2,
} = {}) {
  const base = { allow: true, action: "", injectDump: false, notice: "", unmeasured: false };
  if (role !== "apex") return { ...base, reason: "not an apex lane" };
  if (!context) {
    // An unmeasured turn is not a violation — but never silently certify "under the limit".
    return { ...base, unmeasured: true, reason: "no context reading yet for this session" };
  }
  if (context >= hard) {
    const attempts = Number(dump.attempts) || 0;
    const landed = dump.landed === true;
    if (attempts === 0) {
      return {
        ...base,
        allow: false,
        action: "dump",
        injectDump: true,
        prompt: DUMP_PROMPT,
        reason: `hard limit: context ${context} >= ${hard} — this turn is the engine's dump turn; refresh follows`,
      };
    }
    if (landed) {
      return {
        ...base,
        allow: false,
        action: "refresh",
        reason: `hard limit: context ${context} >= ${hard}, ledger written — refreshing this body now`,
      };
    }
    if (attempts < maxDumpAttempts) {
      // The mind answered but wrote nothing. Ask again rather than disarming: a gate that treats a
      // reply as compliance is a gate that can be talked out of firing.
      return {
        ...base,
        allow: false,
        action: "dump",
        injectDump: true,
        prompt: DUMP_PROMPT,
        reason: `hard limit: dump attempt ${attempts + 1}/${maxDumpAttempts} — the ledger was not written last turn`,
      };
    }
    // Out of attempts and still nothing on disk. Refresh anyway: unwritten state is lost either
    // way, and an endless burn loses it too — plus everything it costs to keep burning.
    return {
      ...base,
      allow: false,
      action: "refresh",
      reason: `hard limit: refreshing WITHOUT a landed dump after ${attempts} attempts — in-flight state was lost`,
    };
  }
  if (context >= threshold) {
    return { ...base, notice: meterNotice({ context, threshold, hard }), reason: "past the refresh threshold" };
  }
  return { ...base, reason: "under the threshold" };
}
