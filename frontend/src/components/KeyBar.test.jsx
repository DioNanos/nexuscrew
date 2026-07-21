import { render, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import KeyBar from './KeyBar.jsx';

function renderKeyBar(props = {}) {
  const send = vi.fn();
  const action = vi.fn();
  render(
    <KeyBar
      send={send} action={action}
      onCtrl={vi.fn()} onKeyboard={vi.fn()} onSelectionMode={vi.fn()}
      {...props}
    />,
  );
  return { send, action };
}

describe('KeyBar reduced view and Enter', () => {
  it('shows the reduced bar by default: toggle + arrows + ■Enter, no ESC', () => {
    renderKeyBar();
    // essentials present
    expect(document.querySelector('button.expand')).toBeTruthy();
    expect(document.querySelector('button.enter')).toBeTruthy();
    expect([...document.querySelectorAll('.nc-keybar .row button')].map((b) => b.textContent))
      .toEqual(['⊞', '☰', '↑', '↓', '←', '→', '■']);
    // rare commands hidden
    expect(document.querySelector('.nc-keybar').textContent).not.toContain('ESC');
    expect(document.querySelector('.nc-keybar').textContent).not.toContain('HOME');
  });

  it('■Enter sends a raw CR (confirms a TUI selection) and ignores ALT sticky', () => {
    const { send } = renderKeyBar();
    fireEvent.mouseDown(document.querySelector('button.enter'));
    expect(send).toHaveBeenCalledWith('\r');
    // exactly one send (no ALT emission around it)
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('toggle expands to the full two-row layout (shows ESC) and retracts', () => {
    renderKeyBar();
    fireEvent.mouseDown(document.querySelector('button.expand'));
    expect(document.querySelector('.nc-keybar').textContent).toContain('ESC');
    expect(document.querySelectorAll('.nc-keybar .row').length).toBe(2);
    // ■Enter stays reachable in the expanded view too
    expect(document.querySelectorAll('button.enter').length).toBe(1);
    fireEvent.mouseDown(document.querySelector('button.expand'));
    expect(document.querySelector('.nc-keybar').textContent).not.toContain('ESC');
    expect(document.querySelectorAll('.nc-keybar .row').length).toBe(1);
  });

  it('arrow keys send the right escape sequences', () => {
    const { send } = renderKeyBar();
    const buttons = [...document.querySelectorAll('.nc-keybar .row button')];
    const byText = (t) => buttons.find((b) => b.textContent === t);
    fireEvent.mouseDown(byText('↑')); expect(send).toHaveBeenLastCalledWith('\x1b[A');
    fireEvent.mouseDown(byText('↓')); expect(send).toHaveBeenLastCalledWith('\x1b[B');
    fireEvent.mouseDown(byText('←')); expect(send).toHaveBeenLastCalledWith('\x1b[D');
    fireEvent.mouseDown(byText('→')); expect(send).toHaveBeenLastCalledWith('\x1b[C');
  });
});