import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAcceptedCheckpoint,
  buildSemanticPacket,
  canonicalJson,
  createCampaign,
  importReview,
  launchFresh,
  parkController,
  readController,
  resumeWarm,
  startController,
  submitGlassCommand,
  verifyParkManifest,
} from "../bin/provider-custody.mjs";

const fresh = () => mkdtempSync(join(tmpdir(), "provider-custody-"));

function acceptanceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKey,
  };
}

function launchReady(root, spec, providerSessionId) {
  return launchFresh(root, {
    ...spec,
    readiness: {
      packetDigest: buildSemanticPacket(root).semantic_digest,
      provider: spec.provider,
      model: spec.model,
      providerSessionId,
      capabilities: { launchFresh: true },
    },
  });
}

function signedGate(root, privateKey, checkpoint, gateDigest = "gate-digest") {
  const state = readController(root);
  const payload = {
    campaign_id: state.campaign_id,
    store_uuid: state.store_uuid,
    previous_checkpoint: state.semantic.accepted_checkpoint,
    checkpoint,
    gate_digest: gateDigest,
  };
  return {
    kind: "signed-gate",
    payload,
    signature_base64: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64"),
  };
}

test("Claude -> Codex -> Claude preserves semantic state and fences every old body", () => {
  const root = fresh();
  const keys = acceptanceKeys();
  createCampaign(root, {
    campaignId: "astro",
    seatId: "astro/apex",
    charterDigest: "charter-v1",
    acceptedCheckpoint: "082e4bd",
    acceptancePublicKeyPem: keys.publicKeyPem,
    queue: [{ id: "reconcile-fable-reviews", state: "ready", version: 1 }],
  });

  const c1 = startController(root);
  assert.equal(c1.controller_generation, 1);
  const transcript = join(root, "legacy-fable-transcript.jsonl");
  writeFileSync(transcript, "provider-only history\n");
  importReview(root, {
    reviewId: "astro-gap-sys",
    prompt: "Audit the system architecture.",
    verdict: "Preserve the parity seam and remove the stale blocker.",
    provider: "claude",
    model: "fable",
    sessionId: "legacy-fable-system",
    sourcePath: transcript,
  });
  assert.doesNotThrow(() =>
    importReview(root, {
      reviewId: "astro-gap-sys",
      prompt: "Audit the system architecture.",
      verdict: "Preserve the parity seam and remove the stale blocker.",
      provider: "claude",
      model: "fable",
      sessionId: "legacy-fable-system",
    }),
  );
  importReview(root, {
    reviewId: "astro-gap-ux",
    prompt: "Audit the product experience.",
    verdict: "Keep the pipeline integration visible to the apex.",
    provider: "claude",
    model: "fable",
    sessionId: "legacy-fable-ux",
  });

  const claude1 = launchReady(
    root,
    { provider: "claude", model: "opus", effort: "xhigh" },
    "claude-body-1",
  );
  assert.equal(claude1.operation, "launchFresh");
  assert.equal(claude1.activation.controller_generation, 1);
  assert.equal(claude1.activation.seat_epoch, 1);
  assert.match(claude1.packet.text, /astro-gap-sys/);
  assert.match(claude1.packet.text, /astro-gap-ux/);
  const semanticDigest = claude1.packet.semantic_digest;
  const staleClaudeAuthority = claude1.authority;

  const park1 = parkController(root, { reason: "switch to codex" });
  assert.equal(verifyParkManifest(park1.path), true);
  rmSync(transcript);

  const c2 = startController(root);
  assert.equal(c2.controller_generation, 2);
  const codex = launchReady(
    root,
    { provider: "codex", model: "sol", effort: "max" },
    "codex-body-1",
  );
  assert.equal(codex.packet.semantic_digest, semanticDigest);
  assert.equal(codex.activation.seat_epoch, 2);
  assert.notEqual(codex.activation.body_id, claude1.activation.body_id);
  assert.throws(
    () =>
      resumeWarm(root, {
        bodyId: staleClaudeAuthority.body_id,
        controllerGeneration: staleClaudeAuthority.controller_generation,
        seatEpoch: staleClaudeAuthority.seat_epoch,
        leaseRef: staleClaudeAuthority.lease_ref,
      }),
    /stale|fenced/i,
  );
  assert.throws(
    () =>
      applyAcceptedCheckpoint(root, staleClaudeAuthority, {
        checkpoint: "must-not-land",
        attestation: { kind: "signed-gate", valid: true, digest: "fake" },
      }),
    /stale|fenced/i,
  );

  const glass = submitGlassCommand(root, {
    commandId: "glass-switch-1",
    idempotencyKey: "switch-codex-to-claude",
    actor: { type: "owner-agent", provider: "codex", sessionId: "outside-codex" },
    intent: "park and resume on Claude",
    observed: {
      controllerGeneration: 2,
      seatEpoch: 2,
      acceptedCheckpoint: "082e4bd",
    },
  });
  assert.equal(glass.status, "received");
  assert.equal(buildSemanticPacket(root).semantic_digest, semanticDigest, "raw glass input is not apex memory");
  const glassView = readFileSync(join(root, "views", "GLASS.md"), "utf8");
  assert.match(glassView, /outside-codex/);
  assert.match(glassView, /body-activated/);

  const park2 = parkController(root, { reason: "switch back to claude" });
  assert.equal(verifyParkManifest(park2.path), true);
  const c3 = startController(root);
  assert.equal(c3.controller_generation, 3);
  const claude2 = launchReady(
    root,
    { provider: "claude", model: "opus", effort: "xhigh" },
    "claude-body-2",
  );
  assert.equal(claude2.packet.semantic_digest, semanticDigest);
  assert.equal(claude2.activation.seat_epoch, 3);
  assert.notEqual(claude2.activation.body_id, codex.activation.body_id);

  const state = readController(root);
  assert.equal(state.seat.id, "astro/apex");
  assert.equal(state.seat.epoch, 3);
  assert.equal(state.seat.body.provider, "claude");
  assert.equal(existsSync(transcript), false, "normal recovery cannot depend on provider transcripts");
});

