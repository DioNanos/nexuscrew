import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import KeyBar from './KeyBar.jsx';
import * as virtualKeyboard from '../lib/virtual-keyboard.js';

// D384 — spia il dismiss della tastiera: CTRL e ALT non devono più chiamarlo.
vi.mock('../lib/virtual-keyboard.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, dismissVirtualKeyboard: vi.fn(() => ({ blurred: false, apiRequested: false })) };
});

function renderKeyBar(overrides = {}) {
  const props = {
    send: vi.fn(), action: vi.fn(), onKeyboard: vi.fn(), onCtrl: vi.fn(),
    onSelectionMode: vi.fn(), ...overrides,
  };
  const view = render(<KeyBar {...props} />);
  return { ...view, props };
}

describe('KeyBar mobile Enter column', () => {
  it('keeps two aligned eight-key rows and places ENTER after PGUP/PGDN', () => {
    const { container } = renderKeyBar();
    const grid = container.querySelector('.nc-keygrid');
    const rows = [...grid.querySelectorAll('.nc-keyrows > .row')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => within(row).getAllByRole('button').length)).toEqual([8, 8]);
    expect(within(rows[0]).getAllByRole('button').at(-1).textContent).toBe('PGUP');
    expect(within(rows[1]).getAllByRole('button').at(-1).textContent).toBe('PGDN');
    const enter = screen.getByRole('button', { name: 'ENTER' });
    expect(enter.classList.contains('nc-enter-key')).toBe(true);
    expect(enter.parentElement).toBe(grid);
    expect(enter.previousElementSibling.classList.contains('nc-keyrows')).toBe(true);
  });

  it('sends carriage return without opening the keyboard or taking pointer focus', () => {
    const { props } = renderKeyBar();
    const input = document.createElement('textarea'); document.body.appendChild(input); input.focus();
    // il dismiss reale è mockato a livello di file: qui si prova che ENTER non
    // PRENDA il focus (preventDefault), non che chiuda la tastiera (test D384 sotto)
    input.blur();
    const enter = screen.getByRole('button', { name: 'ENTER' });
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    enter.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(document.activeElement).not.toBe(enter);
    expect(props.send).toHaveBeenCalledOnce();
    expect(props.send).toHaveBeenCalledWith('\r');
    expect(props.onKeyboard).not.toHaveBeenCalled();
  });

  it('preserves sticky ALT semantics for ENTER', () => {
    const { props } = renderKeyBar();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ALT' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ENTER' }));
    expect(props.send).toHaveBeenCalledWith('\x1b\r');
    expect(screen.getByRole('button', { name: 'ALT' }).classList.contains('armed')).toBe(false);
  });

  it('lets Settings hide only the tall Enter column', () => {
    const { container } = renderKeyBar({ showEnter: false });
    expect(screen.queryByRole('button', { name: 'ENTER' })).toBeNull();
    expect(container.querySelector('.nc-keygrid').classList.contains('no-enter')).toBe(true);
    expect(container.querySelectorAll('.nc-keyrows > .row')).toHaveLength(2);
  });
});

