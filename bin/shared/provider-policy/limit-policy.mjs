// limit-policy.mjs — provider-limit awareness: detect the REAL limit/auth strings the
// claude and codex CLIs emit, classify them (a limit reroutes/parks; an auth failure must
// never be probe-un-parked), and parse the reset time they carry so a parked provider
// comes back exactly when its window rolls.
//
// Every pattern here is anchored to a message OBSERVED on this machine (transcripts /
// rollout files), not guessed:
//   claude 5h:    "You've hit your session limit · resets 3am (America/Edmonton)"
//                 "You've hit your session limit · resets 5:10pm (America/Edmonton)"
//   claude weekly:"You've hit your weekly limit · resets Jul 12, 10pm (America/Edmonton)"
//   claude API:   429 {"type":"error","error":{"type":"rate_limit_error","message":
//                 "This request would exceed your account's rate limit. Please try again later."}}
//   claude legacy:"Claude AI usage limit reached|<unix-epoch>"
//   codex:        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
//                  to purchase more credits or try again at May 30th, 2026 2:29 PM."
//
// A provider limit must NEVER be misread as a node failure: a failure burns retries, then
// escalates, then blocks — all silently wrong when the true cause is a capped subscription.

// Subscription/usage limits and hard quota/rate errors → park the provider until reset.
export const LIMIT_RE = new RegExp([
  /you'?ve (?:hit|reached) your [\w -]{0,24}limit/.source,   // session/weekly/usage/5-hour/opus…
  /usage limit\b/.source,
  /usage[_ ]limit[_ ]reached/.source,
  /usage_not_included/.source,
  /would exceed your (?:account'?s )?rate limit/.source,     // anthropic 429 message body
  /rate_limit_error/.source,                                 // anthropic 429 error type
  /quota (?:exceeded|exhausted|reached)/.source,
  /exceeded your current quota/.source,
  /insufficient.{0,25}credit/.source,
  /purchase more credits/.source,
  /rate.?limit(?:ed\b| exceeded| reached)/.source,
  /too many requests/.source,
  /limit reached\|\d{10}/.source,                            // legacy "usage limit reached|<epoch>"
].join('|'), 'i');

// Auth/credential failures → also park+reroute, but a usage probe must never un-park these
// (the probe proves usage headroom, not credentials).
export const AUTH_RE = new RegExp([
  /not logged in/.source,
  /invalid api key/.source,
  /no api key/.source,
  /401 unauthorized/.source,
  /authentication (?:failed|error)/.source,
  /oauth token .{0,24}(?:expired|revoked|invalid)/.source,
  /please run \/login/.source,
].join('|'), 'i');

// Combined matcher (transcript-tail scan; kept for conductor compatibility).
export const EXTERNAL_BLOCK_RE = new RegExp(`${LIMIT_RE.source}|${AUTH_RE.source}`, 'i');

// Classify a failure string: {kind:'limit'|'auth'} or null when it is an ordinary failure.
// LIMIT wins ties: mixed messages are overwhelmingly limit-shaped, and a mis-kinded auth
// error self-corrects (its probe fails on the same broken credentials, so no un-park).
export function classifyExternalFailure(text) {
  const s = String(text || '');
  if (LIMIT_RE.test(s)) return { kind: 'limit' };
  if (AUTH_RE.test(s)) return { kind: 'auth' };
  return null;
}

// Pull the offending line out of a transcript tail (prefers the embedded JSON "message").
export function extractExternalFailure(tail) {
  const s = String(tail || '');
  if (!EXTERNAL_BLOCK_RE.test(s)) return null;
  const line = s.split('\n').reverse().find(l => EXTERNAL_BLOCK_RE.test(l)) || s.match(EXTERNAL_BLOCK_RE)[0];
  const msg = (line.match(/"message"\s*:\s*"([^"]+)"/) || [null, line])[1];
  return msg.slice(0, 300).trim();
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const WEEK_CAP_MS = 8 * 86_400_000;   // longest believable park: a weekly window + slack

// Parse WHEN the provider comes back, from the reset wording the message carries.
// Handles every observed format; unknown wording falls back to 1h (the guard and the usage
// probes re-check, so a conservative park can only delay, never strand).
export function parseResetTime(msg, now = Date.now()) {
  const s = String(msg);
  const plausible = t => t > now && t - now <= WEEK_CAP_MS;

  // 1) unix epoch seconds: "usage limit reached|1753142400", "resets_at":1783743297
  let m = s.match(/(?:limit reached\||resets?_at["\s:]{1,4})(\d{10})\b/i);
  if (m) {
    const t = +m[1] * 1000;
    if (plausible(t)) return t;
    if (t <= now) return now + 2 * 60_000;   // stated reset already passed → probe shortly
  }

  // 2) explicit date-time: "resets 2026-07-05 22:00 America/Edmonton", ISO "2026-07-11T00:10:00Z"
  m = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z)?/);
  if (m) {
    const t = m[6]
      ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:00Z`)
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime();
    if (plausible(t)) return t;
    if (t <= now) return now + 2 * 60_000;
  }

  // 3) month-day: "resets Jul 12, 10pm" / "try again at May 30th, 2026 2:29 PM"
  m = s.match(/(?:resets?|try again|available|back)\s+(?:at\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?,?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i);
  if (m) {
    let hr = +m[4];
    const min = +(m[5] || 0);
    const ap = m[6].toLowerCase();
    if (ap === 'p' && hr < 12) hr += 12;
    if (ap === 'a' && hr === 12) hr = 0;
    const mon = MONTHS[m[1].toLowerCase()];
    let year = m[3] ? +m[3] : new Date(now).getFullYear();
    let t = new Date(year, mon, +m[2], hr, min, 0, 0).getTime();
    if (!m[3] && t <= now) t = new Date(year + 1, mon, +m[2], hr, min, 0, 0).getTime();  // Dec→Jan rollover
    if (plausible(t)) return t;
    if (t <= now) return now + 2 * 60_000;
  }

  // 4) bare clock time: "resets 3am" / "resets 5:10pm" / "try again at 4:26 PM" / "back at 22:30"
  //    (requires minutes or am/pm so loose digits never read as a time)
  m = s.match(/(?:try again|resets?|available|back)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
  if (m && (m[2] !== undefined || m[3])) {
    let hr = +m[1];
    const min = +(m[2] || 0);
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && hr < 12) hr += 12;
    if (ap === 'am' && hr === 12) hr = 0;
    const d = new Date(now);
    d.setHours(hr, min, 0, 0);
    let t = d.getTime();
    if (t <= now) {
      if (now - t <= 15 * 60_000) return now + 2 * 60_000;   // reset just passed → probe shortly
      t += 24 * 3600_000;                                    // "resets 3am" said at 4pm = TOMORROW 3am
    }
    if (t - now > 26 * 3600_000) return now + 3600_000;      // implausible for a clock-only reset (tz skew?)
    return t;
  }

  // 5) relative: "try again in 3 hours 25 minutes" / "try again in 45 minutes"
  m = s.match(/try again in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (m && (m[1] || m[2])) {
    return Math.min(now + (+(m[1] || 0)) * 3600_000 + (+(m[2] || 0)) * 60_000, now + WEEK_CAP_MS);
  }

  return now + 3600_000;   // unknown wording → 1h, then the guard/probes re-check
}
