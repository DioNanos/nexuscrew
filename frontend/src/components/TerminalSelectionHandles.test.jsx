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

  it('il touch usa l\'offset di ±2 righe: il dito non copre il punto di lavoro', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    grabEnd(view, term);
    // Dito a y=200 (riga visibile 10, meta' schermo → offset -2 righe):
    // la cella di lavoro e' la riga 8, non la 10.
    fireEvent.pointerMove(window, { clientX: 100, clientY: 200, pointerType: 'touch' });
    const last = term.selectCalls.at(-1);
    const endRow = Math.floor((1 * 80 + 2 + last.length - 1) / 80);
    expect(endRow).toBe(8);
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
    // (25, 200): col 2 = cella di continuazione del glifo; offset touch -2 → riga 8.
    fireEvent.pointerMove(window, { clientX: 25, clientY: 200, pointerType: 'touch' });
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
    // (25, 40): col 2 = continuazione; offset touch -2 → riga 0.
    fireEvent.pointerMove(window, { clientX: 25, clientY: 40, pointerType: 'touch' });
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

describe('R25-zoom — la barra con la riga della maniglia in focus', () => {
  function zoomBar(view) {
    return {
      bar: view.container.querySelector('.nc-zoom-bar'),
      line: view.container.querySelector('.nc-zoom-line'),
      sel: view.container.querySelector('.nc-zoom-line .nc-zoom-sel'),
      spans: view.container.querySelectorAll('.nc-zoom-line span'),
    };
  }

  it('con la selezione appare e mostra la riga della maniglia start spezzata in tre, al 2x della cella reale', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    expect(zoomBar(view).bar).toBeNull(); // senza selezione non c'e' barra
    act(() => term.select(2, 1, 10)); // riga 1, col 2..11
    const z = zoomBar(view);
    expect(z.bar).toBeTruthy();
    // 'contenuto-riga-1': prima 'co' (col 0..1), selezionato 'ntenuto-ri'
    // (col 2..11), dopo 'ga-1'. Il focus di default e' start.
    expect(z.spans[0].textContent).toBe('co');
    expect(z.sel.textContent).toBe('ntenuto-ri');
    expect(z.spans[2].textContent).toBe('ga-1');
    // cella 20px misurata → testo 2x = 40px.
    expect(z.line.style.fontSize).toBe('40px');
  });

  it('la barra segue la maniglia che si muove: trascinata la end su un\'altra riga, mostra la SUA riga', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    const h = handles(view);
    fireEvent.pointerDown(h.end, { clientX: 120, clientY: 40, pointerType: 'mouse' });
    // (200, 40): col 20, riga buffer 2 → selezione multi-riga, end (2,20).
    fireEvent.pointerMove(window, { clientX: 200, clientY: 40, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { pointerType: 'mouse' });
    const z = zoomBar(view);
    // Riga della END: selezionato dall'inizio riga fino a col 20 (la riga e'
    // lunga 16: tutta), prima vuota.
    expect(z.spans[0].textContent).toBe('');
    expect(z.sel.textContent).toBe('contenuto-riga-2');
  });

  it('la barra rilegge il testo VIVO dal buffer: la riga riscritta sotto la selezione appare alla barra', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10)); // focus start, riga 1
    term.lineTexts.set(1, 'NUOVA-riga-1');
    act(() => term.renderCb && term.renderCb({ start: 1, end: 1 }));
    const z = zoomBar(view);
    expect(z.line.textContent).toBe('NUOVA-riga-1');
    expect(z.sel.textContent).toBe('NUOVA-riga-1'.slice(2, 12)); // col 2..11
  });

  it('selezione invertita sulla stessa riga: la barra mostra il segmento vero, non la colonna dell\'ancora (R25-zoom rev3)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.lineTexts.set(1, '0123456789');
    // drag nativo all'indietro: xterm 6.0 restituisce start>end NON normalizzati
    term.selectionPosition = { start: { x: 6, y: 1 }, end: { x: 3, y: 1 } };
    term.selectionText = 'invertita';
    act(() => term.emitSelection());
    const z = zoomBar(view);
    expect(z.sel.textContent).toBe('3456'); // col 3..6, non la sola col 6
  });

  it('selezione invertita multi-riga: la barra mostra la riga e lo span della start vera (R25-zoom rev3)', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    term.lineTexts.set(1, 'abcdefghij');
    term.lineTexts.set(2, 'ABCDEFGHIJ');
    // drag all'indietro: ancora su riga 2 col 5, fine su riga 1 col 3
    term.selectionPosition = { start: { x: 5, y: 2 }, end: { x: 3, y: 1 } };
    term.selectionText = 'invertita';
    act(() => term.emitSelection());
    const z = zoomBar(view);
    expect(z.line.textContent).toBe('abcdefghij'); // riga della start vera
    expect(z.sel.textContent).toBe('defghij');      // col 3..fine riga
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

  it('selezione annullata → la barra sparisce con le maniglie', () => {
    const view = renderTerminal();
    terminalBounds(view.container.querySelector('.nc-terminal-host'));
    const term = fixture.instances[0];
    act(() => term.select(2, 1, 10));
    expect(zoomBar(view).bar).toBeTruthy();
    act(() => term.clearSelection());
    expect(zoomBar(view).bar).toBeNull();
  });
});
