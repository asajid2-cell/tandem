# Dual-drive from a Codex session (Codex driver → Claude partner)

Codex doesn't read Claude Code skills, so to make a **Codex** session dual-driven, give it
these instructions (paste into the task, or add to your `AGENTS.md`). The partner is **Claude**,
running as a **persistent, resumable session** on the **subscription** (never the API), in **bypass**
mode (never stops). It is NOT an ephemeral subagent — it's a continuous session you keep open and
can reopen anytime, continuing the same conversation across turns.

## Setup (once)
- `tandem.config.json` → set `claudeBin` to your Claude Code binary.
- **No API:** the bridge scrubs `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `CLAUDE_CODE_USE_*` from the partner env → `apiKeySource: none` (claude.ai OAuth subscription
  only). Keep "usage credits" OFF for an absolute no-API guarantee.
- **No stop:** the partner runs headless with `--dangerously-skip-permissions` (bypass) — no prompts.
- **Persistent + resumable:** `serve` holds one open `claude -p --input-format stream-json` session
  with its own dedicated, persisted session id (separate from your main Claude chats). Closing it
  (`stop`) keeps the id; reopening resumes the exact same session — even across reboots.

## How Codex uses the partner

Set `TANDEM_PARTNER=claude`. The first `ask` auto-opens the persistent session; later `ask`s reuse
it (full context). Each `ask` prints Claude's verdict.

```bash
# (optional) open it explicitly in a side terminal so you can watch it:
TANDEM_PARTNER=claude node /path/to/tandem/bin/peer.mjs serve

# converse with the OPEN session, turn after turn:
TANDEM_PARTNER=claude node /path/to/tandem/bin/peer.mjs ask "<scoped task for the Claude partner>"
TANDEM_PARTNER=claude node /path/to/tandem/bin/peer.mjs ask --bg "<long task>"   # background
TANDEM_PARTNER=claude node /path/to/tandem/bin/peer.mjs status   # running? last verdict
TANDEM_PARTNER=claude node /path/to/tandem/bin/peer.mjs wait     # block until the bg turn is done
TANDEM_PARTNER=claude node /path/to/tandem/bin/peer.mjs stop     # close (session id persists)
TANDEM_PARTNER=claude node /path/to/tandem/bin/peer.mjs new      # ONLY to abandon it and start fresh
```

**Important — long turns:** a foreground `ask` can exceed your shell's command timeout. For
anything non-trivial use `ask --bg` then poll `status` (instant) in a loop until done — don't try to
background it with detached PowerShell (that broke before). The bridge owns the backgrounding.

## The method (same doctrine, roles swapped)

You (Codex) are the **driver**, driven by the human. Claude is your **co-engineer**, not a chore-bot:

1. **Keep your own track** — work from your strength (running it, building, empirical evidence).
2. **Delegate the complementary vantage to Claude, independently** — e.g. have Claude reason over
   the source/architecture / spot design risks / review your diff — and **don't hand it your
   conclusion**; ask it to reach its own.
3. **Cross-check, don't echo.** Converge (both reach it independently) → high confidence. Diverge
   (contradiction) → that's the **blind-spot alarm**; feed each side's evidence to the other and
   dig until it resolves.
4. **Ground-truth wins** — an actual run/build/test beats either model's theory.
5. **Persist + propagate up.** Record findings/decisions in a shared `TANDEM.md` ledger; loop the
   human at forks. If you're a subagent, lead your return with
   `TANDEM (partner: claude) → converged/diverged: <finding>` so the result isn't buried.
