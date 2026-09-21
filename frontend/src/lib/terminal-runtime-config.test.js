import { describe, expect, it, beforeEach } from 'vitest';

// F2 — i parametri del terminale arrivano dalla config del server. Un valore
// assente o non sensato NON deve entrare: resta il default.

import {
  TERMINAL_RUNTIME_DEFAULTS, sanitizeTerminalConfig, setTerminalRuntimeConfig, terminalRuntimeConfig,
} from './terminal-runtime-config.js';

beforeEach(() => { setTerminalRuntimeConfig(null); });

describe('parametri del terminale dalla config', () => {
  it('senza config valgono i default documentati', () => {
    expect(terminalRuntimeConfig()).toEqual(TERMINAL_RUNTIME_DEFAULTS);
  });

  it('una config valida viene usata', () => {
    setTerminalRuntimeConfig({ retryBaseMs: 10, retryMaxMs: 20, pingMs: 30, deadMs: 40, queuedInputBytes: 50, overlayDelayMs: 60 });
    expect(terminalRuntimeConfig()).toEqual({ retryBaseMs: 10, retryMaxMs: 20, pingMs: 30, deadMs: 40, queuedInputBytes: 50, overlayDelayMs: 60 });
  });

  it('valori non numerici, negativi o zero NON entrano: resta il default', () => {
    const out = sanitizeTerminalConfig({ retryBaseMs: 'x', retryMaxMs: -1, pingMs: 0, deadMs: null, queuedInputBytes: undefined });
    expect(out.retryBaseMs).toBe(TERMINAL_RUNTIME_DEFAULTS.retryBaseMs);
    expect(out.retryMaxMs).toBe(TERMINAL_RUNTIME_DEFAULTS.retryMaxMs);
    expect(out.pingMs).toBe(TERMINAL_RUNTIME_DEFAULTS.pingMs);
    expect(out.deadMs).toBe(TERMINAL_RUNTIME_DEFAULTS.deadMs);
    expect(out.queuedInputBytes).toBe(TERMINAL_RUNTIME_DEFAULTS.queuedInputBytes);
  });

  it('un valore parziale non azzera gli altri', () => {
    const out = sanitizeTerminalConfig({ pingMs: 111 });
    expect(out.pingMs).toBe(111);
    expect(out.deadMs).toBe(TERMINAL_RUNTIME_DEFAULTS.deadMs);
  });

  it('una config di tipo sbagliato non rompe nulla', () => {
    for (const bad of [null, undefined, 'x', 4, []]) {
      expect(sanitizeTerminalConfig(bad)).toEqual(TERMINAL_RUNTIME_DEFAULTS);
    }
  });
});
