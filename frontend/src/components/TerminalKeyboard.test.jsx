import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ instances: [], focusCount: 0, closeCount: 0, actions: [], inputs: [] }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      this.textarea = document.createElement('textarea');
      this.options = {}; this.cols = 80; this.rows = 24;
      const self = this;
      this.buffer = { active: {
        viewportY: 0, baseY: 0, type: 'normal',
        // API pubblica di xterm: getLine(y) → riga del buffer con getCell(col).
        getLine: (y) => ({
          getCell: (col) => {
            const text = self.lineTexts.get(y) ?? '';
            return { getChars: () => text[col] ?? '', getWidth: () => 1 };
          },
        }),
      } };
      this.lineTexts = new Map();
      this.selectCalls = []; this.scrollLinesCalls = [];
      // Modalita' e parser come li espone xterm: `modes` per il tracking del
      // mouse, `parser` per osservare la codifica SGR (DECSET 1006) sul filo.
      this.modes = { mouseTrackingMode: 'none' };
      this.csiHandlers = [];
      this.escHandlers = [];
      this.parser = {
        registerCsiHandler: (id, callback) => {
          this.csiHandlers.push({ id, callback });
          return { dispose() {} };
        },
        registerEscHandler: (id, callback) => {
          this.escHandlers.push({ id, callback });
          return { dispose() {} };
        },
      };
      fixture.instances.push(this);
    }
    // Simula la negoziazione fatta dall'applicazione: `CSI ? 1006 h` accende
    // la codifica SGR, `l` la spegne.
    emitCsi(final, params) {
      for (const handler of this.csiHandlers) {
        if (handler.id.final === final && handler.id.prefix === '?') handler.callback(params);
      }
    }
    // RIS (`ESC c`): reset completo del terminale, encoding incluso.
    emitEsc(final) {
      for (const handler of this.escHandlers) {
        if (handler.id.final === final) handler.callback();
      }
    }
    loadAddon() {}
    open(host) { host.appendChild(this.textarea); }
    focus() { fixture.focusCount += 1; this.textarea.focus(); }
    onData() { return { dispose() {} }; }
    onSelectionChange(cb) { this.selectionCb = cb; return { dispose() {} }; }
    onRender(cb) { this.renderCb = cb; return { dispose() {} }; }
    onScroll(cb) { this.scrollCb = cb; return { dispose() {} }; }
    getSelectionPosition() { return this.selectionPosition || null; }
    scrollLines(n) { this.scrollLinesCalls.push(n); }
    // Simula cio' che fa xterm: la selezione cambia, e puo' anche essere
    // AZZERATA da lui (onUserInput, resize, click con mouse tracking).
    emitSelection(text) { this.selectionText = text; if (this.selectionCb) this.selectionCb(); }
    attachCustomKeyEventHandler() {}
    getSelection() { return this.selectionText || ''; }
    hasSelection() { return !!this.selectionText; }
    clearSelection() { this.selectionText = ''; }
    select(col, row, length) {
      this.selectCalls.push({ col, row, length });
      // R37: end ESCLUSIVO come finalSelectionEnd di xterm (startPlusLength =
      // col + length, [cols, y] a fine riga), non incluso di una cella.
      const spl = col + length;
      const end = spl > this.cols
        ? (spl % this.cols === 0
          ? { x: this.cols, y: row + Math.floor(spl / this.cols) - 1 }
          : { x: spl % this.cols, y: row + Math.floor(spl / this.cols) })
        : { x: spl, y: row };
      this.selectionPosition = {
        start: { x: col, y: row },
        end,
      };
    }
    write() {}
    paste() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('../lib/ws-client.js', () => ({
  openTerminalSocket: () => ({
    sendInput: (seq) => { fixture.inputs.push(seq); return true; },
    action: (name) => { fixture.actions.push(name); },
    resize() {}, focus() {}, isReady: () => true,
    close() { fixture.closeCount += 1; },
  }),
}));

const clip = vi.hoisted(() => ({ copied: [] }));
vi.mock('../lib/clipboard.js', () => ({ copyText: async (value) => { clip.copied.push(value); return true; } }));

