import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('./Terminal.jsx', () => ({ default: () => <div data-testid="term" /> }));
vi.mock('./ComposerBar.jsx', () => ({ default: () => <div data-testid="composer" /> }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPopup.jsx', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));

import GridTile from './GridTile.jsx';
import { TARGETS, vlDoneEvents } from '../lib/chat-fixtures.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function preview() {
  return { target: TARGETS.vl, events: vlDoneEvents(), viewer: { canApprove: false }, reviews: {} };
}

function renderTile(props = {}) {
  return render(<GridTile session="cloud-Dev" token="t" {...props} />);
}

describe('GridTile UI-0 preview branch', () => {
  it('keeps the PTY when the build flag is OFF, even with a preview descriptor', () => {
    const { container } = renderTile({ chatPreview: preview() });
    expect(screen.getByTestId('term')).toBeTruthy();
    expect(container.querySelector('.nc-chat')).toBeNull();
  });

  it('keeps the PTY for a session named like the old demo prefix', () => {
    vi.stubEnv('VITE_UI0_CHAT_DEMO', '1');
    const { container } = renderTile({ session: 'ui0-demo-vl' });
    // No explicit preview descriptor: the name is not a discriminator.
    expect(screen.getByTestId('term')).toBeTruthy();
    expect(container.querySelector('.nc-chat')).toBeNull();
  });

  it('renders the chat tile only with an explicit preview descriptor', () => {
    vi.stubEnv('VITE_UI0_CHAT_DEMO', '1');
    const { container } = renderTile({ chatPreview: preview() });
    expect(screen.queryByTestId('term')).toBeNull();
    expect(container.querySelector('.nc-chat')).toBeTruthy();
    expect(container.querySelector('.nc-chat-state').textContent).toContain('terminato');
    // One header, one composer: the PTY composer toggle and bar are gone.
    expect(container.querySelector('button[title="composer"]')).toBeNull();
    expect(screen.queryByTestId('composer')).toBeNull();
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
  });
});
