'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const db = require('./db');
const {
  paths,
  ensureDir,
  guessTranscriptPath,
  resolveBinary,
  projectSlug,
} = require('./paths');
const { TranscriptAccumulator } = require('./transcript');
const { desktopNotify } = require('./notify');
const { TrackingError } = require('./errors');
const { fmtUsd, bold, red, yellow, dim, green } = require('./format');

const POLL_MS = 250;
/**
 * How long we wait for a hook to prove tracking works before refusing to continue blind.
 * Overridable so the failure mode can be exercised in tests without a 30s wait.
 */
const TRACKING_PROOF_MS = Number(process.env.AGENTCAP_TRACKING_PROOF_MS) || 30_000;
/** Grace period between SIGTERM and SIGKILL. */
const SIGKILL_GRACE_MS = 5_000;
const WARN_FRACTION = 0.8;
/** Set AGENTCAP_DEBUG=1 to trace what tracking actually saw, for investigating a bad total. */
const DEBUG = Boolean(process.env.AGENTCAP_DEBUG);

/** Flags that make Claude Code reuse an existing session (and therefore an existing transcript). */
const RESUME_FLAGS = new Set(['--resume', '-r', '--continue', '-c', '--from-pr']);

async function runCommand(opts) {
  const { capUsd, command } = opts;
  const cwd = process.cwd();
  const sessionId = crypto.randomUUID();

  const resuming = command.some(
    (a) => RESUME_FLAGS.has(a) || RESUME_FLAGS.has(a.split('=')[0])
  );

  ensureDir(paths.sessionDir(sessionId));
  writeControl(sessionId, { stopped: false, capUsd });

  const database = db.open();

  // Our flags are APPENDED, not prepended. Claude Code accepts options in any position,
  // and appending keeps wrapper invocations working (`-- npx claude`, `-- node agent.js`),
  // where a prepended flag would be swallowed by the wrapper instead of the agent.
  const argv = command.slice(1);
  let expectedTranscript = null;
  argv.push('--settings', hookSettingsJson(sessionId));
  if (!resuming) {
    // In resume mode we cannot pin --session-id (it conflicts with --resume), so the
    // transcript path must come from the first hook instead.
    argv.push('--session-id', sessionId);
    expectedTranscript = guessTranscriptPath(cwd, sessionId);
  }

  const accumulator = new TranscriptAccumulator(expectedTranscript);

  db.createSession(database, {
    id: sessionId,
    startedAt: new Date().toISOString(),
    cwd,
    command: command.join(' '),
    capUsd,
    baselineUsd: 0,
    status: 'running',
    transcriptPath: expectedTranscript,
  });

  printBanner({ capUsd, sessionId, resuming });

  // Resolve the agent binary ourselves: it is often only on PATH in an interactive shell.
  const exe = resolveBinary(command[0]);
  if (exe !== command[0]) {
    process.stderr.write(dim(`  using ${exe}\n\n`));
  }

  const child = spawn(exe, argv, { cwd, stdio: 'inherit', env: process.env });

  const state = {
    warned: false,
    stopped: false,
    baseline: resuming ? null : 0,
    childAlive: true,
    startedAt: Date.now(),
    lastObserved: null,
    lastEvent: null,
    toolActivity: false,
    blindSince: null,
    trackingConfirmed: false,
    noHookNoticeShown: false,
    sawUsage: false,
    failure: null,
    killTimer: null,
  };

  child.on('error', (err) => {
    state.childAlive = false;
    fail(
      state,
      new TrackingError(`Could not start "${command[0]}": ${err.message}`, {
        hint:
          err.code === 'ENOENT'
            ? `Is "${command[0]}" installed and on your PATH?`
            : undefined,
      })
    );
  });

  const timer = setInterval(() => {
    try {
      tick({ state, accumulator, sessionId, capUsd, child, database, resuming, cwd });
    } catch (err) {
      fail(state, err);
      terminate(state, child);
    }
  }, POLL_MS);

  // Forward the user's own interrupts so Ctrl-C behaves normally.
  const forward = (sig) => () => {
    if (state.childAlive) {
      try {
        child.kill(sig);
      } catch {}
    }
  };
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code, signal) => {
      state.childAlive = false;
      resolve(code === null ? (signal ? 130 : 1) : code);
    });
  });

  clearInterval(timer);
  if (state.killTimer) clearTimeout(state.killTimer);
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);

  // Final reconciliation. The transcript is written asynchronously, so give the last
  // records a moment to land before we write the definitive number to the log.
  await sleep(750);
  let finalSpend = 0;
  let finalError = state.failure ? state.failure.message : null;
  try {
    syncTranscriptPath(state, accumulator, sessionId);
    accumulator.poll();
    finalSpend = spendOf(state, accumulator);
    db.updateProgress(
      database,
      sessionId,
      { ...accumulator.snapshot(), usd: finalSpend },
      accumulator.path
    );
  } catch (err) {
    finalError = finalError || err.message;
  }

  const status = state.failure ? 'error' : state.stopped ? 'capped' : 'completed';
  db.finishSession(database, sessionId, { status, exitCode, error: finalError });

  printSummary({ status, finalSpend, capUsd, accumulator, failure: state.failure });
  database.close();
  writeControl(sessionId, { stopped: state.stopped, capUsd, finished: true });

  if (status === 'error') return 3;
  if (status === 'capped') return 2;
  return exitCode;
}

