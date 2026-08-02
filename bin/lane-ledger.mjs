import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ZERO_USAGE = {
  turns: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  rate_limits: null,
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function rateLimitsFromLine(value) {
  if (!isObject(value)) return null;
  if (
    value.type === 'event_msg' &&
    isObject(value.payload) &&
    value.payload.type === 'token_count' &&
    isObject(value.payload.rate_limits)
  ) {
    return value.payload.rate_limits;
  }
  if (value.type === 'token_count' && isObject(value.rate_limits)) {
    return value.rate_limits;
  }
  return null;
}

function parseJsonLines(text, onValue) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      onValue(JSON.parse(line));
    } catch {
      // Ignore non-JSON lines.
    }
  }
}

export function parseUsageFromStream(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ...ZERO_USAGE };
  }

  let turns = 0;
  let input_tokens = 0;
  let cached_input_tokens = 0;
  let output_tokens = 0;
  let reasoning_output_tokens = 0;
  let rate_limits = null;

  parseJsonLines(text, (value) => {
    const foundRateLimits = rateLimitsFromLine(value);
    if (foundRateLimits) rate_limits = foundRateLimits;

    if (!isObject(value) || value.type !== 'turn.completed') return;

    turns += 1;
    const usage = isObject(value.usage) ? value.usage : {};
    input_tokens += numberOrNull(usage.input_tokens) ?? 0;
    cached_input_tokens += numberOrNull(usage.cached_input_tokens) ?? 0;
    output_tokens += numberOrNull(usage.output_tokens) ?? 0;
    reasoning_output_tokens += numberOrNull(usage.reasoning_output_tokens) ?? 0;
  });

  return {
    turns,
    input_tokens,
    cached_input_tokens,
    output_tokens,
    reasoning_output_tokens,
    rate_limits,
  };
}

export function summarizeRateLimits(rl) {
  if (!isObject(rl)) return null;

  const primary = isObject(rl.primary) ? rl.primary : {};
  const secondary = isObject(rl.secondary) ? rl.secondary : {};

  return {
    used_primary: numberOrNull(primary.used_percent),
    used_secondary: numberOrNull(secondary.used_percent),
    resets_primary: numberOrNull(primary.resets_at),
    resets_secondary: numberOrNull(secondary.resets_at),
  };
}

function matchingRolloutFiles(dir, output) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matchingRolloutFiles(entryPath, output);
      continue;
    }
    if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;

    try {
      output.push({ file: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs });
    } catch {
      // Skip files that cannot be stat'ed.
    }
  }
}

function lastRateLimitsInFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let rate_limits = null;
  parseJsonLines(text, (value) => {
    const foundRateLimits = rateLimitsFromLine(value);
    if (foundRateLimits) rate_limits = foundRateLimits;
  });
  return rate_limits;
}

export function latestRateLimits(sessionsDir) {
  const files = [];
  try {
    if (!fs.statSync(sessionsDir).isDirectory()) return null;
  } catch {
    return null;
  }

  matchingRolloutFiles(sessionsDir, files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file, mtimeMs } of files.slice(0, 10)) {
    const rate_limits = lastRateLimitsInFile(file);
    if (!rate_limits) continue;
    return { ...summarizeRateLimits(rate_limits), asof: mtimeMs };
  }
  return null;
}

export function appendLedger(file, record) {
  if (!isPlainObject(record)) {
    throw new TypeError('record must be an object');
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const written = { ts: Date.now(), ...record };
  fs.appendFileSync(file, `${JSON.stringify(written)}\n`, 'utf8');
  return written;
}

export function readLedger(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  parseJsonLines(text, (value) => records.push(value));
  return records;
}

function readInput(file) {
  return file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
}

function defaultSessionsDir() {
  const codexHome = process.env.CODEX_HOME;
  return path.join(codexHome || path.join(os.homedir(), '.codex'), 'sessions');
}

function usageError() {
  throw new Error(
    'usage: lane-ledger.mjs parse <streamFile|-> | rate-limits [sessionsDir] | append <ledgerFile> - | read <ledgerFile>',
  );
}

function runCli(args) {
  const [command, first, second] = args;

  switch (command) {
    case 'parse':
      if (first === undefined) usageError();
      console.log(JSON.stringify(parseUsageFromStream(readInput(first))));
      return;
    case 'rate-limits':
      if (first !== undefined && first === '') usageError();
      console.log(JSON.stringify(latestRateLimits(first || defaultSessionsDir())));
      return;
    case 'append':
      if (first === undefined || second !== '-') usageError();
      console.log(JSON.stringify(appendLedger(first, JSON.parse(readInput('-')))));
      return;
    case 'read':
      if (first === undefined) usageError();
      console.log(JSON.stringify(readLedger(first)));
      return;
    default:
      usageError();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