describe('KeyBar compact layout', () => {
  function label(button) {
    return button.getAttribute('aria-label') || button.textContent || '';
  }

  it('renders one compact row in the exact order plus the tall Enter', () => {
    const { container } = renderKeyBar({ keybarLayout: 'compact' });
    const grid = container.querySelector('.nc-keygrid');
    expect(grid.classList.contains('compact')).toBe(true);
    const rows = [...grid.querySelectorAll('.nc-keyrows > .row')];
    expect(rows).toHaveLength(1);
    const rowButtons = within(rows[0]).getAllByRole('button');
    expect(rowButtons.map(label)).toEqual([
      'expand the key bar', '⌨', '☰', '↑', '↓', '←', '→', 'PGUP', 'PGDN',
    ]);
    const enter = screen.getByRole('button', { name: 'ENTER' });
    expect(enter.classList.contains('nc-enter-key')).toBe(true);
    expect(enter.parentElement).toBe(grid);
    expect(enter.previousElementSibling.classList.contains('nc-keyrows')).toBe(true);
  });

  it('sends a direct carriage return from the compact Enter without focusing text', () => {
    const { props } = renderKeyBar({ keybarLayout: 'compact' });
    const input = document.createElement('textarea'); document.body.appendChild(input); input.focus();
    // dismiss mockato a livello di file: l'assert qui è che ENTER non prende il focus
    input.blur();
    const enter = screen.getByRole('button', { name: 'ENTER' });
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    enter.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
    expect(document.activeElement).not.toBe(enter);
    expect(props.send).toHaveBeenCalledOnce();
    expect(props.send).toHaveBeenCalledWith('\r');
    expect(props.onKeyboard).not.toHaveBeenCalled();
  });

  it('hides Enter in compact without leaving a gap', () => {
    const { container } = renderKeyBar({ keybarLayout: 'compact', showEnter: false });
    expect(screen.queryByRole('button', { name: 'ENTER' })).toBeNull();
    expect(container.querySelector('.nc-keygrid').classList.contains('no-enter')).toBe(true);
    expect(container.querySelectorAll('.nc-keyrows > .row')).toHaveLength(1);
  });

  it('expand switches to the exact full layout and retract returns to compact without rewriting the preference', () => {
    const { container } = renderKeyBar({ keybarLayout: 'compact' });
    const grid = container.querySelector('.nc-keygrid');
    expect(grid.classList.contains('compact')).toBe(true);

    // expand -> temporary full layout (exact 8+8) + retract affordance
    fireEvent.pointerDown(screen.getByRole('button', { name: 'expand the key bar' }));
    const fullGrid = container.querySelector('.nc-keygrid');
    expect(fullGrid.classList.contains('expanded')).toBe(true);
    expect(fullGrid.classList.contains('compact')).toBe(false);
    const rows = [...fullGrid.querySelectorAll('.nc-keyrows > .row')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => within(row).getAllByRole('button').length)).toEqual([8, 8]);
    expect(within(rows[0]).getAllByRole('button').at(-1).textContent).toBe('PGUP');
    expect(within(rows[1]).getAllByRole('button').at(-1).textContent).toBe('PGDN');
    expect(screen.getByRole('button', { name: 'retract the key bar' })).toBeTruthy();

    // retract -> back to the compact row; keybarLayout prop unchanged (local state only)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'retract the key bar' }));
    const backGrid = container.querySelector('.nc-keygrid');
    expect(backGrid.classList.contains('compact')).toBe(true);
    expect(backGrid.classList.contains('expanded')).toBe(false);
    expect(backGrid.querySelectorAll('.nc-keyrows > .row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'retract the key bar' })).toBeNull();
  });

  it('drops temporary expansion across a compact -> full -> compact preference cycle', () => {
    const props = { send: vi.fn(), action: vi.fn(), onKeyboard: vi.fn(), onCtrl: vi.fn(), onSelectionMode: vi.fn() };
    const view = render(<KeyBar {...props} keybarLayout="compact" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'expand the key bar' }));
    expect(view.container.querySelector('.nc-keygrid').classList.contains('expanded')).toBe(true);

    view.rerender(<KeyBar {...props} keybarLayout="full" />);
    expect(view.container.querySelector('.nc-keygrid').classList.contains('expanded')).toBe(false);
    view.rerender(<KeyBar {...props} keybarLayout="compact" />);
    expect(view.container.querySelector('.nc-keygrid').classList.contains('compact')).toBe(true);
    expect(screen.queryByRole('button', { name: 'retract the key bar' })).toBeNull();
  });

  it('fires once on a keyboard/screen-reader click with detail 0 (no pointerdown)', () => {
    const { props } = renderKeyBar({ keybarLayout: 'compact' });
    const pgdn = screen.getByText('PGDN');
    fireEvent.click(pgdn, { detail: 0 });
    expect(props.send).toHaveBeenCalledOnce();
    expect(props.send).toHaveBeenCalledWith('\x1b[6~');
  });

  it('does not double-fire when a real pointer click (detail > 0) follows pointerdown', () => {
    const { props } = renderKeyBar({ keybarLayout: 'compact' });
    const pgdn = screen.getByText('PGDN');
    fireEvent.pointerDown(pgdn);
    fireEvent.click(pgdn, { detail: 1 });
    expect(props.send).toHaveBeenCalledOnce();
    expect(props.send).toHaveBeenCalledWith('\x1b[6~');
  });
});

