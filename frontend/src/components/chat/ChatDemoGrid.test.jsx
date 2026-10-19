import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ChatDemoGrid from './ChatDemoGrid.jsx';

const fetchSpy = vi.fn(() => { throw new Error('network forbidden in UI-0'); });
const socketSpy = vi.fn(() => { throw new Error('WebSocket forbidden in UI-0'); });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('WebSocket', socketSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchSpy.mockClear();
  socketSpy.mockClear();
});

describe('ChatDemoGrid', () => {
  it('renders two tiles, two headers and two composers, with zero network', () => {
    const { container } = render(<ChatDemoGrid />);
    expect(container.querySelectorAll('.nc-ui0-tile')).toHaveLength(2);
    expect(container.querySelectorAll('.nc-tile-head')).toHaveLength(2);
    expect(container.querySelectorAll('textarea')).toHaveLength(2);
    expect(container.querySelectorAll('.nc-chat')).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
  });

  it('clicks every enabled control without any request', () => {
    const { container } = render(<ChatDemoGrid />);
    expect(container.querySelectorAll('.nc-tile-head')).toHaveLength(2);
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      if (!button.disabled) fireEvent.click(button);
    }
    const textareas = Array.from(container.querySelectorAll('textarea'));
    for (const textarea of textareas) {
      fireEvent.change(textarea, { target: { value: 'prova' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
  });

  it('uses synthetic identities, never the live fleet ids', () => {
    const { container } = render(<ChatDemoGrid />);
    const text = container.textContent;
    expect(text).not.toContain('82dffb30');
    expect(text).not.toContain('36b876f2');
    expect(text).toContain('N900 (demo)');
    expect(text).toContain('Dev (demo)');
  });

  it('shows both source kinds in the same renderer', () => {
    const { container } = render(<ChatDemoGrid />);
    const kinds = Array.from(container.querySelectorAll('.nc-chat')).map((el) => el.getAttribute('data-target-kind'));
    expect(kinds).toEqual(['vl_node', 'cli_cell']);
    expect(screen.getByText('Ciao dal nodo')).toBeTruthy();
    expect(screen.getByText('Serve il tuo OK')).toBeTruthy();
  });
});
