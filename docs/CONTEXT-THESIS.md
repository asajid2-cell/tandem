# The context thesis — why every session must stay small, and how orch makes that structural

> Design doc, written after the first real-monorepo campaign ended **0 leaves folded, 7 blocked**.
> Part 1 states and evidences the context-degradation thesis. Part 2 diagnoses why the campaign
> failed it despite a working budget system. Part 3 specifies the engineering changes that make
> orch *embody* the thesis instead of merely enforcing its ceiling.

---

## Part 1 — The thesis and the evidence

> Citation flags: **[V]** = the primary source was fetched and the numbers below are quoted from
> it. **[S]** = the number comes from secondary transcriptions of a primary we could not fetch
> (probable, re-verify before quoting externally). Claims we could not verify are omitted or
> flagged inline.

### 1.1 The claim, stated precisely

Three ceilings get conflated as "the context limit," and they must be separated because they
demand different engineering:

1. **The hard window limit.** The API rejects or truncates past N tokens. A cliff. Trivially
   detectable, and *not* what killed our campaign — no session ever reached it.
2. **Soft capability regression.** Well inside the window, the model gets measurably worse at
   using what it holds: attention dilutes across more pairwise relationships (n² strain),
   position bias emerges, distractors actively corrupt reasoning, non-lexical recall collapses.
   This is a **slope, not a cliff** — it has no error message, no signal, no floor you bounce
   off. The work just quietly gets worse.
3. **The orch budget.** A self-imposed ceiling whose entire purpose is to keep every live
   session out of zone 2. It is an engineering control, not a physical limit — which is why
   "raise the budget" was never a candidate fix: it's the one knob whose adjustment *is* the
   failure.

The operator's thesis — "models above ~500k regress, so keep every session well under it" — is
**validated in direction and generous in magnitude**. The evidence below shows there is no cliff
at 500k; there is a slope that begins, for anything harder than literal lookup, in the
*single-digit-to-low-tens of thousands*, is serious by 60–130k, and is severe well before 500k.
500k is correct as a never-exceed wall. The honest *operating band* is far lower.

### 1.2 The evidence, by failure mode

**(a) Advertised context is not effective context.** RULER (Hsieh et al., NVIDIA, COLM 2024,
arxiv.org/abs/2404.06654) **[V]** defines effective length as the longest context at which a
model still clears a fixed synthetic-task threshold (85.6%). Results against claims: GPT-4-1106
claimed 128k, effective **64k** (81.2 at 128k); Mistral-Large-2407, Qwen-2-72B, Yi-34B (200k
claimed), Phi-3-medium: effective **32k**; several models claiming **1M** (GradientAI Llama-3,
InternLM2.5, LWM) were effective at **4k–16k**. The majority of 128k–1M-claim models had
effective lengths of 4k–64k, and even "passing" models decline monotonically (GPT-4: 96.6 → 81.2
from 4k → 128k). The advertised number measures the marketing task; see (g).

**(b) Attention over context is non-uniform even at trivial lengths.** "Lost in the Middle"
(Liu et al., Stanford/UW/Meta, TACL 2024, arxiv.org/abs/2307.03172) **[V]**: multi-document QA
with GPT-3.5-Turbo shows the U-curve at only ~3–4.4k tokens — 30 docs: beginning 73.4%, middle
**50.9%**, end 63.7% — and middle-position performance falls *below closed-book* (56.1%): the
context made the model **worse than having no context**. Caveat kept honest: this is a
position-bias result at small scale, not a long-context sweep; its value is establishing that
attention is non-uniform from the start, so piling on tokens dilutes from the first kilobyte.

**(c) Non-lexical recall collapses by the low tens of thousands.** NoLiMa (Modarressi et al.,
Adobe Research + LMU, ICML 2025, arxiv.org/abs/2502.05167) **[V]** removes literal keyword
overlap between question and needle, forcing one latent associative hop — the minimum unit of
actually *understanding* context rather than pattern-matching it. Effective lengths (≥85% of own
short-context baseline): GPT-4o **8k**, Claude 3.5 Sonnet **4k**, Gemini 1.5 Pro — claiming
**2M** — **2k**, Llama 3.1 405B **2k**, GPT-4o-mini **<1k**. At 32k, 11 of 13 models fell below
50% of their own baseline; GPT-4o went 99.3 → 69.7. Reasoning does not rescue it: on
NoLiMa-Hard, o1 falls 99.9 → **31.1** at 32k and CoT-prompted Llama 3.3 70B falls to 10.1.

