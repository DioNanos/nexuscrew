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
