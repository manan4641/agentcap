'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const BIN = path.join(__dirname, '..', 'bin', 'agentcap.js');
const FAKE = path.join(__dirname, 'fake-claude.js');

/**
 * Runs the real `agentcap run` against the fake agent in an isolated AGENTCAP_HOME.
 * Returns the combined output, exit code, and a handle to the sqlite log.
 */
function runAgentcap(args, { proofMs } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcap-e2e-'));
  const env = {
    ...process.env,
    AGENTCAP_HOME: home,
    NO_COLOR: '1',
    ...(proofMs ? { AGENTCAP_TRACKING_PROOF_MS: String(proofMs) } : {}),
  };

  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [BIN, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (err) {
    out = String(err.stdout || '') + String(err.stderr || '');
    code = err.status === null || err.status === undefined ? -1 : err.status;
  }
  return { out, code, home, dbPath: path.join(home, 'usage.db') };
}

function transcriptFor(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentcap-t-')), name);
}

function sessions(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT * FROM sessions').all();
  const events = db.prepare('SELECT * FROM events').all();
  db.close();
  return { rows, events };
}

test('warns at 80% and hard-stops at 100%, terminating the agent', () => {
  const t = transcriptFor('cap.jsonl');
  const r = runAgentcap([
    'run', '--cap', '1.00', '--',
    process.execPath, FAKE, '--transcript', t, '--burn', '0.15', '--interval', '250', '--turns', '50',
  ]);

  assert.match(r.out, /80% of cap|of \$1\.00 used/, 'an 80% warning must be emitted');
  assert.match(r.out, /Cap reached/, 'a cap-reached message must be emitted');
  assert.strictEqual(r.code, 2, 'a capped session exits 2');

  // The agent must not have been allowed to run all 50 turns.
  const turns = (r.out.match(/turn \d+: burned/g) || []).length;
  assert.ok(turns < 50, `agent should have been stopped early, ran ${turns} turns`);

  const { rows, events } = sessions(r.dbPath);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'capped');
  assert.ok(rows[0].cost_usd >= 1.0, 'final logged cost should be at/over the cap');
  assert.ok(events.some((e) => e.kind === 'warn-80'), 'the 80% event must be logged');
  assert.ok(events.some((e) => e.kind === 'cap-reached'), 'the cap event must be logged');
});

test('never emits the 80% warning after already stopping', () => {
  const t = transcriptFor('jump.jsonl');
  // A single turn blows straight past both thresholds.
  const r = runAgentcap([
    'run', '--cap', '0.20', '--',
    process.execPath, FAKE, '--transcript', t, '--burn', '1.00', '--interval', '300', '--turns', '10',
  ]);

  const capIdx = r.out.indexOf('Cap reached');
  const warnIdx = r.out.search(/used \(\d+%\)/);
  assert.ok(capIdx !== -1, 'should report the cap being reached');
  if (warnIdx !== -1) {
    assert.ok(warnIdx < capIdx, 'a warning must never appear after the stop message');
  }
});

test('denies further tool calls when the agent ignores SIGTERM', () => {
  const t = transcriptFor('stubborn.jsonl');
  const r = runAgentcap([
    'run', '--cap', '0.50', '--',
    process.execPath, FAKE, '--transcript', t, '--burn', '0.20', '--interval', '400',
    '--turns', '50', '--stubborn',
  ]);

  assert.match(r.out, /TOOL CALL DENIED BY HOOK/, 'the PreToolUse deny gate must block work');
  assert.strictEqual(r.code, 2);
});

test('completes normally under the cap and logs the final cost', () => {
  const t = transcriptFor('under.jsonl');
  const r = runAgentcap([
    'run', '--cap', '5.00', '--',
    process.execPath, FAKE, '--transcript', t, '--burn', '0.10', '--turns', '3', '--interval', '150',
  ]);

  assert.strictEqual(r.code, 0);
  assert.doesNotMatch(r.out, /Cap reached/);
  const { rows } = sessions(r.dbPath);
  assert.strictEqual(rows[0].status, 'completed');
  assert.ok(Math.abs(rows[0].cost_usd - 0.30) < 0.02, `expected ~$0.30, got ${rows[0].cost_usd}`);
  assert.strictEqual(rows[0].requests, 3, 'dedupe must survive the full pipeline');
});

test('fails loud and stops when a model has no known price', () => {
  const t = transcriptFor('unknown.jsonl');
  const r = runAgentcap([
    'run', '--cap', '5.00', '--',
    process.execPath, FAKE, '--transcript', t, '--burn', '0.10',
    '--model', 'claude-from-the-future-9', '--interval', '200', '--turns', '50',
  ]);

  assert.match(r.out, /TRACKING FAILURE/);
  assert.match(r.out, /Unknown model/);
  assert.strictEqual(r.code, 3);
  const { rows } = sessions(r.dbPath);
  assert.strictEqual(rows[0].status, 'error');
});

