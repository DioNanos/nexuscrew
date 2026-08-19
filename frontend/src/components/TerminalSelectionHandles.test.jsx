// R25 — le due maniglie della selezione: vista pura sopra la selezione di
// xterm. Questi test provano il cablaggio (maniglie ai due capi, drag che
// muove l'estremita' giusta, no-crossing, edge-scroll, sopravvivenza al
// redraw, testo sovrascritto segnalato). La geometria e la policy pure stanno
// in selection-handles.test.js.
//
// LIMITE DICHIARATO: jsdom non prova il pointer capture ne' il feel del touch
// reale (copertura del dito, presa della maniglia): la prova finale e' il
// dito di chi lo usa su un telefono vero.
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ instances: [] }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      this.textarea = document.createElement('textarea');
      this.options = {}; this.cols = 80; this.rows = 24;
      this.lineTexts = new Map(); this.getLineCalls = [];
      // R25-zoom rev4: celle per glifi larghi (getWidth 2/0) e testo per cella.
      this.cellMaps = new Map();
      const self = this;
      this.buffer = { active: {
        viewportY: 0, baseY: 100, type: 'normal',
        // Fedele all'API pubblica di xterm: getLine(y) → riga del buffer,
        // translateToString(trimRight, startColumn, endColumn) ne da' il testo
        // per COLONNE (i test mockano righe ASCII: slice per colonne e' fedele).
        getLine(y) {
          self.getLineCalls.push(y);
          return {
            translateToString: (trimRight, startColumn, endColumn) => {
              const text = self.lineTexts.get(y) ?? '';
              let out = text;
              if (Number.isInteger(startColumn) && Number.isInteger(endColumn)) {
                out = text.slice(startColumn, endColumn);
              }
              return trimRight ? out.replace(/\s+$/, '') : out;
            },
            // R25-zoom rev4: API pubblica di xterm per la parola e lo snap
            // wide. Default: 1 char per cella, larghezza 1; i test wide
            // impostano cellMaps (chars + widths per riga).
            getCell(col) {
              const map = self.cellMaps?.get(y);
              if (map) {
                return {
                  getChars: () => map.chars[col] ?? '',
                  getWidth: () => map.widths[col] ?? 1,
                };
              }
              const text = self.lineTexts.get(y) ?? '';
              return { getChars: () => text[col] ?? '', getWidth: () => 1 };
            },
          };
        },
      } };
      this.selectCalls = []; this.scrollLinesCalls = [];
      this.selectionText = ''; this.selectionPosition = null;
      this.parser = { registerCsiHandler: () => ({ dispose() {} }), registerEscHandler: () => ({ dispose() {} }) };
      this.modes = { mouseTrackingMode: 'none' };
      fixture.instances.push(this);
    }
    loadAddon() {}
    open(host) { host.appendChild(this.textarea); }
    focus() {}
    onData() { return { dispose() {} }; }
    onSelectionChange(cb) { this.selectionCb = cb; return { dispose() {} }; }
    onRender(cb) { this.renderCb = cb; return { dispose() {} }; }
    onScroll(cb) { this.scrollCb = cb; return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    emitSelection() { if (this.selectionCb) this.selectionCb(); }
    // select() spara onSelectionChange come l'xterm vero: le maniglie si
    // aggiornano perche' lo dice xterm, non perche' le richiamiamo noi.
    select(col, row, length) {
      this.selectCalls.push({ col, row, length });
      const endLinear = row * this.cols + col + length - 1;
      this.selectionPosition = {
        start: { x: col, y: row },
        end: { x: endLinear % this.cols, y: Math.floor(endLinear / this.cols) },
      };
      this.selectionText = `testo-${row}-${col}-${length}`;
      for (let y = row; y <= Math.floor((row * this.cols + col + length - 1) / this.cols); y++) {
        this.lineTexts.set(y, `contenuto-riga-${y}`);
      }
      this.emitSelection();
    }
    getSelection() { return this.selectionText; }
    getSelectionPosition() { return this.selectionPosition; }
    hasSelection() { return !!this.selectionText; }
    clearSelection() { this.selectionText = ''; this.selectionPosition = null; this.emitSelection(); }
    scrollLines(n) {
      this.scrollLinesCalls.push(n);
      const max = Math.max(0, this.buffer.active.baseY + this.rows - 1 - this.rows + 1);
      this.buffer.active.viewportY = Math.max(0, Math.min(max, this.buffer.active.viewportY + n));
      if (this.scrollCb) this.scrollCb(n);
    }
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('../lib/ws-client.js', () => ({
  openTerminalSocket: () => ({
    sendInput: () => true, action() {}, resize() {}, focus() {}, isReady: () => true, close() {},
  }),
}));
vi.mock('../lib/clipboard.js', () => ({ copyText: async () => true }));

import Terminal from './Terminal.jsx';

const stableRefs = {
  sendRef: { current: null }, composerRef: { current: null },
  actionRef: { current: null }, ctrlRef: { current: false },
};

function renderTerminal() {
  return render(<Terminal session="cloud-Dev" token="t" {...stableRefs} />);
}

// 800×480 → cella 10×20 px (80 col, 24 righe), stessa convenzione degli altri
// test del terminale.
function terminalBounds(host, width = 800, height = 480) {
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {},
  });
}

