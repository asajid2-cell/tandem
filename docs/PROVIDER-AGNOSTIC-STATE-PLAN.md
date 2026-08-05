# Provider-Agnostic Campaign State Plan

Status: design plan, no implementation accepted yet.

This plan was produced on 2026-08-04 from:

- the current tandem fleet implementation and tests;
- the parked Astro Harness music campaign;
- the campaign-state custody rules;
- an independent Codex Sol max tandem review in
  `tandems/provider-agnostic-engine/`.

The music campaign remains parked while this work changes the shared substrate.

## 1. Goal

Any logical fleet seat must be able to continue under a new provider, model, process, or
interaction mode without replaying chat history or trusting recursive summaries.

This applies to:

- the apex;
- persistent branch minds;
- adversarial reviewers;
- ephemeral builder lanes.

The durability unit differs by role:

- Apex and branch minds preserve accepted state, queue position, decisions, unresolved
  hypotheses, child results, and current work.
- Reviewers preserve the exact request, exact verdict, provenance, claims, anchors, and the
  requesting parent's reconciliation.
- Builders preserve the sealed brief, exact writes, captured verdict, diff, and verifier
  evidence. Resuming the original builder context is optional; reproducing the task under a
  replacement model is mandatory.

Provider transcripts are archival evidence and possible import sources. They are not runtime
memory and ordinary recovery must not depend on them.

## 2. Current Defects

1. Apex rehydration, context metering, dump actuation, refresh, and pump breaking are attached
   to the Claude `serve.mjs` path.
2. The Codex path still uses summary compaction and summary-seeded recovery near context limits.
3. `CURRENT.md` is model-authored. Only entries in `verified[]` receive a shallow evidence-shape
   check; goal and next-state prose can become stale.
4. The packet builder can exceed its nominal budget while still passing `verifyBrief()`.
5. Refresh and succession are not transactional. Seat succession is best-effort bookkeeping.
6. Registry identity mixes logical fleet identity with provider session identity and has no
   fenced generation.
7. Reviews are prose files and mutable job records, with no common durable identity,
   reconciliation, supersession, or selection contract.
8. The focused baseline run on 2026-08-04 passed 62/63 tests. The live refresh test failed its
   fresh-body succession assertion once, and an isolated retry did not complete within 64
   seconds. Baseline stability is phase zero.

## 3. Invariants

1. A campaign has exactly one stable apex seat ID.
2. A seat ID is never a provider session ID.
3. Every provider body belongs to one seat and one monotonically increasing seat epoch.
4. At most one body holds a seat's fenced lease.
5. Every controller mutation carries campaign ID, seat ID, body ID, epoch, and lease token.
6. Stale epochs fail closed.
7. Only the controller writes mutable machine state.
8. Only the acceptance runner advances accepted state.
9. Models submit commands and immutable reasoning artifacts; they do not write accepted state.
10. An outstanding task is never silently discarded. An uncertain attempt is recorded as
    `outcome=unknown` and must be reconciled before replay.
11. A successful handoff leaves zero or one active body, never two.
12. No ordinary recovery requires a provider transcript.

## 4. Custody Model

### Machine-authoritative

- campaign identity and status;
- accepted checkpoint and gate evidence;
- observed repository HEAD and tree state;
- queue state transitions;
- stable seats, body epochs, leases, and lifecycle transactions;
- immutable review capture metadata;
- packet manifests and hashes;
- generated views.

### Model-authored reasoning

- plans;
- charters and contracts;
- hypotheses and ruled-out hypotheses;
- folds;
- raw review verdicts;
- review reconciliations;
- ambiguity reports;
- proposed queue actions.

Model reasoning can create work and evidence. It cannot advance accepted state directly.

## 5. Durable Hierarchy

Portable campaign artifacts live under the project:

```text
.campaign/
  campaign.json
  HANDOFF.md
  accepted/
    current.json
    checkpoints/<checkpoint-id>.json
    gates/<run-id>/
  strategy/
    active.json
    plans/<plan-id>.md
  work/
    items/<item-id>.json
    events/<item-id>/<sequence>.json
    outcomes/<item-id>/<attempt-id>.json
  reasoning/
    folds/<fold-id>.json
    fold-dispositions/<fold-id>.json
    hypotheses/<hypothesis-id>.json
    hypothesis-events/<hypothesis-id>/<sequence>.json
  reviews/
    raw/<review-id>/
      manifest.json
      prompt.md
      verdict.md
    reconciliations/<reconciliation-id>.json
    status/<review-id>.json
  evidence/
    manifests/<evidence-id>.json
    blobs/sha256/<hash>
  packets/
    <packet-id>/
      manifest.json
      packet.md
  parks/<park-id>.json
  imports/<import-id>.json
  views/
    CURRENT.md
    QUEUE.md
```