import Terminal from './Terminal.jsx';

const stableRefs = {
  sendRef: { current: null }, composerRef: { current: null },
  actionRef: { current: null }, ctrlRef: { current: false },
};

function renderTerminal(keyboardGesture = 'double-tap', extraProps = {}) {
  return render(
    <div style={{ width: 400, height: 300 }}>
      <Terminal session="cloud-Dev" token="t" keyboardGesture={keyboardGesture}
        {...stableRefs} {...extraProps} />
    </div>,
  );
}

function tap(host, x = 30, y = 40) {
  fireEvent.touchStart(host, { touches: [{ clientX: x, clientY: y }] });
  fireEvent.touchEnd(host, { changedTouches: [{ clientX: x, clientY: y }] });
}

function terminalBounds(host, width = 800, height = 480) {
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {},
  });
}

beforeEach(() => {
  fixture.instances.length = 0; fixture.focusCount = 0; fixture.closeCount = 0;
  fixture.actions.length = 0; fixture.inputs.length = 0;
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-22T12:00:00Z'));
});

afterEach(() => vi.useRealTimers());

describe('Terminal virtual keyboard gesture', () => {
  it('defaults to inputmode none and unlocks only on the second nearby tap', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const textarea = fixture.instances[0].textarea;
    expect(textarea.inputMode).toBe('none');
    tap(host); expect(fixture.focusCount).toBe(0); expect(textarea.inputMode).toBe('none');
    act(() => vi.advanceTimersByTime(250));
    tap(host, 34, 43);
    expect(fixture.focusCount).toBe(1); expect(textarea.inputMode).toBe('text');
  });

  it('supports the Settings single-tap and never modes without remounting xterm', () => {
    const view = renderTerminal('double-tap');
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    view.rerender(
      <div style={{ width: 400, height: 300 }}>
        <Terminal session="cloud-Dev" token="t" keyboardGesture="single-tap"
          {...stableRefs} />
      </div>,
    );
    expect(fixture.instances).toHaveLength(1); expect(term.textarea.inputMode).toBe('text');
    tap(host); expect(fixture.focusCount).toBe(1);

    view.rerender(
      <div style={{ width: 400, height: 300 }}>
        <Terminal session="cloud-Dev" token="t" keyboardGesture="never"
          {...stableRefs} />
      </div>,
    );
    expect(term.textarea.inputMode).toBe('none');
    fireEvent.doubleClick(host);
    expect(fixture.focusCount).toBe(1);
  });
});

// Doppio tap ravvicinato entro la finestra temporale del candidato originale.
// LONG_PRESS_MS=450 supera i 420ms del doppio tap: per discriminare l'annullamento
// dal solo scadere del timeout, si riporta il system time dentro la finestra.
function tapNearAfterCancellation(host, x = 34, y = 43) {
  vi.setSystemTime(new Date('2026-07-22T12:00:00.100Z'));
  fireEvent.touchStart(host, { touches: [{ clientX: x, clientY: y }] });
  fireEvent.touchEnd(host, { changedTouches: [{ clientX: x, clientY: y }] });
}

