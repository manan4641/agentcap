'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { paths, ensureDir } = require('./paths');
const { TrackingError } = require('./errors');

/**
 * Local SQLite log at ~/.agentcap/usage.db. No cloud, no telemetry, no network.
 */
function open() {
  try {
    ensureDir(path.dirname(paths.db));
    const db = new Database(paths.db);
    db.pragma('journal_mode = WAL');
    migrate(db);
    return db;
  } catch (err) {
    throw new TrackingError(`Cannot open the usage database at ${paths.db}: ${err.message}`, {
      hint: 'Check the file permissions on ~/.agentcap, or set AGENTCAP_HOME to another directory.',
    });
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id               TEXT PRIMARY KEY,
      started_at       TEXT NOT NULL,
      ended_at         TEXT,
      cwd              TEXT NOT NULL,
      command          TEXT NOT NULL,
      cap_usd          REAL NOT NULL,
      baseline_usd     REAL NOT NULL DEFAULT 0,
      cost_usd         REAL NOT NULL DEFAULT 0,
      input_tokens     INTEGER NOT NULL DEFAULT 0,
      output_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      web_searches     INTEGER NOT NULL DEFAULT 0,
      requests         INTEGER NOT NULL DEFAULT 0,
      by_model         TEXT,
      status           TEXT NOT NULL,
      transcript_path  TEXT,
      exit_code        INTEGER,
      error            TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      at         TEXT NOT NULL,
      kind       TEXT NOT NULL,
      cost_usd   REAL,
      detail     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  `);
}

function createSession(db, s) {
  db.prepare(
    `INSERT INTO sessions (id, started_at, cwd, command, cap_usd, baseline_usd, status, transcript_path)
     VALUES (@id, @startedAt, @cwd, @command, @capUsd, @baselineUsd, @status, @transcriptPath)`
  ).run({
    id: s.id,
    startedAt: s.startedAt,
    cwd: s.cwd,
    command: s.command,
    capUsd: s.capUsd,
    baselineUsd: s.baselineUsd || 0,
    status: s.status || 'running',
    transcriptPath: s.transcriptPath || null,
  });
}

function updateProgress(db, id, totals, transcriptPath) {
  db.prepare(
    `UPDATE sessions SET
       cost_usd = @usd, input_tokens = @input, output_tokens = @output,
       cache_read_tokens = @cacheRead, cache_write_tokens = @cacheWrite,
       web_searches = @webSearches, requests = @requests, by_model = @byModel,
       transcript_path = COALESCE(@transcriptPath, transcript_path)
     WHERE id = @id`
  ).run({
    id,
    usd: totals.usd,
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    webSearches: totals.webSearches,
    requests: totals.requests,
    byModel: JSON.stringify(totals.byModel || {}),
    transcriptPath: transcriptPath || null,
  });
}

function finishSession(db, id, { status, exitCode, error }) {
  db.prepare(
    `UPDATE sessions SET ended_at = @endedAt, status = @status, exit_code = @exitCode, error = @error
     WHERE id = @id`
  ).run({
    id,
    endedAt: new Date().toISOString(),
    status,
    exitCode: exitCode === undefined ? null : exitCode,
    error: error || null,
  });
}

function logEvent(db, sessionId, kind, costUsd, detail) {
  db.prepare(
    `INSERT INTO events (session_id, at, kind, cost_usd, detail) VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, new Date().toISOString(), kind, costUsd === undefined ? null : costUsd, detail || null);
}

function getSession(db, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

/** Sessions that started on the given local calendar day (YYYY-MM-DD). */
function sessionsOnDay(db, day) {
  return db
    .prepare(
      `SELECT * FROM sessions WHERE date(started_at, 'localtime') = ? ORDER BY started_at ASC`
    )
    .all(day);
}

function recentSessions(db, limit = 20) {
  return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit);
}

function runningSessions(db) {
  return db.prepare(`SELECT * FROM sessions WHERE status = 'running' ORDER BY started_at ASC`).all();
}

module.exports = {
  open,
  createSession,
  updateProgress,
  finishSession,
  logEvent,
  getSession,
  sessionsOnDay,
  recentSessions,
  runningSessions,
};