**(d) Irrelevant context is not neutral — it actively corrupts.** Shi et al. (Google, ICML
2023, arxiv.org/abs/2302.00093) **[V]**: adding **one irrelevant sentence** to grade-school math
drops code-davinci-002 with CoT from 95.0% to 72.4%, and ≤18% of baseline-solvable problems
survive all distractor variants. Chroma's "Context Rot" (Hong, Troynikov, Huber, July 2025,
research.trychroma.com/context-rot) **[V]**, across 18 frontier models (Claude 4, GPT-4.1, o3,
Gemini 2.5): the same question with the same relevant ~300 tokens answers significantly better
than with those tokens buried in ~113k of context, in every model family; distractors compound
with length; and all 18 models scored *better on shuffled than on coherent* haystacks —
structure itself disrupts attention. Even pure generation (copy a word list) degrades with
length. This is the load-bearing fact for orchestration: **every low-signal token costs
capability now**, not merely space later.

**(e) Multi-hop reasoning over context falls off before 32k and keeps falling.** Michelangelo
(Vodrahalli et al., Google DeepMind, 2024, arxiv.org/abs/2409.12640) **[V, figure-level]**: on
MRCR, "all models experience significant fall off in performance before 32K." OpenAI's own
GPT-4.1 evals **[S]**: 100% single-needle at 1M, but 2-needle MRCR ~84% at 8k → **57.2% at
128k** → ~50% at 1M, and Graphwalks multi-hop at **61.7% below 128k**. Gemini 2.5 Pro's 8-needle
MRCR-v2: 58.0% at ≤128k → **16.4% at 1M** **[S]**. LongBench v2 (Bai et al., 2024,
arxiv.org/abs/2412.15204) **[V]**: hard realistic long-context MCQ — best direct-answer model
50.1% against 25% chance; o1-preview 57.7%. A 2026-era snapshot **[S, single secondary — flag]**
has the best current models' hard-retrieval roughly halving between 128k and 1M, falling through
~60% in the 256–512k band — i.e. even the newest generation is visibly degraded *inside* the
band our deep tier was budgeted to use.

**(f) Coding/agentic work degrades earliest and steepest.** LoCoDiff (Mentat AI, 2025,
abanteai.github.io/LoCoDiff-bench) **[V]** — reproduce a file's exact final state from its
commit history, the skill nearest to what an orch builder does: Claude Sonnet 4.5, the best
measured, falls 96% (2–21k) → 72% (36–60k) → **64%** (60–98k); Claude Opus 4.1 falls 94% →
**22%** by 60–98k; GPT-5 (medium) is at **30% already in the 21–35k band**. Databricks' 13-model
RAG study (Aug 2024, databricks.com/blog/long-context-rag-performance-llms) **[V]**: answer
correctness *peaks* at 16–32k for most models and declines as more context is added, with
qualitative failure-mode shifts — Claude-3-Sonnet's spurious refusals grow 3.7% → 49.5% from 16k
→ 64k; DBRX stops following instructions and starts summarizing. More context past the peak is
negative-value.

**(g) The vendor position agrees, quantitatively.** Anthropic's context-engineering guidance
(Sep 2025, anthropic.com/engineering/effective-context-engineering-for-ai-agents) **[V]** treats
attention as a "finite budget" with "diminishing marginal returns" and prescribes "the smallest
possible set of high-signal tokens." Anthropic's own agent evals (anthropic.com/news/context-management)
**[V]**: context *editing* — deleting stale context — improved agentic-search performance **29%**
alone, **39%** with memory, cut token consumption **84%**, and let 100-turn agents complete
workflows that otherwise fail on context exhaustion. Removing context made agents *better*, not
just cheaper. HELMET (Yen et al., ICLR 2025, arxiv.org/abs/2410.02694) **[V]** closes the loop
on (a): most models score *perfect* on vanilla needle-in-a-haystack, and NIAH does not predict
downstream long-context performance — the advertised-window benchmark is a vanity metric. The
notable counter-position, Cognition's "Don't Build Multi-Agents" (June 2025) **[V, qualitative]**,
argues for sharing full traces — but their own mechanism for long histories is a dedicated
compression model, which concedes the premise: raw accumulated context does not work.

### 1.3 Where the line actually is