describe('terminal double-tap cancellation', () => {
  it('movement beyond the long-press threshold but within double-tap radius cancels the first tap', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    tap(host, 30, 40); // primo tap: registra il candidato
    // move di 15px: > LONG_PRESS_MOVE_PX (8) e <= DOUBLE_TAP_PX (32) -> annulla
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 45, clientY: 40 }] });
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 45, clientY: 40 }] });
    tapNearAfterCancellation(host); // vicino al primo tap, entro finestra
    expect(fixture.focusCount).toBe(0);
    expect(fixture.instances).toHaveLength(1);
  });

  it('a long press cancels the first tap, isolated from selection mode', () => {
    const view = renderTerminal('double-tap');
    const host = view.container.querySelector('.nc-terminal-host');
    tap(host, 30, 40); // primo tap: registra candidato A
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    act(() => vi.advanceTimersByTime(450)); // LONG_PRESS_MS: scatta il timer
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 30, clientY: 40 }] });
    // il long press ha armato selectionModeRef: esco dalla modalita' selezione prima
    // del tap successivo, cosi' il test misura l'invalidazione del candidato e non
    // la guardia di selezione.
    view.rerender(
      <div style={{ width: 400, height: 300 }}>
        <Terminal session="cloud-Dev" token="t" keyboardGesture="double-tap" {...stableRefs} />
      </div>,
    );
    tapNearAfterCancellation(host); // vicino ad A, entro finestra temporale
    expect(fixture.focusCount).toBe(0);
  });

  it('touchcancel cancels the pending first tap candidate', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    tap(host, 30, 40); // registra candidato
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.touchCancel(host); // onTouchCancel: lastTerminalTap = null
    tapNearAfterCancellation(host);
    expect(fixture.focusCount).toBe(0);
  });

  it('a two-finger tap cannot unlock the keyboard as a double-tap second tap', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const textarea = fixture.instances[0].textarea;
    tap(host, 30, 40); // primo tap singolo: registra il candidato
    expect(textarea.inputMode).toBe('none');
    // Tocco a due dita ravvicinato: i due touchend arrivano separatamente.
    // Nessuno dei due rilasci deve diventare un nuovo candidato.
    const first = { clientX: 30, clientY: 40 };
    const second = { clientX: 33, clientY: 42 };
    fireEvent.touchStart(host, { touches: [
      first, second,
    ] });
    fireEvent.touchEnd(host, { touches: [second], changedTouches: [first] });
    fireEvent.touchEnd(host, { touches: [], changedTouches: [second] });
    tapNearAfterCancellation(host); // un tap vicino subito dopo non sblocca
    expect(fixture.focusCount).toBe(0);
    expect(textarea.inputMode).toBe('none');
  });
});

describe('terminal long-press touch selection', () => {
  it('il punto premuto e\' la cella esatta: la selezione parte li\' e il caret la segue (rev4)', () => {
    const onSelectionModeChange = vi.fn();
    const view = renderTerminal('double-tap', { onSelectionModeChange });
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host);

    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 200 }] });
    act(() => vi.advanceTimersByTime(450));
    let caret = view.container.querySelector('.nc-touch-selection-caret');
    expect(onSelectionModeChange).toHaveBeenCalledWith(true);
    // riga 10 = riga premuta (niente offset -2); cella vuota → 1 cella.
    expect(term.selectCalls.at(-1)).toEqual({ col: 5, row: 10, length: 1 });
    expect(caret.style.left).toBe('50px');
    expect(caret.style.top).toBe('200px');

    fireEvent.touchMove(host, { touches: [{ clientX: 70, clientY: 240 }] });
    caret = view.container.querySelector('.nc-touch-selection-caret');
    // estremita' mobile = cella esatta sotto il dito: (7, 12).
    expect(term.selectCalls.at(-1)).toEqual({ col: 5, row: 10, length: 163 });
    expect(caret.style.left).toBe('70px');
    expect(caret.style.top).toBe('240px');

    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 70, clientY: 240 }] });
    expect(view.container.querySelector('.nc-touch-selection-caret')).toBeNull();
    expect(term.selectCalls.at(-1)).toEqual({ col: 5, row: 10, length: 163 });
  });

  it('il punto esatto vale anche sul bordo alto: caret sulla cella premuta (rev4)', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host);

    fireEvent.touchStart(host, { touches: [{ clientX: 799, clientY: 10 }] });
    act(() => vi.advanceTimersByTime(450));
    const caret = view.container.querySelector('.nc-touch-selection-caret');
    // ultima colonna, prima riga: la cella premuta, senza offset.
    expect(term.selectCalls.at(-1)).toEqual({ col: 79, row: 0, length: 1 });
    expect(caret.style.left).toBe('790px');
    expect(caret.style.top).toBe('0px');
    expect(caret.style.width).toBe('10px');
    expect(caret.style.height).toBe('20px');
  });

  // Long-press e percorso selectionMode (tasto SELECT, tocchi successivi)
  // condividono lo stesso contratto: punto di pressione ESATTO, caret sulla
  // cella premuta, espansione a parola. Prima erano due comportamenti
  // diversi per lo stesso gesto.
  it('il percorso selectionMode usa lo stesso punto esatto del long-press (rev4)', () => {
    const view = renderTerminal('double-tap', { selectionMode: true });
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host);

    fireEvent.touchStart(host, { touches: [{ clientX: 50, clientY: 200 }] });
    // il tocco in selectionMode seleziona SUBITO la cella premuta (riga 10)
    expect(term.selectCalls.at(-1)).toEqual({ col: 5, row: 10, length: 1 });
    expect(view.container.querySelector('.nc-touch-selection-caret')).not.toBeNull();
    fireEvent.touchMove(host, { touches: [{ clientX: 50, clientY: 240 }] });
    expect(term.selectCalls.at(-1)).toEqual({ col: 5, row: 10, length: 161 });
  });

  it('hides the long-press caret immediately when a second finger joins the gesture', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    terminalBounds(host);

    const first = { clientX: 50, clientY: 200 };
    fireEvent.touchStart(host, { touches: [first] });
    act(() => vi.advanceTimersByTime(450));
    expect(view.container.querySelector('.nc-touch-selection-caret')).not.toBeNull();

    fireEvent.touchStart(host, { touches: [first, { clientX: 70, clientY: 220 }] });
    expect(view.container.querySelector('.nc-touch-selection-caret')).toBeNull();
  });
});

