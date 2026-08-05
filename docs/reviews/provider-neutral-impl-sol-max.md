# Provider-Neutral Slice 1 - Sol Max Review

review_id: provider-neutral-impl-sol-max
provider: codex
model_requested: gpt-5.6-sol
effort_requested: max
provider_session_id: 019fcf7c-5882-77d2-8cbb-bb651148cbbb
source_ledger:
`Z:\328\CMPUT328-A2\codexworks\301\tandem\tandems\provider-neutral-impl-review\TANDEM.md`
status: reconciled

## Verdict

The line-121 failure was a real stale-body resurrection, not a flaky session-file assertion.
Deleting `claude.session` left the old Claude/Codex pairing in `groups.json`; startup preferred
that pairing, resumed the old provider session, and skipped recreating the pointer because the
stream reported the session ID it had already loaded.

The immediate Claude-path fix is to mark the driver detached before daemon exit and verify that
the successor provider session ID differs. Provider-neutral custody still requires a controller
beneath every provider adapter.

## Adversarial Findings

- A caller-supplied `valid: true` field was not a signed acceptance boundary.
- Candidate activation had no packet-bound provider readiness proof.
- The transcript-deletion test removed an unrelated file the importer never depended on.
- The live refresh test used a cooperative fake and did not itself prove crash/race safety.

## Reconciliation

- accepted: stale pairing resurrection. `performApexRefresh()` now calls `markDetached`, and the
  live test requires a different successor session ID.
- accepted: weak attestation. Accepted-state advancement now verifies an Ed25519 signature against
  the controller-held public key.
- accepted: missing readiness proof. `launchFresh` requires provider/model/session capabilities
  bound to the exact semantic packet digest.
- accepted: weak transcript proof. The test now deletes the actual `sourcePath` used by an
  imported review and proves packet reconstruction from the copied immutable bundle.
- deferred: process-account isolation and crash injection across every lifecycle stage. Slice 1
  fails closed at the controller state-machine boundary; OS capability isolation remains a later
  phase gate.
