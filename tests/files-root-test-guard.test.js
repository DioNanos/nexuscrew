'use strict';
// La root dei file di lancio non deve mai ricadere, durante una run di test,
// sullo store vero dell'operatore: e' l'incidente dei record di test ritrovati
// nel NexusFiles reale. Due prove che rendono la dimenticanza rumorosa:
//
//  1. funzionale: con il marcatore ESPlicito del runner attivo, il ripiego di
//     `filesRootDi` senza `cfg.filesRoot` lancia FILES_ROOT_REQUIRED_IN_TEST;
//     senza marcatori il valore e' identico a quello di oggi (il `defaults()`
//     del config). I marcatori sono solo quelli che il runner imposta davvero
//     (`NEXUSCREW_TEST_HOME_ROOT` di tests/run-isolated.js e il
//     `NODE_TEST_CONTEXT` di node --test): nessuna euristica su path o argv.
//
//  2. statica (lint): ogni tests/fleet-*.test.js che costruisce un runtime o
//     un fleet deve dichiarare `filesRoot` nella cfg di quel call site. I file
//     storici che ancora non lo fanno stanno in MONDI_EREDITA: e' una ghiera,
//     non un permesso — una voce che smette di violare va tolta, e un mondo
//     nuovo senza `filesRoot` e' rosso.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { filesRootDi } = require('../lib/fleet/managed.js');
const { defaults } = require('../lib/config.js');

const MARCATORI_RUNNER = ['NEXUSCREW_TEST_HOME_ROOT', 'NODE_TEST_CONTEXT'];

// Imposta i marcatori come richiesto e restituisce la funzione che ripristina
// l'ambiente com'era (le chiavi assenti restano assenti).
function applicaMarcatori(valori) {
  const salvati = new Map();
  for (const nome of MARCATORI_RUNNER) {
    salvati.set(nome, process.env[nome]);
    if (Object.prototype.hasOwnProperty.call(valori, nome)) process.env[nome] = valori[nome];
    else delete process.env[nome];
  }
  return () => {
    for (const [nome, valore] of salvati) {
      if (valore === undefined) delete process.env[nome];
      else process.env[nome] = valore;
    }
  };
}

test('filesRootDi: con il marcatore del runner attivo il ripiego senza cfg.filesRoot lancia FILES_ROOT_REQUIRED_IN_TEST', () => {
  for (const marcatore of MARCATORI_RUNNER) {
    const ripristina = applicaMarcatori({ [marcatore]: '/tmp/nc-test-runner-marker-segnaposto' });
    try {
      for (const cfgDiProva of [{}, { launchReadyMs: 40 }, undefined]) {
        assert.throws(
          () => filesRootDi(cfgDiProva),
          (err) => err instanceof Error && err.code === 'FILES_ROOT_REQUIRED_IN_TEST' && /filesRoot/.test(err.message),
          `il ripiego doveva lanciare con ${marcatore} attivo (cfg=${JSON.stringify(cfgDiProva) ?? 'undefined'})`,
        );
      }
      // La dichiarazione esplicita resta la via d'uscita: con cfg.filesRoot la
      // guardia non si applica, il valore passa identico.
      assert.equal(filesRootDi({ filesRoot: '/tmp/nc-mondo-dichiarato' }), '/tmp/nc-mondo-dichiarato');
    } finally {
      ripristina();
    }
  }
});

test('filesRootDi: senza marcatori di test il ripiego e il valore sono identici a oggi', () => {
  const ripristina = applicaMarcatori({});
  try {
    const atteso = defaults().filesRoot;
    assert.equal(filesRootDi({}), atteso);
    assert.equal(filesRootDi({ launchReadyMs: 40 }), atteso);
    assert.equal(filesRootDi(undefined), atteso);
  } finally {
    ripristina();
  }
});

// --- Lint statico dei mondi fleet -------------------------------------------

