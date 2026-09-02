'use strict';

const { runCommand } = require('./run');
const { statusCommand } = require('./status');
const { runHook } = require('./hook');
const { TrackingError, UsageError } = require('./errors');
const { bold, dim, red } = require('./format');

const VERSION = require('../package.json').version;

const HELP = `${bold('agentcap')} ${dim('v' + VERSION)} -- a hard spend cap for AI coding agents

${bold('USAGE')}
  agentcap run --cap <dollars> [-- <command...>]
  agentcap status
  agentcap --help | --version

${bold('COMMANDS')}
  run       Wrap an agent session and enforce a hard dollar cap.
            Warns at 80% of the cap, terminates the session at 100%.
            Defaults to running \`claude\` if no command is given.

  status    Show today's spend, plus any session running right now.

${bold('EXAMPLES')}
  agentcap run --cap 5.00                     ${dim('# wrap `claude` with a $5 cap')}
  agentcap run --cap 5.00 -- claude           ${dim('# the same thing, explicitly')}
  agentcap run --cap 2 -- claude --resume     ${dim('# cap applies to new spend only')}
  agentcap status

${bold('NOTES')}
  Spend is computed from Claude Code's own transcript at Anthropic API list prices.
  On a Pro/Max subscription you are not billed per token, so the dollar figure is a
  usage signal rather than a bill.

  Everything stays on this machine: usage is logged to ~/.agentcap/usage.db.
  No network calls, no telemetry, no account.
`;

async function main(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }

  const command = args[0];

  // Internal: invoked by Claude Code as a hook. Not part of the public surface.
  if (command === '__hook') {
    runHook(args.slice(1));
    return null; // runHook owns process exit
  }

  if (command === 'status') return statusCommand();

  if (command === 'run') {
    const parsed = parseRun(args.slice(1));
    return await runCommand(parsed);
  }

  throw new UsageError(`Unknown command "${command}". Run \`agentcap --help\`.`);
}

function parseRun(args) {
  let capUsd = null;
  const rest = [];
  let sawSeparator = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (sawSeparator) {
      rest.push(a);
      continue;
    }
    if (a === '--') {
      sawSeparator = true;
      continue;
    }
    if (a === '--cap' || a === '-c') {
      capUsd = parseCap(args[++i]);
      continue;
    }
    if (a.startsWith('--cap=')) {
      capUsd = parseCap(a.slice('--cap='.length));
      continue;
    }
    // Anything else before `--` is treated as the start of the wrapped command, so
    // `agentcap run --cap 5 claude --resume` works without the separator.
    rest.push(a);
    sawSeparator = true;
  }

  if (capUsd === null) {
    throw new UsageError(
      'A cap is required: `agentcap run --cap 5.00`.\n' +
        '  Refusing to run without one -- an unbounded session is the thing this tool exists to prevent.'
    );
  }

  const command = rest.length > 0 ? rest : ['claude'];

  // `--bare` makes Claude Code skip hooks entirely, which removes both our transcript
  // discovery and the deny gate. Refuse deterministically up front rather than letting the
  // user discover it as a tracking failure 30 seconds in.
  if (command.includes('--bare')) {
    throw new UsageError(
      'Cannot cap a `--bare` session: --bare disables Claude Code hooks, which AgentCap\n' +
        '  needs to track spend. Drop --bare, or run without AgentCap and accept no cap.'
    );
  }

  return { capUsd, command };
}

function parseCap(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new UsageError('--cap needs a dollar amount, e.g. `--cap 5.00`.');
  }
  const cleaned = String(raw).replace(/^\$/, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new UsageError(`--cap must be a number, got "${raw}".`);
  }
  if (n <= 0) {
    throw new UsageError(`--cap must be greater than zero, got "${raw}".`);
  }
  return n;
}

/** Entry point wrapper: turns thrown errors into loud, actionable exits. */
async function cli(argv) {
  try {
    const code = await main(argv);
    if (code !== null) process.exit(code);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(red(`agentcap: ${err.message}\n`));
      process.exit(64);
    }
    if (err instanceof TrackingError) {
      process.stderr.write(red(bold(`agentcap: TRACKING FAILURE - ${err.message}\n`)));
      if (err.hint) process.stderr.write(red(`  ${err.hint}\n`));
      process.exit(3);
    }
    process.stderr.write(red(bold(`agentcap: unexpected error - ${err && err.message}\n`)));
    if (process.env.AGENTCAP_DEBUG) process.stderr.write(String(err && err.stack) + '\n');
    process.exit(1);
  }
}

module.exports = { cli, parseRun, HELP };