test("park manifests are self-verifying and tampering fails closed", () => {
  const root = fresh();
  const keys = acceptanceKeys();
  createCampaign(root, {
    campaignId: "tamper-proof",
    seatId: "apex",
    charterDigest: "c",
    acceptedCheckpoint: "a",
    acceptancePublicKeyPem: keys.publicKeyPem,
    queue: [],
  });
  startController(root);
  launchReady(root, { provider: "codex", model: "sol", effort: "high" }, "codex-tamper");
  const park = parkController(root, { reason: "test" });
  assert.equal(verifyParkManifest(park.path), true);
  const parsed = JSON.parse(readFileSync(park.path, "utf8"));
  parsed.semantic_digest = "tampered";
  writeFileSync(park.path, JSON.stringify(parsed, null, 2));
  assert.equal(verifyParkManifest(park.path), false);
  assert.throws(() => startController(root), /park manifest failed verification/i);
});

test("accepted state advances only under the active fenced authority and a gate attestation", () => {
  const root = fresh();
  const keys = acceptanceKeys();
  createCampaign(root, {
    campaignId: "acceptance",
    seatId: "apex",
    charterDigest: "c",
    acceptedCheckpoint: "old",
    acceptancePublicKeyPem: keys.publicKeyPem,
    queue: [],
  });
  startController(root);
  const body = launchReady(root, { provider: "codex", model: "sol", effort: "high" }, "codex-accept");
  assert.throws(
    () => applyAcceptedCheckpoint(root, body.authority, { checkpoint: "new", attestation: null }),
    /attestation/i,
  );
  applyAcceptedCheckpoint(root, body.authority, {
    checkpoint: "new",
    attestation: signedGate(root, keys.privateKey, "new"),
  });
  assert.equal(readController(root).semantic.accepted_checkpoint, "new");
});
