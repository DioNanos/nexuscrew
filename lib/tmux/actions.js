'use strict';
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isValidSession } = require('../files/store.js');

// Window/pane navigation must NOT be emulated with client-side prefix keys
// (it depends on each host's bindings, which may be remapped or broken).
// It runs server-side with direct, allowlisted tmux commands on the active session.
const ACTIONS = {
  'prev-window': ['previous-window'],
  'next-window': ['next-window'],
  'pane-left': ['select-pane', '-L'],
  'pane-right': ['select-pane', '-R'],
};

// Pure: ritorna gli arg tmux per un'azione allowlistata, o null.
function actionArgs(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name].slice() : null;
}

const SCROLL_LINES = 3;

// Scroll della cronologia via copy-mode: 'up' entra in copy-mode (idempotente
// se già dentro) e scorre; con -e il ritorno in fondo ESCE da copy-mode da
// solo, quindi il gesto "trascina giù fino in fondo" riporta al vivo.
function scrollArgs(session, dir) {
  if (typeof session !== 'string') return null;
  if (dir !== 'up' && dir !== 'down') return null;
  const target = `=${session}:`;
  return [
    ['copy-mode', '-e', '-t', target],
    ['send-keys', '-t', target, '-X', '-N', String(SCROLL_LINES), dir === 'up' ? 'scroll-up' : 'scroll-down'],
  ];
}

function runScroll(tmuxBin, session, dir) {
  const steps = scrollArgs(session, dir);
  if (!steps) return false;
  try {
    // send-keys -X vale solo in copy-mode: va in sequenza, non in parallelo.
    execFile(tmuxBin, steps[0], () => { execFile(tmuxBin, steps[1], () => {}); });
    return true;
  } catch (_) { return false; }
}

// Fire-and-forget: esegue l'azione sulla sessione. Target `=name:` (exact-match
// + colon): su tmux 3.4 il bare `=name` fallisce per i comandi pane/window-target.
function runAction(tmuxBin, session, name) {
  if (name === 'scroll-up') return runScroll(tmuxBin, session, 'up');
  if (name === 'scroll-down') return runScroll(tmuxBin, session, 'down');
  const base = actionArgs(name);
  if (!base) return false;
  try { execFile(tmuxBin, [...base, '-t', `=${session}:`], () => {}); return true; }
  catch (_) { return false; }
}

const MAX_PASTE = 4096;
const MAX_SUBMIT = 8192;

// true se text contiene control char (codici 0x00-0x1f e 0x7f). Espresso via
// charCode invece di regex perche' il write-layer corrompe gli escape backslash
// nel sorgente (v. NOTE in lib/files/store.js).
function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

// Digita testo literal nella sessione, SENZA Invio: il '--' protegge testi
// che iniziano con '-'; i control char (inclusi i ritorni a capo CR e LF)
// sono rifiutati a monte così un paste non può mai submitare un prompt.
function pasteArgs(session, text) {
  if (typeof session !== 'string' || typeof text !== 'string') return null;
  if (!text || text.length > MAX_PASTE) return null;
  if (hasControlChar(text)) return null;
  return ['send-keys', '-t', `=${session}:`, '-l', '--', text];
}

// Risolve col VERO esito di tmux (l'exit code), non col solo lancio del
// processo: un target inesistente deve produrre pasted:false, non un falso ok.
function pasteToSession(tmuxBin, session, text) {
  const args = pasteArgs(session, text);
  if (!args) return Promise.resolve(false);
  return new Promise((resolve) => {
    try { execFile(tmuxBin, args, (err) => resolve(!err)); }
    catch (_) { resolve(false); }
  });
}

function submitTextOk(text) {
  if (typeof text !== 'string' || !text || text.length > MAX_SUBMIT) return false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) return false;
  }
  return true;
}

function execTmux(execFileImpl, tmuxBin, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFileImpl(tmuxBin, args, { timeout }, (err, stdout) => {
        resolve({ ok: !err, stdout: String(stdout || '') });
      });
    } catch (_) { resolve({ ok: false, stdout: '' }); }
  });
}

