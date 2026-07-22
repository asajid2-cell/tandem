#!/usr/bin/env node
// probe-claude.mjs <model-display-name>
// Prints REMAINING usage % (0-100) for the Claude Code subscription, per model.
// Reads the user's own usage meter via GET https://api.anthropic.com/api/oauth/usage
// (the same endpoint the /usage TUI command uses). This is a metadata call — it does
// NOT run any model/inference and burns ZERO tokens.
//
// remaining = 100 - max(session 5h util, weekly util, this-model's weekly-scoped util)
// so it reflects whatever limit would actually cut this model off first.
//
// On ANY error prints nothing and exits 1, so the orchestrator leaves the hold state
// untouched (fail-safe: a probe failure never wrongly frees or holds a model).
//
// Shared-package shape: probeClaude() is the reusable async API (throws on any error);
// runCli() preserves the exact CLI contract for the bin/ shim and this file run directly.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Returns REMAINING usage % (0-100) for `model`, throwing on any error (no token, http
// failure, bad JSON). The caller decides how a failure maps to hold state (the CLI exits 1,
// the policy's refreshHolds leaves holds untouched).
export async function probeClaude(model) {
  const m = String(model || '').toLowerCase();
  const cred = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8'));
  const tok = cred?.claudeAiOauth?.accessToken;
  if (!tok) throw new Error('no token');
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': 'Bearer ' + tok,
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!res.ok) throw new Error('http ' + res.status);
  const d = await res.json();
  const session = Number(d?.five_hour?.utilization ?? 0);
  const weekly  = Number(d?.seven_day?.utilization ?? 0);
  let scoped = 0;
  for (const l of (d?.limits || [])) {
    const dn = l?.scope?.model?.display_name;
    if (l?.kind === 'weekly_scoped' && dn && dn.toLowerCase() === m) {
      scoped = Math.max(scoped, Number(l.percent ?? 0));
    }
  }
  const used = Math.max(session, weekly, scoped);
  return Math.max(0, Math.min(100, 100 - used));
}

// CLI contract (byte-identical to the original bin/usage-probe-claude.mjs): print the rounded
// remaining % to stdout on success; on ANY error print `probe-claude error: <msg>\n` to stderr
// and exit 1.
export async function runCli() {
  const model = process.argv[2] || '';
  try {
    const remaining = await probeClaude(model);
    process.stdout.write(String(Math.round(remaining)));
  } catch (e) {
    process.stderr.write('probe-claude error: ' + e.message + '\n');
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