describe('terminal keyboard relock after unlock', () => {
  function unlock(view) {
    const host = view.container.querySelector('.nc-terminal-host');
    tap(host, 30, 40);
    act(() => vi.advanceTimersByTime(250));
    tap(host, 34, 43); // entro 420ms/32px -> doppio tap -> sblocca
  }

  it('relocks to inputmode=none when the textarea blurs after unlock', () => {
    const view = renderTerminal();
    const textarea = fixture.instances[0].textarea;
    unlock(view);
    expect(fixture.focusCount).toBe(1);
    expect(textarea.inputMode).toBe('text');
    fireEvent.blur(textarea);
    expect(textarea.inputMode).toBe('none');
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.closeCount).toBe(0);
  });

  it('relocks when navigator.virtualKeyboard geometrychange reports height 0', () => {
    // jsdom non espone navigator.virtualKeyboard: stub minimale prima del mount,
    // con boundingRect mutabile e listener reali (nessun seam di produzione).
    const vk = new EventTarget();
    vk.boundingRect = { height: 300 };
    Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: vk });
    try {
      const view = renderTerminal();
      const textarea = fixture.instances[0].textarea;
      unlock(view);
      expect(textarea.inputMode).toBe('text');
      vk.boundingRect = { height: 0 };
      act(() => vk.dispatchEvent(new Event('geometrychange')));
      expect(textarea.inputMode).toBe('none');
      expect(fixture.closeCount).toBe(0);
    } finally {
      delete navigator.virtualKeyboard;
    }
  });

  it('relocks when window.visualViewport re-expands beyond the keyboard', () => {
    const vv = new EventTarget();
    vv.height = 300;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    try {
      const view = renderTerminal();
      const textarea = fixture.instances[0].textarea;
      unlock(view);
      expect(textarea.inputMode).toBe('text');
      vv.height = 600; // risalita di 300px > soglia 80
      act(() => vv.dispatchEvent(new Event('resize')));
      expect(textarea.inputMode).toBe('none');
      expect(fixture.closeCount).toBe(0);
    } finally {
      delete window.visualViewport;
    }
  });
});

describe('terminal gesture never remounts xterm nor reconnects the websocket', () => {
  it('keeps one xterm instance and zero socket closes across cancellations, relocks and preference changes', () => {
    const view = renderTerminal('double-tap');
    const host = view.container.querySelector('.nc-terminal-host');
    // doppio tap -> unlock -> blur (relock)
    tap(host, 30, 40);
    act(() => vi.advanceTimersByTime(250));
    tap(host, 34, 43);
    fireEvent.blur(fixture.instances[0].textarea);
    // cancellazioni
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 45, clientY: 40 }] });
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 45, clientY: 40 }] });
    // cambio preferenza (rerender): deve aggiornare solo la policy, non ricostruire xterm
    view.rerender(
      <div style={{ width: 400, height: 300 }}>
        <Terminal session="cloud-Dev" token="t" keyboardGesture="single-tap" {...stableRefs} />
      </div>,
    );
    view.rerender(
      <div style={{ width: 400, height: 300 }}>
        <Terminal session="cloud-Dev" token="t" keyboardGesture="never" {...stableRefs} />
      </div>,
    );
    tap(host); tap(host);
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.closeCount).toBe(0);
  });
});

