'use strict';

// Rilevatore e contenimento dei server tmux lasciati vivi da una suite.
//
// PERCHE' SULL'ENVIRON E NON SULLA CMDLINE. Un server tmux avviato dal primo
// client CONSERVA la cmdline di quel client (`tmux -L x new-session ...` o
// addirittura `tmux start-server ; set-option ...`): la cmdline dice chi ha
// chiesto la nascita, non chi e' il processo. L'identita' stabile del server
// e' il suo environment (TMUX_TMPDIR/HOME ereditati dal client che l'ha
// partorito). E il nome va preso da `comm` — `tmux: server`, con spazio:
// `pgrep -x tmux` NON li vede.
//
// Il match e' per PREFISSO sotto la root della suite: solo processi nati
// dai test di QUESTA esecuzione (mkdtemp fresca) possono avere TMUX_TMPDIR o
// HOME lì sotto. Il server dell'operatore (HOME reale, senza TMUX_TMPDIR
// di test) non puo' essere raggiunto da questo filtro per costruzione.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// PID di tutti i processi con comm `tmux: server`. Su piattaforme senza /proc
// o senza ps il rilevatore torna semplicemente vuoto (il gate resta attivo su
// Linux, che e' dove la suite gira).
function pidServerTmux() {
  let out;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,comm='], { encoding: 'utf8', timeout: 5000 });
  } catch (_) { return []; }
  const pids = [];
  for (const riga of String(out).split('\n')) {
    const m = riga.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m && m[2] === 'tmux: server') pids.push(Number(m[1]));
  }
  return pids;
}

function environPid(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch (_) { return null; }
}

// Le voci environ che collocano un processo sotto la root: TMUX_TMPDIR=... o
// HOME=... uguali alla root o dentro una sua sottodirectory.
function vociSottoRoot(pid, root) {
  const voci = environPid(pid);
  if (!voci) return [];
  const prefissi = [`TMUX_TMPDIR=${root}`, `HOME=${root}`];
  return voci.filter((voce) => prefissi.some((p) => voce === p || voce.startsWith(`${p}${path.sep}`)));
}

// Il RILEVATORE: server tmux (per PID, via environ) attribuibili alla suite
// la cui root e' `root`. Torna [{ pid, prova }] con la voce environ che ha
// collocato il processo — la prova va nel messaggio di rosso, non solo il PID.
function elencaServerTmuxLeak(root) {
  const leak = [];
  for (const pid of pidServerTmux()) {
    const prova = vociSottoRoot(pid, root);
    if (prova.length) leak.push({ pid, prova: prova[0] });
  }
  return leak;
}

// Chiusura per SEGNALE (mai kill-server: sugli orfani l'alias potrebbe
// essere installato, e il segnale non passa da tmux). Torna i PID terminati.
async function chiudiServerTmux(leak) {
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

module.exports = { elencaServerTmuxLeak, chiudiServerTmux, pidServerTmux, vociSottoRoot };
