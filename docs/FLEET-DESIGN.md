# FLEET — minds spawn minds; the engine is a substrate

Status: design agreed 2026-08-02 (Ahmed + Fable session), supersedes the orchestrate engine as the
long-horizon architecture. The orchestrate repo stays parked on its branch as a measurement archive;
nothing in it dispatches work anymore.

BUILD STATUS 2026-08-02: Phases A–D implemented in the tandem repo (write-scope / brief-lint /
fleet-registry / lane-ledger / fleet-doctor modules — all junior-built from sealed briefs and
driver-verified; prepareSwarm gates + registry stamping + TANDEM_FLEET_DIR nesting; `swarm verify`;
`fleet tree|doctor|quota`; TANDEM_PROFILE DeepSeek routing). The orchestrate skill is rewritten as
apex doctrine over these primitives and deployed to workrepo + both agent installs. Deferred:
watch.mjs family-tree view (CLI tree covers the need); the standing §8 validation experiment.

## 1. Provenance — why this shape and not the last one

The orchestrate engine (daemon conductor spawning one-shot workers into a machine-owned tree) was
refuted by its own instruments across ~2.5 weeks:

- MAX campaign: ~$1,113 true cost, 85% coordination, 247 folds, **0 integrated commits**, win-condition
  judge never ran. 77% of attempt-consuming failures harness-manufactured. 33% of folded leaves sat on
  vacuous verifiers. 94% of branches write-contended (muxd.py: 42 concurrent writers).
- Re-acquisition tax dominated: 41% of premium sessions died producing nothing; retry pairs reduced
  acquisition by >10% zero times out of 38; the fixed 700-token fold cap discarded ~83% of what
  children learned.
- Both in-session adversarial reviews concluded the shipped default (decompose everything up front,
  engine judges everything) loses to a monolith at every size tested.

What SURVIVED refutation: off-pool builders ($0.32/proven-leaf deepseek vs $6.83 premium), the vacuity
/prove-red probe (284ms, zero model tokens), fold=integrate (progress = merged commit, nothing else),
the context thesis (small healthy contexts do better work — literature-verified), and the token
ledger / zero-token usage probes.

External research (verified 2026-08-02, live web): orchestrator-worker wins **iff** (a) threads are
genuinely independent, (b) the token multiplier lands on cheap models, (c) apex reasoning stays on one
capable driver. Anthropic's production system: +90.2% over single-Opus on research tasks, ~15x tokens,
token spend explains ~80% of performance variance. Equal-budget studies: mono wins on serially
dependent reasoning at equal tokens. Multi-agent is a CAPABILITY multiplier, not a token saver — the
win condition is scarce-pool spend per integrated unit + wall-clock, never total tokens.

First validation (2026-08-02, mux fleet-save, pre-price-cut): 3 parallel luna@max juniors via this
bridge, sealed briefs, distinct file ownership, ~40% of a 9-file/+1,823-line feature in ~7 min wall
clock, 1.30M input tokens (89% cache), **0.0% of weekly codex quota** by the rollout's own rate_limits
snapshot. Zero rework. The driver did design/integration/UI concurrently.

## 2. The architecture

**The engine spawns nothing, judges nothing, folds nothing.** It is:

1. **Registry** — every session stamped at spawn: id, parent id, charter (the task boundary it was
   forked with), declared write-scope, model/effort, cwd, ledger path. `whoami` / `family` commands
   let any mind read its own position and the live tree. Minds are REQUIRED (doctrine) to check the
   tree before forking — overlap avoidance is a read, not a governor.
2. **Resume watcher** — notices dead/stalled sessions, offers `resume`-by-name with identity intact.
   Never restarts anything on its own judgment.
3. **Ledger** — per-lane token/quota snapshots (trust the provider's rate_limits weighting over raw
   counters), campaign ceiling that HALTS scarce-pool dispatch. Always on.

**Minds do everything else.** A mind at any level may fork children (tandem lanes, any model,
interactive or headless). The parent holds only: its own slice of the problem + the charters it issued
+ the results its children fold up. The CHILD chooses what to fold up (no engine-defined fold layer).
The CALLER judges its family — it has the context and must integrate the work, so judge-as-a-role does
not exist. Adversarial review is pulled in by minds at junctions they choose (tandem doctrine),
never injected by a scheduler.

