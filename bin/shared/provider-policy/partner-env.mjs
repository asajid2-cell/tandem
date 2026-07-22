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
