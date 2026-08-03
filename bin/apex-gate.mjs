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
//  3. THE HARD LIMIT INJECTS, IT DOES NOT REFUSE. A refusal stalls an autonomous campaign into a
//     log nobody reads (measured: an hour of nudges logging "sent" into /dev/null). Injecting a
//     fixed engine-authored turn has precedent in this very daemon — the T5 progress capture
//     (CAPTURE_PROMPT) is an engine-authored turn already. Fixed text is mechanism, not judgment.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// ---- the gate -----------------------------------------------------------------------------------

export function meterNotice({ context = 0, threshold = 100_000, hard = 300_000 } = {}) {
  return (
    `[ENGINE] apex context ${context} tokens (refresh threshold ${threshold}, hard limit ${hard}). ` +
    "Reasoning degrades well before the window fills. Run `peer.mjs fleet refresh` at your next " +
    "clean seam — write anything unrecorded to the ledger first."
  );
}

// allow      — may the requested task run this turn?
// injectDump — replace this turn with the fixed DUMP_PROMPT (once per cycle)
// notice     — in-band text to prepend to the turn (never a console warning: the autonomous
//              dispatcher discards console output, which is how an hour of failures went unseen)
export function apexGateDecision({
  role = "",
  context = 0,
  threshold = 100_000,
  hard = 300_000,
  dumpedThisCycle = false,
} = {}) {
  if (role !== "apex") return { allow: true, injectDump: false, notice: "", unmeasured: false, reason: "not an apex lane" };
  if (!context) {
    // An unmeasured turn is not a violation — but never silently certify "under the limit".
    return { allow: true, injectDump: false, notice: "", unmeasured: true, reason: "no context reading yet for this session" };
  }
  if (context >= hard) {
    if (!dumpedThisCycle) {
      return {
        allow: false,
        injectDump: true,
        prompt: DUMP_PROMPT,
        notice: "",
        unmeasured: false,
        reason: `hard limit: context ${context} >= ${hard} — this turn is the engine's dump turn; refresh follows`,
      };
    }
    // The dump already ran this cycle. Do NOT inject again (that is how a gate becomes a loop);
    // let work proceed so the refresh can be performed.
    return {
      allow: true,
      injectDump: false,
      notice: meterNotice({ context, threshold, hard }) + " The dump for this cycle has already run — refresh now.",
      unmeasured: false,
      reason: "dump already taken this cycle",
    };
  }
  if (context >= threshold) {
    return { allow: true, injectDump: false, notice: meterNotice({ context, threshold, hard }), unmeasured: false, reason: "past the refresh threshold" };
  }
  return { allow: true, injectDump: false, notice: "", unmeasured: false, reason: "under the threshold" };
}