describe('terminal scroll plan integration', () => {
  it('normal screen scroll uses server-side scroll-up/scroll-down actions', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    expect(term.buffer.active.type).toBe('normal'); // normal screen (non alternate)
    // touch: finger down (clientY increases) -> older history -> scroll-up
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 30, clientY: 64 }] }); // +24 = STEP
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 30, clientY: 64 }] });
    // wheel: deltaY < 0 (scroll up gesture) -> scroll-up
    fireEvent.wheel(host, { deltaY: -24 });
    // wheel: deltaY > 0 (scroll down gesture) -> scroll-down
    fireEvent.wheel(host, { deltaY: 24 });
    expect(fixture.actions).toEqual(expect.arrayContaining(['scroll-up', 'scroll-up', 'scroll-down']));
    expect(fixture.inputs).toEqual([]); // no PTY input on the normal screen
  });

  it('mobile drag scrolls tmux history even in a writable alternate-screen TUI', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    term.buffer.active.type = 'alternate'; // vim/less/htop alt buffer
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ height: 300, width: 400, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} });
    // A realistic 120px phone swipe is below the 300px viewport. It must still
    // emit five 24px tmux scroll ticks instead of being discarded at touchend.
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 30, clientY: 160 }] });
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 30, clientY: 160 }] });
    expect(fixture.actions).toEqual(Array(5).fill('scroll-up'));
    expect(fixture.inputs).toEqual([]);
  });

  it('desktop wheel in a writable alternate-screen TUI browses tmux history like touch', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    term.buffer.active.type = 'alternate'; // Codex/Claude/vim alt buffer
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ height: 300, width: 400, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} });
    fireEvent.wheel(host, { deltaY: -24 });
    fireEvent.wheel(host, { deltaY: 24 });
    expect(fixture.actions).toEqual(['scroll-up', 'scroll-down']);
    expect(fixture.inputs).toEqual([]); // the wheel no longer steals the TUI viewport
  });

  // Un'app che abilita il mouse tracking con codifica SGR possiede il proprio
  // scorrimento: sottrarle il gesto per il copy-mode tmux mostra una
  // scrollback fatta di fotogrammi di ridisegno invece del transcript.
  const enableSgrMouse = (term) => {
    term.emitCsi('h', [1006]);            // DECSET 1006: codifica SGR
    term.modes.mouseTrackingMode = 'any'; // DECSET 1003: tracking attivo
  };

  it('gives the wheel to an application that tracks the mouse with SGR', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host, 400, 300);
    enableSgrMouse(term);
    fireEvent.wheel(host, { deltaY: -24, clientX: 30, clientY: 40 });
    fireEvent.wheel(host, { deltaY: 24, clientX: 30, clientY: 40 });
    expect(fixture.inputs).toEqual(['\x1b[<64;7;4M', '\x1b[<65;7;4M']);
    expect(fixture.actions).toEqual([]); // niente copy-mode: scorre l'app
  });

  it('gives the finger drag to that application too, which is the mobile case', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host, 400, 300);
    enableSgrMouse(term);
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 30, clientY: 64 }] }); // +24 = STEP
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 30, clientY: 64 }] });
    expect(fixture.inputs).toEqual(['\x1b[<64;7;6M']);
    expect(fixture.actions).toEqual([]);
  });

  it('keeps server-side scroll when tracking is on but the encoding is legacy', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host, 400, 300);
    term.modes.mouseTrackingMode = 'vt200'; // nessun DECSET 1006
    fireEvent.wheel(host, { deltaY: -24, clientX: 30, clientY: 40 });
    expect(fixture.inputs).toEqual([]); // mai byte che l'app non sa decodificare
    expect(fixture.actions).toEqual(['scroll-up']);
  });

  // La nostra copia dello stato dell'encoding puo' desincronizzarsi: dopo un
  // RIS l'applicazione riparte in codifica legacy, e continuare a mandarle
  // report SGR significa consegnarle byte che non sa leggere.
  it('forgets the SGR encoding after a terminal reset, even if tracking stays on', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host, 400, 300);
    enableSgrMouse(term);
    fireEvent.wheel(host, { deltaY: -24, clientX: 30, clientY: 40 });
    expect(fixture.inputs).toEqual(['\x1b[<64;7;4M']);
    fixture.inputs.length = 0;
    term.emitEsc('c');                    // RIS: reset, encoding compresa
    expect(term.modes.mouseTrackingMode).toBe('any'); // il tracking resta acceso
    fireEvent.wheel(host, { deltaY: -24, clientX: 30, clientY: 40 });
    expect(fixture.inputs).toEqual([]);   // niente SGR su una codifica non piu' negoziata
    expect(fixture.actions).toEqual(['scroll-up']);
  });

  it('stays on server-side scroll when coordinates are negotiated in pixels', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host, 400, 300);
    enableSgrMouse(term);
    term.emitCsi('h', [1016]);            // SGR-Pixels: le coordinate sono pixel
    fireEvent.wheel(host, { deltaY: -24, clientX: 30, clientY: 40 });
    expect(fixture.inputs).toEqual([]);   // le nostre coordinate sono celle
    expect(fixture.actions).toEqual(['scroll-up']);
    term.emitCsi('l', [1016]);            // tornando a celle si riprende
    fireEvent.wheel(host, { deltaY: -24, clientX: 30, clientY: 40 });
    expect(fixture.inputs).toEqual(['\x1b[<64;7;4M']);
  });

  it('never sends PTY input from a readonly terminal, even with tracking on', () => {
    const view = renderTerminal('double-tap', { readonly: true });
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host, 400, 300);
    enableSgrMouse(term);
    fireEvent.wheel(host, { deltaY: -24, clientX: 30, clientY: 40 });
    expect(fixture.inputs).toEqual([]);
    expect(fixture.actions).toEqual(['scroll-up']);
  });

  it('Shift+wheel still browses tmux history in a writable alternate-screen TUI', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    term.buffer.active.type = 'alternate';
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ height: 300, width: 400, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} });
    fireEvent.wheel(host, { deltaY: -300, shiftKey: true });
    fireEvent.wheel(host, { deltaY: 300, shiftKey: true });
    expect(fixture.inputs).toEqual([]);
    expect(fixture.actions).toEqual([
      ...Array(8).fill('scroll-up'),
      ...Array(8).fill('scroll-down'),
    ]);
  });

  it('Shift+wheel on the normal screen stays server-side', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    fireEvent.wheel(host, { deltaY: -24, shiftKey: true });
    expect(fixture.actions).toEqual(['scroll-up']);
    expect(fixture.inputs).toEqual([]);
  });

  it('keeps Shift-wheel in the same tmux history accumulator as an unmodified wheel', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    term.buffer.active.type = 'alternate';
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ height: 300, width: 400, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} });
    fireEvent.wheel(host, { deltaY: -290, shiftKey: true }); // 8 bounded steps, 2px remainder
    expect(fixture.inputs).toEqual([]);
    expect(fixture.actions).toHaveLength(8);
    fireEvent.wheel(host, { deltaY: -22 }); // 2px + 22px = one more history step
    expect(fixture.actions).toHaveLength(9);
    expect(fixture.inputs).toEqual([]);
  });

  it('bounds a huge wheel event to a small fixed action burst', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    fireEvent.wheel(host, { deltaY: -24_000_007 });
    expect(fixture.actions).toHaveLength(8);
    fireEvent.wheel(host, { deltaY: -17 }); // 7px remainder + 17px = one new step
    expect(fixture.actions).toHaveLength(9);
  });

  it('readonly alternate-screen never sends PTY input and keeps server actions', () => {
    const view = render(
      <div style={{ width: 400, height: 300 }}>
        <Terminal session="cloud-Dev" token="t" readonly keyboardGesture="double-tap" {...stableRefs} />
      </div>,
    );
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    term.buffer.active.type = 'alternate';
    fireEvent.wheel(host, { deltaY: -24 });
    fireEvent.wheel(host, { deltaY: -24, shiftKey: true }); // Shift never lifts the readonly guard
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 30, clientY: 64 }] });
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 30, clientY: 64 }] });
    expect(fixture.inputs).toEqual([]); // readonly: never PTY input
    expect(fixture.actions.filter((name) => name === 'scroll-up').length).toBeGreaterThan(0);
  });

  it('preserves double-tap unlock, long-press selection and multitouch while scrolling', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    // a scroll gesture (move beyond long-press radius) does not unlock the keyboard
    fireEvent.touchStart(host, { touches: [{ clientX: 30, clientY: 40 }] });
    fireEvent.touchMove(host, { touches: [{ clientX: 30, clientY: 90 }] }); // drag > 32px
    fireEvent.touchEnd(host, { changedTouches: [{ clientX: 30, clientY: 90 }] });
    expect(term.textarea.inputMode).toBe('none');
    expect(fixture.focusCount).toBe(0);
    // a two-finger touch during scroll cancels without emitting page input
    term.buffer.active.type = 'alternate';
    fireEvent.touchStart(host, { touches: [{ clientX: 10, clientY: 10 }, { clientX: 50, clientY: 50 }] });
    fireEvent.touchEnd(host, { touches: [{ clientX: 50, clientY: 50 }], changedTouches: [{ clientX: 10, clientY: 10 }] });
    expect(fixture.inputs).toEqual([]);
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.closeCount).toBe(0);
  });
});