| capability | degradation measurable | serious | severe |
|---|---|---|---|
| lexical needle recall | effectively never (100% @ 1M) [S] | — | — |
| associative (non-lexical) recall | **2–8k** [V] | 32k (−30 to −70 pts) [V] | 128k+ |
| multi-hop reasoning over context | **<32k** [V] | ~128k (≈50–60%) [S/V] | 256k–1M (halves again) [S] |
| exact-state coding (LoCoDiff) | ~10–20k [V] | 36–60k (most models <50%) [V] | 60–100k+ |
| RAG answer quality | past 16–32k peak [V] | 64k+ (mode shifts: refusals, drift) [V] | — |

So: **is 500k the line?** No — it is well inside the degradation zone for everything an orch
session actually does. What 500k *is*: a defensible absolute wall (the point past which even the
best 2026 models' hard retrieval is in the 30–60% range [S], i.e. work product you must assume
is wrong). The honest safe operating band for reasoning-heavy sessions is **tens of thousands of
high-signal tokens**, with tier ceilings as kill-switches in the low hundreds of thousands, and
the wall — never crossed — at 500k. The operator's thesis survives with its number reinterpreted:
500k is the outer rampart, not the workspace.

### 1.4 The actionable principle

For an autonomous multi-agent system, four consequences:

1. **Ceilings are necessary and insufficient.** Because regression is silent (no error, no
   signal), a hard external meter + kill is the only trustworthy guard — orch's budget system is
   right to exist and right to fail closed. But a ceiling only prevents the *worst* sessions; it
   does nothing to make sessions *good*.
2. **Quality is produced by exclusion.** Per (d) and (g), every irrelevant token degrades the
   work being done *now*. The design objective of briefs, folds, and reads is the smallest
   high-signal set — context curation is not an economy measure, it is a capability measure.
3. **Therefore acquisition — not just occupancy — must be engineered.** A session that
   whole-reads a 72k-token file into a 200k budget is not "at 36% capacity"; per (c)–(f) it is
   already operating degraded on low-signal material. Bounding session *size* without bounding
   what sessions *pull in* guards the symptom and leaves the cause untouched — which is
   precisely Part 2.
4. **Arbitrarily large work is handled by recursion, not accumulation.** Since no single
   session can safely hold big contexts, the system must hold them structurally: slices held by
   disposable minds, distillates flowing between them. The tree, not any session, is where large
   context lives.

---

## Part 2 — Diagnosis: what we did wrong

### 2.1 The observed death spiral, traced through the engine

The campaign target contains god-files: `ArchiveService.cs` ≈72k tokens, `muxd.py` ≈43k,
`index.html` ≈40k, `server.js` ≈29k. The failure loop, at every level of the tree:

1. A worker (planner or builder) issues a whole-file Read of a god-file. Nothing prevents this:
   the brief's rules (`orch.mjs` brief template, "## Rules" section) govern what to *touch* and
   how to *fold*, but say nothing about how to *acquire context*.
2. The session meter fires: `sessionBudgetHit` (`conductor.mjs:1091`) sees ctxTokens ≥ 80% of the
   tier ceiling, `interruptForBudget` (`conductor.mjs:1173`) tree-kills the worker and preserves…
   a **1600-character transcript tail** (`compactSessionTail`, `conductor.mjs:1165`). Everything
   the session had learned — which parts of the file matter, what the task actually requires —
   dies with it.
3. `handleBudgetInterruption` (`conductor.mjs:1276`) reopens the node with feedback that says
   *"Inspect the current diff/state first"* — an explicit instruction to **re-acquire from zero**.
   The successor re-reads the god-file and blows again.
4. After `maxBudgetHandoffs` non-reducing handoffs, the leaf is auto-converted to a `plan` node
   (`orch decompose`, `orch.mjs:815`) so a planner can slice it. But the planner must understand
   the file to slice it, has no map of it, and no rule against reading it — so **the planner
   performs the same unbounded read** and blows its own (deep-tier) budget.
5. The no-progress guard (`conductor.mjs:1337`, added after observing a deepdive tree-killed
   every ~42s forever) correctly detects the loop and blocks the node. Honest — but the work
   never happened.

Raising budgets (efficient 60k→150k, default 200k→300k, deep 320k→450k) changed nothing, because
the appetite is multiplicative, not additive — see §2.4.

### 2.2 The root cause, in one sentence

