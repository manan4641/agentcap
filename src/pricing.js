'use strict';

const { TrackingError } = require('./errors');

const MTOK = 1_000_000;

/** Web search is billed at $10 per 1,000 searches. Web fetch is free. */
const WEB_SEARCH_USD = 10 / 1000;

/** US-only inference applies a 1.1x multiplier to every token category. */
const US_GEO_MULTIPLIER = 1.1;

/**
 * USD per million tokens. Verified against
 * https://platform.claude.com/docs/en/about-claude/pricing on 2026-08-23.
 *
 * Cache columns are not guesses: 5m writes are 1.25x base input, 1h writes are 2x,
 * and cache reads are 0.1x. Claude Code leans heavily on 1h caching, so collapsing
 * the two write tiers into one materially under-counts a long session.
 */
const PRICING = {
  'claude-fable-5':    { input: 10, write5m: 12.50, write1h: 20, read: 1.00, output: 50 },
  'claude-mythos-5':   { input: 10, write5m: 12.50, write1h: 20, read: 1.00, output: 50 },
  'claude-opus-5':     { input: 5,  write5m: 6.25,  write1h: 10, read: 0.50, output: 25 },
  'claude-opus-4-8':   { input: 5,  write5m: 6.25,  write1h: 10, read: 0.50, output: 25 },
  'claude-opus-4-7':   { input: 5,  write5m: 6.25,  write1h: 10, read: 0.50, output: 25 },
  'claude-opus-4-6':   { input: 5,  write5m: 6.25,  write1h: 10, read: 0.50, output: 25 },
  'claude-opus-4-5':   { input: 5,  write5m: 6.25,  write1h: 10, read: 0.50, output: 25 },
  'claude-opus-4-1':   { input: 15, write5m: 18.75, write1h: 30, read: 1.50, output: 75 },
  'claude-sonnet-5':   { input: 2,  write5m: 2.50,  write1h: 4,  read: 0.20, output: 10 },
  'claude-sonnet-4-6': { input: 3,  write5m: 3.75,  write1h: 6,  read: 0.30, output: 15 },
  'claude-sonnet-4-5': { input: 3,  write5m: 3.75,  write1h: 6,  read: 0.30, output: 15 },
  'claude-haiku-4-5':  { input: 1,  write5m: 1.25,  write1h: 2,  read: 0.10, output: 5 },
  'claude-haiku-3-5':  { input: 0.80, write5m: 1, write1h: 1.60, read: 0.08, output: 4 },
};

/** Fast mode (research preview) is billed at a premium on these models only. */
const FAST_MODE_PRICING = {
  'claude-opus-5':   { input: 10, write5m: 12.50, write1h: 20, read: 1.00, output: 50 },
  'claude-opus-4-8': { input: 10, write5m: 12.50, write1h: 20, read: 1.00, output: 50 },
};

/**
 * Models that are real but cost nothing. `<synthetic>` is Claude Code's placeholder for
 * locally-generated error messages -- it never hit the API, so it must price at $0
 * without tripping the unknown-model guard.
 */
const ZERO_COST_MODELS = new Set(['<synthetic>', 'synthetic']);

/** Strip a trailing date snapshot, e.g. "claude-opus-4-5-20251101" -> "claude-opus-4-5". */
function normalizeModel(model) {
  if (typeof model !== 'string' || model === '') return null;
  let m = model.trim();
  // Vertex uses "@" as a version separator; Bedrock prefixes with the vendor.
  m = m.replace(/^(anthropic|us|eu|apac)\./, '').split('@')[0];
  m = m.replace(/-(\d{8})$/, '');
  return m;
}

function ratesFor(model, { speed } = {}) {
  const normalized = normalizeModel(model);

  if (normalized === null || ZERO_COST_MODELS.has(normalized)) {
    if (normalized === null) {
      throw new TrackingError(
        'A usage record in the transcript has no model name, so its cost cannot be determined.',
        { hint: 'This is unexpected. Please open an issue with your Claude Code version.' }
      );
    }
    return { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
  }

  if (speed === 'fast' && FAST_MODE_PRICING[normalized]) {
    return FAST_MODE_PRICING[normalized];
  }

  const rates = PRICING[normalized];
  if (!rates) {
    // Fail loud. Silently pricing an unknown model at $0 would let a session run
    // uncapped while the tool reports everything is fine -- the exact failure mode
    // this project exists to prevent.
    throw new TrackingError(
      `Unknown model "${model}" -- AgentCap has no price for it, so it cannot enforce a cap.`,
      {
        hint:
          'This usually means a new Claude model shipped. Update AgentCap ' +
          '(npm i -g agentcap@latest), or add the model to src/pricing.js.',
      }
    );
  }
  return rates;
}

/**
 * Price a single Anthropic `usage` object.
 * Returns dollars plus a normalized token breakdown.
 */
function costOfUsage(usage, model, opts = {}) {
  if (!usage || typeof usage !== 'object') {
    throw new TrackingError('Encountered a usage record that was not an object.');
  }

  const rates = ratesFor(model, opts);

  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);

  // Prefer the explicit 5m/1h split; fall back to the reported total at the 5m rate
  // (Anthropic's default TTL) when the breakdown is absent.
  const split = usage.cache_creation;
  let write5m;
  let write1h;
  if (split && typeof split === 'object') {
    write5m = num(split.ephemeral_5m_input_tokens);
    write1h = num(split.ephemeral_1h_input_tokens);
  } else {
    write5m = num(usage.cache_creation_input_tokens);
    write1h = 0;
  }

  const webSearches = num(usage.server_tool_use && usage.server_tool_use.web_search_requests);

  let usd =
    (input * rates.input +
      output * rates.output +
      cacheRead * rates.read +
      write5m * rates.write5m +
      write1h * rates.write1h) /
    MTOK;

  if (usage.inference_geo === 'us') usd *= US_GEO_MULTIPLIER;

  // Server-tool fees are flat and not subject to the geo multiplier.
  usd += webSearches * WEB_SEARCH_USD;

  return {
    usd,
    input,
    output,
    cacheRead,
    cacheWrite: write5m + write1h,
    webSearches,
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

module.exports = {
  costOfUsage,
  ratesFor,
  normalizeModel,
  PRICING,
  FAST_MODE_PRICING,
  WEB_SEARCH_USD,
  knownModels: () => Object.keys(PRICING),
};
