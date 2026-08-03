export function normalizeScopePath(p) {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("empty scope path");
  }

  let value = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (value.startsWith("./")) {
    value = value.slice(2);
  }

  const absolute = value.startsWith("/");
  if (value.length > 1) {
    value = value.replace(/\/+$/, "");
  }

  const parts = value.split("/");
  const resolved = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      // Keep ".." when it would escape the lexical starting point.
      if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
        resolved.pop();
      } else {
        resolved.push("..");
      }
      continue;
    }
    resolved.push(part);
  }

  const normalized = `${absolute ? "/" : ""}${resolved.join("/")}`;
  return normalized.toLowerCase() || (absolute ? "/" : "");
}

function normalizedScopesOverlap(a, b) {
  // The slash makes the prefix check respect path-segment boundaries.
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function scopesOverlap(a, b) {
  return normalizedScopesOverlap(normalizeScopePath(a), normalizeScopePath(b));
}

function isValidWritePath(path) {
  return typeof path === "string" && path.length > 0;
}

function preparePaths(writes) {
  if (!Array.isArray(writes)) {
    return [];
  }

  return writes
    .filter(isValidWritePath)
    .map((raw) => ({ raw, normalized: normalizeScopePath(raw) }));
}

function firstOverlappingPair(pathsA, pathsB) {
  for (const pathA of pathsA) {
    for (const pathB of pathsB) {
      if (normalizedScopesOverlap(pathA.normalized, pathB.normalized)) {
        return { pathA: pathA.raw, pathB: pathB.raw };
      }
    }
  }
  return null;
}

export function checkLaneScopes(lanes) {
  const errors = [];
  const prepared = [];
  const seenNames = new Set();
  const laneList = Array.isArray(lanes) ? lanes : [];

  for (const lane of laneList) {
    const name = lane?.name;
    if (seenNames.has(name)) {
      errors.push({ lane: name, error: "duplicate lane name" });
    } else {
      seenNames.add(name);
    }

    const writes = lane?.writes;
    if (!Array.isArray(writes) || writes.length === 0) {
      errors.push({ lane: name, error: "writes[] required" });
      prepared.push({ name, paths: [] });
      continue;
    }

    if (writes.some((path) => !isValidWritePath(path))) {
      errors.push({ lane: name, error: "invalid write path" });
    }

    prepared.push({ name, paths: preparePaths(writes) });
  }

  const conflicts = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const pair = firstOverlappingPair(prepared[i].paths, prepared[j].paths);
      if (pair) {
        conflicts.push({
          a: prepared[i].name,
          b: prepared[j].name,
          ...pair,
        });
      }
    }
  }

  return {
    ok: errors.length === 0 && conflicts.length === 0,
    errors,
    conflicts,
  };
}

export function checkAgainstLive(lanes, liveScopes) {
  const laneList = Array.isArray(lanes) ? lanes : [];
  const owners = new Map();

  for (const live of Array.isArray(liveScopes) ? liveScopes : []) {
    if (!Array.isArray(live?.writes)) {
      continue;
    }

    const owner = live?.owner;
    if (!owners.has(owner)) {
      owners.set(owner, []);
    }
    owners.get(owner).push(...preparePaths(live.writes));
  }

  const conflicts = [];
  for (const lane of laneList) {
    const lanePaths = preparePaths(lane?.writes);
    for (const [owner, ownerPaths] of owners) {
      const pair = firstOverlappingPair(lanePaths, ownerPaths);
      if (pair) {
        conflicts.push({
          lane: lane?.name,
          owner,
          ...pair,
        });
      }
    }
  }

  return {
    ok: conflicts.length === 0,
    conflicts,
  };
}

async function runCli() {
  if (process.argv[2] !== "check" || process.argv[3] !== "-") {
    console.error("usage: node bin/write-scope.mjs check -");
    process.exitCode = 2;
    return;
  }

  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const laneResult = checkLaneScopes(input?.lanes);
  const liveResult = checkAgainstLive(input?.lanes, input?.live ?? []);
  const result = {
    ok: laneResult.ok && liveResult.ok,
    errors: laneResult.errors,
    conflicts: laneResult.conflicts,
    liveConflicts: liveResult.conflicts,
  };

  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}