function handles(view) {
  return {
    start: view.container.querySelector('.nc-sel-handle.start'),
    end: view.container.querySelector('.nc-sel-handle.end'),
  };
}

// jsdom non ha il costruttore PointerEvent (i browser veri si'): senza, gli
// eventi di test arriverebbero senza clientX/clientY. Polifilla locale.
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, params = {}) {
      super(type, params);
      this.pointerType = params.pointerType || '';
      this.pointerId = params.pointerId || 0;
    }
  };
}

beforeEach(() => { fixture.instances.length = 0; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('R34 — origine della selezione, osservabile (pezzo 1)', () => {
  it('il touch marca data-selection-origin="touch" fin dal touchstart', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 200 }] });
    expect(host.dataset.selectionOrigin).toBe('touch');
    act(() => vi.advanceTimersByTime(450)); // long-press: selezione a parola
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 50, clientY: 200 }] });
    expect(host.dataset.selectionOrigin).toBe('touch');
  });

  it('il mousedown marca "mouse"; la selezione cancellata azzera l\'origine', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    const term = fixture.instances[0];
    fireEvent.mouseDown(host);
    expect(host.dataset.selectionOrigin).toBe('mouse');
    act(() => term.select(2, 1, 10));
    expect(host.dataset.selectionOrigin).toBe('mouse');
    act(() => term.clearSelection());
    expect(host.dataset.selectionOrigin).toBe('');
  });

  it('il mousedown SINTETICO dopo un touch non ruba l\'origine (ghost-click guard)', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 200 }] });
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 50, clientY: 200 }] });
    // Chrome spara un mousedown compat subito dopo il touchend non prevenuto:
    // NON deve cambiare l'origine.
    fireEvent.mouseDown(host);
    expect(host.dataset.selectionOrigin).toBe('touch');
    // Passato il margine, un mousedown e' un mouse vero.
    act(() => vi.advanceTimersByTime(800));
    fireEvent.mouseDown(host);
    expect(host.dataset.selectionOrigin).toBe('mouse');
  });
});

describe('R34 — desktop: maniglie e lente solo se il gesto e\' touch (pezzo 2)', () => {
  it('selezione nata dal MOUSE: niente maniglie, niente barra zoom; la barra strumenti resta', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    const term = fixture.instances[0];
    fireEvent.mouseDown(host); // drag nativo: origine mouse
    act(() => term.select(2, 1, 10));
    expect(handles(view).start).toBeNull();
    expect(handles(view).end).toBeNull();
    expect(view.container.querySelector('.nc-zoom-bubble')).toBeNull();
    expect(view.container.querySelector('.nc-selection-tools')).toBeTruthy(); // la copia resta
  });

  it('selezione nata dal TOCCO (long-press): maniglie presenti', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 200 }] });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 50, clientY: 200 }] });
    expect(handles(view).start).toBeTruthy();
    expect(handles(view).end).toBeTruthy();
  });

  it('origine ignota (select programmatico): maniglie presenti — conservativo touch', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    expect(handles(view).start).toBeTruthy();
  });
});

describe('R34 — Shift+click estende la selezione (pezzo 2)', () => {
  it('Shift+click DOPO la fine, senza drag: sposta end (e non cancella)', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // start (1,2), end (1,11)
    // (300,20) → col 30, riga 1.
    fireEvent.mouseDown(host, { shiftKey: true, clientX: 300, clientY: 20 });
    fireEvent.mouseUp(host, { shiftKey: true, clientX: 300, clientY: 20 });
    expect(term.selectCalls.at(-1)).toEqual({ col: 2, row: 1, length: 30 - 2 + 1 });
    expect(term.hasSelection()).toBe(true);
  });

  it('Shift+click PRIMA dell\'inizio, senza drag: sposta start', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    // (10,20) → col 1, riga 1.
    fireEvent.mouseDown(host, { shiftKey: true, clientX: 10, clientY: 20 });
    fireEvent.mouseUp(host, { shiftKey: true, clientX: 10, clientY: 20 });
    expect(term.selectCalls.at(-1)).toEqual({ col: 1, row: 1, length: 11 - 1 + 1 });
  });

  it('Shift+click+DRAG: apre una selezione NUOVA (non estende la vecchia)', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // selezione preesistente (1,2)-(1,11)
    fireEvent.mouseDown(host, { shiftKey: true, clientX: 300, clientY: 20 }); // col 30, riga 1
    fireEvent.mouseMove(host, { shiftKey: true, clientX: 400, clientY: 60 });  // col 40, riga 3
    fireEvent.mouseUp(host, { shiftKey: true, clientX: 400, clientY: 60 });
    expect(term.selectCalls.at(-1)).toEqual({ col: 30, row: 1, length: (3 * 80 + 40) - (1 * 80 + 30) + 1 });
  });

  it('Shift+click senza selezione attiva e senza drag: nessuna selezione (come oggi)', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    const term = fixture.instances[0];
    fireEvent.mouseDown(host, { shiftKey: true, clientX: 300, clientY: 20 });
    fireEvent.mouseUp(host, { shiftKey: true, clientX: 300, clientY: 20 });
    expect(term.hasSelection()).toBe(false);
    expect(term.selectCalls.length).toBe(0);
  });
});