// xterm butta la selezione a ogni input diretto all'applicazione: un tasto,
// e con il mouse tracking attivo anche un solo click, perche' diventa un
// report SGR verso la TUI. Un resize di righe fa lo stesso, quindi sul
// telefono basta la tastiera virtuale. Il risultato era che si selezionava,
// si andava a premere Copia, e non restava piu' niente da copiare.
describe('terminal selection outlives what xterm discards', () => {
  it('keeps the copyable text after the terminal drops the selection', async () => {
    const view = renderTerminal();
    const term = fixture.instances[0];
    act(() => term.emitSelection('testo scelto'));
    expect(view.container.querySelector('.nc-selection-tools')).not.toBeNull();

    // Qui xterm la cancella per conto suo, senza che l'operatore abbia deciso nulla.
    act(() => term.emitSelection(''));
    expect(view.container.querySelector('.nc-selection-tools'))
      .not.toBeNull();

    const copy = view.container.querySelector('.nc-selection-tools button');
    await act(async () => { fireEvent.click(copy); });
    expect(clip.copied.at(-1)).toBe('testo scelto');
  });

  it('forgets it once the operator has actually copied', async () => {
    const view = renderTerminal();
    const term = fixture.instances[0];
    act(() => term.emitSelection('preso'));
    const copy = view.container.querySelector('.nc-selection-tools button');
    await act(async () => { fireEvent.click(copy); });
    act(() => { vi.advanceTimersByTime(2000); });
    // Senza questo la barra resterebbe su per sempre, offrendo di ricopiare
    // un testo che l'operatore ha gia' preso.
    expect(view.container.querySelector('.nc-selection-tools')).toBeNull();
  });
});


