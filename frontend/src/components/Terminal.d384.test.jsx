// D384 (rilievo DevAuditor) — il throw sincrono di openTerminalSocket
// (ws-client: origine non-locale su ws://) non deve lasciare indietro il
// keyboardRef né il listener di blur registrati prima della connessione.
import React, { useState } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';

vi.mock('../lib/ws-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openTerminalSocket: vi.fn(() => {
      throw new Error('nexuscrew: ws:// rifiutato su origine non-locale e non-TLS');
    }),
  };
});

import Terminal from './Terminal.jsx'; // noqa: E402 (dopo il mock)

// jsdom non ha matchMedia né canvas 2D: xterm li richiede al mount (il renderer
// ricade su DOM se getContext non è disponibile).
beforeAll(() => {
  window.matchMedia = window.matchMedia || ((query) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
});

function mountTerminal(keyboardRef) {
  const refs = {
    sendRef: { current: () => false },
    composerRef: { current: () => false },
    actionRef: { current: () => {} },
    ctrlRef: { current: false },
    altRef: { current: false },
    keyboardRef,
  };
  function Wrapped() {
    const [ctrlArmed, setCtrlArmed] = useState(false);
    const [altArmed, setAltArmed] = useState(false);
    return (
      <Terminal session="s" node="n" token="t" readonly={false} takeSize
        sendRef={refs.sendRef} composerRef={refs.composerRef} actionRef={refs.actionRef}
        ctrlRef={refs.ctrlRef} setCtrlArmed={setCtrlArmed} altRef={refs.altRef}
        setAltArmed={setAltArmed} keyboardRef={refs.keyboardRef} />
    );
  }
  return render(<Wrapped />);
}

describe('Terminal D384 — openTerminalSocket che lancia', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('azzeramento keyboardRef e rimozione del listener di blur nel ramo d\'errore', () => {
    const removeSpy = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const keyboardRef = { current: null };
    mountTerminal(keyboardRef);
    // il ref dev'essere stato AZZERATO dal ramo d'errore (prima del fix restava
    // la funzione requestTerminalKeyboard di un terminale non connesso)
    expect(keyboardRef.current).toBeNull();
    // e il listener di blur di xterm è stato rimosso
    expect(removeSpy).toHaveBeenCalledWith('blur', expect.any(Function));
  });
});
