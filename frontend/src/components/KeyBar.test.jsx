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

describe('KeyBar reduced view', () => {
  it('shows the reduced bar by default: toggle + menu on the left, arrows on the right, no ESC', () => {
    renderKeyBar();
    expect(document.querySelector('button.expand')).toBeTruthy();
    // no dedicated Enter button anymore
    expect(document.querySelector('button.enter')).toBeNull();
    // row buttons, left to right: toggle, keyboard, menu, then the arrow group
    expect([...document.querySelectorAll('.nc-keybar .row > button')].map((b) => b.textContent))
      .toEqual(['⊞', '⌨', '☰']);
    // arrows + page keys (transcript scroll) on the right; no ESC/HOME/END
    expect([...document.querySelectorAll('.nc-keybar-arrows button')].map((b) => b.textContent))
      .toEqual(['↑', '↓', '←', '→', 'PGUP', 'PGDN']);
    // rare commands hidden
    expect(document.querySelector('.nc-keybar').textContent).not.toContain('ESC');
    expect(document.querySelector('.nc-keybar').textContent).not.toContain('HOME');
  });

  it('toggle expands to the full two-row layout (shows ESC) and retracts', () => {
    renderKeyBar();
    fireEvent.mouseDown(document.querySelector('button.expand'));
    expect(document.querySelector('.nc-keybar').textContent).toContain('ESC');
    expect(document.querySelectorAll('.nc-keybar .row').length).toBe(2);
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
    // page keys reach the pty so a TUI (e.g. Claude Code) scrolls its transcript
    fireEvent.mouseDown(byText('PGUP')); expect(send).toHaveBeenLastCalledWith('\x1b[5~');
    fireEvent.mouseDown(byText('PGDN')); expect(send).toHaveBeenLastCalledWith('\x1b[6~');
  });

  it('a send-key blurs the active element so the mobile soft keyboard hides', () => {
    renderKeyBar();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    expect(document.activeElement).toBe(ta);
    const up = [...document.querySelectorAll('.nc-keybar .row button')].find((b) => b.textContent === '↑');
    fireEvent.mouseDown(up);
    expect(document.activeElement).not.toBe(ta);
    ta.remove();
  });
});