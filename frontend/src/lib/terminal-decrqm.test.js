import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Il terminale nero delle celle ospitate dai telefoni (2026-10-14): la prima
// sequenza DECRQM (`CSI ? Ps $ p` / `CSI Ps $ p`) che arriva dal PTY lancia
// `ReferenceError: n is not defined` dentro `requestMode` di @xterm/xterm
// 6.0.0, e da lì il terminale non disegna più.
//
// Il difetto NON è nel sorgente pubblicato: `lib/xterm.mjs` contiene
// `let r;(P=>…)(r||={})`, legale. È la pipeline di build del repo (vite:
// transform + rollup + minify) a trasformarlo in `(void 0||(n={}))` — un
// assegnamento a una variabile dichiarata da nessuno, che in modulo strict
// (il bundle è ESM) lancia alla prima esecuzione. Per questo il test, per
// riprodurre «come lo usa il frontend», ricostruisce prima il bundle
// minificato con la STESSA pipeline (`vite build`), poi lo carica e ci scrive
// dentro le sequenze.
//
// jsdom non ha matchMedia e il renderer DOM di xterm lo chiede su open().
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = () => ({
    matches: false, media: '',
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const cacheRoot = join(here, '..', '..', 'node_modules', '.cache', 'nc-decrqm-bundle');
const artifactName = 'xterm-as-shipped.mjs';

// Il bundle si costruisce in un processo Node FIGLIO, non qui: esbuild (usato
// da vite) si rifiuta di girare dentro l'ambiente jsdom di vitest (invariante
// cross-realm di Uint8Array). Lo script è lo stesso utilizzabile a mano.
function buildXtermAsShipped() {
  const xtermVersion = JSON.parse(
    readFileSync(join(here, '..', '..', 'node_modules', '@xterm', 'xterm', 'package.json'), 'utf8'),
  ).version;
  const distFile = join(cacheRoot, xtermVersion, 'dist', artifactName);
  if (existsSync(distFile)) return { distFile, xtermVersion };
  rmSync(join(cacheRoot, xtermVersion), { recursive: true, force: true });
  const script = join(here, '..', '..', 'scripts', 'build-xterm-as-shipped.mjs');
  const run = spawnSync(process.execPath, [script, join(cacheRoot, xtermVersion)], { encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`build del bundle fallita:\n${run.stderr || run.stdout}`);
  }
  if (!existsSync(distFile)) throw new Error(`artifact non trovato dopo il build: ${distFile}`);
  return { distFile, xtermVersion };
}

// Il terminale come lo monta il componente: elemento nel DOM, focus, e poi
// l'input UTILE della tastiera. L'input utente non è un dettaglio: dopo un
// tasto, il write successivo con buffer vuoto viene processato in modo
// SINCRONO dentro term.write() (WriteBuffer.write → _innerWrite), che è
// esattamente la pila dell'errore in console (write ← onData ← onmessage).
function mountedTerm(TerminalCtor) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const term = new TerminalCtor({ allowProposedApi: true, cols: 20, rows: 4 });
  term.open(host);
  term.focus();
  const inputs = [];
  term.onData((d) => inputs.push(d));
  term.textarea.dispatchEvent(new window.KeyboardEvent('keydown', {
    key: 'a', code: 'KeyA', keyCode: 65, which: 65, bubbles: true, cancelable: true,
  }));
  return { term, host, inputs };
}

// Il write di un chunk del canale, con la callback di fine parse: se la
// pipeline del terminale si fosse inceppata, questa promise non risolve.
function writeChunk(term, text) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('write callback mai invocata: pipeline inceppata')), 2000);
    term.write(text, () => { clearTimeout(timer); resolve(undefined); });
  });
}

