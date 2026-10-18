'use strict';

// Fabbrica UNICA dei server tmux di test (mandato 0.9.74, studio 18/10).
//
// PERCHE' ESISTE. Un server tmux avviato da un test e' immortale per due
// guardie indipendenti: l'alias kill-server installato dalla protezione del
// repo (lib/tmux/shared-server.js) e quello della ~/.tmux.conf dell'operatore
// (fuori harness), entrambi con exit-empty off. `kill-server` quindi NON e'
// una chiusura: e' una display-message. L'unica chiusura affidabile e' il
// SEGNALE al PID del server.
//
// COSA FA. Avvia il server con `-f /dev/null` (nessuna ~/.tmux.conf, nessun
// alias di macchina) su un socket dedicato `-L nc-test-<pid>-<n>` dentro una
// TMUX_TMPDIR creata da questa fabbrica: il server nasce pulito e muore per
// SIGTERM/SIGKILL. `chiudi()` non usa MAI kill-server.
//
// PRECEDENTE in repo: tests/fleet-shell-launch-race.test.js (avvio con
// -f /dev/null su socket esplicito + cleanup) e il suo commento sul perche'
// il server di prova non deve caricare la config dell'operatore.

const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMUX_BIN = process.env.NEXUSCREW_TEST_TMUX_BIN || 'tmux';

let sequenza = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// Chiude un processo per PID: SIGTERM, poi SIGKILL dopo ~2 s se serve.
// Esportata anche da sola per i test che collaudano la GUARDIA su un server
// dedicato (tmux-shared-server, fleet-cold-start): lì il server nasce con
// l'alias installato, quindi l'unica chiusura possibile e' questa.
async function terminaPerPid(pid, { attesaMs = 2000 } = {}) {
  if (!pidVivo(pid)) return false;
  try { process.kill(pid, 'SIGTERM'); } catch (_) { return false; }
  let fine = Date.now() + attesaMs;
  while (Date.now() < fine && pidVivo(pid)) await delay(50);
  if (pidVivo(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gia' morto */ }
    fine = Date.now() + 1000;
    while (Date.now() < fine && pidVivo(pid)) await delay(50);
  }
  return !pidVivo(pid);
}

function uidDir() {
  try { return `tmux-${process.getuid()}`; } catch (_) { return 'tmux-default'; }
}

class ServerTmuxTest {
  constructor({ pid, socketName, socketDir, socketPath, dirNostra, sessioneBoot }) {
    this.pid = pid;
    this.socketName = socketName;
    this.socketDir = socketDir;
    this.socketPath = socketPath;
    this.dirNostra = dirNostra; // true se la dir l'ha creata avvia(): solo allora chiudi() la rimuove
    this.sessioneBoot = sessioneBoot;
    this._wrapper = null;
  }

  envClient() {
    return { ...process.env, TMUX_TMPDIR: this.socketDir, TMUX: '', TMUX_PANE: '' };
  }

  // Comandi client verso QUESTO server. -f /dev/null su ogni client: se il
  // server dovesse nascere da un comando successivo, non leggerebbe comunque
  // la config dell'operatore.
  clientArgs(args) {
    return ['-f', '/dev/null', '-L', this.socketName, ...args];
  }

  runSync(args, { timeout = 5000 } = {}) {
    try {
      const stdout = execFileSync(TMUX_BIN, this.clientArgs(args), {
        encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
        env: this.envClient(),
      });
      return { code: 0, stdout: String(stdout || ''), stderr: '' };
    } catch (e) {
      return {
        code: typeof e.status === 'number' ? e.status : 1,
        stdout: String(e.stdout || ''),
        stderr: String(e.stderr || ''),
      };
    }
  }

  run(args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile(TMUX_BIN, this.clientArgs(args), {
        encoding: 'utf8', timeout: opts.timeout || 5000,
        env: this.envClient(),
      }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || '');
          err.stderr = String(stderr || err.message);
          reject(err); return;
        }
        resolve(String(stdout || ''));
      });
    });
  }

  // Wrapper eseguibile che instrada ogni client tmux (compresi quelli della
  // runtime, che accetta un tmuxBin) su QUESTO socket: stesso trucco di
  // tests/fleet-shell-launch-race.test.js. TMUX_TMPDIR e' fissato DENTRO lo
  // script: un client con env filtrato trovera' comunque il socket.
  wrapper() {
    if (this._wrapper) return this._wrapper;
    const dir = this.dirNostra ? this.socketDir : fs.mkdtempSync(path.join(os.tmpdir(), 'nc-test-tmuxwrap-'));
    const bin = path.join(dir, 'tmux-test');
    fs.writeFileSync(bin, `#!/bin/sh\nTMUX_TMPDIR=${JSON.stringify(this.socketDir)} exec ${TMUX_BIN} -f /dev/null -L ${JSON.stringify(this.socketName)} "$@"\n`, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    this._wrapper = bin;
    this._wrapperDir = dir;
    return bin;
  }

  // I test che contano TUTTE le sessioni non vogliono la sentinella di avvio
  // tra i piedi: la si uccide una volta che il test ha creato la sua prima
  // sessione. Con exit-empty di default (on) il server resta vivo finche'
  // esiste almeno una sessione, e alla fine esce da solo; chiudi() resta
  // comunque idempotente.
  uccidiSessioneBoot() {
    return this.runSync(['kill-session', '-t', this.sessioneBoot]);
  }

  // Chiusura per SEGNALE, mai kill-server: il socket viene rimosso a mano
  // perche' (misurato) il file sopravvive anche quando il server muore.
  async chiudi() {
    await terminaPerPid(this.pid);
    try { fs.unlinkSync(this.socketPath); } catch (_) { /* assente */ }
    if (this._wrapper && this._wrapperDir && !this.dirNostra) {
      try { fs.rmSync(this._wrapperDir, { recursive: true, force: true }); } catch (_) { /* assente */ }
    }
    if (this.dirNostra) {
      try { fs.rmSync(this.socketDir, { recursive: true, force: true }); } catch (_) { /* assente */ }
    }
    this._wrapper = null;
  }
}