**Orch decomposes *tasks* but does not decompose or bound *context acquisition*.** A leaf's goal
can be twenty tokens while its acquisition appetite is two hundred thousand. Every ceiling in the
system — tier budgets, the handoff ratio, the plan-ingest inbound estimate, fold caps, fan-in
caps — bounds *orch-controlled* context (goal, ARCH.md, dependency folds, fold sizes). The one
context source orch does not control, the worker's own tool-driven reads, is unbounded,
unmeasured at plan time, and unpersisted at kill time. Budgets bound the **symptom** (live
session size); nothing bounds the **cause** (what a session pulls in to do its job).

The plan-ingest estimate states this precisely: `orch.mjs:566` computes
`inboundTokens = goalTokens + archTokens + depTokens` — every term is an artifact orch generates.
A build child whose goal says "fix retention logic in ArchiveService.cs" passes ingest at ~2k
estimated tokens and then acquires 150k+ at runtime. The estimate is not wrong; it is measuring
the wrong thing.

### 2.3 Every place unbounded acquisition lives

1. **Architect / root planner recon.** The deep-tier architect must understand the system to
   design seams. Its only tool for "understand" is reading, and nothing steers it away from
   whole-file reads of exactly the files most load-bearing (which correlate with being huge).
2. **Sub-planner recon at every level.** Each fresh planner re-derives understanding from the
   repo — paying the full acquisition cost again at every tree level, per attempt.
3. **Builder implementation reads.** A builder Read()s the file it must edit — whole, because
   that is the path of least resistance and the brief never says otherwise. Edits then echo
   diffs, failed matches force re-reads, verifier output lands in context: the file is paid for
   several times over.
4. **Judge verification reads.** Judges are told to walk artifacts clause by clause; over a
   god-artifact this is another unbounded read.
5. **The auto-decompose reclassify** (`orch.mjs:815` + `conductor.mjs:1371`) — the engine's own
   *response* to context pressure spawns a planner with the same unbounded appetite and **zero
   carried distillate**. The remedy re-executes the disease.
6. **Budget-handoff successors** (`conductor.mjs:1300`): carry = 1600-char tail + 3000-char
   feedback. The instruction "inspect the current diff/state first" mandates re-acquisition.
7. **Deepdive mode** (`conductor.mjs:910`) is *explicitly* told to "claim cumulative context" —
   correct posture for its role, but it inherits no distilled context either, so "cumulative"
   means "re-read everything, at deep-tier prices."
8. **Dep-fold fan-in** is the one acquisition channel that IS bounded (per-tier caps,
   `budget-policy.mjs:7`) — and notably, it is also the one that never caused a failure.
   The bounded channel worked; the unbounded one killed the campaign. That contrast is the
   whole diagnosis.

Also structural: the planner brief's **leaf test** (`orch.mjs:703`) asks the planner to certify
"a fresh worker finishes it comfortably below its tier ceiling" — but gives the planner no size
data whatsoever (no manifest, no outline, no file token counts). The certification is vibes, and
it is systematically optimistic because the goal *text* is small.

### 2.4 Why "just raise budgets" is the wrong axis

Three independent reasons, any one sufficient:

1. **The arithmetic doesn't close.** Live context ≈ acquisition × churn multiplier. One 72k-token
   whole-file read is 72k in context *forever* (tool results persist). Editing it echoes
   old+new strings; a failed Edit match forces a re-read; the verifier dumps output; the model
   reasons on top. Realistic churn is 2–3× the raw read set. So one god-file ≈ 150–220k live —
   past the default tier's 160k handoff threshold *from a single file's workflow*, before the
   goal, deps, or any actual thinking. A task touching two god-files (72k + 43k) × 2.5 ≈ 290k
   exceeds even a 450k-deep session's 360k threshold once planning overhead lands. No budget
   below the degradation wall survives multiplication; a budget above it defeats its purpose.
2. **The budget is not an obstacle to route around — it is the product spec.** Its entire reason
   to exist is Part 1: sessions above the band do *worse work*. Raising it converts an honest
   BLOCKED into silently degraded folds — vacuous verifiers slipping past a dulled judge, subtle
   misreads compounding up the tree. The campaign's 0/7 result is the guard *working*.
3. **Re-reads scale with the tree, budgets don't.** Total acquisition spend is
   O(levels × attempts × appetite) because nothing is carried forward. Raising the per-session
   budget doesn't touch the multiplier; it just makes each wasted acquisition bigger.

### 2.5 Why "just split the files" is a special case, not the fix

Splitting `ArchiveService.cs` shrinks one instance of the problem and leaves the class intact:

- **God-refactors**: a rename/contract-change spanning 30 medium files has the same shape — no
  single file is huge, the *union* a naive session acquires is. File size was never the variable;
  acquisition volume was.
