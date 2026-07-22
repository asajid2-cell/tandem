#!/usr/bin/env node
// probe-codex.mjs
// Prints REMAINING usage % (0-100) for the Codex / ChatGPT subscription.
// Codex writes a `token_count` event after every response into its session rollout
// files (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). That event carries
//   payload.rate_limits.primary.used_percent   (short window, e.g. 5h)
//   payload.rate_limits.secondary.used_percent  (weekly)
// This is a pure LOCAL FILE read — ZERO tokens, no network, no inference.
//
// The limits are per-PLAN (per ChatGPT account), shared by every Codex model
// (gpt-5.6-sol, gpt-5.6-luna, ...), so this same number applies to all of them.
//
// remaining = 100 - max(primary used%, secondary used%)
// Value is as fresh as the last Codex turn; while the orchestrator is actively
// routing to Codex it refreshes every turn. On error prints nothing, exits 1.
//
// Sessions root resolution honors CODEX_HOME (join(CODEX_HOME,'sessions')) when set,
// falling back to ~/.codex/sessions; a caller may also pass sessionsRoot explicitly.
//
// Shared-package shape: probeCodex() is the reusable async API (throws on any error);
// runCli() preserves the exact CLI contract for the bin/ shim and this file run directly.
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function walk(dir, out) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.startsWith('rollout-')) {
      try { out.push([statSync(p).mtimeMs, p]); } catch {}
    }
  }
}

// Returns { remaining, asof } where remaining is 0-100 and asof is the source rollout file's
// mtime (ms epoch). Throws on any error. asof lets the orchestrator refuse un-parking a
// limit-parked provider on data that predates the park.
export async function probeCodex({ sessionsRoot } = {}) {
  const root = sessionsRoot
    || (process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(homedir(), '.codex', 'sessions'));
  const files = [];
  walk(root, files);
  files.sort((a, b) => b[0] - a[0]); // newest first
  let rl = null, srcMtime = 0;
  for (const [mtime, p] of files.slice(0, 8)) { // newest few files
    const lines = readFileSync(p, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln || ln.indexOf('rate_limits') === -1) continue;
      try {
        const o = JSON.parse(ln);
        const cand = o?.payload?.rate_limits;
        if (cand && (cand.primary || cand.secondary)) { rl = cand; srcMtime = mtime; break; }
      } catch {}
    }
    if (rl) break;
  }
  if (!rl) throw new Error('no rate_limits event found in recent sessions');
  const prim = Number(rl?.primary?.used_percent ?? 0);
  const sec  = Number(rl?.secondary?.used_percent ?? 0);
  const used = Math.max(prim, sec);
  const remaining = Math.max(0, Math.min(100, 100 - used));
  return { remaining, asof: srcMtime };
}

// CLI contract (byte-identical to the original bin/usage-probe-codex.mjs): print
// `${Math.round(remaining)} asof=${Math.round(asof)}` to stdout on success; on ANY error
// print `probe-codex error: <msg>\n` to stderr and exit 1.
//
// asof = the source rollout file's mtime: this value is only as fresh as the last Codex
// turn. The orchestrator uses the stamp to refuse un-parking a limit-parked provider on
// data that predates the park (the % itself still parses first for the reserve hold).
export async function runCli() {
  try {
    const { remaining, asof } = await probeCodex();
    process.stdout.write(`${Math.round(remaining)} asof=${Math.round(asof)}`);
  } catch (e) {
    process.stderr.write('probe-codex error: ' + e.message + '\n');
    process.exit(1);
  }
}

// Run as main? Compare this module's realpath to the invoked script's realpath (realpathSync
// on both normalizes symlinks and drive-letter casing so it holds on Windows too).
function isMain() {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

if (isMain()) runCli();
