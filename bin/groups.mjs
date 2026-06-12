// tandem groups registry — records each distinct tandem PAIR (which Claude session
// is matched with which Codex session) so the watcher can show "group N" with the
// correct two halves, instead of guessing from "newest session on disk".

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

// Per-driver state-file key. Concurrent tandems must NOT share verdict/status files, or one
// tandem's turn clobbers another's result. Both peer.mjs and serve.mjs derive the key from the
// driver id with the SAME sanitizer so they agree on the path for a given tandem.
export function jobKey(id) {
  return (id || "default").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "default";
}

// A folder name safe for any filesystem, kept readable (keeps . _ -, e.g. "watch-together-cdn-engine").
export function sanitizeLabel(s) {
  return (s || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "tandem";
}
const labelsFile = (root) => join(root, "tandems", ".labels.json"); // driverId → readable label
function readLabels(root) {
  try {
    return JSON.parse(readFileSync(labelsFile(root), "utf8"));
  } catch {
    return {};
  }
}

// The state DIRECTORY for one tandem pair. Each driving session gets its OWN folder so unrelated
// tandems never share state, timeline, or ledger. Folder name precedence:
//   TANDEM_STATE (explicit override, e.g. tests)  >  .state (no driver id)  >
//   tandems/<TANDEM_LABEL | recorded label | session-id fallback>
export function stateDir(root, driverId) {
  if (process.env.TANDEM_STATE) return resolve(process.env.TANDEM_STATE);
  if (!driverId) return join(root, ".state");
  const label = process.env.TANDEM_LABEL || readLabels(root)[driverId] || jobKey(driverId);
  return join(root, "tandems", sanitizeLabel(label));
}

// Record a readable label for this driver's tandem → tandems/<label>/. Migrates the existing
// session-id fallback folder so naming a tandem LATE doesn't lose its state/coupling. Returns the
// sanitized label.
export function setLabel(root, driverId, label) {
  if (!driverId || !label || !label.trim()) return "";
  const clean = sanitizeLabel(label);
  const dir = join(root, "tandems");
  try {
    mkdirSync(dir, { recursive: true });
    const labels = readLabels(root);
    labels[driverId] = label.trim();
    writeFileSync(labelsFile(root), JSON.stringify(labels));
  } catch {
    /* ignore */
  }
  const idFolder = join(dir, jobKey(driverId));
  const labelFolder = join(dir, clean);
  try {
    if (existsSync(idFolder) && !existsSync(labelFolder)) renameSync(idFolder, labelFolder);
  } catch {
    /* ignore */
  }
  return clean;
}

// Every state dir that exists (legacy .state + each tandems/<label>) — for the watcher to aggregate.
export function listStateDirs(root) {
  if (process.env.TANDEM_STATE) return [resolve(process.env.TANDEM_STATE)]; // explicit override = the only dir
  const dirs = [];
  const legacy = join(root, ".state");
  if (existsSync(legacy)) dirs.push(legacy);
  for (const sub of ["tandems", "sessions"]) {
    // tandems = current; sessions = the earlier interim name (still aggregated if present)
    const base = join(root, sub);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (name.startsWith(".")) continue; // .labels.json etc.
      const p = join(base, name);
      try {
        if (statSync(p).isDirectory()) dirs.push(p);
      } catch {
        /* ignore */
      }
    }
  }
  return dirs;
}

export function readGroups(file) {
  if (!existsSync(file)) return { seq: 1, groups: {} };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { seq: 1, groups: {} };
  }
}

// "Detached" drivers: `peer.mjs new` stamps a driver id with the current time so the
// partner lookup ignores any pairing recorded at/before that stamp. This forces a genuinely
// fresh thread on the next turn (the old pairing stays in history), and once a fresh turn
// records a NEW pair (lastTs > stamp) the lookup re-couples to it automatically.
export function readDetached(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
export function markDetached(file, driverId) {
  if (!driverId) return;
  const d = readDetached(file);
  d[driverId] = Date.now();
  writeFileSync(file, JSON.stringify(d));
}

// Upsert a pair. Key is the (claude,codex) id pair, so the same pairing always maps
// to the same group number across turns. Returns the group record.
export function recordGroup(file, { claudeId, codexId, claudeRole, codexRole, direction, label }) {
  const g = readGroups(file);
  const key = `${claudeId || "?"}|${codexId || "?"}`;
  if (!g.groups[key]) {
    g.groups[key] = { n: g.seq++, firstTs: Date.now() };
  }
  const rec = g.groups[key];
  rec.lastTs = Date.now();
  if (claudeId) rec.claudeId = claudeId;
  if (codexId) rec.codexId = codexId;
  if (claudeRole) rec.claudeRole = claudeRole;
  if (codexRole) rec.codexRole = codexRole;
  if (direction) rec.direction = direction;
  if (label) rec.label = label;
  writeFileSync(file, JSON.stringify(g));
  return rec;
}
