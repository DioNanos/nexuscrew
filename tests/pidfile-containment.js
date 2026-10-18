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
// a NexusCrew. SIGTERM, poi SIGKILL come ripiego, poi il pidfile.
// Ritorna { esito: 'chiuso', pid, pidPath } oppure null se non c'e' niente da
// chiudere (pidfile stale o di un altro processo).
async function chiudiLeakDaPidfile(pidPath, meta) {
  if (!meta || !pidf.isAlive(meta)) return null;
  const live = pidf.readCmdline(meta.pid);
  if (!live.includes('tunnel-supervisor.js')) return null;

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