function tick({ state, accumulator, sessionId, capUsd, child, database, resuming, cwd }) {
  syncTranscriptPath(state, accumulator, sessionId);

  // Resume mode with no hook yet: we have no path to derive, so fall back to the most
  // recent transcript in this project rather than sit blind.
  if (resuming && !accumulator.path) {
    const found = findRecentTranscript(cwd);
    if (found) accumulator.setPath(found);
  }

  const grew = accumulator.poll();

  // Tracking works via the transcript, but no hook has ever fired -- so the pre-emptive
  // deny gate is unavailable. The cap is still enforced by terminating the process; say so
  // once rather than letting the user assume a protection they do not have.
  if (!state.noHookNoticeShown && state.sawUsage && !state.lastObserved) {
    state.noHookNoticeShown = true;
    process.stderr.write(
      dim(
        '\nagentcap: tracking via transcript, but no hook has fired -- tool calls cannot be\n' +
          '  pre-emptively denied. The cap is still enforced by stopping the process.\n'
      )
    );
  }

  // Establish the resume baseline the first time we can read the transcript, so
  // `--cap` means "spend at most this much from now on".
  if (state.baseline === null) {
    if (accumulator.everRead) {
      state.baseline = accumulator.snapshot().usd;
      process.stderr.write(
        dim(
          `\nagentcap: resumed session already had ${fmtUsd(state.baseline)} of spend; ` +
            `the cap applies to new spend only.\n`
        )
      );
    } else {
      guardBlindSession(state, accumulator, child);
      return;
    }
  }

  guardBlindSession(state, accumulator, child);

  const spend = spendOf(state, accumulator);

  if (DEBUG && grew) {
    const snap = accumulator.snapshot();
    process.stderr.write(
      dim(
        `[agentcap:debug] path=${accumulator.path} exists=${accumulator.exists()} ` +
          `lastEvent=${state.lastEvent} toolActivity=${state.toolActivity} ` +
          `requests=${snap.requests} spend=${spend.toFixed(6)}\n`
      )
    );
  }

  if (grew) {
    db.updateProgress(
      database,
      sessionId,
      { ...accumulator.snapshot(), usd: spend },
      accumulator.path
    );
  }

  if (!state.stopped && spend >= capUsd) {
    state.stopped = true;
    // Suppress the 80% warning: when spend jumps past both thresholds at once, or when
    // later ticks re-evaluate, a "will stop at ..." notice after we have already stopped
    // is worse than no notice at all.
    state.warned = true;
    // Slam the door before killing: the deny gate stops any tool call that would
    // otherwise fire during the termination window.
    writeControl(sessionId, {
      stopped: true,
      capUsd,
      reason: `AgentCap: spend cap of ${fmtUsd(capUsd)} reached (${fmtUsd(
        spend
      )} spent). Session halted.`,
    });
    db.logEvent(database, sessionId, 'cap-reached', spend, `cap=${capUsd}`);

    const msg = `Cap reached: ${fmtUsd(spend)} of ${fmtUsd(capUsd)}. Stopping the session now.`;
    desktopNotify('AgentCap - cap reached, session stopped', msg);
    process.stderr.write('\n' + red(bold('agentcap: ' + msg)) + '\n');

    terminate(state, child);
    return;
  }

  if (!state.warned && !state.stopped && spend >= capUsd * WARN_FRACTION) {
    state.warned = true;
    db.logEvent(database, sessionId, 'warn-80', spend, `cap=${capUsd}`);
    const pct = Math.floor((spend / capUsd) * 100);
    const msg = `${fmtUsd(spend)} of ${fmtUsd(capUsd)} used (${pct}%). The session will stop at ${fmtUsd(
      capUsd
    )}.`;
    desktopNotify('AgentCap - 80% of cap used', msg);
    process.stderr.write('\n' + yellow(bold('agentcap: ' + msg)) + '\n');
  }
}

