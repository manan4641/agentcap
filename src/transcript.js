'use strict';

const fs = require('fs');
const { costOfUsage } = require('./pricing');
const { TrackingError } = require('./errors');

/**
 * Incrementally accumulates spend from a Claude Code transcript (.jsonl).
 *
 * Two things make this less trivial than "sum the usage fields":
 *
 * 1. DEDUPE. Claude Code writes one JSONL line per *content block*, and every line for a
 *    given assistant message repeats the same `usage` object verbatim. Summing naively
 *    over-counted a real 10 MB transcript by 2.3x -- which would have made the hard stop
 *    fire less than halfway to the true cap. We key on `message.id`.
 *
 * 2. PARTIAL LINES. The file is appended to asynchronously while we read it, so the last
 *    line is frequently incomplete. We buffer the tail and re-join it on the next poll
 *    instead of discarding it (discarding would silently lose that request's cost).
 */
class TranscriptAccumulator {
  constructor(transcriptPath) {
    this.path = transcriptPath;
    this.offset = 0;
    this.tail = '';
    this.seen = new Set();
    this.totals = blankTotals();
    this.byModel = new Map();
    this.everRead = false;
  }

  setPath(transcriptPath) {
    if (transcriptPath && transcriptPath !== this.path) {
      // The authoritative path arrived from a hook and differs from our guess.
      // Restart accounting against the real file.
      this.path = transcriptPath;
      this.offset = 0;
      this.tail = '';
      this.seen = new Set();
      this.totals = blankTotals();
      this.byModel = new Map();
    }
  }

  exists() {
    return Boolean(this.path) && fs.existsSync(this.path);
  }

  /**
   * Read whatever is new and fold it into the running totals.
   * Returns true if any new usage was counted.
   */
  poll() {
    if (!this.path) return false;

    let stat;
    try {
      stat = fs.statSync(this.path);
    } catch (err) {
      if (err.code === 'ENOENT') return false; // not created yet -- normal at startup
      throw new TrackingError(`Cannot read the session transcript at ${this.path}: ${err.message}`, {
        hint: 'AgentCap cannot track spend without it, so the session was stopped.',
      });
    }

    if (stat.size < this.offset) {
      // Truncated or replaced underneath us. Re-read from the top rather than trust
      // a stale offset; `seen` keeps the re-read from double-counting.
      this.offset = 0;
      this.tail = '';
    }
    if (stat.size === this.offset) return false;

    let chunk;
    let fd;
    try {
      fd = fs.openSync(this.path, 'r');
      const length = stat.size - this.offset;
      const buf = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, this.offset);
      chunk = buf.subarray(0, bytesRead).toString('utf8');
      this.offset += bytesRead;
    } catch (err) {
      throw new TrackingError(`Failed reading the session transcript: ${err.message}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    this.everRead = true;

    const text = this.tail + chunk;
    const lines = text.split('\n');
    // The final element is either "" (clean newline boundary) or a partial line.
    this.tail = lines.pop();

    let counted = false;
    for (const line of lines) {
      if (this.ingestLine(line)) counted = true;
    }
    return counted;
  }

  ingestLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return false;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // A malformed line is not a reason to kill a session -- transcripts can contain a
      // torn write. Skipping is safe because we only ever *add* cost; a line we cannot
      // parse yet will be re-read if the file is rewritten. But we do not swallow
      // pricing errors: those propagate.
      return false;
    }

    if (!record || record.type !== 'assistant') return false;
    const message = record.message;
    if (!message || typeof message !== 'object') return false;
    const usage = message.usage;
    if (!usage) return false;

    const id = message.id;
    if (typeof id === 'string' && id !== '') {
      if (this.seen.has(id)) return false;
      this.seen.add(id);
    }

    const cost = costOfUsage(usage, message.model, { speed: usage.speed });

    this.totals.usd += cost.usd;
    this.totals.input += cost.input;
    this.totals.output += cost.output;
    this.totals.cacheRead += cost.cacheRead;
    this.totals.cacheWrite += cost.cacheWrite;
    this.totals.webSearches += cost.webSearches;
    this.totals.requests += 1;

    const model = message.model || 'unknown';
    const bucket = this.byModel.get(model) || { usd: 0, requests: 0, output: 0 };
    bucket.usd += cost.usd;
    bucket.requests += 1;
    bucket.output += cost.output;
    this.byModel.set(model, bucket);

    return true;
  }

  snapshot() {
    return {
      ...this.totals,
      byModel: Object.fromEntries(this.byModel),
    };
  }
}

function blankTotals() {
  return {
    usd: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    webSearches: 0,
    requests: 0,
  };
}

/** One-shot read of a complete transcript. Used by `status`/`history`, not the hot path. */
function totalForTranscript(transcriptPath) {
  const acc = new TranscriptAccumulator(transcriptPath);
  acc.poll();
  return acc.snapshot();
}

module.exports = { TranscriptAccumulator, totalForTranscript };
