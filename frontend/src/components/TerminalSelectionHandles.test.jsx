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
      const self = this;
      this.buffer = { active: {
        viewportY: 0, baseY: 100, type: 'normal',
        // Fedele all'API pubblica di xterm: getLine(y) → riga del buffer,
        // translateToString() ne da' il testo.
        getLine(y) {
          self.getLineCalls.push(y);
          return { translateToString: () => self.lineTexts.get(y) ?? '' };
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
    // La selezione non e' stata letta: nessuna chiamata getLine in piu'.
    expect(term.getLineCalls.length).toBe(lettureDopoSnapshot);
  });
});