describe('R34 — doppio clic: la tastiera e\' un gesto touch (pezzo 2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('su DESKTOP il dblclick NON chiede la tastiera (la parola la seleziona xterm)', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    expect(term.textarea.getAttribute('inputmode')).toBe('none'); // double-tap bloccato a montaggio
    fireEvent.doubleClick(host);
    expect(term.textarea.getAttribute('inputmode')).toBe('none');
  });

  it('fuori desktop il dblclick chiede la tastiera come oggi', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    fireEvent.doubleClick(host);
    expect(term.textarea.getAttribute('inputmode')).toBe('text');
  });
});

describe('R25 — maniglie: vista pura sopra la selezione xterm', () => {
  it('due maniglie ai due capi quando la selezione esiste, e restano dopo il gesto', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    const term = fixture.instances[0];
    // Riga 1, col 2..11.
    act(() => term.select(2, 1, 10));
    const h = handles(view);
    expect(h.start).toBeTruthy(); expect(h.end).toBeTruthy();
    // start SULLA prima cella, end UNA CELLA OLTRE l'ultima; entrambe pendono
    // sotto il punto (top = (riga+1) * 20).
    expect(h.start.style.left).toBe('20px');
    expect(h.start.style.top).toBe('40px');
    expect(h.end.style.left).toBe('120px');
    expect(h.end.style.top).toBe('40px');
  });

  it('le maniglie compaiono anche col gesto vero: long-press touch', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 200 }] });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 50, clientY: 200 }] });
    // Il gesto e' finito, le maniglie RESTANO (il caret invece sparisce).
    expect(view.container.querySelector('.nc-touch-selection-caret')).toBeNull();
    expect(handles(view).start).toBeTruthy();
    expect(handles(view).end).toBeTruthy();
  });

  it('nessuna selezione → nessuna maniglia; xterm svuota → spariscono', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    expect(handles(view).start).toBeNull();
    act(() => term.select(2, 1, 10));
    expect(handles(view).start).toBeTruthy();
    act(() => term.clearSelection());
    expect(handles(view).start).toBeNull();
    expect(handles(view).end).toBeNull();
  });
});

describe('R25 — drag delle maniglie', () => {
  function grabEnd(view, term) {
    act(() => term.select(2, 1, 10)); // riga 1, col 2..11
    const h = handles(view);
    // Presa esattamente sull'ancora: offset zero, il movimento e' 1:1.
    fireEvent.pointerDown(h.end, { clientX: 120, clientY: 40, pointerType: 'mouse' });
    return h;
  }

  it('il mouse trascina la estremita end e la selezione si estende', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    grabEnd(view, term);
    // (200, 40): col 20, riga visibile 2 → riga buffer 2.
    fireEvent.pointerMove(window, { clientX: 200, clientY: 40, pointerType: 'mouse' });
    const last = term.selectCalls.at(-1);
    expect(last).toEqual({ col: 2, row: 1, length: (2 * 80 + 20) - (1 * 80 + 2) + 1 });
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
  });

  it('dopo il rilascio il drag non risponde piu\'', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    grabEnd(view, term);
    fireEvent.pointerMove(window, { clientX: 200, clientY: 40, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
    const calls = term.selectCalls.length;
    fireEvent.pointerMove(window, { clientX: 300, clientY: 60, pointerType: 'mouse' });
    expect(term.selectCalls.length).toBe(calls);
  });

  it('le maniglie NON si incrociano: start trascinato oltre end si ferma su end', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // start (1,2), end (1,11)
    fireEvent.pointerDown(handles(view).start, { clientX: 20, clientY: 40, pointerType: 'mouse' });
    // (300, 100) → col 30, riga 5: ben oltre end.
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100, pointerType: 'mouse' });
    expect(term.selectCalls.at(-1)).toEqual({ col: 11, row: 1, length: 1 });
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
  });

  it('il touch usa uno scarto costante verso l\'alto: la cella di lavoro sta una frazione di riga sopra il dito', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    grabEnd(view, term);
    // Dito a y=200 (riga 10). Scarto R35: -0.3 * altezza maniglia (in jsdom la
    // maniglia non e' misurabile → fallback altezza riga = 20px → -6px):
    // cella di lavoro = riga 9, una frazione sopra il dito, MAI sotto.
    fireEvent.pointerMove(window, { clientX: 100, clientY: 200, pointerType: 'touch' });
    const last = term.selectCalls.at(-1);
    const endRow = Math.floor((1 * 80 + 2 + last.length - 1) / 80);
    expect(endRow).toBe(9);
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });
});

