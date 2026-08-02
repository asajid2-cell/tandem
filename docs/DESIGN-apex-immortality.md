# Apex immortality — clear-and-reload instead of compaction

Status: DESIGN, under adversarial review. Tests are written and RED (`test/apex-memory.test.mjs`);
nothing is implemented yet.

## The thesis

**Compaction is generation loss.** Each compaction summarizes a context that already contains a
summary, so error compounds: by the tenth cycle the apex reasons from a copy of a copy of a copy.
**A clear-and-reload is always exactly one hop from source.** Fidelity stays constant no matter
how long the apex lives — which is what makes a single apex session genuinely immortal rather
than merely long-lived.

This only works because memory is on disk FIRST. The two decisions are load-bearing on each
other: without the ledger a `/clear` is destructive; with it a `/clear` is a refresh.

**The discipline that makes it safe: writes LEAD the clear.** A fact is recorded by the same
action that produces it — not batched, not written at the threshold. If the apex only wrote at
the threshold, a crash just below it loses everything. Continuous writes mean a clear, a crash,
or the owner killing the tab are all equally safe.

**Fidelity is not correctness.** Reloading faithfully restores whatever was recorded, including
mistakes. Rot is handled by the refresh; DRIFT is handled by `CURRENT.md` being machine-owned and
written only from verified state (the campaign-state discipline), never from what the mind
believes.

## Why not "just raise the ceiling" (the 1M window)

1M is CAPACITY, not the working band. Per `docs/CONTEXT-THESIS.md` (researched against primary
sources): associative recall degrades from 2–8k, multi-hop reasoning falls off before 32k,
exact-state coding — the closest measured analogue to apex work — is under 50% for most models by
36–60k, and degradation is serious across the board by 60–130k; 2026-era snapshots still show
hard retrieval roughly halving between 128k and 1M. An apex at 700k has been doing worse work for
a long time before it refreshes.

Cost agrees with quality, which is unusual and worth stating: a rehydration is ONE bounded read
(~$0.50 at opus rates for a ~40k brief incl. cache write), while carrying a large context costs
~$0.10/turn at 300k vs ~$0.05/turn at 100k. Clearing every ~30 turns saves ~$3 and costs ~$0.50.
**Refreshing more often is both cheaper and sharper.** There is no trade to balance.

## The three thresholds (config knobs, calibrated from research, to be re-calibrated from data)

| threshold | default | behaviour |
|---|---|---|
| `refreshAtTokens` | ~150–200k | at a CLEAN SEAM, refresh |
| defer window | trigger → backstop | wants to refresh, waits for the seam (never mid-sweep) |
| `hardRefreshTokens` | ~500k | **unconditional forced refresh**, seam or not. Firing often means the trigger is mis-set — it is a backstop, not a workflow |

A "clean seam" = no lane in flight, nothing integrated-but-uncommitted, no unresolved raise.

## Mechanism

- **Meter REAL context, not cumulative spend.** `usage.json` currently sums every turn forever
  (53,152,747 for the wave-1 apex) and compares it against a 300k "limit" — that produced wave
  1's bogus low-context warning (F7). Context = the LATEST call's
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
- **Ledger** (per campaign, on disk, in the repo): `CURRENT.md` (machine-owned state, REPLACED
  wholesale — stale state is a drift source), `decisions.jsonl` + `surprises.jsonl` (append-only,
  written as the fact occurs), pointers to artifacts (commits, paths) rather than prose.
- **Rehydration brief** built from those files, bounded, newest-detail-first, CURRENT state never
  sacrificed to budget.
- **Auto-compact MUST be off on the apex session** — otherwise it fires at its own threshold and
  reintroduces exactly the generation loss this design exists to avoid.

## Open questions for the adversarial pass

A. What class of knowledge systematically fails to reach the ledger, and does that make
   clear-and-reload lossy in practice rather than in principle?
B. Are the thresholds defensible, and what would falsify them?
C. Is there any window where a crash loses state despite "writes lead the clear"?
D. Does a machine-owned `CURRENT.md` actually prevent drift, or relocate it?
E. Is the cache/cost math right, or does clearing destroy prefix caching in a way it under-counts?
F. What is the correct primitive for "clear" on a bridge-held claude partner, given that `new`
   forgets the session and `compact` is the generation-loss path we are replacing?
G. What happens when a rehydration brief is wrong, stale, or mid-write?
