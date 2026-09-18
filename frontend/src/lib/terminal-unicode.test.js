import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  TERMINAL_WIDTH_VERSION, createTerminalWidthProvider, registerTerminalWidth,
} from './terminal-unicode.js';

// The widths the terminal must use, and why they are not xterm's defaults.
//
// Measured case (reported 2026-09-13): after a wide character the glyphs on the
// phone went stale until a zoom forced a repaint. The cause was a width
// disagreement: xterm 6.0.0's default provider (UnicodeV6) answers width 1 for
// emoji such as U+1F7E2, so the cell grid the renderer builds and the cell grid
// tmux builds (glibc rules: East Asian Wide = 2) put every following glyph one
// column apart — one column of stale pixels each.
//
// The provider below is the same contract xterm documents
// (IUnicodeVersionProvider: version + wcwidth + charProperties) with widths
// aligned to the terminal on the other side of the wire.

function provider() {
  return createTerminalWidthProvider();
}

function bufferWidths(term, text, count) {
  return new Promise((resolve) => {
    term.write(text, () => {
      const line = term.buffer.active.getLine(0);
      const cells = [];
      for (let i = 0; i < count; i += 1) {
        const cell = line.getCell(i);
        cells.push(cell ? { chars: cell.getChars(), width: cell.getWidth() } : null);
      }
      resolve(cells);
    });
  });
}

describe('terminal width provider — wcwidth', () => {
  it('every emoji of the measured case is two columns wide', () => {
    const wcwidth = provider().wcwidth;
    for (const cp of [0x1F7E2, 0x1F4CC, 0x1F4E7, 0x1F4C5, 0x23F0, 0x2753, 0x23F3]) {
      expect([cp.toString(16), wcwidth(cp)]).toEqual([cp.toString(16), 2]);
    }
  });

  it('box drawing stays one column, ASCII stays one, combining marks are zero', () => {
    const wcwidth = provider().wcwidth;
    expect(wcwidth(0x2501)).toBe(1);        // ━ heavy horizontal
    expect(wcwidth(0x2500)).toBe(1);        // ─ light horizontal
    expect(wcwidth(0x61)).toBe(1);          // a
    expect(wcwidth(0x20)).toBe(1);          // space
    expect(wcwidth(0x301)).toBe(0);         // combining acute
    expect(wcwidth(0xFE0F)).toBe(0);        // variation selector-16
    expect(wcwidth(0x300)).toBe(0);         // combining grave
  });

  it('zero-width format characters take no column, like the producer', () => {
    const wcwidth = provider().wcwidth;
    // glibc wcwidth = 0 for all of these (measured with libc through ctypes);
    // xterm's default provider answers 1 for them, which shifts every emoji
    // sequence that uses a joiner by one column per joiner.
    for (const cp of [
      0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
      0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
      0xFEFF, 0x1BCA0, 0x1D173, 0xE0001, 0xE0020, 0xE007F,
      0x1160, 0x119E, 0x11FF, // Hangul medial/final jamo: glibc counts 0
    ]) {
      expect([cp.toString(16), wcwidth(cp)]).toEqual([cp.toString(16), 0]);
    }
    // Measured the other way round: these are NOT zero.
    expect(wcwidth(0x00AD)).toBe(1);   // soft hyphen: glibc counts one column
    expect(wcwidth(0x1F1E6)).toBe(1);  // regional indicators: one column each, so
    expect(wcwidth(0x1F1FF)).toBe(1);  // a flag pair is two — and not four
    expect(wcwidth(0x1100)).toBe(2);   // leading jamo stay wide
  });

  it('a joined emoji sequence occupies the columns the producer counts (6)', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 3 });
    registerTerminalWidth(term);
    const cells = await bufferWidths(term, '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}|', 10);
    // 2 + 0 + 2 + 0 + 2, as tmux counts it: the family, then the pipe.
    const pipe = cells.findIndex((cell) => cell && cell.chars === '|');
    expect(pipe).toBe(6);
    // The joiner takes no cell of its own: the three glyphs sit in the cells
    // the producer's columns put them in, two columns each.
    // The joiner is absorbed into the glyph before it (no cell of its own), and
    // the three glyphs land in the columns the producer's count puts them in.
    expect(cells[0].chars).toContain('\u{1F468}');
    expect(cells[0].chars).toContain('\u200D');
    expect(cells[2].chars).toContain('\u{1F469}');
    expect(cells[4].chars).toContain('\u{1F467}');
    expect(cells[0].width).toBe(2);
    term.dispose();
  });

  it('declares its own version and mirrors it through charProperties', () => {
    const p = provider();
    expect(typeof p.version).toBe('string');
    expect(p.version).not.toBe('6');        // never shadow xterm's default name
    const props = p.charProperties(0x1F4CC, 0);
    expect(((props >> 1) & 3)).toBe(2);     // width bits, same layout xterm uses
    // A zero-width mark after a wide cell inherits the wide width and joins,
    // exactly as the default provider's arithmetic does.
    const joined = p.charProperties(0x301, p.charProperties(0x1F4CC, 0));
    expect((joined & 1)).toBe(1);
    expect(((joined >> 1) & 3)).toBe(2);
  });
});

describe('terminal width provider — the real xterm buffer', () => {
  it('places the character after an emoji in column 2, not column 1', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 3 });
    registerTerminalWidth(term);
    const cells = await bufferWidths(term, '\u{1F7E2}ab', 4);
    expect(cells[0].chars).toBe('\u{1F7E2}');
    expect(cells[0].width).toBe(2);
    expect(cells[1].chars).toBe('');        // the second half of the wide cell
    expect(cells[2].chars).toBe('a');
    expect(cells[3].chars).toBe('b');
    term.dispose();
  });

  it('NEGATIVE: xterm 6.0.0 default puts it in column 1 — the defect being fixed', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 3 });
    const cells = await bufferWidths(term, '\u{1F7E2}ab', 4);
    expect(cells[0].width).toBe(1);
    expect(cells[1].chars).toBe('a');
    term.dispose();
  });

  it('is registered on the terminal under its own version and becomes active', () => {
    const term = new Terminal({ allowProposedApi: true, cols: 10, rows: 2 });
    registerTerminalWidth(term);
    expect(term.unicode.activeVersion).toBe(TERMINAL_WIDTH_VERSION);
    expect(term.unicode.versions).toContain(TERMINAL_WIDTH_VERSION);
    term.dispose();
  });
});
