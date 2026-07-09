import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export const DRIVE_DIR = resolve(process.env.TANDEM_DRIVE_DIR || join(ROOT, "tmp"));
export const QUEUE_FILE = join(DRIVE_DIR, "claude-drive-queue.jsonl");
export const ENABLED_FILE = join(DRIVE_DIR, "drive.enabled");
export const COUNTER_FILE = join(DRIVE_DIR, "drive.counter.json");

const DEFAULT_CAP = 50;

function ensureDriveDir() {
  if (!existsSync(DRIVE_DIR)) mkdirSync(DRIVE_DIR, { recursive: true });
}

function nowId(prefix = "drv") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readEntries() {
  if (!existsSync(QUEUE_FILE)) return [];
  return readFileSync(QUEUE_FILE, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeEntries(entries) {
  ensureDriveDir();
  const tmp = `${QUEUE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""));
  renameSync(tmp, QUEUE_FILE);
}

export function appendDirective(directive, extra = {}) {
  if (!directive || !String(directive).trim()) throw new Error("drive directive is empty");
  ensureDriveDir();
  const entry = {
    id: nowId(extra.type === "stop" ? "stop" : "drv"),
    ts: Date.now(),
    type: extra.type || "directive",
    directive: String(directive).trim(),
    doneAt: extra.doneAt || null,
  };
  appendFileSync(QUEUE_FILE, JSON.stringify(entry) + "\n");
  return entry;
}

export function consumeNextDirective() {
  const entries = readEntries();
  const i = entries.findIndex((entry) => entry.type !== "stop" && !entry.doneAt);
  if (i < 0) return null;
  entries[i] = { ...entries[i], doneAt: Date.now(), status: "done" };
  writeEntries(entries);
  return entries[i];
}

export function setDriveEnabled(enabled, cap = DEFAULT_CAP) {
  ensureDriveDir();
  if (enabled) {
    writeFileSync(ENABLED_FILE, "true\n");
    writeCounter({ count: 0, cap: normalizeCap(cap), updatedAt: Date.now() });
  } else {
    try {
      rmSync(ENABLED_FILE);
    } catch {
      /* already disabled */
    }
  }
}

export function isDriveEnabled() {
  if (!existsSync(ENABLED_FILE)) return false;
  const v = readFileSync(ENABLED_FILE, "utf8").trim().toLowerCase();
  return v === "true" || v === "1" || v === "enabled" || v === "on";
}

function normalizeCap(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : DEFAULT_CAP;
}

export function readCounter() {
  try {
    const c = JSON.parse(readFileSync(COUNTER_FILE, "utf8"));
    return { count: Number(c.count) || 0, cap: normalizeCap(c.cap), updatedAt: Number(c.updatedAt) || 0 };
  } catch {
    return { count: 0, cap: DEFAULT_CAP, updatedAt: 0 };
  }
}

function writeCounter(counter) {
  ensureDriveDir();
  writeFileSync(COUNTER_FILE, JSON.stringify(counter, null, 2) + "\n");
}

export function incrementCounter() {
  const c = readCounter();
  const next = { ...c, count: c.count + 1, updatedAt: Date.now() };
  writeCounter(next);
  return next;
}

export function capReached() {
  const c = readCounter();
  return c.count >= c.cap;
}

export function stopDrive() {
  ensureDriveDir();
  appendDirective("STOP requested: drive disabled; next Claude stop is allowed.", { type: "stop", doneAt: Date.now() });
  setDriveEnabled(false);
}

export function clearDriveState() {
  for (const file of [QUEUE_FILE, ENABLED_FILE, COUNTER_FILE]) {
    try {
      rmSync(file);
    } catch {
      /* ignore */
    }
  }
}

export function driveStatus() {
  const entries = readEntries();
  const pending = entries.filter((entry) => entry.type !== "stop" && !entry.doneAt);
  const done = entries.filter((entry) => entry.type !== "stop" && entry.doneAt);
  const stops = entries.filter((entry) => entry.type === "stop");
  return {
    dir: DRIVE_DIR,
    queueFile: QUEUE_FILE,
    enabled: isDriveEnabled(),
    counter: readCounter(),
    pending: pending.length,
    done: done.length,
    stops: stops.length,
    next: pending[0] || null,
  };
}

function parseDriveArgs(argv) {
  let start = false;
  let stop = false;
  let status = false;
  let clear = false;
  let cap = DEFAULT_CAP;
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start" || a === "--enable") start = true;
    else if (a === "--stop" || a === "--disable") stop = true;
    else if (a === "--status") status = true;
    else if (a === "--clear") clear = true;
    else if (a === "--cap") cap = argv[++i] ?? cap;
    else if (a?.startsWith("--cap=")) cap = a.slice("--cap=".length);
    else words.push(a);
  }
  return { start, stop, status, clear, cap, directive: words.join(" ").trim() };
}

export function driveUsage() {
  return [
    "peer.mjs drive --start [--cap 50] [\"first directive\"]",
    "peer.mjs drive \"<directive>\"",
    "peer.mjs drive --status",
    "peer.mjs drive --stop",
    "peer.mjs drive --clear",
  ].join("\n");
}

export function driveCli(argv) {
  const opts = parseDriveArgs(argv);
  if (opts.clear) {
    clearDriveState();
    console.log("tandem drive: cleared queue, enable flag, and counter");
    return;
  }
  if (opts.stop) {
    stopDrive();
    console.log("tandem drive: disabled; next Claude stop will be allowed");
    return;
  }
  if (opts.start) {
    setDriveEnabled(true, opts.cap);
    console.log(`tandem drive: enabled (cap ${readCounter().cap})`);
  }
  if (opts.directive) {
    const entry = appendDirective(opts.directive);
    const note = isDriveEnabled() ? "" : " (drive is disabled; run `peer.mjs drive --start` to inject)";
    console.log(`tandem drive: queued ${entry.id}${note}`);
    return;
  }
  if (opts.status || opts.start) {
    const s = driveStatus();
    console.log(
      [
        `enabled: ${s.enabled}`,
        `counter: ${s.counter.count}/${s.counter.cap}`,
        `pending: ${s.pending}`,
        `done: ${s.done}`,
        `stops: ${s.stops}`,
        `queue: ${s.queueFile}`,
        s.next ? `next: ${s.next.directive}` : "next: (none)",
      ].join("\n"),
    );
    return;
  }
  console.log(driveUsage());
}
