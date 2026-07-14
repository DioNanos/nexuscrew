'use strict';
const { execFile, execFileSync } = require('node:child_process');

const FMT = "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_activity}\t#{pane_current_command}\t#{@nexuscrew_visibility}";

function parseSessions(raw) {
  return String(raw)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const [name, attached, windows, created, activity, cmd, visibility] = line.split('\t');
      return {
        name,
        attached: attached === '1',
        windows: Number(windows),
        created: Number(created),
        activity: Number(activity) || 0,
        cmd: cmd || '',
        technical: visibility === 'technical',
      };
    })
    .filter((session) => session.windows > 0);
}

function setSessionVisibility(tmuxBin = 'tmux', name, technical = false) {
  return new Promise((resolve, reject) => {
    if (typeof name !== 'string' || !/^[\w.@%:+-]{1,128}$/.test(name) || name.startsWith('-')) {
      const error = new Error('nome sessione non valido'); error.status = 400; reject(error); return;
    }
    const args = technical
      ? ['set-option', '-t', `=${name}`, '@nexuscrew_visibility', 'technical']
      : ['set-option', '-u', '-t', `=${name}`, '@nexuscrew_visibility'];
    execFile(tmuxBin, args, (err, _stdout, stderr) => {
      if (!err) { resolve({ name, technical: !!technical }); return; }
      const error = new Error(`tmux set-option failed: ${String(stderr || err.message).trim()}`);
      error.status = /can't find session|no server running/i.test(stderr || '') ? 404 : 500;
      reject(error);
    });
  });
}

function listSessions(tmuxBin = 'tmux') {
  return new Promise((resolve, reject) => {
    execFile(tmuxBin, ['list-sessions', '-F', FMT], (err, stdout, stderr) => {
      if (err) {
        if (/no server running/i.test(stderr || '')) return resolve([]);
        return reject(new Error(`tmux list-sessions failed: ${stderr || err.message}`));
      }
      resolve(parseSessions(stdout));
    });
  });
}

// How many clients are already attached to this session (before our attach).
// Used to pick a sane resize default: drive the size only when no one else is watching.
function attachedClients(tmuxBin = 'tmux', session) {
  try {
    const out = execFileSync(
      tmuxBin,
      ['display-message', '-p', '-t', `=${session}`, '#{session_attached}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return Number(String(out).trim()) || 0;
  } catch (_) { return 0; }
}

module.exports = { parseSessions, listSessions, attachedClients, setSessionVisibility, FMT };
