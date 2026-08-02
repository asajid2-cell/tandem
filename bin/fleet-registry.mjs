import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = new Set(["apex", "branch", "junior", "other"]);
const STATUSES = new Set(["live", "done", "error", "gone"]);
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY"]);

function registryPath(dir) {
  return path.join(dir, "registry.json");
}

function emptyRegistry() {
  return { version: 1, sessions: {} };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readRegistry(dir) {
  ensureDir(dir);
  const file = registryPath(dir);
  if (!fs.existsSync(file)) return emptyRegistry();

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`registry corrupt: ${file}`);
    }
    throw error;
  }
}

function writeRegistry(dir, registry) {
  ensureDir(dir);
  const file = registryPath(dir);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  let lastError;
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    if (attempt > 0) sleep(50);
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt === 5) break;
    }
  }

  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // Preserve the rename failure.
  }
  throw lastError;
}

function optionalString(rec, field) {
  if (rec?.[field] === undefined) return "";
  if (typeof rec[field] !== "string") {
    throw new Error(`invalid ${field}: ${rec[field]}`);
  }
  return rec[field];
}

function normalizeRecord(rec) {
  const id = rec && typeof rec.id === "string" ? rec.id : "";
  if (!id) throw new Error("id required");

  const kind = rec?.kind;
  if (!KINDS.has(kind)) throw new Error(`invalid kind: ${kind}`);

  const parent = rec?.parent === undefined ? null : rec.parent;
  if (parent !== null && typeof parent !== "string") {
    throw new Error(`invalid parent: ${parent}`);
  }

  const writes = rec?.writes === undefined ? [] : rec.writes;
  if (!Array.isArray(writes) || writes.some((write) => typeof write !== "string")) {
    throw new Error("invalid writes");
  }

  const charter = optionalString(rec, "charter");
  return {
    id,
    parent,
    kind,
    label: optionalString(rec, "label"),
    charter: charter.slice(0, 2000),
    writes: [...writes],
    model: optionalString(rec, "model"),
    effort: optionalString(rec, "effort"),
    cwd: optionalString(rec, "cwd"),
  };
}

export function registerSession(dir, rec) {
  const registry = readRegistry(dir);
  const normalized = normalizeRecord(rec);
  if (registry.sessions[normalized.id]) {
    throw new Error(`duplicate session id: ${normalized.id}`);
  }
  if (normalized.parent !== null && !registry.sessions[normalized.parent]) {
    throw new Error(`unknown parent: ${normalized.parent}`);
  }

  const stored = {
    ...normalized,
    status: "live",
    ts: Date.now(),
    endTs: null,
  };
  registry.sessions[stored.id] = stored;
  writeRegistry(dir, registry);
  return stored;
}

export function updateStatus(dir, id, status) {
  const registry = readRegistry(dir);
  const record = registry.sessions[id];
  if (!record) throw new Error(`unknown session id: ${id}`);
  if (!STATUSES.has(status)) throw new Error(`invalid status: ${status}`);

  record.status = status;
  record.endTs = status === "live" ? null : Date.now();
  writeRegistry(dir, registry);
  return record;
}

export function getSession(dir, id) {
  return readRegistry(dir).sessions[id] ?? null;
}

export function family(dir, id) {
  const registry = readRegistry(dir);
  const self = registry.sessions[id];
  if (!self) throw new Error(`unknown session id: ${id}`);

  const ancestors = [];
  const seenAncestors = new Set([id]);
  let parentId = self.parent;
  while (parentId !== null && parentId !== undefined && !seenAncestors.has(parentId)) {
    seenAncestors.add(parentId);
    const parent = registry.sessions[parentId];
    if (!parent) break;
    ancestors.push(parent);
    parentId = parent.parent;
  }
  ancestors.reverse();

  const children = new Map();
  for (const record of Object.values(registry.sessions)) {
    if (!children.has(record.parent)) children.set(record.parent, []);
    children.get(record.parent).push(record);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  const descendants = [];
  const seenDescendants = new Set([id]);
  function visit(parent) {
    for (const child of children.get(parent) ?? []) {
      if (seenDescendants.has(child.id)) continue;
      seenDescendants.add(child.id);
      descendants.push(child);
      visit(child.id);
    }
  }
  visit(id);

  return { self, ancestors, descendants };
}

export function liveWriteScopes(dir, excludeId) {
  const records = Object.values(readRegistry(dir).sessions)
    .filter(
      (record) =>
        record.status === "live" &&
        record.writes?.length > 0 &&
        record.id !== excludeId,
    )
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  return records.map((record) => ({ owner: record.id, writes: [...record.writes] }));
}

function sessionLine(record, depth) {
  const model = record.model || "-";
  return `${"  ".repeat(depth)}${record.id} [${record.kind}/${model}] ${record.status} — ${record.label}`;
}

export function renderTree(dir) {
  const registry = readRegistry(dir);
  const records = Object.values(registry.sessions);
  if (records.length === 0) return "(empty fleet)";

  const children = new Map();
  for (const record of records) {
    if (!children.has(record.parent)) children.set(record.parent, []);
    children.get(record.parent).push(record);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  const lines = [];
  const seen = new Set();
  function visit(record, depth) {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    lines.push(sessionLine(record, depth));
    for (const child of children.get(record.id) ?? []) visit(child, depth + 1);
  }

  for (const root of (children.get(null) ?? [])) visit(root, 0);
  for (const record of [...records].sort((a, b) => Number(a.ts) - Number(b.ts))) {
    if (!seen.has(record.id)) visit(record, 0);
  }
  return lines.join("\n");
}

function print(value) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function main() {
  const [, , dir, command, ...args] = process.argv;
  if (!dir || !command) throw new Error("usage: fleet-registry <dir> <command>");

  switch (command) {
    case "register": {
      if (args[0] !== "-") throw new Error("register requires '-'");
      const rec = JSON.parse(fs.readFileSync(0, "utf8"));
      print(registerSession(dir, rec));
      break;
    }
    case "status":
      print(updateStatus(dir, args[0], args[1]));
      break;
    case "tree":
      print(renderTree(dir));
      break;
    case "family":
      print(family(dir, args[0]));
      break;
    case "live-scopes":
      print(liveWriteScopes(dir));
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
