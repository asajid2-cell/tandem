// limit-signals.mjs — the GATE between "the partner MENTIONED a limit" and "the provider IS
// limited". The shared provider-policy patterns (LIMIT_RE/AUTH_RE) are deliberately loose —
// they were built to scan CLI failure output, where any hit is real. Running them over the
// partner's ANSWER text is fundamentally wrong: a model that merely discusses limit banners
// (e.g. a lane building this very feature, printing "resets 3am" in its verdict) would be
// classified as a real limit and park a healthy provider. That exact false park happened in
// production (claude at 35% usage, parked by its own answer text).
//
// A provider limit must be EVIDENCED by a genuine CLI failure signal:
//   1. The partner PROCESS failed (nonzero exit / died) and the banner is on its stderr /
//      captured error channel — the model's answer never lands there, so the loose patterns
//      are safe. (This gate also protects against transient 429 RETRY notices both CLIs print
//      to stderr on turns that ultimately SUCCEED — a surviving turn is never classified.)
//   2. The exit-0 silent-failure shape: the CLI returns the limit banner AS its entire result.
//      Matched ONLY by strict whole-result patterns — start-anchored to the exact phrasings
//      the CLIs emit, single line, bounded length — which prose that quotes or discusses
//      those strings mid-answer can never satisfy.
// When neither signal holds, prefer FALSE-NEGATIVE: a missed limit resurfaces as an ordinary
// error on the next ask; a false park kills productive lanes.

// The whole-result banners, each anchored to a message OBSERVED from the real CLIs (see
// limit-policy.mjs header for provenance). The surrounding gate (single line, <=300 chars,
// trimmed) is part of the match: a multi-line or prose-embedded occurrence never qualifies.
const WHOLE_BANNER_RES = [
  // claude 5h/weekly/opus: "You've hit your session limit · resets 3am (America/Edmonton)"
  // codex: "You've hit your usage limit. Visit https://…/usage to purchase more credits or try again at May 30th, 2026 2:29 PM."
  /^you'?ve (?:hit|reached) your [\w -]{0,24}limit\b/i,
  // legacy claude: "Claude AI usage limit reached|1753142400"
  /^claude ai usage limit reached\|\d{10}$/i,
  // anthropic 429 error body returned verbatim as the ENTIRE result
  /^(?:4\d\d\s+)?\{"type":"error","error":\{"type":"rate_limit_error",[^\n]*\}\}$/i,
  // claude auth shapes the CLI emits as its whole result
  /^invalid api key(?:\s*·\s*please run \/login)?$/i,
  /^please run \/login\b[^\n]{0,60}$/i,
  /^not logged in\b[^\n]{0,60}$/i,
];

// The trimmed message IFF it is a whole-result CLI banner, else null.
export function wholeResultBanner(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 300 || s.includes("\n")) return null;
  return WHOLE_BANNER_RES.some((re) => re.test(s)) ? s : null;
}

// Classify a provider limit/auth failure from GENUINE CLI evidence only.
//   finalMessage — the partner's final answer (res.verdict / the stream's result payload);
//                  ONLY ever strict whole-result matched, never loose-scanned.
//   stderrTail   — the CLI's own stderr / captured error channel; loose-scanned ONLY when
//                  exitFailed (the process genuinely failed).
//   exitFailed   — the partner process exited nonzero or died.
// Returns {msg, kind:'limit'|'auth'} or null. NO default kind: an unclassifiable message is
// NOT a limit.
export function classifyProviderSignal(policyObj, { finalMessage, stderrTail, exitFailed } = {}) {
  let msg = exitFailed ? policyObj.extractFailure(String(stderrTail || "").slice(-4000)) : null;
  if (!msg) {
    const whole = wholeResultBanner(finalMessage);
    if (whole) msg = policyObj.extractFailure(whole) || whole;
  }
  if (!msg) return null;
  const kind = policyObj.classify(msg)?.kind;
  return kind ? { msg: msg.slice(0, 300), kind } : null;
}
