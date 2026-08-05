# Provider-Agnostic Campaign State Plan

Status: conditional design agreement; current implementation is a no-go for cross-provider
round-trip continuity until the Phase 0 and smallest-slice gates pass.

This plan was produced on 2026-08-04 and refined on 2026-08-05 from:

- the current tandem fleet implementation and tests;
- the parked Astro Harness music campaign;
- the campaign-state custody rules;
- independent Codex Sol max tandem reviews in
  `tandems/provider-agnostic-engine/` and
  `tandems/provider-agnostic-glass-plane/`.

The music campaign is operationally paused but not yet transactionally parked. Shared-substrate
implementation must not begin until the legacy park precondition is complete.

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
5. Every controller startup has one monotonically increasing controller generation.
6. Every controller mutation carries campaign ID, controller generation, seat ID, body ID, epoch,
   and lease token.
7. Stale controller generations, seat epochs, and lease tokens fail closed.
8. Only the controller writes mutable machine state.
9. Only a signed acceptance-runner attestation can authorize the controller to advance accepted
   state.
10. Models submit commands and immutable reasoning artifacts; they do not write accepted state.
11. External glass agents can submit commands and observations but cannot mutate queue, lease, or
    accepted state directly.
12. An outstanding task is never silently discarded. An uncertain attempt is recorded as
    `outcome=unknown` and must be reconciled before replay.
13. A successful handoff leaves zero or one active body, never two.
14. No ordinary recovery requires a provider transcript.

## 4. Custody Model

### Machine-authoritative

- campaign identity and status;
- owner charter identity and digest;
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
    gate-attestations/<run-id>/
  control/
    snapshots/<snapshot-id>/
      manifest.json
      state.json
    events/<sequence>-<event-id>.json
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
  glass/
    commands/<command-id>.json
    observations/<observation-id>.json
    receipt-events/<command-id>/<sequence>.json
  packets/
    <packet-id>/
      manifest.json
      packet.md
  parks/<park-id>.json
  imports/<import-id>.json
  views/
    CURRENT.md
    QUEUE.md
    GLASS.json
    GLASS.md