// Claude Code accende il tracking di OGNI movimento (DECSET 1003), non solo del
// trascinamento. Quindi spostare il puntatore e' gia' input per l'applicazione,
// e xterm butta la selezione a ogni input. Finito il trascinamento smettevamo di
// proteggere il gesto proprio mentre l'operatore si muove verso il pulsante
// Copia: la selezione moriva a meta' strada e restava copiabile solo senza
// muovere il mouse, cioe' solo da tastiera.
describe('terminal selection survives the trip to the Copy button', () => {
  function withTracking(view) {
    const term = fixture.instances[0];
    term.emitCsi('h', [1006]);              // codifica SGR
    term.modes.mouseTrackingMode = 'any';   // DECSET 1003
    return term;
  }
  const moveOver = (host) => {
    const ev = new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: 140, clientY: 90 });
    host.dispatchEvent(ev);
    return ev;
  };

  // La precondizione della protezione dev'essere LEGGIBILE dal DOM, o una prova
  // nel browser non puo' distinguere «protetta» da «non c'era niente da cui
  // proteggerla». Trovato provando NC-L con Playwright: il gesto reggeva, ma non
  // potevo dimostrare che il ramo protettivo si fosse acceso.
  it('says whether the app owns the mouse, both ways', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    terminalBounds(host, 400, 300);
    term.emitCsi('h', [1006]);
    term.modes.mouseTrackingMode = 'any';
    act(() => term.emitSelection('scelto'));
    moveOver(host);
    expect(host.dataset.mouseTracking).toBe('on');

    // Spento il tracking, l'attributo deve dirlo: se restasse 'on' una prova nel
    // browser leggerebbe una precondizione che non c'e' piu'.
    term.modes.mouseTrackingMode = 'none';
    moveOver(host);
    expect(host.dataset.mouseTracking).toBe('off');
  });

  it('shields the pointer movement while a selection is alive', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = withTracking(view);
    act(() => term.emitSelection('testo scelto'));
    expect(moveOver(host).defaultPrevented).toBe(true);
  });

  it('lets the application see movement again once nothing is selected', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = withTracking(view);
    act(() => term.emitSelection('testo scelto'));
    // Un click senza Shift e' il modo naturale di annullare: passa, raggiunge
    // l'applicazione, e la selezione se ne va da sola.
    act(() => { term.selectionText = ''; });
    expect(moveOver(host).defaultPrevented).toBe(false);
  });

  it('does not shield anything when the application is not tracking the mouse', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    term.emitCsi('h', [1006]);
    // tracking spento: e' il caso Codex, dove il gesto non e' mai stato rotto
    act(() => term.emitSelection('testo scelto'));
    expect(moveOver(host).defaultPrevented).toBe(false);
  });
});