describe('R35 — scarto verticale del drag touch', () => {
  // R35 pezzo 1: lo scarto ±2 righe INVERTE vicino al bordo alto (righe 0-1:
  // +2, oltre: -2). Con l'inversione, attraversare la soglia con il dito fa
  // saltare la cella di lavoro di 3-4 righe per pochi pixel: e' lo scatto che
  // la mano sente. La guardia misura la CONTINUITA' (2px di dito non possono
  // valere 3 righe di selezione), non la formula dello scarto.
  it('la cella di lavoro varia con continuita\' alla soglia del bordo alto', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    // Selezione in riga 0: la end trascinata puo' scendere senza incrociare
    // start, cosi' il clamp no-crossing non maschera il salto.
    act(() => term.select(2, 0, 10)); // start (0,2), end (0,11), ancora end a y=20
    const h = handles(view);
    fireEvent.pointerDown(h.end, { clientX: 120, clientY: 20, pointerType: 'mouse' });
    // Dito a y=41 (riga 2, oltre la soglia) e a y=39 (riga 1, sotto): 2px di
    // differenza. La cella di lavoro non puo' cambiare piu' di 1 riga.
    fireEvent.pointerMove(window, { clientX: 100, clientY: 41, pointerType: 'touch' });
    const above = term.selectCalls.at(-1);
    fireEvent.pointerMove(window, { clientX: 100, clientY: 39, pointerType: 'touch' });
    const below = term.selectCalls.at(-1);
    fireEvent.pointerUp(window, { pointerType: 'touch' });
    const rowOf = (call) => Math.floor((0 * 80 + 2 + call.length - 1) / 80);
    expect(Math.abs(rowOf(below) - rowOf(above))).toBeLessThanOrEqual(1);
  });
});

describe('R35 — specchiatura ai margini laterali', () => {
  // Termux (HandleView:205-238): se la maniglia uscirebbe dal schermo cambia
  // VERSO, e il punto di selezione NON SI MUOVE — cambia solo da che parte
  // pende il corpo. Da noi il clip e' il rettangolo di .xterm-screen (nel
  // fixture: 80 colonne * 10px = 800px). La guardia misura le due cose
  // insieme: la classe flip (il corpo pende dall'altra parte) E l'ancora
  // ferma al pixel.
  it('la start alla colonna 0 si specchia: corpo a destra, punto fermo a 0px', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(0, 1, 10)); // start (1,0) → x=0; end (1,10), libera
    const h = handles(view);
    expect(h.start.className).toMatch(/\bflip\b/);
    expect(h.start.style.left).toBe('0px'); // il punto di selezione non si muove
    expect(h.end.className).not.toMatch(/\bflip\b/); // l'altra resta dritta
  });

  it('la end all\'ultima colonna si specchia: corpo a sinistra, punto fermo a 800px', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(70, 1, 10)); // end (1,79) → x=80*10=800=larghezza schermo
    const h = handles(view);
    expect(h.end.className).toMatch(/\bflip\b/);
    expect(h.end.style.left).toBe('800px');
    expect(h.start.className).not.toMatch(/\bflip\b/); // start a col 70, libera
  });

  it('selezione in mezzo allo schermo: nessuna maniglia si specchia', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(30, 1, 10)); // start col 30, end col 40: interno
    const h = handles(view);
    expect(h.start.className).not.toMatch(/\bflip\b/);
    expect(h.end.className).not.toMatch(/\bflip\b/);
  });
});