// Sostituisce commenti e contenuti di stringa/template con spazi (le righe si
// conservano), cosi' i match vivono solo nel codice vero.
function spoglia(src) {
  let out = '';
  let i = 0;
  let mode = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'linea') { if (c === '\n') { mode = null; out += '\n'; } i++; continue; }
    if (mode === 'blocco') {
      if (c === '*' && d === '/') { mode = null; i += 2; out += ' '; } else { if (c === '\n') out += '\n'; i++; }
      continue;
    }
    if (mode === 'str') {
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') out += '\n'; else out += ' ';
      if (c === mode) mode = null;
      i++; continue;
    }
    if (c === '/' && d === '/') { mode = 'linea'; i += 2; continue; }
    if (c === '/' && d === '*') { mode = 'blocco'; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { mode = c; out += ' '; i++; continue; }
    out += c; i++;
  }
  return out;
}

function estraiLetterale(src, da) {
  if (src[da] !== '{') return null;
  let profondita = 0;
  let i = da;
  let mode = null;
  while (i < src.length) {
    const c = src[i];
    if (mode) { if (c === '\\') { i += 2; continue; } if (c === mode) mode = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = c; i++; continue; }
    if (c === '{') profondita++;
    else if (c === '}') {
      profondita--;
      if (profondita === 0) return { testo: src.slice(da, i + 1), fine: i + 1 };
    }
    i++;
  }
  return null;
}

// Chiavi top-level di un letterale (shorthand compresi) e i sotto-letterali
// dei valori ad almeno un livello (serve `cfg`).
function chiaviTop(lit) {
  const chiavi = new Set();
  const sub = {};
  let profondita = 0;
  let mode = null;
  let i = 0;
  let corrente = '';
  let chiave = null;
  let inizioValore = -1;
  const chiudiValore = () => { if (chiave !== null) { chiave = null; inizioValore = -1; } };
  while (i < lit.length) {
    const c = lit[i];
    if (mode) { if (c === '\\') { i += 2; continue; } if (c === mode) mode = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = c; i++; continue; }
    if (c === '{' || c === '[' || c === '(') {
      if (profondita === 1 && chiave !== null && inizioValore === -1 && c === '{') inizioValore = i;
      profondita++; i++; continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      profondita--;
      if (profondita === 1 && chiave !== null && inizioValore !== -1 && c === '}') {
        sub[chiave] = lit.slice(inizioValore, i + 1);
        chiudiValore();
      }
      if (profondita === 0) { if (corrente.trim()) chiavi.add(corrente.trim()); break; }
      i++; continue;
    }
    if (profondita === 1 && c === ',') {
      if (chiave === null && corrente.trim()) chiavi.add(corrente.trim());
      else chiudiValore();
      corrente = ''; i++; continue;
    }
    if (profondita === 1 && c === ':' && chiave === null) {
      const k = corrente.trim();
      chiavi.add(k);
      chiave = k;
      corrente = ''; i++; continue;
    }
    if (profondita === 1 && chiave === null) corrente += c;
    i++;
  }
  return { chiavi, sub };
}

