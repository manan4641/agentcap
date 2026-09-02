'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { costOfUsage, normalizeModel } = require('../src/pricing');
const { TrackingError } = require('../src/errors');

test('prices a real transcript record exactly', () => {
  // Captured verbatim from a real Claude Code transcript.
  const usage = {
    input_tokens: 3,
    cache_creation_input_tokens: 13310,
    cache_read_input_tokens: 12936,
    output_tokens: 115,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    cache_creation: { ephemeral_1h_input_tokens: 13310, ephemeral_5m_input_tokens: 0 },
  };
  // 3*3 + 115*15 + 12936*0.30 + 13310*6 = 85,474.8 per million
  const { usd } = costOfUsage(usage, 'claude-sonnet-4-6');
  assert.ok(Math.abs(usd - 0.0854748) < 1e-9, `got ${usd}`);
});

test("matches the pricing docs' own worked example", () => {
  const { usd } = costOfUsage(
    { input_tokens: 10000, cache_read_input_tokens: 40000, output_tokens: 15000 },
    'claude-opus-5'
  );
  // docs: $0.05 uncached + $0.02 cache read + $0.375 output = $0.445
  assert.ok(Math.abs(usd - 0.445) < 1e-9, `got ${usd}`);
});

test('charges 1h cache writes at 2x, not the 5m 1.25x rate', () => {
  const oneHour = costOfUsage(
    { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } },
    'claude-opus-5'
  );
  const fiveMin = costOfUsage(
    { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1e6 } },
    'claude-opus-5'
  );
  assert.strictEqual(oneHour.usd, 10); // 2x $5
  assert.strictEqual(fiveMin.usd, 6.25); // 1.25x $5
});

test('falls back to the 5m rate when the TTL split is absent', () => {
  const { usd } = costOfUsage({ cache_creation_input_tokens: 1e6 }, 'claude-opus-5');
  assert.strictEqual(usd, 6.25);
});

test('fails loud on an unknown model rather than pricing it at zero', () => {
  assert.throws(
    () => costOfUsage({ output_tokens: 1e6 }, 'claude-does-not-exist-7'),
    (err) => err instanceof TrackingError && /Unknown model/.test(err.message)
  );
});

test('prices the <synthetic> pseudo-model at zero without throwing', () => {
  assert.strictEqual(costOfUsage({ output_tokens: 5000 }, '<synthetic>').usd, 0);
});

test('applies fast-mode premium pricing', () => {
  const standard = costOfUsage({ output_tokens: 1e6 }, 'claude-opus-5', { speed: 'standard' });
  const fast = costOfUsage({ output_tokens: 1e6 }, 'claude-opus-5', { speed: 'fast' });
  assert.strictEqual(standard.usd, 25);
  assert.strictEqual(fast.usd, 50);
});

test('fast mode does not apply to models that lack it', () => {
  const fast = costOfUsage({ output_tokens: 1e6 }, 'claude-sonnet-4-6', { speed: 'fast' });
  assert.strictEqual(fast.usd, 15);
});

test('applies the 1.1x US inference-geo multiplier', () => {
  const global = costOfUsage({ output_tokens: 1e6, inference_geo: '' }, 'claude-opus-5');
  const us = costOfUsage({ output_tokens: 1e6, inference_geo: 'us' }, 'claude-opus-5');
  assert.strictEqual(global.usd, 25);
  assert.ok(Math.abs(us.usd - 27.5) < 1e-9);
});

test('bills web search at $10 per 1,000 searches, exempt from the geo multiplier', () => {
  const { usd } = costOfUsage(
    { server_tool_use: { web_search_requests: 100 }, inference_geo: 'us' },
    'claude-opus-5'
  );
  assert.ok(Math.abs(usd - 1.0) < 1e-9, `got ${usd}`);
});

test('ignores negative or non-numeric token counts instead of crediting them', () => {
  const { usd } = costOfUsage({ output_tokens: -5000, input_tokens: 'oops' }, 'claude-opus-5');
  assert.strictEqual(usd, 0);
});

test('normalizes dated, Bedrock, and Vertex model ids', () => {
  assert.strictEqual(normalizeModel('claude-opus-4-5-20251101'), 'claude-opus-4-5');
  assert.strictEqual(normalizeModel('anthropic.claude-opus-5'), 'claude-opus-5');
  assert.strictEqual(normalizeModel('claude-opus-4-5@20251101'), 'claude-opus-4-5');
});

test('throws when a usage record has no model at all', () => {
  assert.throws(() => costOfUsage({ output_tokens: 1 }, null), TrackingError);
});

test("reproduces Claude Code's own /usage figure from the same token counts", () => {
  // Cross-validation against a real Claude Code session (2026-08-23). Claude Code's /usage
  // reported $0.1163 for claude-sonnet-5 from these exact counts. Our formula must agree,
  // otherwise our pricing table or cache-tier handling has drifted.
  const reported = {
    input_tokens: 508,
    output_tokens: 527,
    cache_read_input_tokens: 145400,
    cache_creation_input_tokens: 20200,
    cache_creation: { ephemeral_1h_input_tokens: 20200, ephemeral_5m_input_tokens: 0 },
  };
  const { usd } = costOfUsage(reported, 'claude-sonnet-5');
  assert.ok(Math.abs(usd - 0.1163) < 0.0002, `expected ~$0.1163, got $${usd.toFixed(6)}`);

  // Pricing the same tokens at the 5-minute cache-write rate gives $0.0859, which does NOT
  // match -- concrete evidence that Claude Code bills cache writes at the 1h tier and that
  // collapsing the two tiers would under-count by ~26%.
  const asFiveMin = costOfUsage(
    { ...reported, cache_creation: { ephemeral_5m_input_tokens: 20200, ephemeral_1h_input_tokens: 0 } },
    'claude-sonnet-5'
  );
  assert.ok(asFiveMin.usd < 0.09, 'the 5m tier must be materially cheaper');
});
