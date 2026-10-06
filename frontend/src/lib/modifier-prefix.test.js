// I prefissi di CTRL/ALT sul primo carattere dell'input soft.
import { describe, expect, it } from 'vitest';

import { inputConPrefissi } from './modifier-prefix.js';

describe('inputConPrefissi', () => {
  it('solo CTRL: la lettera diventa il carattere di controllo (c → \\x03)', () => {
    expect(inputConPrefissi('c', { ctrl: true })).toBe('\x03');
    expect(inputConPrefissi('C', { ctrl: true })).toBe('\x03');
    expect(inputConPrefissi(' ', { ctrl: true })).toBe('\x00');
    expect(inputConPrefissi('[', { ctrl: true })).toBe('\x1b');
  });

  it('solo ALT: ESC + carattere (x → \\x1b x)', () => {
    expect(inputConPrefissi('x', { alt: true })).toBe('\x1bx');
  });

  it('CTRL + ALT: ESC + carattere di controllo (c → \\x1b\\x03)', () => {
    expect(inputConPrefissi('c', { ctrl: true, alt: true })).toBe('\x1b\x03');
  });

  it('il prefisso vale solo per il primo carattere: il resto esce pulito (IME/parole intere)', () => {
    expect(inputConPrefissi('ciao', { ctrl: true, alt: true })).toBe('\x1b\x03iao');
    expect(inputConPrefissi('ciao', { ctrl: true })).toBe('\x03iao');
  });

  it('nessun modificatore armato: la stringa passa identica (disarmo = nessun prefisso)', () => {
    expect(inputConPrefissi('c', {})).toBe('c');
    expect(inputConPrefissi('c', { ctrl: false, alt: false })).toBe('c');
  });

  it('carattere fuori dalle tabelle di controllo con CTRL: esce senza conversione', () => {
    // le cifre non sono nella tabella a-z / @A-Z[\]^_ / spazio: restano sé stesse
    expect(inputConPrefissi('1', { ctrl: true })).toBe('1');
  });
});
