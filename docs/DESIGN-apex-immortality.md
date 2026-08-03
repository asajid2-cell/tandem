# Apex immortality — clear-and-reload instead of compaction

Status: IMPLEMENTED and PROVEN LIVE (2026-08-02). Two adversarial passes shaped it; a third
(cold, independent) audited it afterwards. Live proof: two rebirth cycles on real opus sessions,
session ids 3ec4dc8f -> 95b02595 -> f2867041 with the SEAT id stable, each reborn apex answering
from the ledger alone (goal/next, a decision AND its rejected alternative, a ruled-out hypothesis
with its evidence) while a passphrase given to the first session and deliberately never written
came back "I-DO-NOT-KNOW" both times. Code: bin/apex-memory.mjs, bin/apex-refresh.mjs;
CLI: `fleet context|note|current|brief|refresh`; doctrine: orchestrate skill §4b.

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

> These were 150–200k / 500k in the first draft. An adversarial pass pointed out that those cite
> CONTEXT-THESIS §1.3 while sitting ~3x above its own "serious" band, so the document refuted
> itself. Corrected to match the evidence actually cited; overridable via TANDEM_REFRESH_AT /
> TANDEM_HARD_AT.

| threshold | default | behaviour |
|---|---|---|
| `refreshAtTokens` | **100k** | at a CLEAN SEAM, refresh |
| defer window | trigger → backstop | wants to refresh, waits for the seam (never mid-sweep) |
| `hardRefreshTokens` | **300k** | **unconditional forced refresh**, seam or not. Firing often means the trigger is mis-set — it is a backstop, not a workflow |

A "clean seam" = no lane in flight, nothing integrated-but-uncommitted, no unresolved raise.

## Mechanism

- **Meter REAL context, not cumulative spend.** MEASURED on the wave-1 apex log: the last
  per-call `assistant` record's usage = 491,739 (true context) while the same turn's `result`
  record = 53,152,747 (the aggregate over 310 API calls). Reading the result record as context is
  defect F7 and would trip a 100k threshold ~500x early. Context = the LAST ASSISTANT CALL's
  `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; the `result` record is
  spend accounting, never context.
- **Ledger** (per campaign, on disk, in the repo): `CURRENT.md` (machine-owned state, REPLACED
  wholesale — stale state is a drift source), `decisions.jsonl` + `surprises.jsonl` (append-only,
  written as the fact occurs), pointers to artifacts (commits, paths) rather than prose.
- **Rehydration brief** built from those files, bounded, newest-detail-first, CURRENT state never
  sacrificed to budget.
- **Auto-compact MUST be off on the apex session** — otherwise it fires at its own threshold and
  reintroduces exactly the generation loss this design exists to avoid.

## Answered by the adversarial passes (kept for provenance)

A. What class of knowledge systematically fails to reach the ledger, and does that make
   clear-and-reload lossy in practice rather than in principle?
B. Are the thresholds defensible, and what would falsify them?
C. Is there any window where a crash loses state despite "writes lead the clear"?
D. Does a machine-owned `CURRENT.md` actually prevent drift, or relocate it?
E. Is the cache/cost math right, or does clearing destroy prefix caching in a way it under-counts?
F. What is the correct primitive for "clear" on a bridge-held claude partner, given that `new`
   forgets the session and `compact` is the generation-loss path we are replacing?
G. What happens when a rehydration brief is wrong, stale, or mid-write?