**Horizontal, not vertical.** Parallel reasoning is only ever across branches of the grand problem —
the same reasoning a mono session would do serially, relocated to fresh small contexts where (per the
context-rot evidence) it executes BETTER than late-mono-context reasoning. Never parallel reasoning on
the same question (that's the swarm tax); redundancy only as deliberately-chosen adversarial review.
Depth is lazy: fork on measured need, not up front. Expect value at depth 1–2; deeper must justify
itself against the measured 2.3x→8.7x coordination amplification curve.

## 3. The three mechanical gates (everything else is doctrine)

Doctrine-only control measurably failed in orch (every advisory rule was bypassed). Keep exactly three
structural gates, all cheap, all individually proven:

- **G1 Progress = integrated commit.** Nothing counts until merged with its verifier green on the
  merge. (The fold≠integrate gap is what let $1,113 burn against zero value.)
- **G2 Vacuity/prove-red probe** on any machine-checked acceptance (port from orch: ~284ms, zero model
  tokens). A check that passes without the work proves nothing — 33% of orch's folds failed this.
- **G3 Ledger + write-scope.** Fork-time mechanical check: a child's declared write-scope may not
  overlap a live sibling's. Plus the always-on quota ledger with a hard ceiling.

## 4. The junior-lane contract (validated shape — reuse exactly)

For cliff-prone cheap models (luna-class) and any bounded build task:

- **Sealed brief, zero repo reads.** Frozen contract (exact type names, signatures, property names,
  error semantics), ONE exact file path to create, everything needed inlined. The long-context cliff
  never fires because it is never invited.
- **Distinct file ownership** per concurrent lane (G3 makes this mechanical).
- **Self-verify then driver re-verify.** Brief names the verification command; the lane runs it before
  reporting; the driver re-runs it before trusting. A lane's self-graded scoreboard has the standing
  of an untested hypothesis.
- **Ambiguity is reported, not hidden** — the brief demands judgment calls be listed.
- Integration, architecture, and anything requiring repo-wide reading stays with the driver or a
  sol/opus-tier mind.

## 5. Model economics (verified 2026-08-02 — re-benchmark, never assume)

- Luna cut 80% (2026-07-30): $0.20/$1.20 per M. Luna@max ≈ near-frontier agentic coding
  (AA Coding Agent Index: luna 74.6 / fable-5 77.2 / terra 77.4 / sol 80).
- DeepSeek V4 GA (2026-07-20): Flash $0.0868/$0.1736 (off-peak lower), 1M ctx; V4-Pro 80.6%
  SWE-bench Verified (best open-weight).
- Fleet-save measurement: luna@max juniors ≈ free on subscription quota (0.0% weekly after 1.30M
  input, 89% cached). Caveat: that is the provider's cache-weighted accounting on one plan on one
  day — keep logging per-lane rate_limits snapshots; the standing metric is **$/proven-leaf and
  scarce-pool-tokens/proven-leaf**, re-measured per candidate model (the old luna@medium 22%-proven
  number is obsolete on price AND configuration; sonnet 12% stands until remeasured).

## 6. The six planes and their interaction rules

- **GOAL** — `GOAL.md`, written once (human + apex), change-controlled. Charters quote the ONE line
  of their parent charter they serve → provenance chain to the goal without re-injecting it anywhere.
- **AGENTS** — by context posture, tier decision FINAL (2026-08-02, all seats config-owned):
  **Deep tier = fable-high, OUT of the critical path and OUT of the engine.** Fable is never
  engine-scheduled (a mandatory fable pass would be the engine choosing when deep intelligence
  happens — the governor pattern again). Instead it is APEX DOCTRINE, written into the apex's
  system prompt/charter: the apex KNOWS it is opus, knows what fable is for, and before wave 1
  opens an INTERACTIVE fable tandem to co-plan and adversarially pressure-test the campaign plan
  (decomposition seams, write-partition, risk map, junior-brief patterns) — a dialogue, not a
  monologue: opus does acquisition + drafting cheap, fable's expensive turns land only on judgment
  deltas (the arm-C/E relocation result applied at the planning layer; also this design session's
  own working shape). At wave boundaries and junctions the APEX judges worthy, it consults fable
  again — fire-and-continue, binding-on-arrival (verdict must be reconciled at the next junction);
  fable capped/refused → noted in ledger, campaign proceeds on opus judgment — coverage degrades,
  never throughput. Tandem discipline applies: bring fable problems and drafts, never conclusions
  to bless; divergence is the prize. The ONE hard rule, enforced at the seam not the scheduler:
  irreversible junctions (configurable: merge-to-master, deploy, major-refactor commitment) — the
  integrate helper refuses without a deep-review token or an explicit owner waiver.
  **Apex = opus-5-high, standing.** Fold-diet: reads PLAN.md + charters + branch folds ONLY — no
  repo reads, no shell — working set ~30–60k high-signal; rehydrates from the docs plane in one
  turn (the seat is a resumable identity, not a process). Event-driven, never on a clock: deep/apex
  spend that scales with time instead of work was the old engine's worst measured term.
  **Branch minds = opus-5 ladder** (medium/high by gnarliness; persistent tandem peers, one per
  branch of the problem; own a charter + worktree + family folder; integrate and judge their
  juniors; may fork sub-families; drive the swarms; PULL the apex at junctions — the apex never
  polls; summon adversarial review at junctions they choose). sol@xhigh branch minds remain a
  CONFIG option for large codex plans; on the owner's $20 codex plan the codex quota is reserved
  entirely for luna swarms. Luna-class NEVER sits in a branch seat at any price: branch minds do
  scoped repo reads, and that is the cliff.
  **Juniors = luna@max / V4-Flash** (ephemeral swarm lanes; one sealed brief, one task, dead after
  the verdict; fresh by default — "swarms of agents, not swarms of tasks for an agent"; reuse a lane
  only when a follow-up needs its acquired context, which sealed briefs make rare; effectively free
  on quota — stop counting their tokens, count only $/proven-leaf).
- **ENGINE** — registry + resume watcher + ledger + gates. Reads everything, writes only its own
  files. Never spawns, never judges, never folds.
- **DOCS** — the context bus. Per-family folder, ONE WRITER PER FILE: `charter.md` + `contracts/`
  (parent writes), `folds/<child>.md` (child writes), `notes.md` (owning mind's own distillate so
  restarts/successors never re-pay acquisition). If it isn't in a file, it doesn't exist to the tree.
- **REPO** — master untouched; one campaign branch; **one worktree per branch mind, NOT per junior**.
  Juniors write contracted paths directly in their parent's worktree (write-scope gate makes
  collision impossible). Integration is continuous inside each family, upward only through gates —
  kills both orch catastrophes (worktree explosion, merge-later apocalypse) at once.