describe('R35 — throttle del cambio di verso durante il drag', () => {
  // Termux (HandleView:210-215): durante il drag il cambio di orientamento
  // avviene al massimo ogni 50ms, altrimenti al confine la maniglia
  // sfarfalla avanti e indietro. Fuori dal drag la geometria comanda sempre.
  it('il flip non oscilla: entro 50ms il verso resta, poi puo\' cambiare', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(30, 1, 10)); // start col 30, end col 40: interno
    fireEvent.pointerDown(handles(view).end, { clientX: 410, clientY: 40, pointerType: 'touch' });
    // Drag verso l'ultima colonna (y=44 → riga 1 con lo scarto touch: la end
    // resta oltre start e il no-crossing non la ferma): il corpo uscirebbe → flip ON.
    fireEvent.pointerMove(window, { clientX: 795, clientY: 44, pointerType: 'touch' });
    expect(handles(view).end.className).toMatch(/\bflip\b/);
    // Subito dopo (< 50ms, timer non avanzati) il dito rientra: la geometria
    // direbbe flip OFF, ma il verso NON cambia — niente sfarfallio.
    fireEvent.pointerMove(window, { clientX: 410, clientY: 44, pointerType: 'touch' });
    expect(handles(view).end.className).toMatch(/\bflip\b/);
    // Passati i 50ms, il verso segue di nuovo la geometria.
    act(() => vi.advanceTimersByTime(60));
    fireEvent.pointerMove(window, { clientX: 390, clientY: 44, pointerType: 'touch' });
    expect(handles(view).end.className).not.toMatch(/\bflip\b/);
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });
});

describe('R25 — edge-scroll: il dito oltre il bordo estende la selezione', () => {
  it('trascinando start sul bordo alto il terminale scorre e la selezione cresce', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.buffer.active.viewportY = 5; // meta' dello scrollback
    act(() => term.select(2, 7, 10)); // start riga buffer 7, visibile 2
    // Presa sull'ancora della maniglia start: left 2*10, top (7+1)*20 = 160.
    fireEvent.pointerDown(handles(view).start, { clientX: 20, clientY: 160, pointerType: 'mouse' });
    // y=10 → riga visibile 0 → la maniglia e' sul bordo: parte lo scroll.
    fireEvent.pointerMove(window, { clientX: 20, clientY: 10, pointerType: 'mouse' });
    const before = term.selectCalls.at(-1);
    act(() => vi.advanceTimersByTime(130 * 3));
    expect(term.scrollLinesCalls.filter((n) => n === -1).length).toBeGreaterThanOrEqual(3);
    const after = term.selectCalls.at(-1);
    // La selezione si e' estesa verso il piu' vecchio: stessa fine, inizio anticipato.
    expect(after.row).toBeLessThan(before.row);
    expect(after.length).toBeGreaterThan(before.length);
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
    const calls = term.scrollLinesCalls.length;
    act(() => vi.advanceTimersByTime(130 * 3));
    expect(term.scrollLinesCalls.length).toBe(calls); // rilasciato: lo scroll si ferma
  });

  it('sull\'ALTERNATE buffer niente edge-scroll: lo scroll e\' dell\'app', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.buffer.active.type = 'alternate';
    term.buffer.active.viewportY = 5;
    act(() => term.select(2, 7, 10));
    fireEvent.pointerDown(handles(view).start, { clientX: 20, clientY: 160, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 10, pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(130 * 3));
    expect(term.scrollLinesCalls.length).toBe(0);
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
  });
});

describe('R25 — sopravvivenza al redraw e testo sovrascritto', () => {
  it('le maniglie si ri-derivano quando il viewport si muove (nessun pixel ricordato)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 10, 10)); // riga buffer 10 → top (10+1)*20 = 220
    expect(handles(view).start.style.top).toBe('220px');
    term.buffer.active.viewportY = 5;
    act(() => term.scrollCb(1));
    // Riga visibile ora 5 → top (5+1)*20 = 120: la maniglia ha seguito il
    // range, non e' rimasta al vecchio pixel.
    expect(handles(view).start.style.top).toBe('120px');
  });

  it('le maniglie si ri-derivano anche al solo redraw (onRender)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 10, 10));
    expect(handles(view).start.style.top).toBe('220px');
    term.buffer.active.viewportY = 8;
    act(() => term.renderCb && term.renderCb({ start: 0, end: 23 }));
    expect(handles(view).start.style.top).toBe('60px'); // (10-8+1)*20
  });

  it('se il testo SOTTO la selezione viene sovrascritto, si dice', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // snapshot per riga: riga buffer 1
    expect(view.container.querySelector('.nc-selection-changed')).toBeNull();
    // L'app riscrive la riga: la selezione (range) non cambia, il contenuto
    // si'. Il render passa proprio quella riga (viewport 0 + riga 1).
    term.lineTexts.set(1, 'NUOVO-testo-sotto');
    act(() => term.renderCb && term.renderCb({ start: 1, end: 1 }));
    expect(view.container.querySelector('.nc-selection-changed')).toBeTruthy();
    // Un gesto nuovo resetta: chi riseleziona sa cosa sta copiando.
    act(() => term.select(2, 1, 10));
    expect(view.container.querySelector('.nc-selection-changed')).toBeNull();
  });

  it('l\'output FUORI dalla selezione non la rilegge nemmeno: il confronto resta O(intersezione)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // selezione sulla riga buffer 1
    const lettureDopoSnapshot = term.getLineCalls.length;
    // L'app produce output sulla riga 5: renderizzata SOLO lei.
    term.lineTexts.set(5, 'output-altrove');
    act(() => term.renderCb && term.renderCb({ start: 5, end: 5 }));
    expect(view.container.querySelector('.nc-selection-changed')).toBeNull();
    // La selezione non e' stata riletta per il confronto; l'unica lettura in
    // piu' e' la riga della BARRA ZOOM (R25-zoom), che a ogni battito rilegge
    // dal buffer la riga della maniglia in focus: UNA riga fissa, non una per
    // riga selezionata — il confronto resta O(intersezione) + 1.
    expect(term.getLineCalls.length).toBe(lettureDopoSnapshot + 1);
  });
});

