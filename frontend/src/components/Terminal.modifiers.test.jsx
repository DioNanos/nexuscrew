// Terminal con modificatori armati:
// 1) il throw sincrono di openTerminalSocket (ws-client: origine non-locale su
//    ws://) azzera keyboardRef e rimuove i listener (blur e paste);
// 2) il paste NATIVO di xterm (clipboard → evento paste → onData sincrono) è
//    letterale e NON consuma l'armamento (prima incollare mandava ESC+^C+resto);
// 3) GridTile/CellPeek passano SOLO ctrlRef: il blocco non deve toccare altRef.
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';

let lanciaOpen = false;
const ultimaSock = { sendInput: null };

vi.mock('../lib/ws-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openTerminalSocket: vi.fn(() => {
      if (lanciaOpen) throw new Error('nexuscrew: ws:// rifiutato su origine non-locale e non-TLS');
      const sock = {
        sendInput: vi.fn(),
        resize: vi.fn(),
        isReady: () => true,
        action: vi.fn(),
        close: vi.fn(),
      };
      ultimaSock.sendInput = sock.sendInput;
      return sock;
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

function mountTerminal(overrides = {}) {
  const refs = {
    sendRef: { current: () => false },
    composerRef: { current: () => false },
    actionRef: { current: () => {} },
    ctrlRef: { current: false },
    altRef: { current: false },
    setCtrlArmed: vi.fn(),
    setAltArmed: vi.fn(),
    keyboardRef: { current: null },
    ...overrides,
  };
  function Wrapped() {
    const [ctrlArmed, setCtrlArmed] = useState(refs.ctrlRef.current);
    const [altArmed, setAltArmed] = useState(false);
    return (
      <Terminal session="s" node="n" token="t" readonly={false} takeSize
        sendRef={refs.sendRef} composerRef={refs.composerRef} actionRef={refs.actionRef}
        ctrlRef={refs.ctrlRef} setCtrlArmed={setCtrlArmed} altRef={refs.altRef}
        setAltArmed={setAltArmed} keyboardRef={refs.keyboardRef} />
    );
  }
  return { view: render(<Wrapped />), refs };
}

function textarea() {
  const ta = document.querySelector('.xterm-helper-textarea');
  expect(ta).toBeTruthy();
  return ta;
}

describe('Terminal — openTerminalSocket che lancia', () => {
  afterEach(() => { vi.restoreAllMocks(); lanciaOpen = false; });

  it('azzeramento keyboardRef e rimozione dei listener di blur e paste nel ramo d\'errore', () => {
    lanciaOpen = true;
    const removeSpy = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const keyboardRef = { current: null };
    mountTerminal({ keyboardRef });
    // il ref dev'essere stato AZZERATO dal ramo d'errore (prima del fix restava
    // la funzione requestTerminalKeyboard di un terminale non connesso)
    expect(keyboardRef.current).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('paste', expect.any(Function), true);
  });
});

describe('Terminal — modificatori armati e paste nativo', () => {
  afterEach(() => { vi.restoreAllMocks(); lanciaOpen = false; });

  it('paste NATIVO con CTRL armato: letterale e non consuma l\'armamento', () => {
    const ctrlRef = { current: true };
    mountTerminal({ ctrlRef });
    fireEvent.paste(textarea(), { clipboardData: { getData: () => 'ciao' } });
    // letterale: il testo incollato esce così com'è, senza ESC né prefissi di controllo
    expect(ultimaSock.sendInput).toHaveBeenCalledWith('ciao');
    // e non consuma l'armamento: resta pronto per un vero carattere controllato
    expect(ctrlRef.current).toBe(true);
  });

  it('paste NATIVO senza modificatori: letterale uguale', () => {
    mountTerminal({});
    fireEvent.paste(textarea(), { clipboardData: { getData: () => 'ciao' } });
    expect(ultimaSock.sendInput).toHaveBeenCalledWith('ciao');
  });

  it('solo ctrlRef (GridTile/CellPeek): CTRL+c → \\x03 senza toccare altRef assente', () => {
    const ctrlRef = { current: true };
    mountTerminal({ ctrlRef, altRef: undefined, setAltArmed: undefined });
    // nessun TypeError: la guardia su altRef (da audit) deve reggere
    fireEvent.keyDown(textarea(), { key: 'c', keyCode: 67, which: 67 });
    expect(ultimaSock.sendInput).toHaveBeenCalledWith('\x03');
  });
});

describe('Terminal — il marcatore del paste si chiude al primo onData', () => {
  afterEach(() => { vi.restoreAllMocks(); lanciaOpen = false; });

  it('probe audit: paste «ciao» poi keydown a +50 ms → [\'ciao\', \'\x03\'] e CTRL disarmato', async () => {
    const ctrlRef = { current: true };
    mountTerminal({ ctrlRef });
    fireEvent.paste(textarea(), { clipboardData: { getData: () => 'ciao' } });
    await new Promise((r) => setTimeout(r, 50));   // il tasto arriva a +50 ms dal paste
    fireEvent.keyDown(textarea(), { key: 'c', keyCode: 67, which: 67 });
    const chiamate = ultimaSock.sendInput.mock.calls.map((c) => c[0]);
    // PRIMA del commit 4 il marcatore a tempo teneva «c» come incollatura: ['ciao', 'c']
    expect(chiamate).toEqual(['ciao', '\x03']);
    expect(ctrlRef.current).toBe(false);
  });

  it('paste senza onData: il keydown dopo chiude il marcatore e resta una digitazione', async () => {
    const ctrlRef = { current: true };
    mountTerminal({ ctrlRef });
    // clipboardData vuota: il marcatore si arma ma xterm non emette nessun onData
    fireEvent.paste(textarea(), { clipboardData: { getData: () => '' } });
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.keyDown(textarea(), { key: 'c', keyCode: 67, which: 67 });
    // xterm emette onData anche per il paste vuoto ('' = no-op sul PTY) e QUEL
    // primo onData chiude il marcatore, come da progetto
    const con_contenuto = ultimaSock.sendInput.mock.calls.map((c) => c[0]).filter((s) => s !== '');
    expect(con_contenuto).toEqual(['\x03']);
    expect(ctrlRef.current).toBe(false);
  });
});
