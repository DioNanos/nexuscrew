'use strict';
const { execFile, execFileSync } = require('node:child_process');
const { PANES_FMT } = require('./supervisor-pane.js');

const FMT = "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_activity}\t#{pane_current_command}\t#{@nexuscrew_visibility}\t#{pane_title}";

const PANE_TITLE_LIMIT = 160;
// Codex/Claude-compatible terminal titles prefix active work with a spinner.
// session/window activity timestamps are intentionally not used: idle TUIs can
// repaint their status bars continuously and would therefore look busy.
const WORKING_TITLE_PREFIX = /^[\u2800-\u28ff](?:\s+|$)/u;

function sanitizePaneTitle(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PANE_TITLE_LIMIT);
}

function parsePaneTitle(raw) {
  const paneTitle = sanitizePaneTitle(raw);
  const prefix = paneTitle.match(WORKING_TITLE_PREFIX);
  if (!prefix) return { paneTitle, working: false, status: '' };
  return {
    paneTitle,
    working: true,
    status: paneTitle.slice(prefix[0].length).trim(),
  };
}

function parseSessions(raw) {
  return String(raw)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line) => {
      const fields = line.split('\t');
      const [name, attached, windows, created, activity, cmd, visibility] = fields;
      // Join the remainder defensively: a user-controlled title containing a
      // tab must not shift any of the stable session fields.
      const titleState = parsePaneTitle(fields.slice(7).join('\t'));
      return {
        name,
        attached: attached === '1',
        windows: Number(windows),
        created: Number(created),
        activity: Number(activity) || 0,
        cmd: cmd || '',
        technical: visibility === 'technical',
        ...titleState,
      };
    })
    .filter((session) => session.windows > 0);
}

// tmux uses different expected "no server" errors across platforms. Linux
// commonly prints "no server running" while macOS reports the missing socket
// path. Both mean an empty inventory, not a broken NexusCrew node.
function isNoTmuxServerError(raw) {
  const message = String(raw || '');
  return /no server running/i.test(message)
    || /error connecting to .*(?:No such file or directory|Connection refused)/i.test(message);
}

// NexusCrew starts tmux with `set -s exit-empty off`, so a live server with
// no sessions answers `list-panes -a` with "no current target" (not "no
// server running"): that is an empty inventory, not an error — otherwise the
// node would drop out of the fleet whenever its last session closes. This
// applies to list-panes ONLY: the other commands keep rejecting it.
function isNoCurrentTargetError(message) {
  return /no current target/i.test(String(message || ''));
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

// I pani di TUTTE le sessioni, in UNA chiamata: da qui si ricava quale pane e'
// il supervisore di ogni cella e se e' vivo (lib/tmux/supervisor-pane.js).
// `#{pane_dead}` qui e' quello giusto: il pane del SUPERVISORE, non il pane
// attivo della sessione — che con una seconda finestra viva direbbe «vivo»
// anche con il supervisore morto.
function listPanes(tmuxBin = 'tmux') {
  return new Promise((resolve, reject) => {
    execFile(tmuxBin, ['list-panes', '-a', '-F', PANES_FMT], (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr || err.message);
        if (isNoTmuxServerError(message) || isNoCurrentTargetError(message)) return resolve('');
        return reject(new Error(`tmux list-panes failed: ${message}`));
      }
      resolve(stdout);
    });
  });
}

function listSessions(tmuxBin = 'tmux') {
  return new Promise((resolve, reject) => {
    execFile(tmuxBin, ['list-sessions', '-F', FMT], (err, stdout, stderr) => {
      if (err) {
        if (isNoTmuxServerError(stderr || err.message)) return resolve([]);
        return reject(new Error(`tmux list-sessions failed: ${stderr || err.message}`));
      }
      resolve(parseSessions(stdout));
    });
  });
}

// Il formato "fleet snapshot": i campi del supervisore di PANES_FMT (primi
// quattro, gli stessi che legge parsePanes) SEGUITI dai campi della sessione.
// UNA sola chiamata list-panes -a alimenta sia lo stato dei supervisori sia
// l'inventario sessioni di /api/sessions: due spawn per giro diventano uno.
// L'ordine dei campi sessione rispecchia FMT (name, attached, windows,
// created, activity, cmd, visibility, titolo), con i due marker del pane
// attivo prima del titolo.
const FLEET_PANES_FMT = `${PANES_FMT}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_activity}\t#{pane_current_command}\t#{@nexuscrew_visibility}\t#{window_active}\t#{pane_active}\t#{pane_title}`;

// Dalle righe per-pane alle righe per-SESSIONE: per ogni nome tiene il pane
// ATTIVO (window_active=1 e pane_active=1) — lo stesso pane a cui si
// riferivano i formati pane_* di list-sessions. I campi sessione sono uguali
// su tutte le righe dello stesso nome; cambia solo quale pane parla, e deve
// parlare quello attivo.
function sessionsFromPanes(raw) {
  const rows = new Map();
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    const name = f[0];
    if (!name) continue;
    const attiva = f[10] === '1' && f[11] === '1';
    const previous = rows.get(name);
    if (previous && (!attiva || previous.attiva)) continue;
    rows.set(name, {
      attiva,
      line: [f[0], f[4], f[5], f[6], f[7], f[8], f[9], f.slice(12).join('\t')].join('\t'),
    });
  }
  return parseSessions([...rows.values()].map((r) => r.line).join('\n'));
}

function listFleetPanes(tmuxBin = 'tmux') {
  return new Promise((resolve, reject) => {
    execFile(tmuxBin, ['list-panes', '-a', '-F', FLEET_PANES_FMT], (err, stdout, stderr) => {
      if (err) {
        const message = String(stderr || err.message);
        if (isNoTmuxServerError(message) || isNoCurrentTargetError(message)) return resolve('');
        return reject(new Error(`tmux list-panes failed: ${message}`));
      }
      resolve(stdout);
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

module.exports = {
  parsePaneTitle, parseSessions, isNoTmuxServerError, isNoCurrentTargetError, listSessions, listPanes, attachedClients, setSessionVisibility, FMT,
  FLEET_PANES_FMT, sessionsFromPanes, listFleetPanes,
};