describe('KeyBar navigation repeat', () => {
  function startRepeat(button) {
    fireEvent.pointerDown(button);
    act(() => vi.advanceTimersByTime(350));
  }

  it('repeats a held navigation key after the initial delay and stops on release', () => {
    vi.useFakeTimers();
    try {
      const { props } = renderKeyBar();
      const right = screen.getByText('→');
      fireEvent.pointerDown(right);
      expect(props.send).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(349));
      expect(props.send).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(1));
      expect(props.send).toHaveBeenCalledTimes(2);
      act(() => vi.advanceTimersByTime(110));
      expect(props.send).toHaveBeenCalledTimes(4);
      expect(props.send).toHaveBeenLastCalledWith('\x1b[C');

      fireEvent.pointerUp(right);
      act(() => vi.advanceTimersByTime(500));
      expect(props.send).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
    ['PGUP', '\x1b[5~'], ['PGDN', '\x1b[6~'],
  ])('repeats the supported %s key', (label, seq) => {
    vi.useFakeTimers();
    try {
      const { props } = renderKeyBar();
      const button = screen.getByText(label);
      startRepeat(button);
      expect(props.send).toHaveBeenCalledTimes(2);
      expect(props.send).toHaveBeenNthCalledWith(1, seq);
      expect(props.send).toHaveBeenNthCalledWith(2, seq);
      fireEvent.pointerUp(button);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['leaves the button', (button) => fireEvent.pointerLeave(button)],
    ['is cancelled', (button) => fireEvent.pointerCancel(button)],
    ['gets a touchcancel', (button) => fireEvent.touchCancel(button)],
    ['loses window focus', () => window.dispatchEvent(new Event('blur'))],
  ])('stops a repeat when the gesture %s', (_label, stop) => {
    vi.useFakeTimers();
    try {
      const { props } = renderKeyBar();
      const pgdn = screen.getByText('PGDN');
      startRepeat(pgdn);
      expect(props.send).toHaveBeenCalledTimes(2);
      stop(pgdn);
      act(() => vi.advanceTimersByTime(500));
      expect(props.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a repeat when the page becomes hidden', () => {
    vi.useFakeTimers();
    const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      const { props } = renderKeyBar();
      const left = screen.getByText('←');
      startRepeat(left);
      expect(props.send).toHaveBeenCalledTimes(2);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      act(() => vi.advanceTimersByTime(500));
      expect(props.send).toHaveBeenCalledTimes(2);
    } finally {
      if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor);
      vi.useRealTimers();
    }
  });

  it('keeps Escape, Enter, Ctrl and Alt as one-shot controls', () => {
    vi.useFakeTimers();
    try {
      const { props } = renderKeyBar();
      const esc = screen.getByText('ESC');
      fireEvent.pointerDown(esc);
      act(() => vi.advanceTimersByTime(600));
      expect(props.send).toHaveBeenCalledTimes(1);
      expect(props.send).toHaveBeenLastCalledWith('\x1b');

      const enter = screen.getByRole('button', { name: 'ENTER' });
      fireEvent.pointerDown(enter);
      act(() => vi.advanceTimersByTime(600));
      expect(props.send).toHaveBeenCalledTimes(2);
      expect(props.send).toHaveBeenLastCalledWith('\r');

      const ctrl = screen.getByText('CTRL');
      fireEvent.pointerDown(ctrl);
      act(() => vi.advanceTimersByTime(600));
      expect(props.onCtrl).toHaveBeenCalledOnce();

      const alt = screen.getByText('ALT');
      fireEvent.pointerDown(alt);
      act(() => vi.advanceTimersByTime(600));
      expect(alt.classList.contains('armed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('KeyBar cell switcher', () => {
  it('replaces the redundant keyboard key when a mobile cell switcher is available', () => {
    const onCellSwitcher = vi.fn();
    render(<KeyBar send={vi.fn()} action={vi.fn()} onCtrl={vi.fn()} onSelectionMode={vi.fn()}
      onCellSwitcher={onCellSwitcher} cellSwitcherOpen={false} />);
    const button = screen.getByRole('button', { name: /celle|cells/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.pointerDown(button);
    expect(onCellSwitcher).toHaveBeenCalledOnce();
  });
});


describe('KeyBar D384 — CTRL e ALT tengono/aprono la tastiera', () => {
  beforeEach(() => { vi.mocked(virtualKeyboard.dismissVirtualKeyboard).mockClear(); });

  it('CTRL non chiude la tastiera e chiede l\'apertura', () => {
    // la classe «armed» è pilotata dalla prop ctrlArmed (lo sticky lo tiene App via toggleCtrl)
    const { props } = renderKeyBar({ ctrlArmed: true, onKeyboardKeep: vi.fn() });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'CTRL' }));
    expect(virtualKeyboard.dismissVirtualKeyboard).not.toHaveBeenCalled();
    expect(props.onKeyboardKeep).toHaveBeenCalledOnce();
    expect(props.onCtrl).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'CTRL' }).classList.contains('armed')).toBe(true);
  });

  it('ALT non chiude la tastiera, chiede l\'apertura e resta sticky per un tasto', () => {
    const { props } = renderKeyBar({ onKeyboardKeep: vi.fn() });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ALT' }));
    expect(virtualKeyboard.dismissVirtualKeyboard).not.toHaveBeenCalled();
    expect(props.onKeyboardKeep).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'ALT' }).classList.contains('armed')).toBe(true);
    // il prossimo tasto della barra esce come Meta e disarma ALT (invariato)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ESC' }));
    expect(props.send).toHaveBeenCalledWith('\x1b\x1b');
    expect(screen.getByRole('button', { name: 'ALT' }).classList.contains('armed')).toBe(false);
  });

  it('ESC continua a chiudere la tastiera (dismiss), senza chiedere aperture', () => {
    const { props } = renderKeyBar({ onKeyboardKeep: vi.fn() });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ESC' }));
    expect(virtualKeyboard.dismissVirtualKeyboard).toHaveBeenCalledOnce();
    expect(props.onKeyboardKeep).not.toHaveBeenCalled();
    expect(props.send).toHaveBeenCalledWith('\x1b');
  });

  it('con keepKeyboardClosed=false ESC non chiama il dismiss (comportamento invariato)', () => {
    renderKeyBar({ keepKeyboardClosed: false, onKeyboardKeep: vi.fn() });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'ESC' }));
    expect(virtualKeyboard.dismissVirtualKeyboard).not.toHaveBeenCalled();
  });
});