- **God-context-dumps**: "reason over these 20 logs / this API corpus / this test matrix" has no
  file to split at all.
- **Adversarial regeneration**: codebases grow god-files faster than campaigns split them; a fix
  that requires the *target repo* to be well-shaped before orch can work on it is not a fix —
  reshaping ill-shaped repos is precisely the work we want orch to do.
- And note the recursion: *splitting a god-file is itself a task current orch cannot run*,
  because the splitter would read the god-file. Any real fix must let a bounded session operate
  on an unbounded artifact — which is the general mechanism of Part 3.

### 2.6 What the budget system got right — and the one thing it's missing

Got right (keep all of it):

- **Fail-closed metering** — an unmeterable session is killed, never trusted (`conductor.mjs:1152`).
- **No silent degradation** — kills at 80%, blocks honestly, never limps along degraded.
- **No attempt burned on a budget kill** + WIP checkpoints — partial work survives on disk.
- **No-progress loop detection** (`conductor.mjs:1288`) — the re-explode loop terminates instead
  of spinning forever.
- **The fold layer** — inherited tree state stays flat regardless of subtree size. The
  *vertical* context economy (folds up, briefs down) is exactly right.

Missing: **any graceful response to context pressure other than kill → re-read → block.** The
engine has one verb for an over-appetite session — terminate it — and its recovery paths all
respawn a mind with the same appetite and less knowledge. What it needs is the verb the rest of
orch is built on: *decompose* — applied to acquisition, informed by the session that already
paid for the context, before that context is destroyed.

---

## Part 3 — The engineering fix: make orch embody the thesis

### 3.0 Principle

Every prior orch layer bounds *orch-generated* context. This layer bounds *worker-acquired*
context, with the same doctrine the fold system uses: *never move raw material when a distillate
will do; never pay for the same understanding twice; when something is too big, slice it along
seams and fold the slices.* Concretely, a session budget stops being one number and becomes an
allocation:

| slice | share of tier ceiling | contents |
|---|---|---|
| inbound | ≤ ~35% | brief: goal + ARCH + dep folds + carried distillate (enforced at plan ingest) |
| acquisition | ≤ ~40% | outline-guided, span-scoped reads (enforced by doctrine + hook + meter) |
| churn/reasoning | remainder | edits, verifier output, thinking room |

### 3.1 Targeted acquisition: manifest, outline, context map

**`orch manifest`** (run at `init`, refreshed at plan ingest): `git ls-files` + stat →
`.orch/manifest.json` — every tracked file with an estimated token size (bytes/4, conservative).
Files above `godFileTokens` (default 25k) are flagged. Zero model tokens, milliseconds of I/O.

**`orch outline <path>`**: a deterministic (regex/heuristic, zero-dep — no model) structural
outline: top-level symbols (functions/classes/sections), their line ranges, and per-span token
estimates. Imperfect parsing is fine; the consumer is a model that only needs *seams and sizes*,
then reads exact spans with ranged reads (`Read` offset/limit or `sed -n a,bp`). The outline of a
72k-token file is ~1–2k tokens — a 40–70× compression for navigation purposes.

**Context map instead of raw dumps**: briefs and folds refer to code as
`path:line-range (≈tokens)` entries. A planner's product for a god-file is a *map* — which spans
matter to which child — not prose about the whole file.

**Brief doctrine (all roles)** — a new "## Context acquisition" section in every brief
(`orch.mjs` brief template):

- Before reading any file, check its size (manifest/outline). **Never whole-read a file larger
  than `perReadCapTokens`** (tier-scaled, ~10–15% of ceiling); outline it, then read only the
  spans your mission needs.
- Track what you've pulled in. If completing the mission would push acquisition past
  `acquisitionCapTokens` (~40% of ceiling), **stop early and emit an overflow fold (§3.2) while
  you are still healthy** — a budget kill destroys everything you learned; an early overflow
  preserves it.
- Maintain the scratch ledger (§3.3) as you learn.

**Mechanical enforcement where the harness allows it**: orch ships `hooks/read-cap.mjs`; the
Claude-family spawn posture wires it as a PreToolUse hook on Read that rejects whole-file reads
of files above the cap with the message "outline first, then ranged reads." (Posture-owned, per
the custody rule — the engine stays mechanism-neutral; codex workers get doctrine only.) And the
session meter already sees acquisition spikes: a single poll-to-poll ctxTokens jump larger than
`perReadCapTokens` can trigger an early interrupt whose feedback names the gulp specifically,
instead of waiting for the 80% wall (optional, §3.8 item 11).

