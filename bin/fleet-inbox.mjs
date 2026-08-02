// Fleet inbox — the push channel that makes "as soon as they're done" literal.
//
// Every bridge-managed session (claude partner turns, codex lanes, swarm juniors) reaches ONE
// choke point when a turn ends: jobs.mjs signalDone(), which appends a turn-done event here.
// The apex then runs a single `peer.mjs fleet wake` for the WHOLE fleet instead of one polling
// `swarm wait` per swarm — fs.watch push with a bounded poll fallback (Z: is a network drive;
// watch events there are best-effort, so the poll is authoritative for correctness and the
// watch only improves latency).
//
// The inbox is append-only JSONL, advisory telemetry: job records stay the sole source of
// truth, and a woken caller re-reads them. A failed append must never break a dispatch.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, "..");

// Same resolution as swarm.mjs fleetDir (which delegates here): explicit pin > per-state
// isolation (tests, nested contexts) > the repo-level fleet.
export function fleetDirFor(root) {
  if (process.env.TANDEM_FLEET_DIR) return process.env.TANDEM_FLEET_DIR;
  if (process.env.TANDEM_STATE) return join(resolve(process.env.TANDEM_STATE), "fleet");
  return join(root, "tandems", ".fleet");
}

export function defaultFleetDir() {
  return fleetDirFor(MODULE_ROOT);
}

export function inboxPath(dir) {
  return join(dir, "inbox.jsonl");
}

export function appendEvent(dir, event) {
  const record = { ts: Date.now(), ...event };
  mkdirSync(dir, { recursive: true });
  appendFileSync(inboxPath(dir), `${JSON.stringify(record)}\n`);
  return record;
}

export function readEvents(dir, lastN = 0) {
  const file = inboxPath(dir);
  if (!existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* a torn tail line is expected mid-append; skip it */
    }
  }
  return lastN > 0 ? events.slice(-lastN) : events;
}

// Resolve with the FIRST event newer than sinceTs that passes filter, or null on timeout.
// Push (fs.watch on the inbox's directory) races a poll; the poll is authoritative.
export function waitForEvent(dir, { sinceTs = Date.now(), filter = null, timeoutSec = 1800, pollMs = 500 } = {}) {
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + timeoutSec * 1000;
  return new Promise((resolvePromise) => {
    let watcher = null;
    let timer = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (watcher) try { watcher.close(); } catch { /* already closed */ }
      if (timer) clearTimeout(timer);
      resolvePromise(value);
    };
    const check = () => {
      if (settled) return;
      for (const event of readEvents(dir)) {
        if ((event.ts || 0) <= sinceTs) continue;
        if (filter && !filter(event)) continue;
        return finish(event);
      }
      if (Date.now() >= deadline) return finish(null);
      timer = setTimeout(check, pollMs);
    };
    try {
      watcher = watch(dir, () => check());
    } catch {
      /* watch unavailable (network fs) — the poll carries it */
    }
    check();
  });
}
