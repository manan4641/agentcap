'use strict';

const fs = require('fs');
const { paths, ensureDir } = require('./paths');

/**
 * The hook handler. Claude Code invokes this once per hook event with a JSON payload on stdin.
 *
 * Hook payloads carry NO token or cost data (verified against every documented hook event),
 * so this process does not do accounting. It has exactly two jobs:
 *
 *   1. DISCOVERY -- report the authoritative `transcript_path` and `session_id` to the parent
 *      `agentcap run` process, which is where all accounting happens.
 *   2. ENFORCEMENT -- once the parent has declared the cap blown, deny every subsequent tool
 *      call. This closes the window between "cap reached" and "process actually dead", so the
 *      agent cannot fire off one more expensive call on its way out.
 *
 * It must stay fast: it sits in the critical path of every tool call.
 */
function runHook(argv) {
  const sessionId = valueOf(argv, '--session');

  readStdin((raw) => {
    let payload = {};
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      // Keep going with an empty payload; a parse failure here must not wedge the session.
    }

    const event = payload.hook_event_name || 'unknown';

    if (sessionId) {
      try {
        ensureDir(paths.sessionDir(sessionId));
        // Atomic-ish write so the parent never reads a half-written file.
        const tmp = paths.observed(sessionId) + '.tmp';
        fs.writeFileSync(
          tmp,
          JSON.stringify({
            transcriptPath: payload.transcript_path || null,
            claudeSessionId: payload.session_id || null,
            lastEvent: event,
            at: new Date().toISOString(),
          })
        );
        fs.renameSync(tmp, paths.observed(sessionId));

        // A tool call cannot happen without a model request, so a tool hook is definitive
        // proof that money was spent. `observed.json` only holds the *latest* event, which
        // the parent's poll can miss, so record this as a sticky marker instead.
        if (event === 'PreToolUse' || event === 'PostToolUse') {
          fs.writeFileSync(paths.toolActivity(sessionId), event);
        }
      } catch {
        // If we cannot write, the parent's watchdog notices the missing proof-of-life
        // and fails loud on our behalf. Never crash the user's session from here.
      }
    }

    const control = readControl(sessionId);

    if (control && control.stopped && event === 'PreToolUse') {
      const reason =
        control.reason ||
        'AgentCap: session spend cap reached. No further tool calls are permitted.';
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        })
      );
      process.exit(0);
    }

    process.exit(0);
  });
}

function readControl(sessionId) {
  if (!sessionId) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.control(sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function readStdin(cb) {
  let data = '';
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    cb(data);
  };
  // Never hang a tool call on a stdin that does not close.
  const timer = setTimeout(finish, 2000);
  timer.unref?.();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    data += c;
  });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(flag + '='));
  return eq ? eq.slice(flag.length + 1) : null;
}

module.exports = { runHook };
