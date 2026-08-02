// Apex immortality — clear-and-reload instead of compaction.
//
// Compaction is generation loss: each cycle summarizes a context that already contains a summary,
// so by the tenth hop the apex reasons from a copy of a copy. A clear-and-reload is always
// exactly ONE hop from source, so fidelity is constant however long the apex lives. That only
// holds because memory lands on disk FIRST — without the ledger a clear is destructive, with it
// a clear is a refresh. The discipline: WRITES LEAD THE CLEAR (a fact is recorded by the same
// action that produces it), so a clear, a crash, or the owner killing the tab are equally safe.
//
// Fidelity is not correctness. Reloading faithfully restores whatever was recorded, mistakes
// included — which is why CURRENT.md refuses machine-class claims that carry no machine evidence.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const SENTINEL = "<<<END-REHYDRATION-BRIEF>>>";

// ---- the meter ------------------------------------------------------------------------------
// MEASURED on a real apex log: the last assistant record's usage = 491,739 (true context) while
// the same turn's `result` usage = 53,152,747 (the aggregate over 310 API calls). The result
// record is SPEND accounting and must never be read as context — that conflation is defect F7,
// and at a 100k threshold it would trip ~500x too early and thrash the session into amnesia.

export function contextSizeFromUsage(usage) {
  if (!usage || typeof usage !== "object") return 0;
  return (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
}

export function liveContext(turnLogFile) {
  if (!turnLogFile || !existsSync(turnLogFile)) return 0;
  let last = null;
  let text;
  try {
    text = readFileSync(turnLogFile, "utf8");
  } catch {
    return 0;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a torn or garbage line never breaks the meter
    }
    // ONLY per-call assistant records. `result` is the turn aggregate; `iterations[]` inside it
    // carries per-call numbers but the assistant stream is the direct, always-present source.
    if (o.type === "assistant" && o.message?.usage) last = o.message.usage;
  }
  return last ? contextSizeFromUsage(last) : 0;
}

// ---- the refresh decision -------------------------------------------------------------------
// Defaults follow CONTEXT-THESIS §1.3: exact-state coding — the closest measured analogue to
// apex work — is already under 50% for most models by 36–60k. Refreshing is cheap (one bounded
// read) while carrying context is charged on every call of every turn, so quality and cost point
// the same way: refresh early and often.

export const DEFAULT_REFRESH_TOKENS = 100_000;
export const DEFAULT_HARD_TOKENS = 300_000;

export function refreshDecision({
  context = 0,
  thresholdTokens = DEFAULT_REFRESH_TOKENS,
  hardTokens = DEFAULT_HARD_TOKENS,
  busy = false,
  backstopFires = 0,
} = {}) {
  // The backstop is UNCONDITIONAL — and it is the only path that clears mid-sweep, which makes
  // it the maximal-loss event rather than a safety net: in-flight hypotheses and calibrated
  // distrust die with the session. So it forces a dump turn first. A degraded apex writing a
  // degraded dump still beats zero.
  if (context >= hardTokens) {
    return {
      refresh: true,
      defer: false,
      requiresDump: busy,
      reason: `hard backstop: context ${context} >= ${hardTokens} — refresh regardless of what is in flight`,
      warning:
        backstopFires >= 2
          ? `the backstop has fired ${backstopFires} times — that is a mis-set refresh trigger, not a working safety net`
          : "",
    };
  }
  if (context >= thresholdTokens) {
    if (busy) {
      return { refresh: false, defer: true, requiresDump: false, reason: `threshold reached (${context} >= ${thresholdTokens}) but work is in flight — refresh at the next clean seam` };
    }
    return { refresh: true, defer: false, requiresDump: false, reason: `threshold reached: context ${context} >= ${thresholdTokens} at a clean seam` };
  }
  return { refresh: false, defer: false, requiresDump: false, reason: `context ${context} is under the ${thresholdTokens} threshold` };
}

// ---- the ledger -----------------------------------------------------------------------------
// Append-only, one file per class. The classes exist because an adversarial review named what
// reliably fails to reach a ledger: NEGATIVE and sub-threshold knowledge — hypotheses ruled out,
// calibrated distrust, the shape of a half-cornered bug, what was deliberately not checked.