/**
 * Hook events that prove the model has actually been invoked, and therefore that money
 * has been spent. `SessionStart` and `SessionEnd` prove nothing of the kind -- they fire
 * around a session that may never send a single request.
 */
const SPEND_IMPLYING_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'Stop']);

/**
 * The single most important guard in the tool: refuse to keep running when the agent is
 * demonstrably doing paid work that we cannot account for.
 *
 * The subtlety is what counts as "demonstrably". An earlier version started a 30s clock at
 * process launch, which killed sessions that were sitting on Claude Code's first-run setup
 * wizard (theme picker) or a /login prompt -- waiting on a human, spending nothing, firing
 * no hooks. That is a false alarm, and a false alarm on the one guard the product's
 * credibility rests on is worse than no guard.
 *
 * So the clock is driven by evidence of spend, not by wall-clock:
 *   - Usage we can read, or a transcript on disk  -> tracking works, nothing to do.
 *   - A spend-implying hook fired but we still cannot read any transcript -> real failure.
 *   - No hooks and no transcript -> the session has not started doing anything. Nothing can
 *     be spent before a request is made, so waiting indefinitely is correct.
 */
function guardBlindSession(state, accumulator, child) {
  if (state.failure) return;

  // Usage records we parsed successfully mean tracking demonstrably works, even if the
  // total so far is $0.00.
  if (state.sawUsage) {
    state.trackingConfirmed = true;
    state.blindSince = null;
    return;
  }

  // A tool call requires a model request, so tool activity with zero readable usage means
  // we are blind even though a transcript exists. Merely *finding* a file is not proof we
  // can account for the spend inside it -- it may be the wrong file, or empty.
  if (!state.toolActivity) {
    // No proof of spend yet. A transcript that exists but has no usage is the normal state
    // of a session that has not asked anything (or only ran local slash commands).
    if (accumulator.exists()) {
      state.trackingConfirmed = true;
      state.blindSince = null;
      return;
    }
    // `Stop` is deliberately not treated as proof: local slash commands such as /exit end a
    // turn without any model request.
    if (!SPEND_IMPLYING_EVENTS.has(state.lastEvent)) return;
  }

  if (!state.blindSince) state.blindSince = Date.now();
  if (Date.now() - state.blindSince < TRACKING_PROOF_MS) return;

  fail(
    state,
    new TrackingError(
      `Claude Code reported activity (${state.toolActivity ? 'a tool call' : state.lastEvent}), ` +
        `but AgentCap still cannot read ` +
        `any usage data after ${Math.round(TRACKING_PROOF_MS / 1000)}s` +
        (accumulator.path ? ` at ${accumulator.path}` : '') +
        '.',
      {
        hint:
          'Refusing to continue, because a session that is not tracked is not capped. ' +
          'This can mean the transcript is being written somewhere unexpected -- please ' +
          'report your Claude Code version.',
      }
    )
  );
  terminate(state, child);
}

function syncTranscriptPath(state, accumulator, sessionId) {
  let observed;
  try {
    observed = JSON.parse(fs.readFileSync(paths.observed(sessionId), 'utf8'));
  } catch {
    return;
  }
  state.lastObserved = observed.at || state.lastObserved;
  if (observed.lastEvent) state.lastEvent = observed.lastEvent;
  if (!state.toolActivity && fs.existsSync(paths.toolActivity(sessionId))) {
    state.toolActivity = true;
  }
  if (observed.transcriptPath) {
    accumulator.setPath(observed.transcriptPath);
  }
}

/**
 * Resume mode gives us no session id to derive a transcript path from, so if hooks are
 * unavailable we would be blind. Fall back to the most recently modified transcript in
 * this project's directory.
 */