test('does not kill a session sitting on the first-run setup wizard', () => {
  // Regression: an earlier version started a 30s clock at process launch, so Claude Code's
  // theme-picker wizard (which waits on a human, spends nothing and fires no hooks) ate the
  // whole window and the session was killed before it began.
  const t = transcriptFor('wizard.jsonl');
  const r = runAgentcap(
    [
      'run', '--cap', '5.00', '--',
      process.execPath, FAKE, '--transcript', t,
      '--silent-ms', '4000', '--no-hooks', '--burn', '0', '--turns', '1', '--interval', '50',
    ],
    { proofMs: 1200 } // far shorter than the silent period
  );

  assert.doesNotMatch(r.out, /TRACKING FAILURE/, 'waiting on a human is not a tracking failure');
  assert.strictEqual(r.code, 0);
});

test('fails loud when a hook reports activity but the transcript cannot be read', () => {
  // The genuine blind-spend case: we are told the model ran, but the usage data is
  // somewhere we cannot see.
  const real = transcriptFor('hidden.jsonl');
  const bogus = path.join(os.tmpdir(), 'agentcap-nonexistent-dir', 'nope.jsonl');
  const r = runAgentcap(
    [
      'run', '--cap', '5.00', '--',
      process.execPath, FAKE, '--transcript', real, '--report-transcript', bogus,
      '--burn', '0.10', '--interval', '250', '--turns', '50',
    ],
    { proofMs: 1500 }
  );

  assert.match(r.out, /TRACKING FAILURE/);
  assert.match(r.out, /cannot read any usage data/);
  assert.strictEqual(r.code, 3);
});

test('fails loud when tool calls happen but no usage record can be read', () => {
  // Regression: an existing transcript file was treated as proof of tracking, so a readable
  // but usage-free transcript combined with real tool activity produced a confident $0.00.
  // A tool call cannot happen without a model request, so zero usage here means we are blind.
  const t = transcriptFor('nousage.jsonl');
  const r = runAgentcap(
    [
      'run', '--cap', '5.00', '--',
      process.execPath, FAKE, '--transcript', t, '--no-usage',
      '--interval', '250', '--turns', '50',
    ],
    { proofMs: 1500 }
  );

  assert.match(r.out, /TRACKING FAILURE/);
  assert.match(r.out, /a tool call/);
  assert.strictEqual(r.code, 3);
});

test('treats a genuinely free request as tracked, not as a failure', () => {
  // The inverse: usage records that price to $0.00 still prove tracking works.
  const t = transcriptFor('free.jsonl');
  const r = runAgentcap(
    [
      'run', '--cap', '5.00', '--',
      process.execPath, FAKE, '--transcript', t, '--burn', '0', '--turns', '3', '--interval', '200',
    ],
    { proofMs: 1000 }
  );
  assert.doesNotMatch(r.out, /TRACKING FAILURE/);
  assert.strictEqual(r.code, 0);
});

test('refuses a --bare session up front, without waiting for a timeout', () => {
  const r = runAgentcap(['run', '--cap', '5.00', '--', 'claude', '--bare']);
  assert.match(r.out, /Cannot cap a `--bare` session/);
  assert.strictEqual(r.code, 64, 'should be a usage error, not a 30s tracking failure');
});

test('does not kill an idle session that simply has not spent anything', () => {
  const t = transcriptFor('idle.jsonl');
  const r = runAgentcap(
    [
      'run', '--cap', '5.00', '--',
      process.execPath, FAKE, '--transcript', t, '--burn', '0', '--turns', '4', '--interval', '700',
    ],
    { proofMs: 1200 }
  );

  assert.doesNotMatch(r.out, /TRACKING FAILURE/, 'no spend is not a tracking failure');
  assert.strictEqual(r.code, 0);
});

test('fails loud when the wrapped command does not exist', () => {
  const r = runAgentcap(['run', '--cap', '5.00', '--', 'agentcap-no-such-binary-xyz']);
  assert.match(r.out, /TRACKING FAILURE/);
  assert.match(r.out, /PATH/);
  assert.strictEqual(r.code, 3);
});

test('status reports the logged session', () => {
  const t = transcriptFor('status.jsonl');
  const r = runAgentcap([
    'run', '--cap', '4.00', '--',
    process.execPath, FAKE, '--transcript', t, '--burn', '0.10', '--turns', '2', '--interval', '150',
  ]);
  assert.strictEqual(r.code, 0);

  const out = execFileSync(process.execPath, [BIN, 'status'], {
    env: { ...process.env, AGENTCAP_HOME: r.home, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  assert.match(out, /agentcap status/);
  assert.match(out, /\$0\.20/);
  assert.match(out, /\$4\.00/);
  assert.match(out, /today/);
});