- **CONTEXT** — down: charter + contracts sealed and sized to the child (juniors: everything inlined,
  zero acquisition rights; branch minds: a scope they may read within). Up: folds whose content the
  CHILD chooses; the parent bounces bad folds (judgment, not a validator). Lateral: parent-relayed
  only. Ambient: registry reads. Reasoning parallelizes only across branches; the only sanctioned
  redundancy is deliberately-summoned adversarial review.

## 7. Build order

- **Phase A — swarm-grade juniors** (first; fleet-save made repeatable):
  swarm.json v2 lanes `{brief|briefFile, model, effort, writes[], verify, cwd}` with mandatory
  `writes[]` + overlap refusal at dispatch (G3); ephemeral one-`codex exec`-per-lane dispatch (no
  serve daemon), streamed verdicts, fast re-dispatch waves; `swarm verify` = driver-side re-run of
  every lane's declared verifier (the trust gate as a verb); `swarm brief-lint` = mechanical §4
  conformance (frozen-contract block, exact paths, self-check cmd, ambiguity section, no
  search-the-repo phrasing); per-lane rate_limits snapshot → family ledger at lane end.
- **Phase B — family registry**: parent edges + charter + write-scope in lane records; `peer.mjs
  whoami|family`; nested registration under the parent's node (TANDEM_STATE isolation already
  carries most of it). Plus DeepSeek `--profile` passthrough + real-completion preflight.
- **Phase C — orch reborn as doctrine**: rewrite the orchestrate SKILL to drive these primitives
  (apex doctrine: fold reading, charter writing, fork-vs-hold, when to summon review; family-folder
  conventions; the gates). The old engine contributes exactly three ports: vacuity/prove-red probe,
  integrate-on-accept helper, usage probes. Everything else in bin/ stays parked.
- **Phase D — fleet verbs + resume watcher**: tree-rendered watch; fleet status/pause/kill-subtree;
  dead-session detection with resume-by-name (salvage guard/campaign-notify's detection, none of its
  judgment).
- Comms stay parent-mediated throughout. No sibling bus until a real need appears — the parent IS
  the compression boundary.

## 8. Standing validation gate

Before believing any scale-up: one real scoped task (WASM emulator subsystem), run mono vs depth-1
family, same meter, compare scarce-pool $/integrated-leaf + wall-clock. Fleet-save is n=1 in favor;
the doctrine is measure-then-trust.