describe('R25-zoom rev3-audit — drag su selezione nativa INVERTITA preesistente', () => {
  it('end tirata verso l\'esterno: la maniglia si muove e il lato opposto (col 3) non sparisce', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    // selezione nativa invertita (start>end), NESSUN term.select intermedio:
    // e' il caso in cui applyHandlePoint rileggeva il range grezzo.
    term.selectionPosition = { start: { x: 6, y: 1 }, end: { x: 3, y: 1 } };
    term.selectionText = 'invertita';
    act(() => term.emitSelection());
    // selRange normalizzato (rev3): start (1,3) → 30px, end (1,6) → 70px.
    const h = handles(view);
    fireEvent.pointerDown(h.end, { clientX: 70, clientY: 40, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 40, pointerType: 'mouse' });
    const last = term.selectCalls.at(-1);
    const endLinear = last.row * 80 + last.col + last.length - 1;
    expect(last.col).toBe(3);        // il lato opposto resta: parte da col 3
    expect(endLinear % 80).toBe(20); // la end si e' mossa fino a col 20
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
  });

  it('end tirata verso l\'interno: la maniglia si muove invece di congelarsi', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.selectionPosition = { start: { x: 6, y: 1 }, end: { x: 3, y: 1 } };
    term.selectionText = 'invertita';
    act(() => term.emitSelection());
    const h = handles(view);
    fireEvent.pointerDown(h.end, { clientX: 70, clientY: 40, pointerType: 'mouse' });
    // (30, 20) → riga 1, col 3: la end raggiunge l'ancora (col 3) e la
    // selezione si accorcia a una cella. Col range grezzo si clampava a
    // col 6: congelata.
    fireEvent.pointerMove(window, { clientX: 30, clientY: 20, pointerType: 'mouse' });
    const last = term.selectCalls.at(-1);
    const endLinear = last.row * 80 + last.col + last.length - 1;
    expect(endLinear % 80).toBe(3);
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
  });
});

describe('R25-zoom rev5 — liveness: il drag non risuscita una selezione cancellata', () => {
  it('selezione cancellata a meta\' drag: il pointermove NON la fa ricomparire', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    const h = handles(view);
    fireEvent.pointerDown(h.end, { clientX: 120, clientY: 40, pointerType: 'mouse' });
    // xterm azzera la selezione (resize di righe / trim oltre il top):
    // onSelectionChange porta null e il gesto deve chiudersi.
    act(() => term.clearSelection());
    const calls = term.selectCalls.length;
    fireEvent.pointerMove(window, { clientX: 200, clientY: 40, pointerType: 'mouse' });
    expect(term.selectCalls.length).toBe(calls); // nessuna select nuova
    expect(term.hasSelection()).toBe(false);
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
  });
});