// Avvia un server dedicato e ne legge il PID SUBITO: `display-message -p
// '#{pid}'` e' l'unica fonte affidabile del PID del server (la cmdline del
// processo e' quella del client che l'ha creato, non del server).
async function avviaTmuxTest({ tmpDir, primaSessione = 'nc-test-boot', comando = ['/usr/bin/sleep', '3600'] } = {}) {
  const dirNostra = !tmpDir;
  const socketDir = dirNostra ? fs.mkdtempSync(path.join(os.tmpdir(), 'nc-test-tmux-')) : tmpDir;
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const socketName = `nc-test-${process.pid}-${++sequenza}`;
  const socketPath = path.join(socketDir, uidDir(), socketName);
  const proto = new ServerTmuxTest({ pid: 0, socketName, socketDir, socketPath, dirNostra, sessioneBoot: primaSessione });

  const crea = proto.runSync(['new-session', '-d', '-s', primaSessione, '-c', socketDir, ...comando]);
  if (crea.code !== 0) {
    if (dirNostra) { try { fs.rmSync(socketDir, { recursive: true, force: true }); } catch (_) { /* assente */ } }
    throw new Error(`avvio server tmux di test fallito: ${crea.stderr.trim() || crea.stdout.trim()}`);
  }
  const pidOut = proto.runSync(['display-message', '-p', '#{pid}']);
  const pid = Number(pidOut.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    await proto.chiudi().catch(() => {});
    throw new Error(`PID del server tmux di test non letto: "${pidOut.stdout.trim()}" ${pidOut.stderr.trim()}`);
  }
  return new ServerTmuxTest({ pid, socketName, socketDir, socketPath, dirNostra, sessioneBoot: primaSessione });
}

module.exports = { avviaTmuxTest, terminaPerPid, pidVivo };
