'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TranscriptAccumulator } = require('../src/transcript');

function tmpFile(name = 'transcript.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcap-test-'));
  return path.join(dir, name);
}

/** One assistant JSONL line. Claude Code emits several of these per message. */
function line(messageId, outputTokens, model = 'claude-sonnet-4-6', extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    requestId: 'req_' + messageId,
    ...extra,
    message: {
      id: messageId,
      role: 'assistant',
      model,
      usage: { output_tokens: outputTokens, input_tokens: 0 },
    },
  });
}

test('deduplicates repeated usage across content-block lines', () => {
  const f = tmpFile();
  // Three lines, one message: Claude Code repeats the same usage on each content block.
  fs.writeFileSync(f, [line('msg_a', 10000), line('msg_a', 10000), line('msg_a', 10000)].join('\n') + '\n');

  const acc = new TranscriptAccumulator(f);
  acc.poll();
  const t = acc.snapshot();

  assert.strictEqual(t.requests, 1, 'should count one request, not three');
  assert.strictEqual(t.output, 10000, 'should not triple-count output tokens');
  assert.ok(Math.abs(t.usd - 0.15) < 1e-9);
});

test('counts distinct messages separately', () => {
  const f = tmpFile();
  fs.writeFileSync(f, [line('msg_a', 10000), line('msg_b', 10000)].join('\n') + '\n');
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  assert.strictEqual(acc.snapshot().requests, 2);
  assert.ok(Math.abs(acc.snapshot().usd - 0.3) < 1e-9);
});

test('does not double-count across successive polls', () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('msg_a', 10000) + '\n');
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  acc.poll();
  acc.poll();
  assert.strictEqual(acc.snapshot().requests, 1);
});

test('accumulates only newly appended records', () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('msg_a', 10000) + '\n');
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  assert.ok(Math.abs(acc.snapshot().usd - 0.15) < 1e-9);

  fs.appendFileSync(f, line('msg_b', 10000) + '\n');
  const grew = acc.poll();
  assert.strictEqual(grew, true);
  assert.ok(Math.abs(acc.snapshot().usd - 0.3) < 1e-9);
});

test('recovers a record split across two writes (torn line)', () => {
  const f = tmpFile();
  const full = line('msg_a', 10000) + '\n';
  const cut = Math.floor(full.length / 2);

  fs.writeFileSync(f, full.slice(0, cut)); // half a line on disk
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  assert.strictEqual(acc.snapshot().requests, 0, 'a partial line must not be counted yet');

  fs.appendFileSync(f, full.slice(cut)); // the rest arrives
  acc.poll();
  assert.strictEqual(acc.snapshot().requests, 1, 'the completed line must be counted, not lost');
  assert.ok(Math.abs(acc.snapshot().usd - 0.15) < 1e-9);
});

test('handles a file that has not been created yet', () => {
  const acc = new TranscriptAccumulator(path.join(os.tmpdir(), 'agentcap-nope', 'missing.jsonl'));
  assert.strictEqual(acc.poll(), false);
  assert.strictEqual(acc.everRead, false);
  assert.strictEqual(acc.snapshot().usd, 0);
});

test('re-reads from the top if the file is truncated, without double-counting', () => {
  const f = tmpFile();
  fs.writeFileSync(f, [line('msg_a', 10000), line('msg_b', 10000)].join('\n') + '\n');
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  const before = acc.snapshot().usd;

  fs.writeFileSync(f, line('msg_a', 10000) + '\n'); // truncated, same message
  acc.poll();
  assert.ok(Math.abs(acc.snapshot().usd - before) < 1e-9, 'seen-ids must prevent recount');
});

test('skips malformed lines without losing valid neighbours', () => {
  const f = tmpFile();
  fs.writeFileSync(f, [line('msg_a', 10000), '{not valid json', line('msg_b', 10000)].join('\n') + '\n');
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  assert.strictEqual(acc.snapshot().requests, 2);
});

test('ignores non-assistant records and assistant records with no usage', () => {
  const f = tmpFile();
  fs.writeFileSync(
    f,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'x', model: 'claude-opus-5' } }),
      JSON.stringify({ type: 'system', content: 'note' }),
      line('msg_a', 10000),
    ].join('\n') + '\n'
  );
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  assert.strictEqual(acc.snapshot().requests, 1);
});

test('counts subagent (sidechain) usage too', () => {
  const f = tmpFile();
  fs.writeFileSync(
    f,
    [line('msg_a', 10000), line('msg_sub', 10000, 'claude-sonnet-4-6', { isSidechain: true })].join('\n') + '\n'
  );
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  assert.strictEqual(acc.snapshot().requests, 2, 'subagent spend is still the user’s money');
});

test('breaks spend down per model', () => {
  const f = tmpFile();
  fs.writeFileSync(
    f,
    [line('msg_a', 1e6, 'claude-opus-5'), line('msg_b', 1e6, 'claude-haiku-4-5')].join('\n') + '\n'
  );
  const acc = new TranscriptAccumulator(f);
  acc.poll();
  const { byModel } = acc.snapshot();
  assert.strictEqual(byModel['claude-opus-5'].usd, 25);
  assert.strictEqual(byModel['claude-haiku-4-5'].usd, 5);
});

test('setPath resets accounting when the authoritative path differs from the guess', () => {
  const guessed = tmpFile('guess.jsonl');
  const real = tmpFile('real.jsonl');
  fs.writeFileSync(guessed, line('msg_a', 10000) + '\n');
  fs.writeFileSync(real, line('msg_z', 20000) + '\n');

  const acc = new TranscriptAccumulator(guessed);
  acc.poll();
  acc.setPath(real);
  acc.poll();

  assert.strictEqual(acc.snapshot().requests, 1);
  assert.strictEqual(acc.snapshot().output, 20000, 'totals must come from the real transcript only');
});
