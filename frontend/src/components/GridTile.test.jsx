import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// I figli pesanti (Terminal/Composer/Files) fanno chiamate di rete: stub.
// grid-model e terminal-lifecycle restano reali (puri, senza rete).
vi.mock('./Terminal.jsx', () => ({ default: () => <div data-testid="term" /> }));
vi.mock('./ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));

import GridTile from './GridTile.jsx';

function renderTile(props) {
  return render(
    <GridTile
      session="cloud-Dev"
      token="t"
      onFocus={vi.fn()}
      {...props}
    />,
  );
}

describe('GridTile title (Tranche D)', () => {
  it('shows the logical Fleet cell name, not the tmux session name', () => {
    renderTile({ session: 'cloud-Dev', cellName: 'Dev' });
    const title = screen.getByText('Dev');
    expect(title.tagName).toBe('B');
    // la tmuxSession non deve comparire nel titolo visibile
    expect(screen.queryByText('cloud-Dev')).toBeNull();
  });

  it('does not show the @node chip for a remote cell', () => {
    // cell=Dev, tmuxSession=cloud-Dev, route workstation -> solo "Dev" visibile.
    renderTile({ session: 'cloud-Dev', node: 'workstation', cellName: 'Dev' });
    expect(screen.queryByText('workstation')).toBeNull();
    expect(screen.queryByText(/@/)).toBeNull();
    expect(screen.getByText('Dev')).toBeTruthy();
  });

  it('keeps a sanitized technical identifier only in the tooltip, not in visible text', () => {
    renderTile({ session: 'cloud-Dev', node: 'workstation', cellName: 'Dev' });
    const btn = screen.getByText('Dev').closest('button');
    expect(btn.getAttribute('title')).toContain('workstation');
    // il testo visibile del bottone resta il solo nome logico
    expect(btn.textContent.trim()).toBe('Dev');
  });

  it('uses a plain tooltip equal to the visible name for a local tile', () => {
    renderTile({ session: 'cloud-Dev', cellName: 'Dev' });
    const btn = screen.getByText('Dev').closest('button');
    expect(btn.getAttribute('title')).toBe('Dev');
  });

  it('falls back to the session name for an unmanaged session', () => {
    renderTile({ session: 'scratch-pad', cellName: 'scratch-pad' });
    expect(screen.getByText('scratch-pad')).toBeTruthy();
    expect(screen.queryByText('cloud-Dev')).toBeNull();
  });

  it('defaults the visible title to the session when cellName is not provided (back-compat)', () => {
    renderTile({ session: 'my-session', cellName: undefined });
    expect(screen.getByText('my-session')).toBeTruthy();
  });

  it('renders two tiles with the same cell name on different nodes without @node collisions', () => {
    const { container } = render(
      <>
        <GridTile session="cloud-Dev" node="workstation" cellName="Dev" token="t" onFocus={vi.fn()} />
        <GridTile session="cloud-Dev" node="vps/relay" cellName="Dev" token="t" onFocus={vi.fn()} />
      </>,
    );
    const titles = container.querySelectorAll('b');
    expect(titles).toHaveLength(2);
    titles.forEach((b) => expect(b.textContent).toBe('Dev'));
    // nessun chip @node visibile
    expect(container.textContent).not.toContain('@');
  });
});