A controller-owned local SQLite database stores runtime control state:

- seats;
- bodies;
- epochs and leases;
- lifecycle transactions;
- idempotency keys;
- indexes over portable artifacts;
- controller events.

The control database must remain on a local disk. It must not live on SMB or another network
filesystem. Portable artifacts remain the recovery source and are exported into the project.

## 6. Writer Rules

- Owner or explicit campaign initializer writes `campaign.json`.
- Acceptance runner alone writes `accepted/`.
- Fenced apex or human writes strategy artifacts.
- Controller alone transitions work-item state.
- Child seat writes its fold; parent writes the fold disposition.
- Owning seat writes its hypothesis; controller appends lifecycle metadata.
- Controller or importer captures immutable raw review bundles.
- Requesting parent writes review reconciliation.
- Evidence collectors write evidence manifests and content-addressed blobs.
- Controller builds packets and generated views.

No file has two live writers.

## 7. Seat and Body Lifecycle

Seat states:

```text
vacant -> activating -> active -> quiescing -> parked
                                      \-> retired
```

Body states:

```text
allocated -> starting -> ready -> active -> fenced -> retired
                               \-> lost
                               \-> orphaned
```

The controller, not the provider adapter, owns these transitions.

Every adapter implements idempotent operations:

```text
capabilities()
launchFresh(operationId, bodySpec, packetRef)
resumeWarm(operationId, providerRef)
sendTurn(operationId, providerRef, turnRef)
observe(providerRef, cursor)
checkpoint(providerRef, reason)
interrupt(providerRef, turnRef)
retire(providerRef, reason)
discover(operationId | bodyId)
```

Capabilities state whether the adapter supports:

- warm resume;
- exact, estimated, or unavailable context measurement;
- clean, best-effort, or unavailable checkpointing;
- interruption;
- interactive attachment;
- provider-session discovery;
- actual model and effort provenance;
- transcript export.

Warm resume is an optimization. Fresh launch from a durable packet is the portability
requirement.

## 8. Transactional Handoff

Every handoff uses a durable transaction:

```text
PREPARED
  -> QUIESCED
  -> PACKET_BUILT
  -> OLD_FENCED
  -> CANDIDATE_STARTING
  -> CANDIDATE_READY
  -> ACTIVE
  -> DONE
```

Before `OLD_FENCED`, the old body remains authoritative and the transaction can retry or abort.

At `OLD_FENCED`, one controller transaction:

1. increments the seat epoch;
2. revokes the old lease;
3. records the pending packet and candidate specification.

A crash after fencing leaves no apex rather than two apexes. Candidate launch is idempotently
recoverable. Once the candidate is `ACTIVE`, all mutations from the old epoch fail.

## 9. Campaign Park and Resume

Park:

1. Write `PARKING` intent.
2. Freeze new dispatch.
3. Record every running or uncertain attempt.
4. Checkpoint bodies where supported.
5. Build and hash the park packet.
6. Fence all seats.
7. Retire or mark provider bodies orphaned.
8. Commit `PARKED` only when active lease count is zero.

Resume:

1. Verify park-manifest hashes.
2. Compare recorded repository state with current repository state.
3. Open a reconciliation item for any drift.
4. Build a fresh apex packet.
5. Activate the apex first.
6. Restore other seats only when their work becomes active.

A long park must remain resumable even when every provider session has expired.

## 10. Durable Review Objects

The raw review bundle is immutable.

`manifest.json` records:

- review ID and review type;
- exact prompt path and hash;
- exact verdict path and hash;
- requested scope and baseline;
- structured claim index;
- source anchors;
- requester seat, body, and epoch;
- reviewer seat, body, and epoch;
- provider, transport, requested and actual model and effort;
- provider session and dispatch IDs;
- timestamps and duration;
- transcript reference and hash;
- import provenance;
- content-normalization rules used during import.

`status/<review-id>.json` is controller-owned and carries:

- `unindexed | unreconciled | reconciled | superseded | invalid`;
- supersession edges;
- reconciliation IDs;
- validation or import warnings.

A parent-authored reconciliation classifies every claim:

```text
accepted | rejected | deferred | duplicate | stale
```

It records rationale, evidence references, queue actions, and unresolved contradictions.

Successor packets normally include reconciliation summaries and unresolved claim indexes. Raw
verdict text is included only when:

- reconciliation is still required;
- a high-severity claim is unresolved;
- reviews conflict;
- active work directly touches the review scope;
- the review is explicitly pinned.

## 11. Deterministic Packet Builder

Use a canonical UTF-8 byte ceiling with a safety reserve and an adapter token preflight.

Mandatory content is all-or-fail:

