#!/usr/bin/env node
'use strict';

/**
 * A stand-in for the `claude` binary, used to test AgentCap end-to-end without spending
 * real API credits.
 *
 * It imitates the parts of Claude Code that AgentCap actually depends on:
 *   - accepts `--settings <json>` and `--session-id <uuid>`
 *   - fires the configured hooks as real subprocesses, with a real JSON payload on stdin
 *   - honours a PreToolUse `deny` decision returned by a hook
 *   - appends assistant records (with `usage`) to a transcript .jsonl
 *   - reproduces Claude Code's real quirk of writing ONE LINE PER CONTENT BLOCK, each
 *     repeating the same usage object -- so the dedupe logic is genuinely exercised
 *
 * Flags:
 *   --transcript <path>   where to write the transcript
 *   --burn <usd>          dollars of spend to emit per turn (default 0.15)
 *   --turns <n>           max turns before exiting normally (default 100)
 *   --interval <ms>       delay between turns (default 300)
 *   --dupes <n>           JSONL lines to write per assistant message (default 3)
 *   --model <id>          model to attribute usage to (default claude-sonnet-4-6)
 *   --stubborn            ignore SIGTERM, forcing AgentCap to escalate to SIGKILL
 *   --no-hooks            never fire hooks, simulating a broken tracking setup
 *   --no-usage            fire tool hooks but never write a usage record, so the transcript
 *                         exists and is readable but has nothing to price
 *   --report-transcript P report a DIFFERENT transcript path in hook payloads than the one
 *                         actually written, simulating usage we are told about but cannot read
 *   --silent-ms N         do nothing at all for N ms before starting: no hooks, no writes.
 *                         Simulates Claude Code's first-run setup wizard waiting on a human.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : dflt;
};
const has = (name) => argv.includes(name);

const settingsRaw = opt('--settings', '{}');
const sessionId = opt('--session-id', crypto.randomUUID());
// Default into a temp dir, never the cwd -- an omitted --transcript should not litter
// the repository with fake transcripts.
const transcriptPath = opt(
  '--transcript',
  path.join(require('os').tmpdir(), 'agentcap-fake', `${sessionId}.jsonl`)
);
const burnUsd = Number(opt('--burn', '0.15'));
const maxTurns = Number(opt('--turns', '100'));
const intervalMs = Number(opt('--interval', '300'));
const dupes = Number(opt('--dupes', '3'));
const model = opt('--model', 'claude-sonnet-4-6');
const stubborn = has('--stubborn');
const reportTranscript = opt('--report-transcript', null);
const silentMs = Number(opt('--silent-ms', '0'));
const noHooks = has('--no-hooks');
const noUsage = has('--no-usage');

if (stubborn) process.on('SIGTERM', () => log('ignoring SIGTERM (stubborn mode)'));

let settings = {};
try {
  settings = JSON.parse(settingsRaw);
} catch {
  log('could not parse --settings');
}
const hooks = (settings && settings.hooks) || {};

/** Deferred: during a simulated setup wizard nothing should exist on disk yet. */
function initTranscript() {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, '');
}

function log(msg) {
  process.stdout.write(`[fake-claude] ${msg}\n`);
}

/** Fire every command hook registered for an event; return the parsed JSON outputs. */
function fireHook(event, extra = {}) {
  if (noHooks) return [];
  const groups = hooks[event] || [];
  const payload = JSON.stringify({
    session_id: sessionId,
    transcript_path: reportTranscript || transcriptPath,
    cwd: process.cwd(),
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  });

  const outputs = [];
  for (const group of groups) {
    for (const h of group.hooks || []) {
      if (h.type !== 'command') continue;
      try {
        const stdout = execSync(h.command, { input: payload, encoding: 'utf8', timeout: 10000 });
        if (stdout && stdout.trim()) {
          try {
            outputs.push(JSON.parse(stdout.trim()));
          } catch {
            /* non-JSON stdout is not a decision */
          }
        }
      } catch (err) {
        // exit code 2 is a blocking error in the real hook contract
        if (err.status === 2) outputs.push({ __blocked: true });
      }
    }
  }
  return outputs;
}

/**
 * Emit one assistant message worth `burnUsd`, priced on output tokens alone so the
 * expected cost is trivial to verify: output tokens = usd / rate * 1e6.
 */
const OUTPUT_RATE = { 'claude-sonnet-4-6': 15, 'claude-opus-5': 25, 'claude-haiku-4-5': 5 }[model] || 15;
const outputTokens = Math.round((burnUsd / OUTPUT_RATE) * 1_000_000);

function writeTurn(turn) {
  const messageId = `msg_fake_${turn}_${crypto.randomBytes(4).toString('hex')}`;
  const requestId = `req_fake_${turn}`;
  const usage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: outputTokens,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    speed: 'standard',
    inference_geo: '',
  };

  // One line per content block, each repeating the SAME usage -- the real behaviour.
  const lines = [];
  for (let i = 0; i < dupes; i++) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        requestId,
        sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        isSidechain: false,
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: `block ${i} of turn ${turn}` }],
          stop_reason: 'end_turn',
          usage,
        },
      })
    );
  }
  fs.appendFileSync(transcriptPath, lines.join('\n') + '\n');
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  if (silentMs > 0) {
    // Imitate the first-run setup wizard / login prompt: alive, waiting on a human,
    // firing no hooks and spending nothing.
    log(`waiting ${silentMs}ms before starting (simulated setup wizard)`);
    await sleep(silentMs);
  }
  initTranscript();
  log(`starting; transcript=${transcriptPath}`);
  fireHook('SessionStart');

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Ask permission for a tool call, exactly as Claude Code would.
    const decisions = fireHook('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'echo work' },
      tool_use_id: `toolu_fake_${turn}`,
    });

    const denied = decisions.find(
      (d) =>
        d.__blocked ||
        (d.hookSpecificOutput && d.hookSpecificOutput.permissionDecision === 'deny')
    );
    if (denied) {
      const reason =
        (denied.hookSpecificOutput && denied.hookSpecificOutput.permissionDecisionReason) ||
        'blocked';
      log(`TOOL CALL DENIED BY HOOK: ${reason}`);
      log('exiting because further work is not permitted');
      fireHook('SessionEnd');
      process.exit(0);
    }

    if (noUsage) {
      // Tool calls happen, but no usage record is ever written: the transcript exists and
      // is readable, yet contains nothing to price. AgentCap must not report a confident $0.
      log(`turn ${turn}: tool call made, but NO usage record written`);
    } else {
      writeTurn(turn);
      log(`turn ${turn}: burned $${burnUsd.toFixed(2)} (${outputTokens} output tokens)`);
    }
    fireHook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'echo work' },
      tool_use_id: `toolu_fake_${turn}`,
    });

    await sleep(intervalMs);
  }

  log('finished all turns');
  fireHook('Stop');
  fireHook('SessionEnd');
  process.exit(0);
})();
