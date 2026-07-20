// Subscription-billing guard for a Claude partner (verified via deep research).
// If ANY of these env vars is present, Claude Code bills the per-token API even
// when logged into a subscription — and in headless/non-interactive use it does
// so SILENTLY. So we scrub them from the partner's environment, forcing auth via
// the claude.ai OAuth subscription. CLAUDE_CODE_OAUTH_TOKEN is a SUBSCRIPTION
// token and is preserved.

export const API_ROUTING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_AZURE",
];

export function scrubbedClaudeEnv(base) {
  const out = { ...base };
  for (const k of API_ROUTING_VARS) delete out[k];
  return out;
}

export function apiRoutingVarsPresent(base) {
  return API_ROUTING_VARS.filter((k) => base[k] !== undefined && base[k] !== "");
}

// Lane-identity vars describe THIS lane (its state dir, label, partner/model
// binding) and the DRIVER's session — not the partner agent spawned into it.
// If they leak into a partner's environment, every `peer.mjs ask` the partner
// runs from a tool call resolves to the PARENT's own lane: ensureClaudeDaemon
// finds the lane's own daemon alive and silently relays the "new" task into the
// caller's own session (self-injection) — no sub-lane is ever spawned, so the
// job-escape path never even runs. The partner is a fresh actor: it keeps the
// nested-agent marker (so ITS spawns job-escape) and the shared project cwd,
// but derives its own lane identity from its own session.
export const LANE_IDENTITY_VARS = [
  "TANDEM_STATE",
  "TANDEM_LABEL",
  "TANDEM_LANE_ID",
  "TANDEM_PARTNER",
  "TANDEM_MODEL",
  "TANDEM_EFFORT",
  "TANDEM_TIER",
  // driver-session ids: they name the DRIVER of this lane; inherited, they
  // would couple a partner's own sub-lanes to the wrong driver/state
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_CONVERSATION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
];

// Environment for spawning a PARTNER agent (serve's claude child, the codex
// exec worker, interactive attach): lane identity scrubbed, nested marker on.
export function partnerEnv(base) {
  const out = { ...base };
  for (const k of LANE_IDENTITY_VARS) delete out[k];
  out.TANDEM_NESTED_AGENT = "1";
  return out;
}