// COLLECTION-TIME audit. The gate checks writes[] at DISPATCH; nothing checked what a lane
// actually touched, so a lane could write outside its declared scope and only ever be caught by
// a driver hashing its own seeded files (which is how wave 1 found it). `formattingOnly` names
// changes the driver has already proven to be whitespace: a brief demanding package-wide
// `cargo fmt` forces a lane out of scope BY CONSTRUCTION, so that is a brief defect and must be
// reported as its own class rather than as a rogue lane.
export function auditLaneScope({ changed = [], writes = [], formattingOnly = [], seeds = [] } = {}) {
  if (!Array.isArray(writes) || writes.length === 0) {
    return { ok: false, outside: [], formatting: [], detail: "no declared writes — nothing can be audited" };
  }
  const declared = writes.filter((w) => typeof w === "string" && w.trim()).map(normalizeScopePath);
  const fmtSet = new Set(formattingOnly.map(normalizeScopePath));
  // SEEDS are the apex's own files, deliberately placed dirty in the lane's worktree so the lane
  // is graded by assertions it does not own. They show up in `git status` and are outside every
  // lane's declared scope BY DESIGN — counting them as breaches would fire on every lane of the
  // proven recipe and teach the operator to ignore the signal. Tampering with them is caught
  // separately and mechanically by recheckSeeds().
  const seedSet = new Set(seeds.filter((s) => typeof s === "string" && s.trim()).map(normalizeScopePath));
  const outside = [];
  const formatting = [];
  for (const raw of changed) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const p = normalizeScopePath(raw);
    if (declared.some((d) => scopesOverlap(d, p))) continue;
    if (seedSet.has(p)) continue; // the apex's own grader, not a lane breach
    if (fmtSet.has(p)) formatting.push(raw);
    else outside.push(raw);
  }
  const ok = outside.length === 0 && formatting.length === 0;
  return {
    ok,
    outside,
    formatting,
    detail: ok
      ? "every change is inside the lane's declared scope"
      : [
          outside.length ? `${outside.length} file(s) written OUTSIDE the declared scope` : "",
          formatting.length ? `${formatting.length} formatting-only excursion(s) — the BRIEF forced this, fix the brief` : "",
        ]
          .filter(Boolean)
          .join("; "),
  };
}

// VERIFIER CUSTODY — the audit's central hole, made mechanical.
//
// The engine runs whatever verify command the manifest names. Rust unit tests live inside the
// file a lane owns, so a lane can implement wrong behaviour, write tests asserting that wrong
// behaviour, and sail through prove-red: withheld it fails to compile (a convincing RED),
// restored its own tests pass (a convincing GREEN). The campaigns avoided this only because the
// apex chose apex-owned `accept_<unit>::` filters BY DOCTRINE — and this system's own charter
// records that doctrine-only control measurably failed in its predecessor.
//
// Mechanical rule: a lane must declare the apex-owned grader files it is judged against (seeds),
// and its verify command must actually REFERENCE one of them. Plus the evidence pins, because
// exit codes alone are not proof.
export function checkVerifyCustody({ verify = "", seeds = [], expectRed = "", expectGreen = "" } = {}) {
  const problems = [];
  const cmd = String(verify || "");
  const owned = (seeds || []).filter((s) => typeof s === "string" && s.trim());
  if (!cmd.trim()) problems.push("no verify command");
  if (!owned.length) {
    problems.push("no apex-owned grader declared (seeds[]) — the lane would be graded by assertions it owns and can edit");
  } else {
    // the module/file stem of a seeded grader, e.g. src/accept_alu.rs -> accept_alu
    const stems = owned.map((p) => normalizeScopePath(p).split("/").pop().replace(/\.[a-z0-9]+$/i, "")).filter(Boolean);
    if (!stems.some((stem) => cmd.includes(stem))) {
      problems.push(`the verify command references none of the apex-owned graders (${stems.join(", ")}) — it would also run the lane's own tests`);
    }
  }
  if (!String(expectRed || "").trim()) problems.push("no expectRed pin — the withheld phase could fail for an unrelated reason and still certify");
  if (!String(expectGreen || "").trim()) problems.push("no expectGreen pin — a zero-assertion pass could certify");
  return { ok: problems.length === 0, problems, detail: problems.join("; ") };
}

if (process.argv[1]?.endsWith("write-scope.mjs")) {
  runCli();
}
