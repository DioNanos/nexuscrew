'use strict';

// Rilevatore e contenimento dei supervisor dei tunnel (node tunnel-supervisor.js)
// lasciati vivi da una suite. Specchio di tests/tmux-containment.js.
//
// PERCHE' SULL'ENVIRON E NON SUL PIDFILE. Il gate di run-isolated.js trova i
// supervisor leggendo i pidfile sotto la root della suite: un test che piazza
// la sua fixture home FUORI dalla root (per esempio una mkdtemp dritta in
// TMPDIR) rende i pidfile invisibili, e i supervisor detachati sopravvivono
// alla suite continuando a ritentare ssh. L'identita' che non dipende dal posto
// dove e' finito il pidfile e' l'ENVIRON: un supervisor eredita la HOME del
// worker che l'ha partorito (la root per-worker dell'harness), e la cmdline
// nomina tunnel-supervisor.js — lo stesso controllo d'identita' che usa la
// terminateOwnedLeak del gate sui pidfile.
//
// Il match e' per PREFISSO sotto la root della suite: solo processi nati dai
// test di QUESTA esecuzione (mkdtemp fresca) possono avere HOME o TMPDIR li'
// sotto. Il supervisor dell'operatore (HOME reale, fuori da qui) non puo'
// essere raggiunto da questo filtro per costruzione.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// PID di tutti i processi la cui cmdline nomina tunnel-supervisor.js. Lo si
// prende da `args`, non da `comm`: il supervisor e' un `node` qualunque,
// indistinguibile per comm (a differenza del `tmux: server`). Su piattaforme
// senza `ps` il rilevatore torna semplicemente vuoto (il gate resta attivo su
// Linux, che e' dove la suite gira).
function pidSupervisorTunnel() {
  let out;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 5000 });
  } catch (_) { return []; }
  const pids = [];
  for (const riga of String(out).split('\n')) {
    const m = riga.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m && m[2].includes('tunnel-supervisor.js')) pids.push(Number(m[1]));
  }
  return pids;
}

function environPid(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch (_) { return null; }
}

// Le voci environ che collocano un processo sotto la root: HOME=... o
// TMPDIR=... uguali alla root o dentro una sua sottodirectory.
function vociSottoRoot(pid, root) {
  const voci = environPid(pid);
  if (!voci) return [];
  const prefissi = [`HOME=${root}`, `TMPDIR=${root}`];
  return voci.filter((voce) => prefissi.some((p) => voce === p || voce.startsWith(`${p}${path.sep}`)));
}

// Il RILEVATORE: supervisor dei tunnel (per PID, via environ) attribuibili
// alla suite la cui root e' `root`. Torna [{ pid, prova }] con la voce environ
// che ha collocato il processo — la prova va nel messaggio di rosso, non solo
// il PID.
function elencaSupervisorTunnelLeak(root) {
  const leak = [];
  for (const pid of pidSupervisorTunnel()) {
    const prova = vociSottoRoot(pid, root);
    if (prova.length) leak.push({ pid, prova: prova[0] });
  }
  return leak;
}

// Chiusura per SEGNALE (SIGTERM poi SIGKILL, come i server tmux): il supervisor
// gestisce SIGTERM uccidendo il proprio figlio ssh e uscendo. Torna i PID
// terminati.
async function chiudiSupervisorTunnel(leak) {
  const chiusi = [];
  for (const { pid } of leak) {
    if (!pidVivo(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch (_) { continue; }
    let fine = Date.now() + 2000;
    while (Date.now() < fine && pidVivo(pid)) await delay(50);
    if (pidVivo(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gia' morto */ }
      fine = Date.now() + 1000;
      while (Date.now() < fine && pidVivo(pid)) await delay(50);
    }
    if (!pidVivo(pid)) chiusi.push(pid);
  }
  return chiusi;
}

module.exports = { elencaSupervisorTunnelLeak, chiudiSupervisorTunnel, pidSupervisorTunnel, vociSottoRoot };
