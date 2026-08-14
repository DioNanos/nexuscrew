'use strict';

// D2 audit: "il consumatore vero non e' il file: e' Pi che lo legge." Un test
// che legge il file .ts generato non prova che Pi possa caricarlo — questo
// helper esegue REALMENTE il pacchetto Pi installato sulla macchina (Node 24
// esegue file .ts nativamente, e i moduli di composizione modello di Pi sono
// pura logica JS, importabili senza avviare l'intero agente).
//
// Portabile per costruzione: risolve il binario `pi` dal PATH del processo
// (mai un percorso hardcoded di una singola installazione nvm), poi risale le
// directory dal binario fino al package.json del pacchetto
// @earendil-works/pi-coding-agent. Se Pi non e' installato sulla macchina che
// esegue la suite, resolvePiComposer() ritorna null e il test chiamante deve
// fare uno SKIP esplicito e motivato — mai un pass silenzioso.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let cached; // { composeModelProvider } | null, calcolato una volta

function findPackageRoot(fromFile) {
  let dir = path.dirname(fromFile);
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name === '@earendil-works/pi-coding-agent') return dir;
    } catch (_) { /* non qui, risali */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function resolvePiComposer() {
  if (cached !== undefined) return cached;
  try {
    const which = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
    if (!which) { cached = null; return cached; }
    const real = fs.realpathSync(which);
    const root = findPackageRoot(real);
    if (!root) { cached = null; return cached; }
    const composerPath = path.join(root, 'dist', 'core', 'provider-composer.js');
    if (!fs.existsSync(composerPath)) { cached = null; return cached; }
    const mod = await import(`file://${composerPath}`);
    cached = { composeModelProvider: mod.composeModelProvider, root };
  } catch (_) {
    cached = null;
  }
  return cached;
}

// Esegue REALMENTE il file .ts generato da NexusCrew (import dinamico nativo
// di Node 24) e cattura la config passata a `pi.registerProvider(id, config)`
// — esattamente cio' che Pi fa internamente quando carica un'estensione.
async function loadPiExtensionFile(tsPath) {
  const mod = await import(`file://${tsPath}`);
  let captured = null;
  await mod.default({ registerProvider: (id, config) => { captured = { id, config }; } });
  return captured;
}

module.exports = { resolvePiComposer, loadPiExtensionFile };