Is a pre-built symbol index worth it? Yes at exactly this fidelity and no more: deterministic,
stat-and-regex, built lazily per file on first `outline` call and cached in `.orch/outlines/` by
content hash. Not worth it: a semantic/embedding index, a tree-sitter dependency, or any indexing
that spends model tokens — the consumers are smart; the index only needs to be *cheap and honest
about sizes*.

### 3.2 The overflow protocol — graceful context-pressure recursion (the core fix)

Replace "blow → kill → re-read → block" with: **the session that discovers the appetite is the
session that slices the work — before dying, using what it already knows.**

**Worker side.** A worker (any role) that determines its mission's required context exceeds its
acquisition cap stops working and writes a normal fold whose `## Surprises` section begins
`CONTEXT-OVERFLOW:`, plus one new section:

```
## Slice proposal
[{"title": "...", "kind": "build|sweep|plan|judge",
  "goal": "... (self-contained, names exact spans)",
  "reads": [{"path": "src/ArchiveService.cs", "span": "410-980", "estTokens": 9000}],
  "verifier": "<cmd>", "deps": [1]}]
```

This is exactly the plan-child schema plus `reads`. The proposer is the one mind that has
already paid for (part of) the context — its slicing is *informed*, and the outline/spans in the
children mean **no descendant ever re-pays the acquisition**. The fold's Result/Interfaces
sections carry the distilled understanding (the context map) forward.

**Engine side — `orch slice <id>`.** Fold ingest recognizes the overflow marker and, in one
atomic tree mutation: validates the proposal *exactly* as plan ingest validates children
(non-vacuous verifiers, fan-in caps, dep acyclicity, and the §3.4 inbound estimate *including*
`reads`), converts the node to `plan`, ingests the children, and records the fold as the node's
recon distillate. No attempt is burned — this is the system working, not failing. A proposal
that fails validation falls through to the existing failure ladder with the validation errors as
feedback (no new silent path; the no-silent-fail invariant holds).

**Conductor side.** `handleBudgetInterruption` gains a step before reopening: harvest the scratch
ledger (§3.3) and any partial slice proposal from the killed worktree, and attach them to the
successor's feedback. The successor's first move is no longer "re-inspect from zero" but "here is
what the previous session knew; continue or slice."

Result: context pressure becomes just another way a node discovers it is really a subtree —
the same shape as the leaf test, the same shape as a surprise, handled by the same recursion.
The tree doesn't merely tolerate god-inputs; it *digests* them.

### 3.3 The scratch ledger — distilled context that survives sessions

`.orch/scratch/<id>.md`, worker-maintained, hard-capped at `scratchMaxTokens` (~2k, validated on
harvest like folds): distilled *facts learned* — file outlines discovered, interface truths,
dead ends, decisions. It is to *successive attempts of one node* what folds are to *the tree*:
folds flow up; the ledger flows forward. It rides in: budget-handoff successor prompts,
auto-decompose planner briefs, deepdive briefs (making "claim cumulative context" real instead
of aspirational), and governor evidence. It replaces the 1600-char transcript tail as the
primary carry (the tail remains as a liveness/debugging artifact). It is never authoritative
state — the tree remains the memory; the ledger is a cache of understanding.

### 3.4 Plan ingest: estimate the appetite, not just the inheritance

Two changes at `orch.mjs` plan ingest (~line 566):

1. **`reads` joins the estimate.** Plan children for build/sweep declare
   `reads: [{path, span?, estTokens?}]`. Orch verifies against the manifest — a declared whole
   file costs its stat-derived size, a span costs its outline-derived size, and *declared sizes
   are ignored in favor of measured ones* (fail-closed: estimates only grow). The inbound
   estimate becomes
   `goal + ARCH + depFolds + Σ measured(reads) × churnFactor (default 2.0) + workingReserve`.
   A child naming `ArchiveService.cs` whole is now rejected **at plan time, deterministically,
   with the file's outline attached to the rejection** — the error message *is* the slicing map
   for the planner's next attempt. The budget stops being a wall the worker hits and becomes a
   constraint the planner designs against, with the data to do it.
2. **Separate the ingest ratio from the handoff ratio.** Today `ingestLimit = tierHandoffLimit`
   (80% of ceiling) — a child can pass ingest at 79% inheritance and spawn with ~zero execution
   room. Introduce `ingestInboundRatio` (default 0.35): inbound must fit in ~35% of the ceiling,
   preserving the §3.0 allocation. This is a latent bug independent of god-files.

