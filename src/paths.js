'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const ROOT = process.env.AGENTCAP_HOME || path.join(HOME, '.agentcap');

const paths = {
  root: ROOT,
  db: path.join(ROOT, 'usage.db'),
  runDir: path.join(ROOT, 'run'),
  claudeProjects: path.join(HOME, '.claude', 'projects'),
  sessionDir: (sessionId) => path.join(ROOT, 'run', sessionId),
  control: (sessionId) => path.join(ROOT, 'run', sessionId, 'control.json'),
  observed: (sessionId) => path.join(ROOT, 'run', sessionId, 'observed.json'),
  toolActivity: (sessionId) => path.join(ROOT, 'run', sessionId, 'tool-activity'),
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Claude Code stores each project's transcripts in a directory named after the cwd
 * with every non-alphanumeric run collapsed to a single dash.
 * e.g. "/Users/nova/Documents/AgentCap Prod" -> "-Users-nova-Documents-AgentCap-Prod"
 *
 * This is only a *fallback* for the window before the first hook fires. The
 * authoritative transcript path always comes from the hook payload.
 */
function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]+/g, '-');
}

function guessTranscriptPath(cwd, sessionId) {
  return path.join(paths.claudeProjects, projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Locate the agent binary we are about to wrap.
 *
 * Tools like Claude Code are commonly installed somewhere that is on PATH only in an
 * *interactive* shell (nvm's bin dir, ~/.local/bin). AgentCap can be launched from a
 * context without those entries, so a bare "command not found" would be a confusing
 * first-run failure. Check the usual install locations before giving up.
 *
 * Returns an absolute path when one is found, otherwise the name unchanged so the
 * caller's loud ENOENT still fires.
 */
function resolveBinary(name) {
  if (!name || name.includes(path.sep)) return name;

  const isExec = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && isExec(path.join(dir, name))) return name; // on PATH already
  }

  const candidates = [
    path.join(HOME, '.local', 'bin', name),
    path.join(HOME, 'bin', name),
    path.join(HOME, '.claude', 'local', name),
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ];
  for (const c of candidates) {
    if (isExec(c)) return c;
  }
  return name;
}

module.exports = { paths, ensureDir, projectSlug, guessTranscriptPath, resolveBinary };
