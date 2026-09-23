'use strict';
// Il desktop grafico come servizio GOVERNATO: un container con nome fisso
// (`ai-desktop`, lo stesso che l'engine desktop.local esegue con docker exec)
// e un pannello web su porta propria (KasmVNC). La spunta in Impostazioni
// decide se esiste come funzione della UI: ON → il container gira e il tasto
// appare; OFF → il container si ferma e il pannello esce da ogni superficie.
//
// Contratti:
//   - DOCKER SENZA SHELL: execFile con argomenti vettore, nome del container
//     COSTANTE (mai stringhe costruite da input), timeout, esito sempre
//     riportato {ok, error}. Il binario e' 'docker' salvo override esplicito
//     (per i test: un finto binario via `dockerBin`, mai un docker vero).
//   - LA CHIAVE COMANDA, IL DEFAULT SI DERIVA: `aiDesktop` esplicita in
//     config.json vince sempre; se assente, `chiaveEsplicita` risponde null e
//     il chiamante deriva dal container (running → true) DOVE ha senso —
//     nelle impostazioni, in una chiamata esplicita. MAI nel percorso caldo
//     del fleetStatus: li' conta solo la chiave esplicita (false taglia il
//     pannello del desktop; assente = comportamento di sempre, nessuno perde
//     un tasto senza aver mai toccato la spunta).
//   - IL PANNELLO DEL DESKTOP si riconosce dalla porta (KasmVNC 6901): e' la
//     porta che l'engine desktop.local precompila e la sola cosa che il
//     pannello del container e un altro pannello hanno di diverso.

const { execFile } = require('node:child_process');
const { readConfigJson, configJsonPath } = require('../config.js');

const CONTAINER = 'ai-desktop';
const PANEL_PORT = 6901;
const TIMEOUT_MS = 15_000;
// La config e' piccola ma il chiamante caldo (cellStatus) gira a ogni giro di
// polling: un mtime guard evita di riparsare il file ad ogni lettura.
const CACHE_MS = 3000;
let cacheConfig = null; // {path, mtimeMs, valore}

function leggiConfig(pathConfig = configJsonPath()) {
  if (pathConfig) {
    try {
      const mtime = require('node:fs').statSync(pathConfig).mtimeMs;
      if (cacheConfig && cacheConfig.path === pathConfig && cacheConfig.mtimeMs === mtime) {
        return cacheConfig.valore;
      }
      const valore = readConfigJson(pathConfig) || {};
      cacheConfig = { path: pathConfig, mtimeMs: mtime, valore };
      return valore;
    } catch (_) { /* config assente o illeggibile: come assente */ }
  }
  return {};
}

// La chiave esplicita: true/false quando l'utente ha toccato la spunta,
// null quando non l'ha mai toccata (il chiamante deriva o non taglia).
function chiaveEsplicita(config) {
  if (!config || typeof config !== 'object') return null;
  return typeof config.aiDesktop === 'boolean' ? config.aiDesktop : null;
}

function leggiChiave(pathConfig = configJsonPath()) {
  return chiaveEsplicita(leggiConfig(pathConfig));
}

// Il pannello del desktop: porta KasmVNC del container, nessun altro caso.
function isDesktopPanelUrl(url) {
  try {
    return Number(new URL(String(url)).port) === PANEL_PORT;
  } catch (_) { return false; }
}

// Il taglio nel percorso caldo: SOLO la chiave esplicita false nasconde il
// pannello del desktop. Chiave assente o true: il pannello passa come sempre —
// una lettura di docker qui sarebbe una dipendenza nuova su un percorso a poll,
// la classe di difetto gia' scartata per l'engine (builtin.js).
function pubblicaPanelUrl(url, config) {
  const urlClean = typeof url === 'string' ? url.trim() : '';
  if (!urlClean) return '';
  if (chiaveEsplicita(config) === false && isDesktopPanelUrl(urlClean)) return '';
  return urlClean;
}

// Variante per il chiamante caldo (cellStatus): la config arriva dal guard su
// mtime (cache interna), non da una lettura per cella né da un probe docker.
function pubblicaPanelUrlCaldo(url) {
  return pubblicaPanelUrl(url, leggiConfig());
}

// Docker senza shell: execFile vettoriale, timeout, esito mai lanciato.
function eseguiDocker(args, opts = {}) {
  const bin = opts.dockerBin || 'docker';
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout ?? TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timeout: !!(err && err.killed),
      });
    });
  });
}

// Il container esiste e gira? `docker inspect` risponde anche da fermo; se
// non risponde proprio, il container e' assente (o docker lo nega): in tutti
// i casi `running:false` con la causa, mai un lancio.
async function containerRunning(opts = {}) {
  const r = await eseguiDocker(['inspect', '-f', '{{.State.Running}}', CONTAINER], opts);
  if (!r.ok) return { running: false, exists: false, error: r.stderr.trim() || 'container non ispezionabile' };
  return { running: r.stdout.trim() === 'true', exists: true };
}

async function avvia(opts = {}) {
  const r = await eseguiDocker(['start', CONTAINER], opts);
  return r.ok ? { ok: true, running: true } : { ok: false, running: false, error: r.stderr.trim() || 'start fallito', timeout: r.timeout };
}

async function ferma(opts = {}) {
  const r = await eseguiDocker(['stop', CONTAINER], opts);
  return r.ok ? { ok: true, running: false } : { ok: false, running: null, error: r.stderr.trim() || 'stop fallito', timeout: r.timeout };
}

module.exports = {
  CONTAINER, PANEL_PORT, TIMEOUT_MS,
  chiaveEsplicita, leggiChiave, leggiConfig, isDesktopPanelUrl, pubblicaPanelUrl, pubblicaPanelUrlCaldo,
  containerRunning, avvia, ferma,
};