describe('R25-zoom rev4 — selezione come Termux (punto esatto, parola, glifi larghi)', () => {
  function longPressAt(view, x, y) {
    const host = view.container.querySelector('.nc-terminal-host');
    fireEvent.touchStart(host, { touches: [{ clientX: x, clientY: y }] });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: x, clientY: y }] });
  }

  it('long-press: la selezione comincia alla riga premuta, non due righe sopra (rev4 #1)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    // y=200 → riga visibile 10 (viewport 0). Oggi l'offset -2 la porta a 8.
    longPressAt(view, 50, 200);
    expect(term.selectCalls.at(-1).row).toBe(10);
  });

  it('long-press su una parola: selezionata la parola intera (rev4 #2)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.lineTexts.set(10, 'ciao mondo');
    // x=65 → col 6, dentro 'mondo' (col 5..9).
    longPressAt(view, 65, 200);
    expect(term.selectCalls.at(-1)).toEqual({ col: 5, row: 10, length: 5 });
  });

  it('long-press su uno spazio: resta una cella (rev4 #2)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.lineTexts.set(10, 'ciao mondo');
    // x=45 → col 4, lo spazio fra le due parole.
    longPressAt(view, 45, 200);
    expect(term.selectCalls.at(-1)).toEqual({ col: 4, row: 10, length: 1 });
  });

  it('maniglia end trascinata dentro un glifo doppio (界): finisce al bordo destro, mai a meta\' (rev4 #3)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // end (1,11)
    term.cellMaps.set(8, {
      chars: ['a', '界', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      widths: [1, 2, 0, 1, 1, 1, 1, 1, 1, 1],
    });
    fireEvent.pointerDown(handles(view).end, { clientX: 120, clientY: 40, pointerType: 'mouse' });
    // (25, 180): col 2 = cella di continuazione del glifo; scarto touch R35
    // (-6px nel fixture) → riga di lavoro 8, dove sta il glifo.
    fireEvent.pointerMove(window, { clientX: 25, clientY: 180, pointerType: 'touch' });
    const last = term.selectCalls.at(-1);
    const endLinear = last.row * 80 + last.col + last.length - 1;
    expect(endLinear % 80).toBe(3); // bordo destro del glifo, non la continuazione
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('maniglia start trascinata dentro un glifo doppio (emoji): finisce al bordo sinistro (rev4 #3)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // start (1,2)
    // Il glifo largo sta sulla riga 0: la maniglia start va trascinata PRIMA
    // di end (il no-crossing la fermerebbe su end, non sullo snap).
    term.cellMaps.set(0, {
      chars: ['a', '😀', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      widths: [1, 2, 0, 1, 1, 1, 1, 1, 1, 1],
    });
    fireEvent.pointerDown(handles(view).start, { clientX: 20, clientY: 40, pointerType: 'mouse' });
    // (25, 20): col 2 = continuazione; scarto touch R35 (-6px nel fixture,
    // 20-6=14) → riga di lavoro 0, dove sta il glifo.
    fireEvent.pointerMove(window, { clientX: 25, clientY: 20, pointerType: 'touch' });
    const last = term.selectCalls.at(-1);
    expect(last.col).toBe(1); // bordo sinistro del glifo, non la continuazione
    expect(last.row).toBe(0);
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('long-press a meta\' di un glifo doppio: il punto iniziale va al bordo del glifo (rev4 #3)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.cellMaps.set(10, {
      chars: ['a', '界', '', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      widths: [1, 2, 0, 1, 1, 1, 1, 1, 1, 1],
    });
    // x=25 → col 2 = continuazione: snap al bordo sinistro (col 1), poi parola.
    longPressAt(view, 25, 200);
    expect(term.selectCalls.at(-1)).toEqual({ col: 0, row: 10, length: 2 });
  });
});

describe('R34 — puntine: selezione corta → presa "tight" (pezzo 4)', () => {
  it('a meno di un target tattile di distanza, ENTRAMBE le puntine si marcano tight', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 2)); // 2 celle: start 20px, end 40px → 20px < 46
    expect(handles(view).start.classList.contains('tight')).toBe(true);
    expect(handles(view).end.classList.contains('tight')).toBe(true);
  });

  it('selezione larga: niente tight (le prese non si sovrappongono)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // 10 celle: 100px
    expect(handles(view).start.classList.contains('tight')).toBe(false);
    expect(handles(view).end.classList.contains('tight')).toBe(false);
  });
});

