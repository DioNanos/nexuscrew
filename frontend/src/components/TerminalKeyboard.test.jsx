import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ instances: [], focusCount: 0, closeCount: 0, actions: [], inputs: [] }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      this.textarea = document.createElement('textarea');
      this.options = {}; this.cols = 80; this.rows = 24;
      this.buffer = { active: { viewportY: 0 } };
      fixture.instances.push(this);
    }
    loadAddon() {}
    open(host) { host.appendChild(this.textarea); }
    focus() { fixture.focusCount += 1; this.textarea.focus(); }
    onData() { return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
    getSelection() { return ''; }
    clearSelection() {}
    select() {}
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

import Terminal from './Terminal.jsx';

const stableRefs = {
  sendRef: { current: null }, composerRef: { current: null },
  actionRef: { current: null }, ctrlRef: { current: false },
};

function renderTerminal(keyboardGesture = 'double-tap') {
  return render(
    <div style={{ width: 400, height: 300 }}>
      <Terminal session="cloud-Dev" token="t" keyboardGesture={keyboardGesture}
        {...stableRefs} />
    </div>,
  );
}

function tap(host, x = 30, y = 40) {
  fireEvent.touchStart(host, { touches: [{ clientX: x, clientY: y }] });
  fireEvent.touchEnd(host, { changedTouches: [{ clientX: x, clientY: y }] });
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
    expect(term.buffer.active.type).toBeUndefined(); // normal screen
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

  it('Shift+wheel keeps the raw PageUp/PageDown escape hatch for the TUI viewport', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    term.buffer.active.type = 'alternate';
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ height: 300, width: 400, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} });
    fireEvent.wheel(host, { deltaY: -300, shiftKey: true });
    fireEvent.wheel(host, { deltaY: 300, shiftKey: true });
    expect(fixture.inputs).toEqual(['\x1b[5~', '\x1b[6~']);
    expect(fixture.actions).toEqual([]);
  });

  it('Shift+wheel on the normal screen stays server-side', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    fireEvent.wheel(host, { deltaY: -24, shiftKey: true });
    expect(fixture.actions).toEqual(['scroll-up']);
    expect(fixture.inputs).toEqual([]);
  });

  it('does not reinterpret an alternate-screen page remainder as line ticks after a mode change', () => {
    const view = renderTerminal();
    const host = view.container.querySelector('.nc-terminal-host');
    const term = fixture.instances[0];
    term.buffer.active.type = 'alternate';
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ height: 300, width: 400, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON() {} });
    fireEvent.wheel(host, { deltaY: -290, shiftKey: true }); // page remainder: +290, no action
    expect(fixture.inputs).toEqual([]);
    fireEvent.wheel(host, { deltaY: -1 }); // releasing Shift switches mode: line delta only
    expect(fixture.actions).toEqual([]);
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
