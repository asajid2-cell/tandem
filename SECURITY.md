# Security

tandem drives a second coding agent **unattended** — by design, the *partner* agent runs
with approvals disabled so it never deadlocks waiting for a human:

- **Codex partner:** your `~/.codex/config.toml` never-ask setting, or `posture: "yolo"`
  (`--dangerously-bypass-approvals-and-sandbox`).
- **Claude partner:** `--dangerously-skip-permissions` (bypass mode).

This means the partner can run shell commands and edit files without prompting. Run tandem
**only** on machines and projects you control, ideally where the agent's own sandbox/config
still bounds what it may do. The `yolo` / bypass postures remove that bound — use them only
when you accept full responsibility for what the partner executes.

## What is NOT in this repo

The bridge keeps all per-session state under `.state/` (session ids, transcripts, verdicts,
the daemon pid) and your machine paths in `tandem.config.json`. Both are `.gitignore`d and are
**not** part of this repository. Nothing tandem records is sent anywhere — the watcher is a
local, read-only dashboard that tails files on your own machine.

## Reporting

This is a personal/educational tool with no support guarantee. If you find a security issue,
open an issue describing it (without including any private data from your own sessions).