The planner brief's leaf test gains teeth: clause 2 changes from "a fresh worker finishes it
comfortably below its tier ceiling" (unverifiable vibes) to "its declared `reads`, measured
against the manifest, fit the tier's acquisition budget" (machine-checked at ingest). The
architect brief embeds the manifest's god-file list from day one — **context topology is
architecture**: the seams the architect picks determine every descendant's read set, so files
too big to read whole are a design input, not a runtime surprise.

### 3.5 Fixing the existing pressure paths

- **Auto-decompose** (`conductor.mjs:1371` → `orch.mjs:815`): the spawned planner's brief now
  carries the scratch ledger, the engine-generated outlines of every file the dead sessions
  touched (from the meter's file tracking + manifest), and the acquisition rules. The planner
  plans *from the map*, forbidden from whole-reading what killed its predecessors. The
  decomposition itself is thereby context-bounded — closing the loop that blocked the campaign.
- **Budget-handoff successors**: feedback template (`conductor.mjs:1300`) changes from "inspect
  the current diff/state first" to "read the scratch ledger first; re-read only spans it does
  not cover."
- **Judges**: same acquisition section; verification over a god-artifact means running the
  verifier and span-checking the clauses, not whole-reading the artifact.
- **Deepdive**: keeps its long leash but gets the ledger and the outline tools; its observed
  42s-kill-loop failure mode is already terminally detected, and now its successors inherit
  understanding instead of re-deriving it.

### 3.6 Budgets as a productive constraint — and where to set them

The ceilings' job is to sit *below the degradation band with margin*, and their enforcement
mechanism (ingest rejection with outlines attached) is what *drives* fine-grained decomposition
— the constraint produces the architecture. Per Part 1's evidence, reasoning-over-context
degrades far below 500k (measurable from 2–32k for associative and multi-hop work; exact-state
coding under 50% for most models by 36–60k; serious across the board by 60–130k), so the
ceilings below are *kill-switches at the outer edge of defensibility*, while the §3.0 allocation
keeps a *healthy* session's high-signal working set in the tens of thousands:

| tier | today | proposed | rationale |
|---|---|---|---|
| efficient | 60k | **60k** (keep) | mechanical sweeps on well-specified spans; least degradation-sensitive |
| default | 200k | **150k** | implementation with judgment; keeps churn under the ~128k-and-below band where quality is well-characterized |
| deep | 320k (config; policy default 480k) | **300k** | planners/judges do the *most* degradation-sensitive work and, holding folds+maps rather than dumps, need the least raw context; a healthy deep session should run under ~150k, with 300k as headroom |
| hard wall | <500k | **<500k** (keep) | absolute never-exceed backstop, per the thesis |

With the §3.0 allocation, a default-tier build's brief is ≤52k, acquisition ≤60k, leaving ~40k+
of churn room — comfortable for span-scoped work, impossible for god-reads. Which is the point.

### 3.7 Generality — the same mechanism digests all three god-shapes

- **God-file** (72k-token `ArchiveService.cs`): manifest flags it → planner (or an overflowing
  builder) outlines it → slice proposal: span-scoped children, each with `reads` of ≤10k-token
  ranges, disjoint by construction (the existing same-files serialization rule), each with its
  own verifier; git worktrees merge the spans; fold-up synthesizes. No session ever holds the
  whole file. (Splitting the file *itself* becomes runnable the same way: each child extracts
  one outlined symbol group — the task current orch couldn't execute.)
- **God-refactor** (a contract change across 30 files): no single file trips the cap; the *sum
  of declared `reads`* trips the ingest estimate — same signal, same response. The planner
  slices by file-set; the shared contract lives in ARCH.md/dep folds (bounded, orch-controlled);
  each child owns a bounded file-set; a `sweep` handles the mechanical residue. Fan-in caps
  force aggregation folds if the refactor fans wide.
- **God-context-dump** ("reason over these 20 logs"): the inputs aren't code, so the answer is
  the tree's native map-reduce — sweep children each distill one bounded slice into a fold
  (`reads` bounds each slice); the parent reasons over folds, never raw inputs; fan-in caps
  auto-insert aggregation layers. This already existed vertically; `reads` makes it *triggered
  automatically* when a planner or worker meets an over-sized input, instead of depending on a
  planner spontaneously choosing map-reduce.

One mechanism — measure appetite, reject or slice at the seams, carry the distillate — covers
all three because all three were always the same problem: acquisition volume exceeding the safe
band. Files were just where we met it first.

### 3.8 Concrete change list (ordered; each with the invariant it preserves)

1. **`orch manifest`** (new, `orch.mjs`; run at `init`, refresh at plan ingest). Token-size map +
   god-file flags. *Invariant: zero model tokens; orch.mjs remains the only tree writer (manifest
   is derived state, like ORCH.md).*
2. **`orch outline <path>`** (new, `orch.mjs`; cache in `.orch/outlines/` by content hash).
   *Invariant: zero-dep, deterministic, read-only.*
3. **Brief templates** (`orch.mjs` brief command): add "## Context acquisition" to every role;
   rewrite leaf-test clause 2 to reference measured `reads`; embed god-file list in architect
   briefs. *Invariant: fold contract and existing sections unchanged; additive.*
4. **Plan schema + ingest** (`orch.mjs` ~566): `reads` field; measured-size estimate with
   `churnFactor` + `workingReserve`; new `ingestInboundRatio` (0.35) separate from
   `budgetHandoffRatio`; rejections attach outlines. *Invariant: fail-closed budget math —
   estimates only grow; malformed `reads` abort ingest, never coerce.*
5. **Overflow protocol + `orch slice <id>`** (`orch.mjs` fold ingest): CONTEXT-OVERFLOW marker +
   Slice proposal section → atomic validate-convert-ingest; invalid proposals fall to the
   existing failure ladder. *Invariant: no new silent path; slice children pass the full plan
   ingest gauntlet (verifier non-vacuity, fan-in, estimates); attempt only un-burned when the
   proposal validates.*
6. **Scratch ledger** (`orch.mjs` validation + `conductor.mjs` harvest): `.orch/scratch/<id>.md`,
   capped ~2k tokens, carried into successor/planner/deepdive/governor prompts. *Invariant: tree
   stays the sole authoritative memory; ledger is per-node, size-validated, advisory.*
7. **`handleBudgetInterruption` rework** (`conductor.mjs:1276`): harvest ledger + partial
   proposal before reopen; auto-decompose planner briefs carry ledger + outlines; successor
   feedback says "ledger first," not "inspect from zero." *Invariant: WIP-checkpoint semantics,
   no-attempt-burn, and the no-progress terminal all unchanged.*
8. **Read-cap hook** (`hooks/read-cap.mjs` + Claude-family spawn posture wiring). *Invariant:
   posture stays user-owned (custody rule); engine remains mechanism-neutral; codex workers get
   doctrine-only enforcement.*
9. **Budget re-tune** (`orchestrate.config.json` / `budget-policy.mjs` defaults): default 150k,
   deep 300k, per §3.6. *Invariant: hard <500k wall and fail-closed validation unchanged.*
10. **Governor/overseer prompt updates**: recognize CONTEXT-OVERFLOW and ledgers as evidence;
    a governor ruling on a context-blocked node receives the outline map. *Invariant:
    governor authority and the blocker-proof requirement unchanged.*
11. *(Optional)* **Acquisition-spike interrupt** (`sessionBudgetHit`): poll-to-poll ctxToken
    jump > perReadCap → early interrupt with gulp-specific feedback. *Invariant: fail-closed
    metering; strictly earlier and more informative than the 80% kill, never later.*

Items 1–3 are additive enablement (small, immediately useful); 4–5 are the core; 6–7 make
recovery cumulative; 8–11 are enforcement and tuning. Each item is independently landable and
independently testable (manifest/outline are pure functions; slice ingest gets a stub-campaign
test like `test/conduct.mjs`; the interruption rework extends the existing budget tests).

### 3.9 The stopgap question: split the four files first?

Split them eventually — a 72k-token single class is bad for humans too — but **not as the unblocking
move, and not by hand**: (a) splitting a god-file is itself a task current orch cannot run (the
splitter reads the file — §2.5), so "first" would mean a manual or unmetered session doing
exactly the unbounded-context work the thesis forbids; (b) it fixes 4 instances of a class the
very next campaign will meet again. Land items 1–5, then let the campaign split the files *as
sliced leaf work* (each child extracts one outlined symbol group, span by span) — the first real
proof that the general mechanism digests the special case.

---

*Evidence in Part 1 was gathered and verified against fetched primary sources where marked
**[V]**; **[S]**-flagged numbers come from secondary transcriptions and should be re-verified
before quoting outside this repo.*