- campaign identity;
- seat, body, and epoch;
- human charter;
- accepted checkpoint;
- observed workspace state;
- active queue item;
- unresolved contradictions;
- packet manifest.

Remaining budget is allocated deterministically:

- 40 percent: active plan and direct child folds;
- 35 percent: relevant reviews and reconciliations;
- 25 percent: hypotheses and tactical reasoning.

Unused capacity spills forward. Selection order is:

1. scope distance;
2. unresolved before resolved;
3. severity;
4. logical sequence;
5. object ID.

No object is silently truncated. The packet manifest lists selected and omitted objects, reason,
digest, byte count, accepted baseline, observed HEAD, dirty-tree snapshot, and contradictions.

Machine facts defeat contradictory reasoning only inside the facts' proven scope.
Reasoning-versus-reasoning contradictions include both sides. New evidence that contradicts an
accepted checkpoint opens a revalidation item; it does not rewrite accepted history.

## 12. Astro Harness Migration

1. Transactionally park the music campaign at HEAD `713e2be`, including dirty-state and active
   process evidence.
2. Create one stable `astro/apex` seat.
3. Import historical apex provider bodies as bodies, not separate apex nodes.
4. Import legacy `CURRENT.md`, `APEX-INBOX.md`, checkpoints, and notes as reasoning artifacts.
5. Do not treat legacy `CURRENT.md` as accepted state. Seed acceptance from a real gate run or
   mark the campaign `acceptance=unseeded`.
6. Record the stale audit-blocker contradiction explicitly.
7. Import the existing Fable reviews without running a model:
   - `astro-gap-sys`;
   - `astro-gap-ux`;
   - `astro-judge-be`;
   - `astro-judge-ui`;
   - `astro-reason`;
   - relevant earlier engine Fable review tandems.
8. Recover exact prompts from job records or source transcripts, exact verdicts from tandem
   captures or committed verdict files, and proven model/session/dispatch data from the bridge
   logs.
9. Deduplicate by normalized content hash plus provider session and dispatch identity.
10. Mark imported reviews unreconciled unless a durable parent reconciliation already exists.
11. Create an apex queue item to reconcile imported reviews before replanning.
12. Future deep review uses a configured capability tier. Fable and Sol max are providers of the
    capability, not engine branches.

The two committed gap-audit files contain provenance headers followed by the captured Fable
verdicts. Import must preserve both the committed file hash and the raw captured verdict hash.

## 13. Build Order

### Phase 0: Stabilize the baseline

- Reproduce and fix or explain the live refresh/succession test instability.
- Run the full existing suite repeatedly.
- Record a clean baseline through a new engine acceptance runner.

### Phase 1: Schemas and pure logic

- Define campaign, seat, body, lease, work-item, review, reconciliation, evidence, packet, park,
  and lifecycle schemas.
- Add schema validation and invariant/property tests.
- Implement deterministic review selection and packet construction as pure functions.

### Phase 2: Controller custody

- Build the local controller store.
- Add stable seats, monotonic epochs, fenced leases, idempotency keys, and the one-apex
  constraint.
- Generate portable event artifacts and views.

### Phase 3: Reviews and legacy import

- Capture new reviews automatically.
- Implement the local tandem/transcript importer.
- Import the Astro Fable reviews and validate hashes and provenance.

### Phase 4: Provider adapters

- Wrap current Claude, Codex, and interactive paths behind the adapter contract without changing
  behavior.
- Add conformance tests with fake adapters before routing production calls through them.

### Phase 5: Handoff, park, and resume

- Implement the lifecycle transaction and crash recovery.
- Add park/resume commands and manifests.
- Preserve uncertain outstanding tasks.

### Phase 6: Provider-neutral policy

- Move context rotation, dump verification, rehydration, pump breaking, and parking out of
  `serve.mjs`.
- Drive policy from generic adapter observations and controller state.
- Disable summary compaction for every apex, regardless of provider.

### Phase 7: Astro migration and live proof

- Park and import the campaign.
- Activate a fresh Codex Sol apex from the bounded packet.
- Reconcile imported Fable reviews.
- Resume the music work only after every cross-provider gate passes.

## 14. Acceptance Experiments

1. Crash-inject every lifecycle stage. Restart must yield zero or one apex, never two.
2. Race two controllers and two apex starts. Exactly one lease wins.
3. Prove stale epochs cannot mutate queue, accepted state, reviews, or indexes.
4. Prove fabricated model evidence cannot advance accepted state.
5. Prove the Astro packet remains within budget, includes both gap audits and `4f270ff`, and
   tombstones the stale blocker.
