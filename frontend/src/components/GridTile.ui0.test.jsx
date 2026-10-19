import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('./Terminal.jsx', () => ({ default: () => <div data-testid="term" /> }));
vi.mock('./ComposerBar.jsx', () => ({ default: () => <div data-testid="composer" /> }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPopup.jsx', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));

import GridTile from './GridTile.jsx';

afterEach(() => {
  delete globalThis.__NC_UI0_CHAT_DEMO__;
});

function renderTile(session) {
  return render(<GridTile session={session} token="t" />);
}

describe('GridTile UI-0 branch', () => {
  it('keeps the PTY when the flag is OFF, even for a demo session', () => {
    globalThis.__NC_UI0_CHAT_DEMO__ = false;
    const { container } = renderTile('ui0-demo-vl');
    expect(screen.getByTestId('term')).toBeTruthy();
    expect(container.querySelector('.nc-chat')).toBeNull();
    expect(container.querySelector('button[title="composer"]')).toBeTruthy();
  });

  it('renders the chat tile for a demo session when the flag is ON', () => {
    globalThis.__NC_UI0_CHAT_DEMO__ = true;
    const { container } = renderTile('ui0-demo-vl');
    expect(screen.queryByTestId('term')).toBeNull();
    expect(container.querySelector('.nc-chat')).toBeTruthy();
    expect(container.querySelector('.nc-chat-state').textContent).toContain('terminato');
    // One header, one composer: the PTY composer toggle and bar are gone.
    expect(container.querySelector('button[title="composer"]')).toBeNull();
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
  });

  it('never switches a real cell to chat', () => {
    globalThis.__NC_UI0_CHAT_DEMO__ = true;
    const { container } = renderTile('cloud-Dev');
    expect(screen.getByTestId('term')).toBeTruthy();
    expect(container.querySelector('.nc-chat')).toBeNull();
  });
});