describe('R34 — la bolla lente vicino alla maniglia attiva (pezzo 3)', () => {
  function zoomBubble(view) {
    return {
      bubble: view.container.querySelector('.nc-zoom-bubble'),
      line: view.container.querySelector('.nc-zoom-line'),
      sel: view.container.querySelector('.nc-zoom-line .nc-zoom-sel'),
      spans: view.container.querySelectorAll('.nc-zoom-line span'),
    };
  }
  function grabHandle(view, which, x, y) {
    fireEvent.pointerDown(handles(view)[which], { clientX: x, clientY: y, pointerType: 'touch' });
  }

  it('a selezione FERMA nessuna bolla: la lente esiste solo DURANTE il gesto', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    expect(zoomBubble(view).bubble).toBeNull();
  });

  it('durante il drag la bolla mostra la riga della maniglia attiva, spezzata in tre, al 2x della cella reale', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // riga 1, col 2..11
    expect(zoomBubble(view).bubble).toBeNull();
    grabHandle(view, 'start', 20, 40);
    const z = zoomBubble(view);
    expect(z.bubble).toBeTruthy();
    // 'contenuto-riga-1': prima 'co', selezionato 'ntenuto-ri', dopo 'ga-1'.
    expect(z.spans[0].textContent).toBe('co');
    expect(z.sel.textContent).toBe('ntenuto-ri');
    expect(z.spans[2].textContent).toBe('ga-1');
    expect(z.line.style.fontSize).toBe('40px'); // cella 20px → 2x
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('la bolla sta SOPRA la maniglia attiva quando c\'e\' spazio (non in cima allo schermo)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    // start (10,30): ancora left 300, top (10+1)*20 = 220. Bolla alta 62 (font 40):
    // top = 220 - 8 - 62 = 150 — NON il vecchio 44px fisso.
    act(() => term.select(30, 10, 10));
    grabHandle(view, 'start', 300, 220);
    expect(zoomBubble(view).bubble.style.top).toBe('150px');
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('maniglia nelle prime righe: la bolla ribalta SOTTO la puntina', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    // start (1,2): ancora top 40 → sopra non c'e' spazio → flip: 40 + 30 + 8 = 78.
    act(() => term.select(2, 1, 10));
    grabHandle(view, 'start', 20, 40);
    expect(zoomBubble(view).bubble.style.top).toBe('78px');
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('la bolla segue la maniglia che si muove: trascinata la end su un\'altra riga, mostra la SUA riga', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    grabHandle(view, 'end', 120, 40);
    // touch con scarto R35 (-6px nel fixture): (200,140-6) → col 20, riga 6.
    fireEvent.pointerMove(window, { clientX: 200, clientY: 140, pointerType: 'touch' });
    const z = zoomBubble(view);
    expect(z.spans[0].textContent).toBe('');
    expect(z.sel.textContent).toBe('contenuto-riga-6');
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('a gesto finito la bolla sparisce', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    grabHandle(view, 'end', 120, 40);
    expect(zoomBubble(view).bubble).toBeTruthy();
    fireEvent.pointerUp(window, { pointerType: 'touch' });
    expect(zoomBubble(view).bubble).toBeNull();
  });

  it('long-press: la bolla appare DURANTE il gesto iniziale (il dito copre la parola) e sparisce al rilascio', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);
    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 200 }] });
    act(() => vi.advanceTimersByTime(450)); // selezione a parola, dito ancora giu'
    expect(zoomBubble(view).bubble).toBeTruthy();
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 50, clientY: 200 }] });
    expect(zoomBubble(view).bubble).toBeNull();
  });

  it('la bolla rilegge il testo VIVO dal buffer: la riga riscritta sotto la selezione appare durante il drag', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // focus start, riga 1
    grabHandle(view, 'start', 20, 40);
    term.lineTexts.set(1, 'NUOVA-riga-1');
    act(() => term.renderCb && term.renderCb({ start: 1, end: 1 }));
    const z = zoomBubble(view);
    expect(z.line.textContent).toBe('NUOVA-riga-1');
    expect(z.sel.textContent).toBe('NUOVA-riga-1'.slice(2, 12)); // col 2..11
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('selezione invertita sulla stessa riga: la bolla mostra il segmento vero, non la colonna dell\'ancora (R25-zoom rev3)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.lineTexts.set(1, '0123456789');
    term.selectionPosition = { start: { x: 6, y: 1 }, end: { x: 3, y: 1 } };
    term.selectionText = 'invertita';
    act(() => term.emitSelection());
    grabHandle(view, 'start', 30, 40);
    expect(zoomBubble(view).sel.textContent).toBe('3456'); // col 3..6
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('selezione invertita multi-riga: la bolla mostra la riga e lo span della start vera (R25-zoom rev3)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.lineTexts.set(1, 'abcdefghij');
    term.lineTexts.set(2, 'ABCDEFGHIJ');
    term.selectionPosition = { start: { x: 5, y: 2 }, end: { x: 3, y: 1 } };
    term.selectionText = 'invertita';
    act(() => term.emitSelection());
    grabHandle(view, 'start', 30, 40);
    const z = zoomBubble(view);
    expect(z.line.textContent).toBe('abcdefghij');
    expect(z.sel.textContent).toBe('defghij');
    fireEvent.pointerUp(window, { pointerType: 'touch' });
  });

  it('selezione invertita: le maniglie NON sono scambiate, start a sinistra di end con +1 sulla fine vera (R25-zoom rev3)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.lineTexts.set(1, '0123456789');
    term.selectionPosition = { start: { x: 6, y: 1 }, end: { x: 3, y: 1 } };
    term.selectionText = 'invertita';
    act(() => term.emitSelection());
    const h = handles(view);
    expect(h.start).toBeTruthy();
    expect(h.end).toBeTruthy();
    const left = (el) => Number(el.style.left.replace('px', ''));
    expect(left(h.start)).toBeLessThan(left(h.end));
    expect(h.start.style.left).toBe('30px'); // start vera: col 3
    expect(h.end.style.left).toBe('70px');   // end vera: (col 6 + 1)
  });

  it('selezione annullata → la bolla sparisce con le maniglie', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    grabHandle(view, 'start', 20, 40);
    expect(zoomBubble(view).bubble).toBeTruthy();
    act(() => term.clearSelection());
    expect(zoomBubble(view).bubble).toBeNull();
  });
});
