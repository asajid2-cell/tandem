---
name: tandem
description: Make this session dual-driven — pair-program with the OTHER model (Codex from a Claude session, or Claude from a Codex session) as a true co-engineer, not a subagent. Two minds work the same problem from independent vantages, cross-check each other, and let empirical ground-truth settle disputes. Invoke when the user asks to work in tandem / dual-drive / "bring in Codex (or Claude)", or when a hard, ambiguous, or high-stakes problem (a nasty bug, a risky design, a crash with competing theories) would benefit from a genuinely independent second mind catching your blind spots.
---

# Tandem — dual-driven pair programming

You are the **driver**: the human drives you, and you drive a **partner** (the other
model) as a true co-engineer. The partner is NOT a disposable subagent you hand a chore.
It is a peer that reasons alongside you, works in parallel, and exists to **catch the
mistakes you can't see** — because it analyzes from a different vantage than you.

This works because each model has different strengths. In a real game-engine renderer crash,
the Claude side reasoned best from **source/architecture**, the Codex side from
**runtime/empirical evidence** (debugger, builds, captures). Neither alone found the bug; the
**contradiction between their two findings** is what exposed it, and Codex's runtime
ground-truth corrected Claude's source theory. That is the entire point.

## The bridge

Delegate a turn to the partner and get back its verdict + a digest of what it actually did
(commands, files, tokens) — no manual log parsing:

Run these from your tandem checkout (or use the absolute path to `bin/peer.mjs`):

```bash
# short task:
node bin/peer.mjs ask "<scoped task>"
# long/multiline task (preferred — pipe via stdin):
printf '%s' "$TASK" | node bin/peer.mjs ask -
node bin/peer.mjs status      # is the partner mid-turn? last verdict
node bin/peer.mjs tail 60     # live progress of the in-flight turn
node bin/peer.mjs compact "<handoff prompt>"   # hand a near-full partner to a fresh thread
node bin/peer.mjs new         # forget the session (start fresh)
```

**Compaction — don't let the partner break at its context limit.** `ask`/`status` warn you when
the partner is running low. When you see that, run `peer.mjs compact "<what to preserve>"`: the
partner summarizes with YOUR prompt, a fresh thread is seeded with it, and the pair re-couples
automatically. You craft the handoff, so nothing that matters is lost.

The bridge **resumes the same partner session** across calls, so the partner keeps full
context — treat it as one continuous colleague, not stateless one-shots. Set the working
project with `TANDEM_CWD=<path>` (or `cwd` in `tandem.config.json`).

**Long turns** (builds, captures, deep dives can run many minutes): start the `ask` via your
harness's background mechanism so you keep working while the partner runs; read the verdict
when it returns. Do your own analysis in parallel — never just idle waiting on the partner.

## Prerequisite the USER must set up first

The partner runs **unattended** — there is no human in *its* turn to grant a permission. So
the partner MUST be configured to **never stop for approval**, or the system deadlocks:
- **Codex partner:** set your `~/.codex/config.toml` to never ask (the default `config`
  posture uses it). Or set `"posture": "yolo"` in `tandem.config.json` for a full bypass.
- **Claude partner:** must run with permissions bypassed (`--dangerously-skip-permissions`
  / bypass mode) for the same reason.

You (the driver) still pause for the human normally — only the **partner** must be auto-allow.
If a delegated turn hangs, the partner stopped for a prompt: that's a setup problem, fix the
never-ask config, don't work around it.

## The method (do this, not "consult once")

1. **Keep your own track.** Work the problem from your strength (source, architecture,
   reasoning). Form your own hypothesis with evidence.
2. **Delegate the complementary vantage — independently.** Give the partner a *scoped*
   investigation from a DIFFERENT angle than yours (if you're reading source, have it get
   runtime/empirical evidence: run it, debug it, build it, capture it). **Do not tell it your
   conclusion** — ask it to reach its own. An echo is worthless; independence is the value.
3. **Cross-check, don't rubber-stamp.** Compare its finding to yours.
   - **Converge** (both reach the same answer independently) → high confidence, proceed.
   - **Diverge** (contradiction) → this is the **blind-spot alarm**. Do not paper over it.
     Feed each side's evidence to the other and dig until the contradiction resolves. The
     resolution is almost always the real insight.
4. **Ground-truth wins.** Empirical evidence (a build result, a test, a capture, a debugger
   read) beats either model's theory. When in doubt, have the partner *produce the evidence*
   and believe the evidence.
5. **Converge → act → persist → PROPAGATE UP.** Record findings, decisions, and open contradictions
   in a shared `TANDEM.md` ledger. And if someone is driving *you* (you're a subagent), surface the
   result upward: lead your return with `TANDEM (partner: <model>) → converged/diverged: <finding>`.
   A second-brain correction buried in a subagent transcript no one reads is a tandem loss.
6. **Loop the human at forks** — real direction decisions are theirs.

## Framing a good delegation

Give the partner what a real colleague needs, then get out of its way:

```
Context: <the situation + only the facts it needs>
Your task (your independent angle): <the specific question to answer from YOUR vantage,
  e.g. "from the running process / debugger, what is the actual fault — don't trust my
  source theory, verify from runtime">
Bring back: <the concrete evidence/verdict you need — addresses, values, a diff, a result>
Reach your own conclusion; if you disagree with the obvious explanation, say so and why.
```

## When NOT to use tandem

Trivial or unambiguous work, or when you're already confident and verified — a second mind
is overhead there. Reach for tandem on the hard, contested, or expensive-to-get-wrong calls.
