// Model/effort provenance — prove what the partner CLI ACTUALLY ran a turn, versus what tandem
// asked for. The tier/failover machinery routes on model CLAIMS from config; nothing else in the
// job-record layer proves what executed. These helpers compare the requested value against the
// value the claude stream / codex rollout PROVED, and build a loud, greppable warning on a proven
// mismatch. Absence of evidence (actual === "") is never a mismatch — records must not lie.

const norm = (s) => String(s || "").toLowerCase().trim();

// A proven mismatch: BOTH sides non-empty and neither normalized string contains the other. The
// containment rule lets an alias request match — requested "opus" vs actual "claude-opus-4-8" is
// OK (actual contains "opus"); requested "fable" vs the same actual WARNS (neither contains the
// other). Effort uses the same exact-or-contains rule.
export function provenanceMismatch(requested, actual) {
  const r = norm(requested);
  const a = norm(actual);
  if (!r || !a) return false;
  return !a.includes(r) && !r.includes(a);
}

export function modelMismatchWarning(requested, actual) {
  return `model mismatch: requested "${requested}" but the partner CLI ran "${actual}" — the tier/failover routing may be wrong; verify tandem.config.json and the daemon binding`;
}

export function effortMismatchWarning(requested, actual) {
  return `effort mismatch: requested "${requested}" but the partner ran "${actual}"`;
}

// The warning string for a record's provenance, joined onto any existing warning (e.g. a coupling
// warning) with "; ". Returns "" when there is nothing to warn about, so callers can `|| null`.
export function provenanceWarning(fields = {}, existing = "") {
  const parts = [];
  if (existing) parts.push(existing);
  if (provenanceMismatch(fields.modelRequested, fields.modelActual)) {
    parts.push(modelMismatchWarning(fields.modelRequested, fields.modelActual));
  }
  if (provenanceMismatch(fields.effortRequested, fields.effortActual)) {
    parts.push(effortMismatchWarning(fields.effortRequested, fields.effortActual));
  }
  return parts.join("; ");
}