// I mondi storici che ancora non dichiarano `filesRoot`: la ghiera. Ogni voce
// deve restare viva (file esistente E ancora violante): chi sistema un file
// eredite tolga la voce, altrimenti questo lint diventa rosso per voce stantia.
const MONDI_EREDITA = new Set([
  'fleet-boot-finestra.test.js',
  'fleet-capability-profiles-preserve.test.js',
  'fleet-cell-capabilities.test.js',
  'fleet-cold-start.test.js',
  'fleet-credential-provenance.test.js',
  'fleet-custom-engine-model-listing.test.js',
  'fleet-cwd-portability.test.js',
  'fleet-declared-models-e2e.test.js',
  'fleet-definitions.test.js',
  'fleet-defs-window.test.js',
  'fleet-desktop.test.js',
  'fleet-engine-models-auth-cause.test.js',
  'fleet-engine-models-reasoning.test.js',
  'fleet-engine-models-route.test.js',
  'fleet-engine-order.test.js',
  'fleet-import.test.js',
  'fleet-model-cap.test.js',
  'fleet-model-crud.test.js',
  'fleet-model-declaration-fields.test.js',
  'fleet-model-probe-wiring.test.js',
  'fleet-model-remove-cell-override.test.js',
  'fleet-models-backup.test.js',
  'fleet-pi-discovery.test.js',
  'fleet-staged-launch-failures.test.js',
  'fleet-tmux-migration.test.js',
  'fleet-vl-bootstrap-claim-outcome.test.js',
  'fleet-vl-bootstrap-claim-runtime.test.js',
  'fleet-vl-fields-roundtrip.test.js',
  'fleet-vl-first-up-real.test.js',
  'fleet-vl-host-down-isolation-runtime.test.js',
  'fleet-vl-host-stop-clean-outcome.test.js',
  'fleet-vl-host-stop-expected.test.js',
  'fleet-vl-launch-matrix.test.js',
  'fleet-vl-newsessionenv.test.js',
  'fleet-vl-peer-stop-real.test.js',
  'fleet-vl-peer-unattested-up.test.js',
  'fleet-vl-preflight-peer-stop.test.js',
  'fleet-vl-profiles.test.js',
  'fleet-vl-session.test.js',
]);

test('lint mondi fleet: ogni costruzione dichiara filesRoot (o sta nella ghiera delle eredita)', () => {
  const violazioni = [];
  const erediVivi = new Set();
  const nomi = fs.readdirSync(__dirname).filter((f) => /^fleet-.*\.test\.js$/.test(f)).sort();
  for (const nome of nomi) {
    const erede = MONDI_EREDITA.has(nome);
    const pulito = spoglia(fs.readFileSync(path.join(__dirname, nome), 'utf8'));
    const re = /\b(createBuiltinRuntime|createBuiltinFleet)\s*\(/g;
    let m;
    while ((m = re.exec(pulito)) !== null) {
      const fn = m[1];
      let i = m.index + m[0].length;
      while (/\s/.test(pulito[i])) i++;
      const riga = pulito.slice(0, m.index).split('\n').length;
      const lit = estraiLetterale(pulito, i);
      if (!lit) {
        if (!erede) violazioni.push(`${nome}:${riga} ${fn}: argomento non letterale, filesRoot non verificabile`);
        else erediVivi.add(nome);
        continue;
      }
      const t = chiaviTop(lit.testo);
      const dichiaraRoot = t.chiavi.has('filesRoot')
        || (t.sub.cfg ? chiaviTop(t.sub.cfg).chiavi.has('filesRoot') : false);
      if (!dichiaraRoot) {
        if (!erede) violazioni.push(`${nome}:${riga} ${fn}: cfg senza filesRoot`);
        else erediVivi.add(nome);
      }
      re.lastIndex = lit.fine;
    }
  }
  const vociStantie = [...MONDI_EREDITA].filter((nome) => !erediVivi.has(nome) && !nomi.includes(nome));
  const vociSistemate = [...MONDI_EREDITA].filter((nome) => !erediVivi.has(nome) && nomi.includes(nome));
  const problemi = [];
  if (violazioni.length) {
    problemi.push(`mondi che non dichiarano dove finiscono i record di lancio (aggiungi filesRoot alla cfg, dentro la root temporanea del mondo):\n  ${violazioni.join('\n  ')}`);
  }
  if (vociSistemate.length) {
    problemi.push(`voci di MONDI_EREDITA che non violano piu' (togliele dalla ghiera):\n  ${vociSistemate.join('\n  ')}`);
  }
  if (vociStantie.length) {
    problemi.push(`voci di MONDI_EREDITA senza file corrispondente (togliele dalla ghiera):\n  ${vociStantie.join('\n  ')}`);
  }
  assert.equal(problemi.length, 0, `\n${problemi.join('\n')}\n`);
});