```

A controller-owned local SQLite database stores runtime control state:

- seats;
- bodies;
- controller generations and singleton ownership;
- controller store UUID and store-generation ownership;
- epochs and leases;
- lifecycle transactions;
- idempotency keys;
- transactional export outbox;
- indexes over portable artifacts;
- controller events.

The control database must remain on a local disk. It must not live on SMB or another network
filesystem. Portable artifacts remain the recovery source and are exported into the project.
The database and controller signing material must be outside every model body's filesystem write
scope.

The local database is authoritative for ordinary same-host restart. Portable recovery consists of
a signed control snapshot plus the ordered controller-event tail after that snapshot. A database
transaction that changes portable state also appends an outbox record. The exporter writes the
artifact idempotently, verifies it, then marks that outbox record delivered. Restart replays any
undelivered outbox rows before accepting new commands.

## 6. Writer Rules

- Owner or explicit campaign initializer writes `campaign.json`.
- Acceptance runner produces immutable signed gate attestations. Only that principal can authorize
  acceptance advancement.
- Controller performs the atomic acceptance commit: checkpoint, accepted pointer, canonical ref,
  queue transition, and generated views move together or not at all.
- Apex or human writes immutable strategy proposals. Controller alone writes
  `strategy/active.json`.
- Controller alone transitions work-item state.
- Child seat writes its fold; parent writes the fold disposition.
- Owning seat writes its hypothesis; controller appends lifecycle metadata.
- Controller or importer captures immutable raw review bundles.
- Requesting parent writes review reconciliation.
- Evidence collectors write evidence manifests and content-addressed blobs.
- External glass agents submit commands or observations through the authenticated broker.
- Controller writes one immutable portable command or observation file per accepted submission.
- Controller alone writes glass receipt events, transition events, command-status projections, and
  generated operator views.
- Controller builds packets and generated views.

No file has two live writers.

Glass commands are proposals, not engine mutations. Immutable receipt events describe command
lifecycle transitions such as `received | deferred | applied | rejected | failed | stale |
duplicate | invalid`. A generated status projection reports the latest state. Raw glass
observations never enter an apex packet automatically.

### Enforced trust boundary

Writer rules must be enforced by process capability, not documentation:

- Every apex and branch body receives an epoch-scoped worktree and declared write scope.
- The canonical accepted branch is read-only to provider bodies.
- Controller state, lease material, acceptance credentials, and signing keys are inaccessible to
  provider and glass-agent processes.
- The controller alone can merge a candidate commit into the canonical branch, and only while
  consuming a valid signed acceptance-runner attestation.
- Portable controller exports are hash-chained and signed. Direct edits remain visible as
  untrusted drift and cannot be imported silently.
- A fenced body may keep running or writing its abandoned worktree, but it cannot mutate controller
  state, the canonical branch, accepted artifacts, or another epoch's workspace.

On Windows this requires an actual process/account or sandbox boundary. Same-user advisory checks
inside `peer.mjs` are not sufficient.

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

### Controller incarnation

The controller is also replaceable runtime machinery:

1. On startup it acquires exclusive ownership of the campaign's one controller store and atomically
   increments the controller generation.
2. Every issued lease is bound to that controller generation.
3. A clean shutdown reaches `PARKED` with zero active leases before releasing ownership.
4. After a crash, the next controller generation invalidates every lease from the dead generation
   before recovering lifecycle transactions.
5. Two controller processes racing to start cannot both acquire ownership.

This is what permits the full engine process to stop under one provider regime and restart under
another without trusting a surviving provider body.

There is never more than one writable controller store for a campaign. Restoring from portable
state into a replacement store requires an explicit owner-authorized adoption transaction that:

1. verifies the signed snapshot and complete event tail;
2. assigns a new store UUID and store generation;
3. records the prior store as retired;
4. increments the controller generation;
5. fences every prior lease.

A copied database or portable snapshot cannot silently become a second controller.

The supported authority domain is one host. Multi-host active/passive failover is out of scope
because the design deliberately rejects distributed consensus. A replacement store may be adopted
only after the old controller host is offline and its store has produced a signed retirement
record, or after an explicit disaster-recovery ceremony that permanently abandons the old
authority domain. The old host must never be restarted against that campaign afterward.

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
3. freezes the old epoch's worktree as recovery evidence;
4. records the pending packet and candidate specification.

A crash after fencing leaves no apex rather than two apexes. Candidate launch is idempotently
recoverable. Once the candidate is `ACTIVE`, all mutations from the old epoch fail.

The candidate starts without mutation authority. It returns a structured readiness response that
includes the semantic-packet digest and adapter capability result. The controller verifies that
response, then atomically grants the lease and marks the body and seat `ACTIVE`.

Rollback is forward-only. Before `OLD_FENCED`, the transaction may abort and retain the old body.
After `OLD_FENCED`, no old epoch is reactivated. A failed candidate is fenced, its attempt is
recorded, and any replacement receives a newer epoch and lease token. Unknown external side
effects must be reconciled before replay; irreversible operations require idempotency or an
explicit human gate.

The pre-fence abort rule applies only while the same controller generation remains alive. Any
controller crash invalidates all leases from the old generation. Recovery is forward-only even
when the persisted handoff stage was only `PREPARED` or `QUIESCED`; the old body must not be
silently reauthorized.

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

### Body rotation versus full engine stop

Routine Claude-to-Codex or Codex-to-Claude changes are body handoffs. The controller stays active,
the stable apex seat remains unchanged, and the seat epoch advances.

A full engine stop is a campaign park:

1. Quiesce and capture the active attempt.
2. Build and verify the restart packet.
3. Fence every seat and reach zero active leases.
4. Commit the park manifest and controller generation.
5. Stop the controller process.
6. Restart the controller, acquire a new controller generation, and verify the park manifest.
7. Launch a fresh apex body using the selected provider adapter.

"Resume on Claude" means launching a new Claude body for the same apex seat at a new epoch. Warm
resume is forbidden after a provider change, controller-generation change, seat succession, or
apex refresh. Every successor apex uses `launchFresh`. `resumeWarm` is allowed only to reconnect
the same body in the same controller generation, seat epoch, and lease. It never restores
authority by itself. A body from an earlier controller generation or seat epoch remains fenced
even if its provider process is still alive.

## 9A. Glass-Agent Coordination Plane

Owner-driven Claude and Codex chats operate outside the insulated campaign engine. They need a
shared coordination plane, but it must not become a second `CURRENT.md`.

Glass agents may append:

- commands: owner intent, requested provider switch, pause/resume request, or proposed queue action;
- observations: what the outside agent inspected or changed, with evidence and repository anchors.

Each object is one immutable file, never a shared multi-writer JSONL. A command records:

- command ID and idempotency key;
- controller store UUID;
- actor type, provider, session ID, and provenance;
- campaign ID plus the controller generation and seat epoch the actor observed;
- observed accepted checkpoint and queue version;
- intent, scope, evidence references, and timestamp.

Agent-authored commands are proposals. Owner directives use a separate authenticated submission
path and cannot be forged merely by writing a JSON file. Human charter changes always require that
owner path.

The controller writes:

- immutable receipt events and a generated latest-status projection;
- immutable engine events for body activation, fencing, park, resume, accepted checkpoints, and
  queue transitions;
- generated `views/GLASS.json` and `views/GLASS.md` operator views.

When an outside Claude session resumes after Codex ran the engine, it reads `GLASS.json` or
`GLASS.md`, receipt events, and referenced accepted evidence. It can see which provider body held
which epoch, what commands were applied, what checkpoints were accepted, and what remains
unresolved.

The apex packet does not ingest raw glass chatter. It receives only controller-materialized queue
items, acknowledged owner directives, reconciled evidence, and unresolved contradictions selected
by the packet policy. This keeps external coordination transparent without contaminating apex
reasoning.

Glass submission uses a narrow `glass submit` command or equivalent API. The controller imports the
proposal, validates actor class, campaign/store identity, observed versions, and idempotency key,
then writes the receipt and controller event through the transactional outbox. Consumers advance
advisory cursors in local client state outside signed campaign artifacts; they never mark shared
events read or mutate the generated view. Generated views summarize claims and evidence anchors but
never render raw observation text automatically.

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

Use a canonical UTF-8 byte ceiling with a safety reserve and an adapter token preflight. Each seat
has a portability profile sized to the minimum supported apex capacity. Provider adapters may
accept or reject that canonical packet; they may not silently reselect, summarize, or truncate it.

Mandatory content is all-or-fail:

- campaign identity;
- stable seat identity;
- human charter;
- accepted checkpoint;
- observed workspace state;
- active queue item;
- unresolved contradictions;
- packet manifest.

Body ID, seat epoch, controller generation, provider identity, and lease authority are not semantic
packet content. The controller supplies them in a separate activation envelope.

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

### Semantic state versus activation envelope

Provider parity is defined by a stable semantic state digest, not identical prose. The semantic
digest covers canonical encodings of:

- campaign and owner-charter digest;
- accepted checkpoint and gate-evidence digests;
- active strategy IDs and digests;
- queue item IDs, versions, states, attempts, and unknown outcomes;
- review IDs, claim dispositions, and unresolved contradictions;
- selected reasoning-object IDs and digests;
- observed repository HEAD and dirty-state digest.

The activation envelope is separate and intentionally changes across provider switches:

- controller store UUID and generation;
- controller generation;
- seat ID and epoch;
- body ID and an opaque lease-capability reference;
- provider, model, effort, transport, and provider-session provenance;
- packet ID and launch transaction.

Lease secrets are never written into the semantic packet, portable artifacts, model-visible text,
or glass records. The provider adapter or controller-side command proxy attaches authority
out-of-band and exposes only an opaque capability reference to the body.

A Claude-to-Codex-to-Claude round trip with no accepted work must preserve the semantic digest
exactly while changing only activation envelopes and lifecycle events. Output quality is protected
by the same provider-neutral acceptance gates; textual similarity between model responses is not an
acceptance signal.

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
12. Park the full controller under Claude, restart under Codex, park again, and restart under
    Claude. Accepted checkpoint, queue position, review visibility, and artifact hashes must remain
    unchanged except for explicit accepted work.
13. Submit concurrent and stale glass commands. Prove one command identity and ordered receipt-event
    stream per idempotency key, stale commands cannot mutate state, and unacknowledged observations
    never enter an apex packet.
14. Prove a resumed outside Claude session can reconstruct the intervening Codex operations from
    the generated glass view without reading the apex transcript.
15. Leave fenced Claude and Codex bodies alive and attempt direct writes to controller files,
    accepted artifacts, the canonical branch, and the new epoch's worktree. Every attempt must
    fail or remain quarantined outside accepted state.
16. Tamper with a portable event, receipt, and checkpoint. Signature/hash-chain verification must
    reject recovery from the modified artifacts.
17. Crash after each database mutation but before, during, and after portable export. Outbox replay
    must yield one verified artifact and one controller event, never zero or duplicates.
18. Start from a copied database or snapshot while the original store remains live. The second
    controller must fail closed until an owner-authorized adoption retires the original store.
19. Compare semantic digests before Claude -> Codex -> Claude rotation. They must be byte-identical
    unless an acceptance-runner checkpoint explicitly changed semantic state.
20. Fail candidate activation after old-body fencing. Recovery must move forward to a newer epoch,
    never restore authority to the old body.
21. Assert that every provider change, controller-generation change, seat succession, and apex
    refresh invokes `launchFresh` and that `resumeWarm` is rejected.
22. Crash between gate attestation, canonical-ref update, accepted-pointer update, and queue
    transition. Recovery must expose either the old accepted state or the complete new state.
23. Exercise glass `deferred -> applied` and `deferred -> failed` transitions, duplicate
    idempotency keys with the same payload, and duplicate keys with different payloads.
24. Attempt controller startup from a second host and store path. It must fail outside the declared
    single-host authority domain.
25. Repeat acceptance runs to detect timing flakes.

## 15. Smallest Useful Slice

The first accepted slice contains:

1. one stable apex seat with epoch fencing;
2. a controller-owned accepted-state stub;
3. imported Astro system and UX Fable reviews;
4. a bounded deterministic Astro packet;
5. a real fresh Claude-to-Codex handoff;
6. proof that the old epoch is rejected;
7. proof that the new apex can orient without either provider transcript;
8. one full controller park and restart with a new controller generation;
9. a glass command, controller receipt-event stream, transition event, and generated operator view.

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

Only a signed acceptance-runner attestation authorizes accepted-state advancement after a phase
gate. The controller commits the accepted pointer, canonical ref, queue transition, and generated
views atomically. A model verdict can reject a candidate checkpoint or create work, but cannot
accept it.

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
- Advisory-only writer rules while provider bodies share unrestricted access to authoritative
  state and the canonical branch.
- Changing the shared substrate while a campaign is active.
