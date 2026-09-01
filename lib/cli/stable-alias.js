'use strict';
// R23 — alias stabili per i path del servizio di boot.
//
// Il companion di boot scrive nodeBin e entryPath LETTERALMENTE nel plist
// launchd (ProgramArguments[0]) e nell'unit systemd (ExecStart=). Quei path
// possono essere VERSIONATI:
//   node  -> /opt/homebrew/Cellar/node/<ver>/bin/node   (Homebrew)
//            ~/.nvm/versions/node/<ver>/bin/node        (nvm)
//   entry -> ~/.nvm/versions/node/<ver>/lib/node_modules/<pkg>/bin/nexuscrew.js
// Homebrew rompe all'upgrade (sostituisce il Cellar), nvm rompe a
// `nvm uninstall` della vecchia versione: il servizio punta a un file che non
// esiste piu' e la cella non parte, con un sintomo confuso (il node c'e', il
// file no — o viceversa).
//
// La cura, per CIASCUNO dei due path: fra candidati noti, cercare un alias
// stabile che risolva (realpath) allo STESSO IDENTICO FILE che sta girando.
// Se c'e', scrivere quello; se no, scrivere il path attuale e DICHIARARLO:
// un avviso alla scrittura e' meglio di un path che scade in silenzio.
//
// Tre vincoli non negoziabili (briefing R23):
// 1. La verifica «e' lo stesso file» si fa alla SCRITTURA del servizio, MAI a
//    ogni avvio: dopo l'upgrade il symlink DEVE puntare a un node diverso —
//    e' l'effetto voluto. Un controllo di identita' permanente si
//    autoannullerebbe.
// 2. Su nvm NON esiste un alias stabile (~/.nvm/current non c'e',
//    ~/.nvm/alias/default e' un file di testo, `command -v node` risolve al
//    path versionato): qui il risolutore non trova nulla e il ramo che conta
//    e' quello che lo dichiara. Non inventare un alias nvm.
// 3. Il PATH del plist che include /opt/homebrew/bin NON e' una protezione:
//    ProgramArguments[0] e' assoluto. Non contarci.

const fs = require('node:fs');
const path = require('node:path');

// Prefissi stabili noti (ordinati per probabilita'), senza $PREFIX che viene
// aggiunto solo se presente (Termux).
const STABLE_ROOTS = ['/opt/homebrew', '/usr/local', '/usr'];

function rootsWithPrefix(env = process.env) {
  const roots = [...STABLE_ROOTS];
  if (env && env.PREFIX) roots.push(env.PREFIX);
  return roots;
}

// Candidati stabili per il BINARIO node. Almeno tre per costruzione —
// requisito del briefing: con uno solo «prova tutti i candidati» e «prova il
// primo» coincidono.
function nodeAliasCandidates(env = process.env) {
  const c = rootsWithPrefix(env).map((r) => path.join(r, 'bin', 'node'));
  return [...new Set(c)];
}

// Candidati stabili per l'ENTRY del pacchetto. Il suffisso dopo node_modules/
// (es. '@mmmbuto/nexuscrew/bin/nexuscrew.js') e' DERIVATO dal path che sta
// girando, non inventato: se il path non attraversa un node_modules (checkout
// di sviluppo) non ci sono candidati e il risolutore dichiarera' il path
// attuale — un checkout di sviluppo non scade, ma l'avviso e' il prezzo
// dell'onestà.
function entryAliasCandidates(entryPath, env = process.env) {
  if (!entryPath || typeof entryPath !== 'string') return [];
  const marker = `${path.sep}node_modules${path.sep}`;
  const i = entryPath.lastIndexOf(marker);
  if (i < 0) return [];
  const rel = entryPath.slice(i + marker.length);
  if (!rel) return [];
  const c = rootsWithPrefix(env).map((r) => path.join(r, 'lib', 'node_modules', rel));
  return [...new Set(c)];
}

