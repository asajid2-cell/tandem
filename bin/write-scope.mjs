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

if (process.argv[1]?.endsWith("write-scope.mjs")) {
  runCli();
}
