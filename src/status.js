'use strict';

const db = require('./db');
const { paths } = require('./paths');
const { TranscriptAccumulator } = require('./transcript');
const { fmtUsd, bold, dim, red, yellow, green, pad } = require('./format');

/**
 * `agentcap status` -- today's spend and anything currently running.
 *
 * For live sessions we re-read the transcript rather than trusting the last row the
 * runner wrote, so the number is current even between the runner's 500ms polls.
 */
function statusCommand() {
  const database = db.open();
  const today = localDay(new Date());
  const rows = db.sessionsOnDay(database, today);
  const running = db.runningSessions(database);

  const live = new Map();
  for (const r of running) {
    const spend = liveSpend(r);
    if (spend !== null) live.set(r.id, spend);
  }

  const todayTotal = rows.reduce(
    (sum, r) => sum + (live.has(r.id) ? live.get(r.id) : r.cost_usd),
    0
  );

  process.stdout.write(`${bold('agentcap status')}  ${dim(today)}\n\n`);

  if (rows.length === 0) {
    process.stdout.write(dim('  No sessions today.\n'));
  } else {
    process.stdout.write(
      dim(
        `  ${pad('STARTED', 9)}${pad('SPEND', 11)}${pad('CAP', 10)}${pad('STATUS', 11)}PROJECT\n`
      )
    );
    for (const r of rows) {
      const spend = live.has(r.id) ? live.get(r.id) : r.cost_usd;
      process.stdout.write(
        '  ' +
          pad(timeOf(r.started_at), 9) +
          pad(fmtUsd(spend), 11) +
          pad(fmtUsd(r.cap_usd), 10) +
          pad(statusLabel(r.status), 11) +
          dim(shortenPath(r.cwd)) +
          '\n'
      );
    }
  }

  process.stdout.write(`\n  ${bold('today')}  ${bold(fmtUsd(todayTotal))}`);
  process.stdout.write(dim(`  across ${rows.length} session${rows.length === 1 ? '' : 's'}\n`));

  if (running.length > 0) {
    process.stdout.write(
      `\n  ${yellow(bold('live'))}  ${running.length} session${running.length === 1 ? '' : 's'} running now:\n`
    );
    for (const r of running) {
      const spend = live.has(r.id) ? live.get(r.id) : r.cost_usd;
      const pct = r.cap_usd > 0 ? Math.floor((spend / r.cap_usd) * 100) : 0;
      process.stdout.write(
        `    ${dim(r.id.slice(0, 8))}  ${bold(fmtUsd(spend))} of ${fmtUsd(r.cap_usd)} ` +
          `(${pct}%)  ${dim(shortenPath(r.cwd))}\n`
      );
    }
  }

  process.stdout.write(dim(`\n  ${paths.db}\n`));
  database.close();
  return 0;
}

/**
 * Recompute a running session's spend straight from its transcript.
 * Returns null when the transcript cannot be read -- the caller falls back to the
 * stored value rather than reporting a confidently wrong $0.00.
 */
function liveSpend(row) {
  if (!row.transcript_path) return null;
  try {
    const acc = new TranscriptAccumulator(row.transcript_path);
    acc.poll();
    if (!acc.everRead) return null;
    return Math.max(0, acc.snapshot().usd - (row.baseline_usd || 0));
  } catch {
    return null;
  }
}

function statusLabel(s) {
  if (s === 'capped') return red('capped');
  if (s === 'error') return red('error');
  if (s === 'running') return yellow('running');
  return green('done');
}

function localDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timeOf(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function shortenPath(p) {
  const home = require('os').homedir();
  return p && p.startsWith(home) ? '~' + p.slice(home.length) : p || '';
}

module.exports = { statusCommand };
