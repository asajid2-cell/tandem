// Fleet identity — who a session IS, who forked it, and what it may hand to its own children.
//
// Three defects from the first real campaign live here:
//  - a mind forked by plain `peer.mjs ask` (the doctrinal way to fork a branch mind) never
//    entered the registry, so `fleet tree` under-reported the fleet it exists to show;
//  - the apex appeared TWICE — once under the id it registered itself with, once under its raw
//    session id when prepareSwarm registered a "driver";
//  - TANDEM_ROLE / TANDEM_LABEL / TANDEM_LANE_ID leaked into children by env inheritance, so a
//    child that declared no role inherited its parent's.
//
// Rule: IDENTITY (who am I) is per-session and never inherited. LINEAGE (who forked me) and
// CONFIG (which fleet) are inherited. Registration is advisory: it must never throw into a
// dispatch path.
import { getSession, registerSession } from "./fleet-registry.mjs";

// Identity env vars: describe THIS session. Must be stripped before spawning a child.
const IDENTITY_VARS = ["TANDEM_ROLE", "TANDEM_SELF_ID", "TANDEM_LABEL", "TANDEM_LANE_ID"];

export function resolveIdentity(env = process.env, defaultKind = "other", sessionId = "") {
  const kind = env.TANDEM_ROLE || (env.TANDEM_LANE_ID ? "junior" : defaultKind);
  const selfId = env.TANDEM_SELF_ID || env.TANDEM_LANE_ID || sessionId || "";
  return {
    kind,
    selfId,
    parentId: env.TANDEM_PARENT_ID || null,
    label: env.TANDEM_LABEL || "",
    laneId: env.TANDEM_LANE_ID || "",
  };
}

// The env a session hands to anything it spawns: its own identity stripped, its own id installed
// as the child's parent, lineage/config preserved.
export function childEnv(env = process.env, { selfId = "" } = {}) {
  const out = { ...env };
  for (const key of IDENTITY_VARS) delete out[key];
  const parent = selfId || env.TANDEM_SELF_ID || env.TANDEM_LANE_ID || "";
  if (parent) out.TANDEM_PARENT_ID = parent;
  return out;
}

// Registry kinds are a closed set; fleet ROLES are the operator-facing vocabulary.
function registryKind(kind) {
  if (kind === "apex") return "apex";
  if (kind === "branch-mind" || kind === "branch") return "branch";
  if (kind === "junior" || kind === "lane") return "junior";
  return "other";
}

// Idempotent, fail-safe registration. Returns the stored record, or null if it could not be
// written — identity bookkeeping must never break a dispatch.
export function ensureRegistered(dir, { selfId, sessionId = "", parentId = null, kind = "other", label = "", model = "", effort = "", cwd = "", writes = [], state = "" } = {}) {
  const id = selfId || sessionId;
  if (!id) return null;
  try {
    const existing = getSession(dir, id);
    if (existing) return existing;
    // fail SAFE: an unknown/stale parent registers as a root rather than refusing
    const parent = parentId && getSession(dir, parentId) ? parentId : null;
    return registerSession(dir, {
      id,
      parent,
      kind: registryKind(kind),
      label: label || id,
      model,
      effort,
      cwd,
      writes,
      state,
    });
  } catch (error) {
    // a concurrent writer may have inserted it between our read and write — that is success
    if (/duplicate session id/.test(String(error?.message || error))) {
      try {
        return getSession(dir, id);
      } catch {
        return null;
      }
    }
    return null;
  }
}
