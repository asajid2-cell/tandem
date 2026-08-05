# Provider-Neutral Custody Loops

> Baseline notes can age. `.provider-neutral/CURRENT.md`, written only by
> `tools/run-provider-gates.ps1`, is authoritative.

## Grand Goal Contract

- Astro has an immutable park manifest proving its legacy apex daemon stopped.
- One stable apex seat survives Claude -> Codex -> Claude controller restarts.
- Every successor is a fresh body with a newer controller generation and seat epoch.
- The semantic digest is identical across provider changes when no accepted work changes.
- A stale body cannot mutate accepted state or warm-resume after succession.
- Existing Fable reviews are immutable packet inputs and require no live Fable call.
- Glass commands and lifecycle events are durable and visible outside apex packets.
- Recovery succeeds after provider transcript artifacts are deleted.

## Loop Contracts

### L0 - Legacy Park

Invariant: Astro is stopped with zero active label-bound daemons and a committed evidence manifest.

Verifier: park manifest `verification.park_complete=true`, PID dead, heartbeat disabled.

Status: done. Astro commit `082e4bd`; manifest SHA-256
`086eb33890cb2b9a4cac50bdc33d36543c946ae310b8a8e6eaf6a5e403dc2745`.

### L1 - Baseline Succession

Invariant: apex refresh launches a different provider body instead of recovering the old group.

Verifier: `node --test --test-concurrency=1 test/apex-gate-live.test.mjs`.

Status: done. Red observed at the fresh-session assertion; root cause was missing group
detachment plus a test fixture that relaunched a fake fresh body at 800k context. The verifier now
requires the successor session ID to differ and passes.

### L2 - Provider-Neutral Controller

Invariant: controller generation, seat epoch, body lease, park, restart, reviews, packets, and
glass records are provider-neutral durable state.

Verifier: `node --test --test-concurrency=1 test/provider-custody.test.mjs`.

Status: done. The verifier was observed red with `ERR_MODULE_NOT_FOUND`, then green with three
controller generations, three seat epochs, stable semantic digest, stale-authority rejection,
Ed25519 gate verification, readiness proof, park tamper rejection, glass isolation, and recovery
after deletion of an imported review's provider source.

### L3 - Acceptance Custody

Invariant: one command runs the gate chain, stores evidence, and alone rewrites
`.provider-neutral/CURRENT.md`.

Verifier: `powershell -ExecutionPolicy Bypass -File tools/run-provider-gates.ps1 -Tag <tag>`.

Status: done. `pn-slice1-20260805` passed all focused gates; a final post-commit run records the
accepted HEAD.

### L4 - Astro Review Import

Invariant: the system and UX Fable reviews are immutable review bundles selected into the Astro
apex packet without reading provider transcripts.

Verifier: importer hash audit plus packet test against the parked Astro files.

Status: done for the system and UX audits. Astro commit `536a43c` contains both immutable review
bundles; their copied verdict SHA-256 values exactly match the committed audit files.

### L5 - Adversarial Synthesis

Invariant: a fresh Sol-max reviewer cannot refute the round-trip continuity claim with a concrete
counterexample.

Verifier: durable tandem verdict and driver rerun of every cited command.

Status: done for slice 1. Sol-max independently reproduced the stale-body resurrection and found
three weaknesses in the first controller draft. All three were resolved before acceptance. Durable
review: `docs/reviews/provider-neutral-impl-sol-max.md`.

### L6 - Production Adapter Round Trip

Invariant: the controller, not `peer.mjs` or `serve.mjs`, owns a real fresh
Claude -> Codex -> Claude activation sequence, and each provider returns packet-bound readiness
before receiving authority.

Verifier: one live run records three distinct provider session IDs, controller generations and
seat epochs; old bodies remain alive long enough to prove their authority is fenced; the final
Claude packet has the same semantic digest as the first packet; imported transcript sources are
unavailable during the final launch.

Status: BLOCKED for the full round trip. Slice 1 provides the controller contract, CLI, readiness
gate, park verification, and fake-adapter proof. Production adapter integration is not yet routed
through this controller, and a fresh Claude body is unavailable while the five-hour limit is
exhausted. Astro remains safely parked rather than being resumed through a half-integrated path.

## Progress

- 2026-08-05: Astro parked transactionally before shared-substrate edits.
- 2026-08-05: isolated worktree created at
  `C:\Users\Ahmed\worktrees\tandem-provider-neutral`, branch `provider-neutral-custody`.
- 2026-08-05: live failure showed deletion of `claude.session` did not fence the old pairing in
  `groups.json`; the successor resumed the same session.
- 2026-08-05: Astro provider-neutral custody committed at `536a43c`, parked at semantic digest
  `e4c52dd8fbeec1eb1b455832cb335fc88f8689475ce85ece4a48afc948e4dbbe`.

## Learnings

- A missing session pointer does not imply a fresh body; pair registries can silently restore it.
- Clean worktrees expose tests that accidentally rely on ignored local configuration.
- Semantic state and activation authority must be separate objects with separate digests.
