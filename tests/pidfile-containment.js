'use strict';

// Contenimento dei supervisor dei tunnel trovati dai PIDFILE sotto la root della
// run. Specchio di tests/tmux-containment.js e di
// tests/tunnel-supervisor-containment.js.
//
// PERCHE' QUI E NON DENTRO run-isolated.js. Il gate chiude i leak descritti dai
// pidfile rimasti sotto la root: la funzione vive in un modulo suo perche' il
// suo contratto (cosa si considera «un nostro leak») sia verificabile da un test
// vero, non solo dal runner alla fine della suite.

const fs = require('node:fs');
const path = require('node:path');
const pidf = require('../lib/cli/pidfile.js');
const { vociSottoRoot } = require('./tunnel-supervisor-containment.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Tutti i pidfile dei supervisor sotto `dir`: la forma e' quella scritta dai
// tunnel (`<...>/tunnels/<nome>.pid`).
function allPidfiles(dir, found = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return found; }
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) allPidfiles(target, found);
    else if (entry.isFile() && entry.name.endsWith('.pid') && path.basename(path.dirname(target)) === 'tunnels') found.push(target);
  }
  return found;
}

// Chiude il supervisor descritto da `pidPath` quando i metadati (pid vivo,
// nascita attestata, cmdline che nomina tunnel-supervisor.js) lo attribuiscono
// a NexusCrew **e** l'appartenenza alla run e' dimostrata dall'environ. SIGTERM,
// poi SIGKILL come ripiego, poi il pidfile.
//
// L'APPARTENENZA VIENE PRIMA DI OGNI SEGNALE. Un pidfile valido sotto la root
// dice dove sta il FILE, non dove e' nato il processo: un pidfile copiato (o la
// fixture di un test che ha scritto la sua home altrove) descriverebbe un
// processo estraneo, e mandargli un segnale chiuderebbe il lavoro di qualcun
// altro — sulla macchina di sviluppo, il supervisor di produzione. La prova e'
// la stessa delle reti environ (`vociSottoRoot`): HOME o TMPDIR uguali alla
// root o dentro una sua sottodirectory. Nessuna prova — environ illeggibile
// compreso — significa nessun segnale: fail-closed.
//
// Ritorna:
//   { esito: 'chiuso', pid, pidPath }                  -> segnalato e pidfile rimosso
//   { esito: 'anomalia', pid, pidPath, motivo }        -> nessun segnale
//   null                                               -> niente da chiudere
async function chiudiLeakDaPidfile(pidPath, meta, root) {
  if (!meta || !pidf.isAlive(meta)) return null;
  const live = pidf.readCmdline(meta.pid);
  if (!live.includes('tunnel-supervisor.js')) return null;

  const prova = vociSottoRoot(meta.pid, root);
  if (!prova.length) {
    return {
      esito: 'anomalia', pid: meta.pid, pidPath,
      motivo: 'appartenenza alla run non dimostrata: nessuna voce environ HOME/TMPDIR sotto la root '
        + '(o /proc/<pid>/environ non leggibile). Nessun segnale inviato.',
    };
  }

  try { process.kill(meta.pid, 'SIGTERM'); } catch (_) {}
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && pidf.pidExists(meta.pid)) await delay(50);
  if (pidf.pidExists(meta.pid)) {
    const still = pidf.readCmdline(meta.pid);
    if (still.includes('tunnel-supervisor.js')) {
      try { process.kill(meta.pid, 'SIGKILL'); } catch (_) {}
    }
  }
  pidf.removePidfile(pidPath);
  return { esito: 'chiuso', pid: meta.pid, pidPath };
}

module.exports = { allPidfiles, chiudiLeakDaPidfile };