// Consegna un messaggio a un pane esatto e lo sottopone al TUI. Il testo non
// passa mai in argv: file temporaneo 0600 -> tmux load-buffer -> paste-buffer -p
// (bracketed paste), poi Enter con una chiamata separata. Il pane id viene
// risolto prima del paste e verificato di nuovo prima dell'Enter, evitando
// prefix match e il riuso del solo nome sessione.
async function submitToSession(tmuxBin, session, text, opts = {}) {
  if (!isValidSession(session) || !submitTextOk(text)) {
    return { submitted: false, reason: 'input non valido' };
  }
  const execFileImpl = opts.execFileImpl || execFile;
  const fsImpl = opts.fsImpl || fs;
  const tmpRoot = opts.tmpdir || os.tmpdir();
  const delay = typeof opts.delay === 'function'
    ? opts.delay : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const codexComposer = /^(?:codex|codex-vl)(?:\.|$)/.test(String(opts.engine || ''));
  const nonce = (opts.nonce || crypto.randomBytes(8).toString('hex')).replace(/[^a-f0-9]/g, '').slice(0, 32);
  if (!nonce) return { submitted: false, reason: 'invio non disponibile' };
  const buffer = `ncmsg-${nonce}`;
  const tmp = path.join(tmpRoot, `.nexuscrew-message-${nonce}.txt`);
  let loaded = false;
  try {
    fsImpl.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsImpl.chmodSync(tmp, 0o600);
    const pane = await execTmux(execFileImpl, tmuxBin,
      ['display-message', '-p', '-t', `=${session}:`, '#{pane_id}']);
    const paneId = pane.stdout.trim();
    if (!pane.ok || !/^%[0-9]+$/.test(paneId)) {
      return { submitted: false, reason: 'sessione non raggiungibile' };
    }
    const load = await execTmux(execFileImpl, tmuxBin, ['load-buffer', '-b', buffer, tmp]);
    if (!load.ok) return { submitted: false, reason: 'buffer non disponibile' };
    loaded = true;
    const paste = await execTmux(execFileImpl, tmuxBin,
      ['paste-buffer', '-p', '-t', paneId, '-b', buffer]);
    if (!paste.ok) return { submitted: false, reason: 'consegna non riuscita' };
    const paneAlive = async () => {
      const verify = await execTmux(execFileImpl, tmuxBin,
        ['display-message', '-p', '-t', paneId, '#{session_name}\t#{pane_dead}\t#{pane_id}']);
      const [verifiedSession, dead, verifiedPane] = verify.stdout.trim().split('\t');
      return verify.ok && verifiedSession === session && dead === '0' && verifiedPane === paneId;
    };
    // Codex/Codex-VL have a paste-burst window: a too-early Enter can remain
    // inside the composer. C-e is sent as its own tmux command after the paste,
    // then the pane is revalidated before the separate Enter. Other clients
    // still receive a short separation between paste and submit.
    await delay(codexComposer ? 400 : 150);
    if (!(await paneAlive())) return { submitted: false, reason: 'sessione terminata durante la consegna' };
    if (codexComposer) {
      const flush = await execTmux(execFileImpl, tmuxBin, ['send-keys', '-t', paneId, 'C-e']);
      if (!flush.ok) return { submitted: false, reason: 'testo consegnato ma flush composer non riuscito' };
      await delay(300);
      if (!(await paneAlive())) return { submitted: false, reason: 'sessione terminata durante la consegna' };
    }
    const enter = await execTmux(execFileImpl, tmuxBin, ['send-keys', '-t', paneId, 'Enter']);
    if (!enter.ok) return { submitted: false, reason: 'testo consegnato ma invio non riuscito' };
    return { submitted: true, reason: codexComposer
      ? 'bracketed paste + burst flush + Enter separati'
      : 'bracketed paste + Enter separato' };
  } catch (_) {
    return { submitted: false, reason: 'consegna non riuscita' };
  } finally {
    if (loaded) await execTmux(execFileImpl, tmuxBin, ['delete-buffer', '-b', buffer]);
    try { fsImpl.unlinkSync(tmp); } catch (_) { /* cleanup best-effort */ }
  }
}

module.exports = {
  actionArgs, runAction, ACTIONS, pasteArgs, pasteToSession, scrollArgs,
  submitTextOk, submitToSession, MAX_SUBMIT,
};