6. Prove reconciled reviews omit raw text while unresolved scoped reviews remain visible.
7. Prove pending tasks survive dump, park, provider limit, and handoff.
8. Perform real Claude -> Codex Sol max -> headful PTY succession.
9. Plant an unwritten nonce before handoff. It must disappear; durable state must survive.
10. Delete imported provider transcripts and prove normal rehydration still succeeds.
11. Leave an old body alive after handoff and prove it is fenced and reported orphaned.
12. Repeat acceptance runs to detect timing flakes.

## 15. Smallest Useful Slice

The first accepted slice contains:

1. one stable apex seat with epoch fencing;
2. a controller-owned accepted-state stub;
3. imported Astro system and UX Fable reviews;
4. a bounded deterministic Astro packet;
5. a real fresh Claude-to-Codex handoff;
6. proof that the old epoch is rejected;
7. proof that the new apex can orient without either provider transcript.

Do not build branch-mind restoration, PTY rotation, or all legacy review imports before this slice
passes. The slice must prove the central thesis first.

## 16. Migration Fleet Regime

The migration itself uses the provider-neutral role split before the engine can enforce it:

- `engine/apex` is the stable logical apex seat. Its normal body is Codex Sol at high effort so
  integration and implementation do not spend max-tier reasoning on routine turns.
- `engine/reviewer` is an independent review seat. Use Codex Sol max at phase gates, lifecycle
  design junctions, and before retiring legacy custody paths.
- Existing Fable sessions are imported as immutable review objects. They remain first-class
  evidence even when no new Fable body can be launched.
- New Fable review, when available, and Sol max review are two providers of the same deep-review
  capability. Neither receives a provider-specific engine path.
- Luna max lanes perform sealed extraction, fixture construction, schema boilerplate, adapter
  shims, and bounded implementation work. They never own lifecycle policy, reconciliation, or
  acceptance.
- The apex integrates every lane and reruns its verifier. The reviewer attempts to refute the
  integrated result from a fresh packet rather than inheriting the apex transcript.

The apex body may move from Sol high to Sol max for a specific junction without changing the seat.
The engine must record requested and actual model and effort as body provenance, not campaign
identity.

## 17. Legacy Park Precondition

Astro must be durably quarantined before implementation changes the shared substrate:

1. Freeze heartbeat and dispatch.
2. Capture the repository HEAD, porcelain status, untracked-file inventory, campaign-file hashes,
   tandem job/session hashes, scheduled-task state, and matching live processes.
3. Treat every legacy registry `live` flag as untrusted. Reconcile it against process and job
   evidence; preserve the contradiction rather than rewriting history.
4. Record all outstanding work as `none`, `known`, or `unknown`. `unknown` blocks automatic replay.
5. Stop only the identified Astro apex daemon through its provider adapter or existing bridge.
6. Re-scan processes and prove no Astro body or heartbeat remains active.
7. Write an immutable legacy park manifest with pre-stop and post-stop evidence and content hashes.
8. Mark the snapshot `acceptance=unseeded`; it is recovery evidence, not accepted campaign state.

The old provider sessions and transcripts remain available for forensic import, but resume must
launch a fresh body from the new packet path. Whole-machine session capture is optional operational
insurance and is not a substitute for the campaign park manifest.

## 18. Phase Gates And Ownership

Every phase lands as a separate accepted checkpoint:

| Phase | Apex deliverable | Independent gate |
|---|---|---|
| Legacy park | immutable Astro park manifest, zero active Astro processes | re-scan and hash verification |
| Baseline | stable repeated existing suite and acceptance runner | Sol-max flake/root-cause review |
| Schemas | validated schemas and invariant/property tests | malformed/stale-epoch adversarial fixtures |
| Controller | one-apex lease, epochs, idempotency, portable events | race and crash-injection suite |
| Reviews | importer plus immutable bundles and reconciliations | Fable fixtures and hash/provenance audit |
| Packets | deterministic bounded builder | omission, contradiction, and budget fixtures |
| Adapters | Claude, Codex, and PTY conformance | fake-adapter fault matrix |
| Lifecycle | transactional handoff, park, and resume | failpoint restart matrix |
| Astro proof | fresh Codex apex, imported reviews, no transcript dependency | cross-provider acceptance experiments |

Only the acceptance runner updates accepted state after a phase gate. A model verdict can reject a
candidate checkpoint or create work, but cannot accept it.

## 19. Rejected Designs

- Adding more provider branches inside `peer.mjs` or `serve.mjs`.
- Treating transcripts as memory.
- Model-written `CURRENT.md`.
- A second `seats.json` beside a competing registry.
- Silent truncation or sentinel-only packet validation.
- Treating "no tool calls" as a universal definition of no progress.
- Automatic semantic reconciliation of reviews.
- Mandatory provider brands in campaign logic.
- Distributed consensus.
- Controller SQLite on a network drive.
- Changing the shared substrate while a campaign is active.
