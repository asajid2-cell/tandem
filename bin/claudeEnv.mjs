// Subscription-billing guard for a Claude partner (verified via deep research).
// If ANY of the API_ROUTING_VARS is present, Claude Code bills the per-token API even
// when logged into a subscription — and in headless/non-interactive use it does
// so SILENTLY. So we scrub them from the partner's environment, forcing auth via
// the claude.ai OAuth subscription. CLAUDE_CODE_OAUTH_TOKEN is a SUBSCRIPTION
// token and is preserved.
//
// The scrub list + its helpers now live in the shared, vendored provider-policy package
// (bin/shared/provider-policy/partner-env.mjs) so orch and tandem share ONE source of truth
// for the billing guard — see that file for the full rationale. They are re-exported here so
// every existing tandem import (`from "./claudeEnv.mjs"`) keeps working unchanged. Only the
// tandem-SPECIFIC lane-identity concepts (LANE_IDENTITY_VARS + partnerEnv) stay local, because
// they describe tandem lanes, not the cross-tool provider policy.
export { API_ROUTING_VARS, scrubbedClaudeEnv, apiRoutingVarsPresent } from "./shared/provider-policy/partner-env.mjs";

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
  // identity of THIS session — inherited, it makes a child claim its parent's role in the brand,
  // the sessions manifest and the fleet tree (measured: a branch mind inheriting "apex")
  "TANDEM_ROLE",
  "TANDEM_SELF_ID",
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
  // LINEAGE is inherited even though IDENTITY is not: whoever spawns becomes the child's parent,
  // so a mind forked by this lane hangs under it in the fleet tree instead of becoming a root.
  const parent = base.TANDEM_SELF_ID || base.TANDEM_LANE_ID || "";
  for (const k of LANE_IDENTITY_VARS) delete out[k];
  if (parent) out.TANDEM_PARENT_ID = parent;
  out.TANDEM_NESTED_AGENT = "1";
  return out;
}
