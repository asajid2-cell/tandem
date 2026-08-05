import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID, verify as verifySignature } from "node:crypto";
import { dirname, join } from "node:path";

const SCHEMA = "provider-custody/v1";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function digestText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function controllerFile(root) {
  return join(root, "controller", "controller.json");
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function immutableWrite(path, value) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing !== text) throw new Error(`immutable artifact conflict: ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function readController(root) {
  const path = controllerFile(root);
  if (!existsSync(path)) throw new Error(`campaign controller is not initialized: ${path}`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state.schema !== SCHEMA) throw new Error(`unsupported controller schema: ${state.schema}`);
  return state;
}

function saveController(root, state) {
  atomicWriteJson(controllerFile(root), state);
  renderGlassViews(root, state);
  return state;
}

function appendEvent(root, state, type, detail = {}) {
  state.sequence += 1;
  const event = {
    schema: "provider-custody-event/v1",
    sequence: state.sequence,
    event_id: randomUUID(),
    type,
    campaign_id: state.campaign_id,
    controller_generation: state.controller_generation,
    seat_id: state.seat.id,
    seat_epoch: state.seat.epoch,
    created_at: new Date().toISOString(),
    detail: canonicalValue(detail),
  };
  immutableWrite(
    join(root, "events", `${String(event.sequence).padStart(8, "0")}-${event.event_id}.json`),
    event,
  );
  state.events.push(event);
  return event;
}

function renderGlassViews(root, state) {
  const commands = Object.values(state.glass.commands).sort((a, b) =>
    a.command_id.localeCompare(b.command_id),
  );
  const view = {
    schema: "provider-custody-glass-view/v1",
    campaign_id: state.campaign_id,
    store_uuid: state.store_uuid,
    controller_generation: state.controller_generation,
    status: state.status,
    accepted_checkpoint: state.semantic.accepted_checkpoint,
    seat: {
      id: state.seat.id,
      epoch: state.seat.epoch,
      active_body: state.seat.body
        ? {
            body_id: state.seat.body.body_id,
            provider: state.seat.body.provider,
            model: state.seat.body.model,
            effort: state.seat.body.effort,
          }
        : null,
    },
    commands,
    events: state.events,
  };
  atomicWriteJson(join(root, "views", "GLASS.json"), view);
  const lines = [
    "# Campaign Glass View",
    "",
    `campaign: ${view.campaign_id}`,
    `controller_generation: ${view.controller_generation}`,
    `status: ${view.status}`,
    `accepted_checkpoint: ${view.accepted_checkpoint}`,
    `apex_seat: ${view.seat.id} epoch ${view.seat.epoch}`,
    `active_body: ${
      view.seat.active_body
        ? `${view.seat.active_body.provider}/${view.seat.active_body.model} ${view.seat.active_body.body_id}`
        : "none"
    }`,
    "",
    "## Commands",
    ...(
      commands.length
        ? commands.map(
            (command) =>
              `- ${command.command_id}: ${command.status}; actor=${command.actor.provider}/${command.actor.session_id}`,
          )
        : ["- none"]
    ),
    "",
    "## Lifecycle",
    ...(
      state.events.length
        ? state.events.map(
            (event) =>
              `- ${event.sequence} ${event.type}; generation=${event.controller_generation}; epoch=${event.seat_epoch}`,
          )
        : ["- none"]
    ),
    "",
  ];
  mkdirSync(join(root, "views"), { recursive: true });
  writeFileSync(join(root, "views", "GLASS.md"), lines.join("\n"), "utf8");
}

export function createCampaign(
  root,
  {
    campaignId,
    seatId,
    charterDigest,
    acceptedCheckpoint,
    acceptancePublicKeyPem,
    queue = [],
  },
) {
  if (!campaignId || !seatId || !charterDigest || !acceptancePublicKeyPem) {
    throw new Error("campaign identity or acceptance key is incomplete");
  }
  if (existsSync(controllerFile(root))) throw new Error("campaign controller is already initialized");
  const state = {
    schema: SCHEMA,
    campaign_id: campaignId,
    store_uuid: randomUUID(),
    store_generation: 1,
    controller_generation: 0,
    status: "parked",
    sequence: 0,
    semantic: {
      campaign_id: campaignId,
      charter_digest: charterDigest,
      accepted_checkpoint: acceptedCheckpoint || "",
      queue: canonicalValue(queue),
      reviews: [],
      contradictions: [],
      reasoning: [],
    },
    seat: {
      id: seatId,
      epoch: 0,
      body: null,
      history: [],
    },
    controller: null,
    acceptance: {
      algorithm: "ed25519",
      public_key_pem: acceptancePublicKeyPem,
    },
    events: [],
    glass: {
      commands: {},
      idempotency: {},
    },
  };
  appendEvent(root, state, "campaign-initialized", { store_uuid: state.store_uuid });
  return saveController(root, state);
}

export function startController(root) {
  const state = readController(root);
  if (state.status === "active" || state.controller) {
    throw new Error("controller already active for this store");
  }
  if (state.controller_generation > 0) {
    const latestPath = join(root, "parks", "latest.json");
    if (!existsSync(latestPath)) throw new Error("restart refused: latest park pointer is missing");
    const latest = JSON.parse(readFileSync(latestPath, "utf8"));
    const manifestPath = join(root, "parks", `${latest.park_id}.json`);
    if (!verifyParkManifest(manifestPath)) {
      throw new Error("restart refused: latest park manifest failed verification");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest.manifest_hash !== latest.manifest_hash ||
      manifest.store_uuid !== state.store_uuid ||
      manifest.controller_generation !== state.controller_generation ||
      manifest.seat_epoch !== state.seat.epoch ||
      manifest.semantic_digest !== digest(state.semantic)
    ) {
      throw new Error("restart refused: park manifest does not match controller state");
    }
  }
  if (state.seat.body) {
    state.seat.history.push({ ...state.seat.body, status: "fenced", fenced_reason: "controller-restart" });
    state.seat.body = null;
  }
  state.controller_generation += 1;
  state.controller = {
    generation: state.controller_generation,
    process_id: process.pid,
    started_at: new Date().toISOString(),
  };
  state.status = "active";
  appendEvent(root, state, "controller-started", {
    store_uuid: state.store_uuid,
    store_generation: state.store_generation,
  });
  saveController(root, state);
  return state;
}

function requireActiveController(state) {
  if (state.status !== "active" || !state.controller) throw new Error("controller is not active");
  if (state.controller.generation !== state.controller_generation) {
    throw new Error("controller generation is inconsistent");
  }
}

export function buildSemanticPacket(root) {
  const state = readController(root);
  const semantic = canonicalValue(state.semantic);
  const semanticDigest = digest(semantic);
  const reviewSections = semantic.reviews.map((review) => {
    const verdictPath = join(root, "reviews", "raw", review.review_id, "verdict.md");
    const verdict = readFileSync(verdictPath, "utf8");
    return `## Review ${review.review_id}\nstatus: ${review.status}\nverdict_sha256: ${review.verdict_sha256}\n\n${verdict}`;
  });
  const text = [
    "# Provider-Neutral Apex Packet",
    "",
    `campaign_id: ${semantic.campaign_id}`,
    `charter_digest: ${semantic.charter_digest}`,
    `accepted_checkpoint: ${semantic.accepted_checkpoint}`,
    `semantic_digest: ${semanticDigest}`,
    "",
    "## Queue",
    JSON.stringify(semantic.queue, null, 2),
    "",
    ...reviewSections,
    "",
  ].join("\n");
  return {
    schema: "provider-custody-packet/v1",
    semantic_digest: semanticDigest,
    semantic,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

export function launchFresh(
  root,
  { provider, model, effort = "", transport = "headless", readiness },
) {
  const state = readController(root);
  requireActiveController(state);
  if (!provider || !model) throw new Error("provider body specification is incomplete");
  if (state.seat.body) throw new Error("apex seat already has an active body");
  const packet = buildSemanticPacket(root);
  if (
    !readiness ||
    readiness.packetDigest !== packet.semantic_digest ||
    readiness.provider !== provider ||
    readiness.model !== model ||
    !readiness.providerSessionId ||
    readiness.capabilities?.launchFresh !== true
  ) {
    throw new Error("candidate readiness proof is missing or does not match the semantic packet");
  }
  state.seat.epoch += 1;
  const body = {
    body_id: randomUUID(),
    provider,
    model,
    effort,
    transport,
    provider_session_id: readiness.providerSessionId,
    controller_generation: state.controller_generation,
    seat_epoch: state.seat.epoch,
    lease_ref: randomUUID(),
    status: "active",
    launched_at: new Date().toISOString(),
  };
  state.seat.body = body;
  appendEvent(root, state, "body-activated", {
    operation: "launchFresh",
    body_id: body.body_id,
    provider,
    model,
    effort,
    transport,
    provider_session_id: readiness.providerSessionId,
  });
  saveController(root, state);
  return {
    operation: "launchFresh",
    packet,
    activation: {
      store_uuid: state.store_uuid,
      store_generation: state.store_generation,
      controller_generation: state.controller_generation,
      seat_id: state.seat.id,
      seat_epoch: state.seat.epoch,
      body_id: body.body_id,
      lease_capability_ref: `opaque:${digest(body.lease_ref).slice(0, 24)}`,
      provider,
      model,
      effort,
      transport,
      provider_session_id: readiness.providerSessionId,
    },
    authority: {
      controller_generation: state.controller_generation,
      seat_id: state.seat.id,
      seat_epoch: state.seat.epoch,
      body_id: body.body_id,
      lease_ref: body.lease_ref,
    },
  };
}

function assertAuthority(state, authority) {
  requireActiveController(state);
  const body = state.seat.body;
  if (
    !body ||
    !authority ||
    authority.controller_generation !== state.controller_generation ||
    authority.seat_id !== state.seat.id ||
    authority.seat_epoch !== state.seat.epoch ||
    authority.body_id !== body.body_id ||
    authority.lease_ref !== body.lease_ref
  ) {
    throw new Error("stale or fenced body authority");
  }
  return body;
}

export function resumeWarm(
  root,
  { bodyId, controllerGeneration, seatEpoch, leaseRef },
) {
  const state = readController(root);
  const body = assertAuthority(state, {
    body_id: bodyId,
    controller_generation: controllerGeneration,
    seat_id: state.seat.id,
    seat_epoch: seatEpoch,
    lease_ref: leaseRef,
  });
  return {
    operation: "resumeWarm",
    body_id: body.body_id,
    controller_generation: body.controller_generation,
    seat_epoch: body.seat_epoch,
  };
}

export function applyAcceptedCheckpoint(root, authority, { checkpoint, attestation }) {
  const state = readController(root);
  assertAuthority(state, authority);
  const expectedPayload = {
    campaign_id: state.campaign_id,
    store_uuid: state.store_uuid,
    previous_checkpoint: state.semantic.accepted_checkpoint,
    checkpoint,
    gate_digest: attestation?.payload?.gate_digest || "",
  };
  if (
    !attestation ||
    attestation.kind !== "signed-gate" ||
    digest(attestation.payload) !== digest(expectedPayload) ||
    !attestation.signature_base64 ||
    !verifySignature(
      null,
      Buffer.from(canonicalJson(attestation.payload), "utf8"),
      state.acceptance.public_key_pem,
      Buffer.from(attestation.signature_base64, "base64"),
    )
  ) {
    throw new Error("a valid signed gate attestation is required");
  }
  const previous = state.semantic.accepted_checkpoint;
  state.semantic.accepted_checkpoint = checkpoint;
  appendEvent(root, state, "accepted-checkpoint-advanced", {
    previous,
    checkpoint,
    gate_attestation_digest: digest(attestation),
  });
  saveController(root, state);
  return state;
}

export function importReview(
  root,
  { reviewId, prompt, verdict, provider, model, sessionId = "", sourcePath = "" },
) {
  const state = readController(root);
  requireActiveController(state);
  if (!reviewId || !prompt || !verdict || !provider || !model) {
    throw new Error("review import is incomplete");
  }
  const promptHash = digestText(prompt);
  const verdictHash = digestText(verdict);
  const reviewDir = join(root, "reviews", "raw", reviewId);
  const manifestPath = join(reviewDir, "manifest.json");
  const existingManifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : null;
  const manifest = existingManifest || {
    schema: "provider-custody-review/v1",
    review_id: reviewId,
    provider,
    model,
    provider_session_id: sessionId,
    source_path: sourcePath,
    prompt_sha256: promptHash,
    verdict_sha256: verdictHash,
    imported_at: new Date().toISOString(),
    status: "unreconciled",
  };
  immutableWrite(join(reviewDir, "prompt.md"), prompt);
  immutableWrite(join(reviewDir, "verdict.md"), verdict);
  if (
    existingManifest &&
    (
      existingManifest.prompt_sha256 !== promptHash ||
      existingManifest.verdict_sha256 !== verdictHash ||
      existingManifest.provider !== provider ||
      existingManifest.model !== model
    )
  ) {
    throw new Error(`review identity conflict: ${reviewId}`);
  }
  immutableWrite(manifestPath, manifest);
  const existing = state.semantic.reviews.find((review) => review.review_id === reviewId);
  const index = {
    review_id: reviewId,
    provider,
    model,
    prompt_sha256: promptHash,
    verdict_sha256: verdictHash,
    status: "unreconciled",
  };
  if (existing && digest(existing) !== digest(index)) {
    throw new Error(`review identity conflict: ${reviewId}`);
  }
  if (!existing) {
    state.semantic.reviews.push(index);
    state.semantic.reviews.sort((a, b) => a.review_id.localeCompare(b.review_id));
    appendEvent(root, state, "review-imported", {
      review_id: reviewId,
      provider,
      model,
      verdict_sha256: verdictHash,
    });
    saveController(root, state);
  }
  return index;
}

function writeReceipt(root, commandId, sequence, receipt) {
  immutableWrite(
    join(root, "glass", "receipt-events", commandId, `${String(sequence).padStart(6, "0")}.json`),
    receipt,
  );
}

export function submitGlassCommand(
  root,
  { commandId, idempotencyKey, actor, intent, observed = {} },
) {
  const state = readController(root);
  requireActiveController(state);
  if (!commandId || !idempotencyKey || !actor?.provider || !actor?.sessionId || !intent) {
    throw new Error("glass command is incomplete");
  }
  const payload = canonicalValue({
    command_id: commandId,
    idempotency_key: idempotencyKey,
    actor: {
      type: actor.type || "agent",
      provider: actor.provider,
      session_id: actor.sessionId,
    },
    intent,
    observed,
  });
  const payloadDigest = digest(payload);
  const prior = state.glass.idempotency[idempotencyKey];
  if (prior) {
    if (prior.payload_digest !== payloadDigest) {
      throw new Error(`idempotency conflict: ${idempotencyKey}`);
    }
    return state.glass.commands[prior.command_id];
  }
  let status = "received";
  if (
    observed.controllerGeneration !== undefined &&
    observed.controllerGeneration !== state.controller_generation
  ) {
    status = "stale";
  }
  if (observed.seatEpoch !== undefined && observed.seatEpoch !== state.seat.epoch) {
    status = "stale";
  }
  const command = {
    ...payload,
    payload_digest: payloadDigest,
    status,
    received_at: new Date().toISOString(),
  };
  immutableWrite(join(root, "glass", "commands", `${commandId}.json`), command);
  const receipt = {
    schema: "provider-custody-glass-receipt/v1",
    command_id: commandId,
    sequence: 1,
    status,
    controller_generation: state.controller_generation,
    seat_epoch: state.seat.epoch,
    payload_digest: payloadDigest,
    created_at: new Date().toISOString(),
  };
  writeReceipt(root, commandId, 1, receipt);
  state.glass.commands[commandId] = command;
  state.glass.idempotency[idempotencyKey] = {
    command_id: commandId,
    payload_digest: payloadDigest,
  };
  appendEvent(root, state, "glass-command-received", {
    command_id: commandId,
    status,
    actor_provider: actor.provider,
    actor_session_id: actor.sessionId,
  });
  saveController(root, state);
  return command;
}

export function parkController(root, { reason = "" } = {}) {
  const state = readController(root);
  requireActiveController(state);
  const fencedBody = state.seat.body
    ? {
        ...state.seat.body,
        status: "fenced",
        fenced_at: new Date().toISOString(),
        fenced_reason: reason || "campaign-park",
      }
    : null;
  if (fencedBody) state.seat.history.push(fencedBody);
  state.seat.body = null;
  appendEvent(root, state, "campaign-parked", {
    reason,
    fenced_body_id: fencedBody?.body_id || "",
    active_leases: 0,
  });
  state.status = "parked";
  state.controller = null;
  saveController(root, state);

  const unsigned = {
    schema: "provider-custody-park/v1",
    park_id: randomUUID(),
    campaign_id: state.campaign_id,
    store_uuid: state.store_uuid,
    store_generation: state.store_generation,
    controller_generation: state.controller_generation,
    seat_id: state.seat.id,
    seat_epoch: state.seat.epoch,
    semantic_digest: digest(state.semantic),
    controller_state_sha256: digest(state),
    active_leases: 0,
    reason,
    created_at: new Date().toISOString(),
  };
  const manifest = {
    ...unsigned,
    manifest_hash: digest(unsigned),
  };
  const path = join(root, "parks", `${manifest.park_id}.json`);
  immutableWrite(path, manifest);
  atomicWriteJson(join(root, "parks", "latest.json"), {
    park_id: manifest.park_id,
    manifest_hash: manifest.manifest_hash,
  });
  return { ...manifest, path };
}

export function verifyParkManifest(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const { manifest_hash: manifestHash, ...unsigned } = manifest;
    return (
      manifest.schema === "provider-custody-park/v1" &&
      manifest.active_leases === 0 &&
      typeof manifestHash === "string" &&
      digest(unsigned) === manifestHash
    );
  } catch {
    return false;
  }
}