function findRecentTranscript(cwd) {
  try {
    const dir = path.join(paths.claudeProjects, projectSlug(cwd));
    const newest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? newest.p : null;
  } catch {
    return null;
  }
}

function spendOf(state, accumulator) {
  const snap = accumulator.snapshot();
  // Proof of tracking is "we parsed usage records", NOT "the total is above zero".
  // A cheap or free request still demonstrates we can read and price the transcript.
  if (snap.requests > 0) state.sawUsage = true;
  return Math.max(0, snap.usd - (state.baseline || 0));
}

function terminate(state, child) {
  if (!state.childAlive) return;
  try {
    child.kill('SIGTERM');
  } catch {}
  state.killTimer = setTimeout(() => {
    if (state.childAlive) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }, SIGKILL_GRACE_MS);
  state.killTimer.unref?.();
}

function fail(state, err) {
  if (state.failure) return;
  state.failure = err;
  process.stderr.write('\n' + red(bold('agentcap: TRACKING FAILURE - ' + err.message)) + '\n');
  if (err.hint) process.stderr.write(red('  ' + err.hint) + '\n');
  desktopNotify('AgentCap - tracking failed', err.message);
}

/**
 * Hooks are injected with `claude --settings <json>`, which *merges* with the user's own
 * settings. We never write to ~/.claude/settings.json or the project's .claude/settings.json,
 * so there is nothing to clean up if this process dies unexpectedly.
 */
function hookSettingsJson(sessionId) {
  const cmd =
    `${shq(process.execPath)} ` +
    `${shq(path.join(__dirname, '..', 'bin', 'agentcap.js'))} ` +
    `__hook --session ${shq(sessionId)}`;
  const entry = [{ hooks: [{ type: 'command', command: cmd, timeout: 10 }] }];
  return JSON.stringify({
    hooks: {
      SessionStart: entry,
      PreToolUse: entry,
      PostToolUse: entry,
      Stop: entry,
      SessionEnd: entry,
    },
  });
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function writeControl(sessionId, obj) {
  try {
    ensureDir(paths.sessionDir(sessionId));
    fs.writeFileSync(paths.control(sessionId), JSON.stringify(obj));
  } catch (err) {
    throw new TrackingError(`Cannot write AgentCap control state: ${err.message}`);
  }
}

function printBanner({ capUsd, sessionId, resuming }) {
  process.stderr.write(
    `${bold('agentcap')} ${dim('v0.1')}  cap ${bold(fmtUsd(capUsd))}  ` +
      `${dim('session ' + sessionId.slice(0, 8))}` +
      `${resuming ? dim(' (resumed - cap applies to new spend)') : ''}\n` +
      dim('  Costs are estimates at Anthropic API list prices. On a Pro/Max subscription\n') +
      dim('  you are not billed per token, so treat the figure as a usage signal.\n\n')
  );
}

function printSummary({ status, finalSpend, capUsd, accumulator, failure }) {
  const t = accumulator.snapshot();
  const head =
    status === 'capped'
      ? red(bold('cap reached - session stopped'))
      : status === 'error'
        ? red(bold('stopped: tracking failure'))
        : green('session ended');

  process.stderr.write(`\n${bold('agentcap')} ${head}\n`);
  process.stderr.write(
    `  spend      ${bold(fmtUsd(finalSpend))} of ${fmtUsd(capUsd)}\n` +
      `  requests   ${t.requests}\n` +
      `  tokens     ${t.input.toLocaleString()} in / ${t.output.toLocaleString()} out / ` +
      `${t.cacheRead.toLocaleString()} cache read / ${t.cacheWrite.toLocaleString()} cache write\n`
  );
  if (t.webSearches > 0) process.stderr.write(`  websearch  ${t.webSearches} ($10/1k)\n`);
  const models = Object.entries(t.byModel || {});
  if (models.length) {
    process.stderr.write(
      '  models     ' + models.map(([m, v]) => `${m} ${fmtUsd(v.usd)}`).join(', ') + '\n'
    );
  }
  if (failure) process.stderr.write(red(`  error      ${failure.message}\n`));
  process.stderr.write(dim(`  logged to  ${paths.db}\n`));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { runCommand, hookSettingsJson };
