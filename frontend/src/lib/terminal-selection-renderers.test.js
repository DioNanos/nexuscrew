import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { handlePositions, rangeFromXterm } from './selection-handles.js';

// Selection and handles in BOTH renderers.
//
// The GPU renderer replaces the DOM rows with a canvas: `.xterm-rows` stops
// existing. Measured first (git grep, this branch): nothing in the selection or
// handle code reads `.xterm-rows` — the geometry comes from `.xterm-screen`,
// which both renderers provide, and the truth of the selection comes from the
// buffer through term.getSelectionPosition(). These tests pin that shape: they
// build the WebGL DOM (screen present, rows removed) and check the pipeline
// still produces handle positions.
// jsdom has no matchMedia and xterm's DOM renderer asks for it on open().
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = () => ({
    matches: false, media: '',
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
}

function webglDomShape(host) {
  const screen = host.querySelector('.xterm-screen');
  expect(screen).toBeTruthy();
  const rows = host.querySelector('.xterm-rows');
  if (rows) rows.remove();               // what WebGL leaves behind: no rows
  return screen;
}

function measuresOf(screen, cols, rows) {
  // Stand-in for getBoundingClientRect in jsdom, where layout is not computed:
  // the geometry chain takes numbers, never the DOM, so this is the whole input.
  const rect = { left: 4, top: 12, width: cols * 9, height: rows * 18 };
  screen.getBoundingClientRect = () => rect;
  return { rect, cellWidth: rect.width / cols, cellHeight: rect.height / rows };
}

describe('selection geometry with the WebGL DOM shape', () => {
  it('produces handle positions with no .xterm-rows in the DOM at all', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 4 });
    term.open(host);
    const screen = webglDomShape(host);
    const { cellWidth, cellHeight } = measuresOf(screen, 20, 4);

    term.select(2, 0, 3);
    const range = rangeFromXterm(term.getSelectionPosition(), 20);
    const positions = handlePositions({
      range, viewportY: 0, rows: 4, cols: 20, cellWidth, cellHeight, screenLeft: 4, screenTop: 12,
    });

    expect(positions.start.visible).toBe(true);
    expect(positions.end.visible).toBe(true);
    // Start on the first selected cell, end one cell past the last one.
    expect(positions.start.left).toBe(4 + 2 * cellWidth);
    expect(positions.end.left).toBe(4 + 5 * cellWidth);
    term.dispose();
    host.remove();
  });

  it('keeps selecting through the buffer, not through the DOM', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal({ allowProposedApi: true, cols: 20, rows: 4 });
    term.open(host);
    webglDomShape(host);

    term.write('hello', () => {
      term.select(0, 0, 5);
      expect(term.getSelection()).toBe('hello');
      term.dispose();
      host.remove();
    });
  });
});
