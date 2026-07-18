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

> ⛔ **NEVER create or write a `TANDEM.md` file yourself** — not in the repo, the workspace root, or
> WorkRepo. Don't `Write`/`Edit`/`echo >>` a `TANDEM.md`. The bridge owns the ledger:
> `peer.mjs ledger "<entry>"` writes *this pair's own* `TANDEM.md` in its private `tandems/<label>/`
> folder. Hand-writing one is the #1 way tandems collapse into a single shared, cross-contaminated file.

## The bridge

Delegate a turn to the partner and get back its verdict + a digest of what it actually did
(commands, files, tokens) — no manual log parsing:

Run these from your tandem checkout (or use the absolute path to `bin/peer.mjs`):

```bash
node bin/peer.mjs label "<short-name>"   # FIRST: name this tandem → private tandems/<name>/ folder
# short task:
node bin/peer.mjs ask "<scoped task>"
# long/multiline task (preferred — pipe via stdin from a file; never a heredoc/inline multiline):
node bin/peer.mjs ask - < task.txt
node bin/peer.mjs ask --bg "<long task>"       # background a long turn; poll status / use wait
node bin/peer.mjs status      # is the partner mid-turn? last verdict
node bin/peer.mjs wait 240   # block until the --bg turn finishes
node bin/peer.mjs tail 60     # live progress of the in-flight turn
node bin/peer.mjs ledger "<entry>"             # record to THIS pair's own ledger (no arg = print it)
node bin/peer.mjs compact "<handoff prompt>"   # hand a near-full partner to a fresh thread
node bin/peer.mjs new         # forget the session (start fresh)
```

**Each session is its own tandem — name it first.** Before your first `ask`, run
`peer.mjs label "<short-name>"` (e.g. `watch-together-cdn-engine`). That gives this tandem its OWN
private folder `tandems/<name>/` — its own registry, timeline, pointers, and ledger — so tandems run
from different code sessions never cross-contaminate. If you skip it, the folder falls back to the
opaque session id. Nothing else to point; just run `peer.mjs`.

**Fanning out multiple concurrent tandems from ONE session (subagents/workers): unique `TANDEM_LABEL`
env per tandem.** The `label` command keys off the driver session id, which parallel workers share —
they'd all collapse into one folder. Set `TANDEM_LABEL=<unique-name>` on every `peer.mjs` call for
that tandem instead (it overrides the recorded label). One tandem = one label = one folder.

**Drive like a master planner — fan out lanes, never idle.** A partner turn running is when YOUR
real job happens: you own the whole (plan, direction, correctness); each partner owns a slice.
Never delegate one 30+ min task and doze until the verdict — that inverts the design and makes you
your partner's subagent. When the problem decomposes into independent workstreams, run one tandem
lane per workstream concurrently (unique `TANDEM_LABEL` + `ask --bg` each), then cycle: own work →
poll `status` per lane → interpret arrivals (converge/diverge) → dispatch next. Size asks for
steering, not batching — a mega-turn bundling five questions loses parallelism and early divergence
signals; long turns are only for genuinely long work (builds, captures, deep debugs). Each lane is
still a peer on its slice (independent vantage, no conclusion-feeding); 2–4 lanes is the honest
ceiling before the driver stops genuinely interpreting.

**Compaction — don't let the partner break at its context limit.** `ask`/`status` warn you when
the partner is running low. When you see that, run `peer.mjs compact "<what to preserve>"`: the
partner summarizes with YOUR prompt, a fresh thread is seeded with it, and the pair re-couples
automatically. You craft the handoff, so nothing that matters is lost.

The bridge **resumes the same partner session** across calls, so the partner keeps full
context — treat it as one continuous colleague, not stateless one-shots. Set the working
project with `TANDEM_CWD=<path>` (or `cwd` in `tandem.config.json`).

**Long turns** (builds, captures, deep dives can run many minutes): use `ask --bg` then poll
`status` (or `wait`) — the bridge owns the backgrounding. A true harness background tool on a
foreground `ask` also works; a hand-rolled detached shell (Start-Process / nohup wrappers) does
NOT — it has broken here before. Do your own analysis in parallel — never just idle waiting on
the partner.

**Reliability (set in `tandem.config.json`):**
- **`autoCompact`** (on in the shipped config; code default off) + **`compactAtTokens`** (default
  300000 input tokens, env `TANDEM_COMPACT_AT`) — when the partner's tracked input tokens cross
  the threshold, the next **Codex-partner** ask auto-hands-off to a fresh session first,
  preserving continuity via a summary. The **Claude partner is never auto-compacted** — `ask`/
  `status` warn "running low"; run `compact "<handoff>"` yourself. Hard-context-error recovery
  (fresh session seeded with a summary) is always on for the Codex partner only.
- **`maxTurnSec`** (shipped 2400, env `TANDEM_MAX_TURN_SEC`, 0 = off) — a runaway CODEX-partner
  turn is tree-killed at the cap and the job reports an error naming it. `wait` giving up does
  NOT stop a turn — only the cap does. A runaway Claude-partner turn has no auto-kill: use
  `stop`/`new`. Scope asks small (~20 min of work) regardless.
- Project context for a fresh partner session goes **in the ask itself** (there is no preamble
  mechanism) — state repo root and key paths so the partner doesn't recurse a huge workspace.
- **Partner tier/model/effort:** doctrine is model-agnostic — select by TIER via env
  `TANDEM_TIER=efficient|deep` (default tier = just ask). The tier→model mapping lives ONLY in
  `tandem.config.json`: `tiers.<partner>.<tier>` = `{model, effort}`, flat
  `codexModel`/`codexEffort`/`claudeModel`/`claudeEffort` keys = the default tier. Explicit env
  `TANDEM_MODEL`/`TANDEM_EFFORT` override a tier. Codex partner: binds per ask (fresh and resume,
  `-m`/`-c model_reasoning_effort`). Claude partner: binds at daemon start (`--model`/`--effort`)
  — `stop` first to change. Doctrine: default tier for most work incl. grunt + adversarial
  passes; efficient tier for mechanical sweeps; deep tier ONLY for genuinely deep architectural
  review (state the reason); never map a tier to a small/mini-class model. Update the config when
  model generations change — never docs.

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
4. **Ground-truth wins — and the partner's claims meet the same evidence bar as yours.** Empirical
   evidence (a build result, a test, a capture, a debugger read) beats either model's theory. When
   in doubt, have the partner *produce the evidence* (the exact command + output, the diff, the
   address) and believe the evidence — never an unbacked assertion from either side.
5. **Converge → act → persist → PROPAGATE UP.** Record findings, decisions, and open contradictions
   with `peer.mjs ledger "<entry>"` — this writes to **this tandem pair's OWN ledger** (its private
   `TANDEM.md`), never a shared one, so unrelated tandems don't bleed into each other. And if someone
   is driving *you* (you're a subagent), surface the result upward: lead your return with
   `TANDEM (partner: <model>) → converged/diverged: <finding>`. A second-brain correction buried in a
   subagent transcript no one reads is a tandem loss.
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

The cheapest high-value delegation: **pre-ship adversarial review**. Before declaring a risky change
done, hand the partner your diff + your claim and ask it to *refute* it. Two models reviewing the
same change independently routinely find **complementary** bugs — each catches the one the other
structurally can't see.

## When NOT to use tandem

Trivial or unambiguous work, or when you're already confident and verified — a second mind
is overhead there. Reach for tandem on the hard, contested, or expensive-to-get-wrong calls.