function appendJsonl(dir, name, record) {
  mkdirSync(dir, { recursive: true });
  const stamped = { ts: Date.now(), ...record };
  appendFileSync(join(dir, name), `${JSON.stringify(stamped)}\n`);
  return stamped;
}

function readJsonl(dir, name) {
  const file = join(dir, name);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn trailing append is expected mid-write; skip it */
    }
  }
  return out;
}

export const noteDecision = (dir, rec) => appendJsonl(dir, "decisions.jsonl", { tier: "tactical", alternatives_rejected: [], ...rec });
export const noteHypothesis = (dir, rec) => appendJsonl(dir, "hypotheses.jsonl", { status: "open", ...rec });
export const noteDistrust = (dir, rec) => appendJsonl(dir, "distrust.jsonl", rec);
export const noteSurprise = (dir, rec) => appendJsonl(dir, "surprises.jsonl", rec);

export function readOpen(dir) {
  return {
    decisions: readJsonl(dir, "decisions.jsonl"),
    hypotheses: readJsonl(dir, "hypotheses.jsonl"),
    distrust: readJsonl(dir, "distrust.jsonl"),
    surprises: readJsonl(dir, "surprises.jsonl"),
  };
}

// ---- CURRENT.md — machine-owned means PROVENANCE, not file format ---------------------------
// A mind asserting its own `verified[]` is the drift channel wearing a JSON schema. Machine-class
// claims must carry machine evidence (the filter that ran, its exit code, the green count, the
// commit); anything else is refused and the refusal is recorded rather than silently dropped.

function hasMachineEvidence(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.test_filter === "string" &&
    Number.isInteger(entry.exit_code) &&
    Number.isInteger(entry.green_count) &&
    typeof entry.commit === "string"
  );
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file); // same-volume rename: a reader never observes a partial CURRENT.md
}

export function setCurrent(dir, state = {}) {
  mkdirSync(dir, { recursive: true });
  const verified = [];
  const rejected = [];
  for (const entry of Array.isArray(state.verified) ? state.verified : []) {
    if (hasMachineEvidence(entry)) verified.push(entry);
    else rejected.push(entry);
  }
  const rec = {
    ts: Date.now(),
    goal: String(state.goal || ""),
    next: String(state.next || ""),
    verified,
    rejected,
    suspicions: Array.isArray(state.suspicions) ? state.suspicions : [],
    not_yet_checked: Array.isArray(state.not_yet_checked) ? state.not_yet_checked : [],
    head: String(state.head || ""),
  };
  const lines = [
    "# CURRENT — machine-owned campaign state (replaced wholesale; never appended)",
    "",
    `goal: ${rec.goal}`,
    `next: ${rec.next}`,
    rec.head ? `head: ${rec.head}` : "",
    "",
    "## verified (machine evidence required)",
    ...(rec.verified.length ? rec.verified.map((v) => `- ${v.test_filter} exit=${v.exit_code} green=${v.green_count} @${v.commit}`) : ["- (none)"]),
    ...(rec.rejected.length
      ? ["", "## REFUSED — asserted without machine evidence (drift guard)", ...rec.rejected.map((r) => `- ${typeof r === "string" ? r : JSON.stringify(r)}`)]
      : []),
    ...(rec.suspicions.length ? ["", "## suspicions (mind-asserted)", ...rec.suspicions.map((s) => `- ${s}`)] : []),
    ...(rec.not_yet_checked.length ? ["", "## not yet checked", ...rec.not_yet_checked.map((s) => `- ${s}`)] : []),
    "",
  ];
  writeAtomic(join(dir, "CURRENT.md"), lines.filter((l) => l !== "").join("\n") + "\n");
  return rec;
}