// Il testo puo' sopravvivere alla propria evidenziazione: xterm la butta a ogni
// input verso l'applicazione e a ogni resize di righe. Copiare continua a
// funzionare, ma senza il riquadro giallo l'operatore non sa piu' se ha
// qualcosa in mano ne' cosa. Va detto, non dedotto.
describe('terminal tells you when the selection is detached from its highlight', () => {
  it('says the highlight is gone while the text is still held', () => {
    const view = renderTerminal();
    const term = fixture.instances[0];
    act(() => term.emitSelection('riga scelta'));
    expect(view.container.querySelector('.nc-selection-held')).toBeNull();

    // xterm la butta per conto suo: input all'app, oppure un resize di righe.
    act(() => term.emitSelection(''));
    const held = view.container.querySelector('.nc-selection-held');
    expect(held).not.toBeNull();
    expect(held.textContent).toBe('highlight gone, text still held');
    // e la copia continua a offrire il testo, non il vuoto
    expect(view.container.querySelector('.nc-selection-tools button')).not.toBeNull();
  });

  it('stops saying it as soon as a fresh selection exists', () => {
    const view = renderTerminal();
    const term = fixture.instances[0];
    act(() => term.emitSelection('prima'));
    act(() => term.emitSelection(''));
    expect(view.container.querySelector('.nc-selection-held')).not.toBeNull();
    act(() => term.emitSelection('seconda'));
    expect(view.container.querySelector('.nc-selection-held')).toBeNull();
  });

  it('forgets the detachment once the operator has copied', async () => {
    const view = renderTerminal();
    const term = fixture.instances[0];
    act(() => term.emitSelection('presa'));
    act(() => term.emitSelection(''));
    const copy = view.container.querySelector('.nc-selection-tools button');
    await act(async () => { fireEvent.click(copy); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(view.container.querySelector('.nc-selection-held')).toBeNull();
  });
});
