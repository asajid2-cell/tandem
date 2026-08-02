import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendLedger, latestRateLimits, parseUsageFromStream, readLedger, summarizeRateLimits } from '../bin/lane-ledger.mjs';

const nestedRateLimits = {
  limit_id: 'x',
  limit_name: 'y',
  primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1783743297 },
  secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1784330097 },
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lane-ledger-'));
}

test('sums turn usage and skips garbage lines', () => {
  const stream = [
    'not json',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 },
    }),
    '{broken',
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 4 } }),
  ].join('\n');

  assert.deepEqual(parseUsageFromStream(stream), {
    turns: 2,
    input_tokens: 15,
    cached_input_tokens: 2,
    output_tokens: 7,
    reasoning_output_tokens: 1,
    rate_limits: null,
  });
});

test('counts a turn with missing usage as zero', () => {
  assert.deepEqual(parseUsageFromStream(JSON.stringify({ type: 'turn.completed' })), {
    turns: 1,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    rate_limits: null,
  });
});

test('uses the last nested rate_limits object', () => {
  const first = { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 1 } } } };
  const second = { type: 'event_msg', payload: { type: 'token_count', rate_limits: nestedRateLimits } };

  assert.deepEqual(parseUsageFromStream(`${JSON.stringify(first)}\n${JSON.stringify(second)}`).rate_limits, nestedRateLimits);
});

test('accepts the flat token_count shape', () => {
  const rate_limits = { primary: { used_percent: 8, resets_at: 100 } };
  const result = parseUsageFromStream(JSON.stringify({ type: 'token_count', rate_limits }));

  assert.deepEqual(result.rate_limits, rate_limits);
});

test('empty and non-string input returns zero usage', () => {
  const expected = {
    turns: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    rate_limits: null,
  };

  assert.deepEqual(parseUsageFromStream(''), expected);
  assert.deepEqual(parseUsageFromStream(null), expected);
});

test('summarizes both rate limit halves', () => {
  assert.deepEqual(summarizeRateLimits(nestedRateLimits), {
    used_primary: 12.5,
    used_secondary: 3,
    resets_primary: 1783743297,
    resets_secondary: 1784330097,
  });
});

test('missing secondary rate limits produce null secondary fields', () => {
  assert.deepEqual(summarizeRateLimits({ primary: { used_percent: 4, resets_at: 42 } }), {
    used_primary: 4,
    used_secondary: null,
    resets_primary: 42,
    resets_secondary: null,
  });
});

test('bad rate limit input summarizes to null', () => {
  assert.equal(summarizeRateLimits(null), null);
  assert.equal(summarizeRateLimits('bad'), null);
});

test('latestRateLimits picks the newer rollout file', () => {
  const dir = tempDir();
  const oldFile = path.join(dir, '2026', '08', '01', 'rollout-old.jsonl');
  const newFile = path.join(dir, '2026', '08', '02', 'rollout-new.jsonl');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  fs.writeFileSync(oldFile, JSON.stringify({ type: 'token_count', rate_limits: { primary: { used_percent: 1 } } }));
  fs.writeFileSync(newFile, JSON.stringify({ type: 'token_count', rate_limits: { primary: { used_percent: 2 } } }));
  fs.utimesSync(oldFile, 1000, 1000);
  fs.utimesSync(newFile, 2000, 2000);

  assert.deepEqual(latestRateLimits(dir), {
    used_primary: 2,
    used_secondary: null,
    resets_primary: null,
    resets_secondary: null,
    asof: 2000000,
  });
});

test('latestRateLimits skips a newer file without rate limits', () => {
  const dir = tempDir();
  const older = path.join(dir, 'rollout-with-limits.jsonl');
  const newer = path.join(dir, 'rollout-without-limits.jsonl');
  fs.writeFileSync(older, JSON.stringify({ type: 'item.completed' }));
  fs.writeFileSync(newer, `${JSON.stringify({ type: 'item.completed' })}\nnot json\n`);
  fs.appendFileSync(older, `\n${JSON.stringify({ type: 'token_count', rate_limits: nestedRateLimits })}\n`);
  fs.utimesSync(older, 3000, 3000);
  fs.utimesSync(newer, 4000, 4000);

  assert.deepEqual(latestRateLimits(dir), {
    used_primary: 12.5,
    used_secondary: 3,
    resets_primary: 1783743297,
    resets_secondary: 1784330097,
    asof: 3000000,
  });
});

test('missing sessions directory returns null', () => {
  assert.equal(latestRateLimits(path.join(tempDir(), 'missing')), null);
});

test('appendLedger creates parent directories and readLedger skips corrupt lines', () => {
  const file = path.join(tempDir(), 'nested', 'ledger.jsonl');
  const first = appendLedger(file, { lane: 'a', value: 1 });
  const second = appendLedger(file, { lane: 'b', value: 2 });
  fs.appendFileSync(file, '{corrupt}\n\n');

  assert.deepEqual(readLedger(file), [first, second]);
});

test('appendLedger rejects non-object records', () => {
  assert.throws(() => appendLedger(path.join(tempDir(), 'ledger.jsonl'), []), {
    message: 'record must be an object',
  });
});

test('readLedger returns an empty array for a missing file', () => {
  assert.deepEqual(readLedger(path.join(tempDir(), 'missing.jsonl')), []);
});