export function readCurrent(dir) {
  const file = join(dir, "CURRENT.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// ---- rehydration ----------------------------------------------------------------------------
// Derived at build time from the files, every time. NEVER a stored seed: a seed is consumed once
// and lost if the first turn fails, which leaves a mind both memoryless and briefless.

export function buildRehydrationBrief(dir, { maxTokens = 20_000, head = "" } = {}) {
  const budgetChars = maxTokens * 4;
  const current = readCurrent(dir);
  const { decisions, hypotheses, distrust, surprises } = readOpen(dir);

  if (!current && !decisions.length && !hypotheses.length && !surprises.length) {
    return [
      "# REHYDRATION BRIEF",
      "",
      "There is no prior campaign state on disk. Do NOT assume this is a fresh project:",
      "verify against git (`git log -1`, `git status`) and the fleet registry before acting,",
      "and if the repository is non-empty treat the missing ledger as a fault to report.",
      "",
      SENTINEL,
      "",
    ].join("\n");
  }

  const head_line = head ? `head_at_build: ${head}` : "";
  const openHyp = hypotheses.filter((h) => h.status === "open");
  const ruledOut = hypotheses.filter((h) => h.status === "ruled_out");

  // Everything except tactical decisions is constitution-class and is never evicted: current
  // state, open hypotheses, ruled-out paths (they stop the reborn apex re-walking dead ends),
  // distrust, and surprises.
  const fixed = [
    "# REHYDRATION BRIEF — you are ONE hop from source, not a summary of a summary",
    "",
    head_line,
    "",
    "## CURRENT",
    current.trim() || "(none)",
    ...(openHyp.length ? ["", "## OPEN HYPOTHESES", ...openHyp.map((h) => `- ${h.statement} — evidence: ${h.evidence || "n/a"}; kill: ${h.kill_criterion || "n/a"}`)] : []),
    ...(ruledOut.length ? ["", "## RULED OUT (do not re-walk)", ...ruledOut.map((h) => `- ${h.statement} — ${h.evidence || ""}`)] : []),
    ...(distrust.length ? ["", "## CALIBRATED DISTRUST", ...distrust.map((d) => `- ${d.target}: ${d.why}`)] : []),
    ...(surprises.length ? ["", "## SURPRISES", ...surprises.map((s) => `- ${s.what} — ${s.evidence || ""}`)] : []),
  ].filter((l) => l !== "");

  const pinned = decisions.filter((d) => d.tier === "constitution");
  const tactical = decisions.filter((d) => d.tier !== "constitution");
  const fmt = (d) => `- ${d.what}${d.why ? ` — ${d.why}` : ""}${d.alternatives_rejected?.length ? ` (rejected: ${d.alternatives_rejected.join("; ")})` : ""}`;

  const head_block = [...fixed, "", "## DECISIONS (constitution)", ...(pinned.length ? pinned.map(fmt) : ["- (none)"])];
  let used = head_block.join("\n").length;
  // newest tactical first, dropping the OLDEST unpinned when the budget runs out — age is the
  // eviction key only among tactical entries, never across the constitution
  const keptTactical = [];
  for (let i = tactical.length - 1; i >= 0; i--) {
    const line = fmt(tactical[i]);
    if (used + line.length + 200 > budgetChars) break;
    keptTactical.unshift(line);
    used += line.length + 1;
  }

  return [
    ...head_block,
    "",
    "## DECISIONS (tactical, newest kept)",
    ...(keptTactical.length ? keptTactical : ["- (none retained)"]),
    "",
    `counts: decisions_included=${pinned.length + keptTactical.length} decisions_dropped=${tactical.length - keptTactical.length} surprises_included=${surprises.length} hypotheses_included=${hypotheses.length}`,
    "",
    SENTINEL,
    "",
  ].join("\n");
}

// A brief is self-authenticating: truncation loses the sentinel, staleness fails the head check.
// Both are free, and they turn "confidently wrong with no memory of being wrong" into a caught
// precondition failure.
export function verifyBrief(brief, { head = "" } = {}) {
  const problems = [];
  const text = String(brief || "");
  if (!text.includes(SENTINEL)) problems.push("brief is truncated (end sentinel missing)");
  if (head) {
    const m = /head_at_build:\s*(\S+)/.exec(text);
    if (!m) problems.push("brief carries no build head");
    else if (m[1] !== head) problems.push(`brief is stale: built at ${m[1]}, repository is at ${head}`);
  }
  return { ok: problems.length === 0, problems };
}
