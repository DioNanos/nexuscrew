import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import LiveHostIndicator from './LiveHostIndicator.jsx';
import { liveHostView } from '../lib/live-host-view.js';

// The compact, read-only line: which cell is the Live host, which mode the
// bridge will use, and what the node measured. It sits at the top of the sidebar
// and of the compact selector — never in the phone header, which has room for a
// dot and nothing else.
const cells = [
  { cell: 'cell-one', engine: 'claude.native' },
  { cell: 'cell-two', engine: 'codex-vl.ollama-cloud' },
];

function view(liveHost, extra = {}) {
  return liveHostView({ liveHost, cells, ...extra });
}

describe('LiveHostIndicator', () => {
  beforeEach(() => { localStorage.setItem('nc_lang', 'en'); });

  it('names the cell, the mode and the state', () => {
    render(<LiveHostIndicator view={view({ hostCell: 'cell-one', threadStatus: 'absent' })} />);
    const row = screen.getByTestId('live-host-indicator');
    expect(row.textContent).toContain('cell-one');
    expect(row.textContent).toContain('tmux');
    expect(row.getAttribute('data-state')).toBe('designated');
  });

  it('says native for a codex-vl host and marks an active thread', () => {
    render(<LiveHostIndicator view={view({ hostCell: 'cell-two', threadStatus: 'active' })} />);
    const row = screen.getByTestId('live-host-indicator');
    expect(row.textContent).toContain('native');
    expect(row.getAttribute('data-state')).toBe('thread-active');
    expect(row.querySelector('.nc-live-host-dot').className).toContain('active');
  });

  it('says there is no host instead of disappearing', () => {
    render(<LiveHostIndicator view={view({ hostCell: null })} />);
    const row = screen.getByTestId('live-host-indicator');
    expect(row.getAttribute('data-state')).toBe('none');
    expect(row.querySelector('.nc-live-host-dot').className).toContain('none');
  });

  it('marks a host that belongs to another node', () => {
    render(<LiveHostIndicator view={view(
      { hostCell: 'cell-one', threadStatus: 'absent' },
      { localNodeId: 'a'.repeat(32), ownerId: 'b'.repeat(32) },
    )} />);
    expect(screen.getByTestId('live-host-indicator').getAttribute('data-remote')).toBe('true');
  });
});
