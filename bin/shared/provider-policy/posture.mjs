// posture.mjs — the ONE headless-partner approval posture both tools ship for a Claude
// child: never stop to ask a human who isn't there. orch injects it via config
// (orchestrate.config.json posture.claude); tandem's serve daemon hard-codes the same
// flag — both now reference this constant so the value has a single source of truth.
// Codex posture intentionally has no constant here: both tools defer to ~/.codex/config.toml.
export const CLAUDE_HEADLESS_POSTURE = '--dangerously-skip-permissions';