describe('DECRQM/requestMode — il terminale nero dopo la prima query di modo', () => {
  let MinifiedTerminal;
  let bundleSource;
  let xtermVersion;

  beforeAll(async () => {
    const { distFile, xtermVersion: v } = buildXtermAsShipped();
    xtermVersion = v;
    bundleSource = readFileSync(distFile, 'utf8');
    // La pipeline vite elimina lo statement `export` dal chunk (misurato): il
    // riferimento affidabile al costruttore è il global di retention che lo
    // script di build mette nel bundle.
    delete globalThis.__NC_XTERM_AS_SHIPPED__;
    await import(pathToFileURL(distFile).href);
    MinifiedTerminal = globalThis.__NC_XTERM_AS_SHIPPED__;
    expect(typeof MinifiedTerminal).toBe('function');
  });

  it('precondizione misurata: la pipeline di build del repo rompe requestMode', () => {
    // Tripwire: se questo rosso, @xterm/xterm ha smesso di produrre
    // l'assegnamento senza dichiarazione dopo il build — lo scudo resta
    // innocuo ma va rimosso con calma (e questo file aggiornato).
    expect(xtermVersion).toBe('6.0.0');
    // La DEFINIZIONE, non la prima chiamata di registrazione: la funzione è
    // `requestMode(a,b){`, le chiamate sono `this.requestMode(x,!0)`.
    const defAt = bundleSource.search(/requestMode\([a-z],[a-z]\)\{/);
    expect(defAt).toBeGreaterThanOrEqual(0);
    const around = bundleSource.slice(defAt, defAt + 300);
    expect(around).toMatch(/\(void 0\|\|\([a-z]=\{\}\)\)/);
  });

  it('senza scudo: la prima DECRQM lancia ReferenceError dentro requestMode', () => {
    const { term } = mountedTerm(MinifiedTerminal);
    try {
      let err = null;
      try { term.write('\x1b[?2026$p'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ReferenceError);
      expect(err.message).toMatch(/^[a-z]+ is not defined$/);
      expect(err.stack).toContain('requestMode');

      const ansi = mountedTerm(MinifiedTerminal);
      try {
        let err2 = null;
        try { ansi.term.write('\x1b[4$p'); } catch (e) { err2 = e; }
        expect(err2).toBeInstanceOf(ReferenceError);
        expect(err2.stack).toContain('requestMode');
      } finally { ansi.term.dispose(); ansi.host.remove(); }
    } finally { term.dispose(); }
  });

  it('con lo scudo del frontend: DECRQM non uccide il terminale e risponde DECRPM', async () => {
    // Il percorso è composto perche' vite:import-analysis risolverebbe un
    // letterale a tempo di raccolta: qui serve che la risoluzione avvenga a
    // runtime, cosi' il rosso pre-fix e' questo test, non tutta la suite.
    const shieldPath = '.' + '/terminal-decrqm' + '.js';
    const { shieldDecrqm } = await import(/* @vite-ignore */ shieldPath);
    const { term, host, inputs } = mountedTerm(MinifiedTerminal);
    const replies = [];
    shieldDecrqm(term, (d) => replies.push(d));
    try {
      // Ogni chunk aspetta la fine del parse: dopo il primo write l'input
      // utente è consumato e i successivi passano dal timer (write asincrono).
      await expect(writeChunk(term, '\x1b[?2026$p')).resolves.toBeUndefined();
      await expect(writeChunk(term, '\x1b[4$p')).resolves.toBeUndefined();
      // La risposta DECRPM passa dal canale di input (chi ha chiesto il modo
      // riceve una risposta, Pm=0 «modo non riconosciuto»), e NON dal buffer
      // del terminale: per questo si cerca tra le reply inviate.
      expect(replies).toEqual(['\x1b[?2026;0$y', '\x1b[4;0$y']);
      // La sequenza è ingoiata: nessun residuo nel buffer, sulla STESSA riga…
      const before = inputs.length;
      await writeChunk(term, 'prima\x1b[?2026$p dopo');
      expect(term.buffer.active.getLine(0).translateToString(true)).toContain('prima dopo');
      expect(replies).toEqual(['\x1b[?2026;0$y', '\x1b[4;0$y', '\x1b[?2026;0$y']);
      // …e la pipeline continua a vivere: un write successivo parseggia e chiude.
      await writeChunk(term, '\r\nfine');
      expect(term.buffer.active.getLine(1).translateToString(true)).toContain('fine');
      expect(inputs.length).toBe(before);
    } finally { term.dispose(); host.remove(); }
  });

  it('safeTermWrite: un eccezione del parser non risale al canale, ma viene loggata', async () => {
    const { safeTermWrite } = await import(/* @vite-ignore */ '.' + '/terminal-decrqm' + '.js');
    const boom = { write: () => { throw new Error('parser esploso'); } };
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
      expect(() => safeTermWrite(boom, 'x')).not.toThrow();
    } finally { console.error = original; }
    expect(errors.length).toBe(1);
    // Il motivo resta visibile: «senza nascondere l'errore».
    expect(String(errors[0][1])).toContain('parser esploso');
  });
});