// Risolutore: { path, alias, warning }.
//   alias    — il candidato scelto (realpath === realpath del path attuale),
//              oppure null se nessuno risolve allo stesso file;
//   path     — l'alias se trovato, altrimenti il path attuale intatto;
//   warning  — null se trovato, altrimenti la dichiarazione scritta.
// realpathImpl e' iniettabile per i test deterministici; di default
// fs.realpathSync. Un candidato assente si salta (realpath lancia): l'assenza
// non e' un errore, e' solo un candidato in meno.
function resolveStableAlias(currentPath, candidates, opts = {}) {
  const realpathImpl = typeof opts.realpath === 'function' ? opts.realpath : fs.realpathSync;
  let currentReal = null;
  try { currentReal = realpathImpl(currentPath); } catch (_) { currentReal = null; }
  for (const cand of Array.isArray(candidates) ? candidates : []) {
    let candReal;
    try { candReal = realpathImpl(cand); } catch (_) { continue; } // assente: avanti
    if (currentReal !== null && candReal === currentReal) {
      return { path: cand, alias: cand, warning: null };
    }
  }
  return {
    path: currentPath,
    alias: null,
    warning: `nessun alias stabile per ${currentPath}: il servizio punta al path attuale; se l'installazione cambia (upgrade/uninstall di node) il path scade — rilancia l'installazione per rigenerare il servizio`,
  };
}

// Composizione per il servizio di boot: risolve ENTRAMBI i path (node ed
// entry) e raccoglie le dichiarazioni. E' il punto che il flusso di
// installazione chiama alla SCRITTURA del servizio (vincolo 1: mai a ogni
// avvio). `env` e `realpath` iniettabili per test.
function resolveBootPaths({ nodeBin, entryPath, env = process.env, realpath } = {}) {
  const opts = {};
  if (typeof realpath === 'function') opts.realpath = realpath;
  const node = resolveStableAlias(nodeBin, nodeAliasCandidates(env), opts);
  const entry = resolveStableAlias(entryPath, entryAliasCandidates(entryPath, env), opts);
  return {
    nodeBin: node.path,
    entryPath: entry.path,
    warnings: [node.warning, entry.warning].filter((w) => w !== null),
  };
}

// da revisione: il runner dell'aggiornamento puo' girare con un process.execPath gia'
// MORTO su disco — l'upgrade di node (Homebrew) unlinka il Cellar vecchio
// mentre il processo resta in memoria, e npm reinstalla il pacchetto nel
// prefix del node NUOVO. In quel caso resolveBootPaths scriverebbe il path
// morto: il suo criterio e' «alias che realpath allo STESSO file», e un file
// morto non e' lo stesso file di nessuno. Il criterio qui e' diverso e
// dichiarato: un path VIVO — l'alias stabile dello stesso file quando
// l'attuale vive (R23 intatto), altrimenti il primo candidato stabile che
// ESISTE, con la dichiarazione; se non c'e' niente di vivo, il path resta e
// la dichiarazione dice di rilanciare init. `env`, `realpath` e `exists`
// iniettabili per test.
function resolveLiveBootPaths({ nodeBin, entryPath, env = process.env, realpath, exists } = {}) {
  const realpathImpl = typeof realpath === 'function' ? realpath : fs.realpathSync;
  const existsImpl = typeof exists === 'function' ? exists : fs.existsSync;
  const warnings = [];
  const revive = (current, candidates, what) => {
    try {
      realpathImpl(current);
      return null; // vivo: decide il criterio R23 di resolveBootPaths
    } catch (_) { /* morto su disco: cerca una alternativa viva */ }
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (existsImpl(candidate)) {
        warnings.push(
          `${what} ${current} non esiste piu' su disco; la definizione rigenerata punta al primo percorso stabile vivo ${candidate}`,
        );
        return candidate;
      }
    }
    warnings.push(
      `${what} ${current} non esiste piu' su disco e nessun percorso stabile e' installato; la definizione resta puntata lì — rilancia nexuscrew init`,
    );
    return current;
  };
  const revivedNode = revive(nodeBin, nodeAliasCandidates(env), 'il node del servizio');
  const revivedEntry = revive(entryPath, entryAliasCandidates(entryPath, env), "l'entry del servizio");
  const boot = resolveBootPaths({
    nodeBin: revivedNode || nodeBin,
    entryPath: revivedEntry || entryPath,
    env,
    realpath: realpathImpl,
  });
  return {
    nodeBin: boot.nodeBin,
    entryPath: boot.entryPath,
    warnings: [...warnings, ...boot.warnings],
  };
}

module.exports = {
  nodeAliasCandidates,
  entryAliasCandidates,
  resolveStableAlias,
  resolveBootPaths,
  resolveLiveBootPaths,
};
