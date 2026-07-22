import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import KeyBar from './KeyBar.jsx';

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
    const enter = screen.getByRole('button', { name: 'ENTER' });
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    enter.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
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
      'expand keybar', '⌨', '☰', '↑', '↓', '←', '→', 'PGUP', 'PGDN',
    ]);
    const enter = screen.getByRole('button', { name: 'ENTER' });
    expect(enter.classList.contains('nc-enter-key')).toBe(true);
    expect(enter.parentElement).toBe(grid);
    expect(enter.previousElementSibling.classList.contains('nc-keyrows')).toBe(true);
  });

  it('sends a direct carriage return from the compact Enter without focusing text', () => {
    const { props } = renderKeyBar({ keybarLayout: 'compact' });
    const input = document.createElement('textarea'); document.body.appendChild(input); input.focus();
    const enter = screen.getByRole('button', { name: 'ENTER' });
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    enter.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(input);
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
    fireEvent.pointerDown(screen.getByRole('button', { name: 'expand keybar' }));
    const fullGrid = container.querySelector('.nc-keygrid');
    expect(fullGrid.classList.contains('expanded')).toBe(true);
    expect(fullGrid.classList.contains('compact')).toBe(false);
    const rows = [...fullGrid.querySelectorAll('.nc-keyrows > .row')];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => within(row).getAllByRole('button').length)).toEqual([8, 8]);
    expect(within(rows[0]).getAllByRole('button').at(-1).textContent).toBe('PGUP');
    expect(within(rows[1]).getAllByRole('button').at(-1).textContent).toBe('PGDN');
    expect(screen.getByRole('button', { name: 'retract keybar' })).toBeTruthy();

    // retract -> back to the compact row; keybarLayout prop unchanged (local state only)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'retract keybar' }));
    const backGrid = container.querySelector('.nc-keygrid');
    expect(backGrid.classList.contains('compact')).toBe(true);
    expect(backGrid.classList.contains('expanded')).toBe(false);
    expect(backGrid.querySelectorAll('.nc-keyrows > .row')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'retract keybar' })).toBeNull();
  });

  it('drops temporary expansion across a compact -> full -> compact preference cycle', () => {
    const props = { send: vi.fn(), action: vi.fn(), onKeyboard: vi.fn(), onCtrl: vi.fn(), onSelectionMode: vi.fn() };
    const view = render(<KeyBar {...props} keybarLayout="compact" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'expand keybar' }));
    expect(view.container.querySelector('.nc-keygrid').classList.contains('expanded')).toBe(true);

    view.rerender(<KeyBar {...props} keybarLayout="full" />);
    expect(view.container.querySelector('.nc-keygrid').classList.contains('expanded')).toBe(false);
    view.rerender(<KeyBar {...props} keybarLayout="compact" />);
    expect(view.container.querySelector('.nc-keygrid').classList.contains('compact')).toBe(true);
    expect(screen.queryByRole('button', { name: 'retract keybar' })).toBeNull();
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
