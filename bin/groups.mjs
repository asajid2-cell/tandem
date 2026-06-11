// tandem groups registry — records each distinct tandem PAIR (which Claude session
// is matched with which Codex session) so the watcher can show "group N" with the
// correct two halves, instead of guessing from "newest session on disk".

import { readFileSync, writeFileSync, existsSync } from "node:fs";

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
