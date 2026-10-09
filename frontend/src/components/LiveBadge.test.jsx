import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import LiveBadge from './LiveBadge.jsx';
import { liveHostView } from '../lib/live-host-view.js';

beforeEach(() => { localStorage.clear(); localStorage.setItem('nc_lang', 'en'); });

const viewOf = (engine, threadStatus, active = true) => liveHostView({
  liveHost: { hostCell: 'Dev', threadStatus },
  cells: [{ cell: 'Dev', engine, active, tmux: active }],
});

describe('LiveBadge', () => {
  it('mostra Live con il modo nel titolo quando la Live e viva', () => {
    render(<LiveBadge view={viewOf('codex-vl.native', 'active')} />);
    const badge = screen.getByTestId('live-badge');
    expect(badge.textContent).toBe('Live');
    expect(badge.getAttribute('data-mode')).toBe('native');
    expect(badge.getAttribute('title')).toMatch(/native/i);
  });

  it('in tmux dice che non riceve messaggi', () => {
    render(<LiveBadge view={viewOf('claude.native', 'absent')} />);
    expect(screen.getByTestId('live-badge').getAttribute('data-mode')).toBe('tmux');
    expect(screen.getByTestId('live-badge').getAttribute('title')).toMatch(/does not receive messages/i);
  });

  it('non rende nulla senza una Live viva', () => {
    const { container } = render(<LiveBadge view={viewOf('codex-vl.native', 'absent')} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('live-badge')).toBeNull();
  });

  it('il nome della cella ospite non compare nel badge', () => {
    render(<LiveBadge view={viewOf('codex-vl.native', 'present')} />);
    expect(screen.getByTestId('live-badge').textContent).not.toMatch(/Dev/);
    expect(screen.getByTestId('live-badge').getAttribute('title')).not.toMatch(/Dev/);
  });
});
