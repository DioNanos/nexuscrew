'use strict';

const os = require('node:os');
const { execFile } = require('node:child_process');
const { minimalRuntimeEnv } = require('../runtime/env.js');

// Operational guard for NexusCrew's shared tmux server.  tmux command aliases
// are not a security boundary against another process running as the same UID,
// but they neutralize accidental `tmux kill-server` calls while exit-empty=off
// keeps the server alive when the last managed session is intentionally stopped.
const KILL_SERVER_ALIAS_INDEX = 'command-alias[100]';
const KILL_SERVER_ALIAS = 'kill-server=display-message "DENIED: kill-server disabled by NexusCrew"';

function protectionArgs() {
  return [
    'start-server',
    ';', 'set-option', '-s', 'exit-empty', 'off',
    ';', 'set-option', '-s', KILL_SERVER_ALIAS_INDEX, KILL_SERVER_ALIAS,
  ];
}

function protectSharedTmuxServer(tmuxBin = 'tmux', opts = {}) {
  if (opts.enabled === false) return Promise.resolve({ ok: true, protected: false, reason: 'disabled' });
  const execFileImpl = opts.execFileImpl || execFile;
  const env = opts.env || minimalRuntimeEnv(process.env, { home: opts.home || os.homedir() });
  return new Promise((resolve) => {
    try {
      execFileImpl(tmuxBin, protectionArgs(), { env, timeout: opts.timeoutMs || 5000 }, (err, _stdout, stderr) => {
        if (err) {
          return resolve({
            ok: false,
            protected: false,
            reason: String(stderr || err.message || 'tmux protection failed').trim(),
          });
        }
        resolve({ ok: true, protected: true, reason: 'kill-server guarded; exit-empty off' });
      });
    } catch (error) {
      resolve({ ok: false, protected: false, reason: String(error && error.message || error) });
    }
  });
}

async function requireSharedTmuxProtection(tmuxBin, opts = {}) {
  const result = await protectSharedTmuxServer(tmuxBin, opts);
  if (!result.ok) {
    const error = new Error(`tmux shared-server protection failed: ${result.reason || 'unknown error'}`);
    error.status = 500;
    throw error;
  }
  return result;
}

module.exports = {
  KILL_SERVER_ALIAS_INDEX,
  KILL_SERVER_ALIAS,
  protectionArgs,
  protectSharedTmuxServer,
  requireSharedTmuxProtection,
};
