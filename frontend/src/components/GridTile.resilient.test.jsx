import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Il terminale NON si smonta quando l'owner diventa irreperibile: il buffer
// resta al suo posto e la indisponibilità è un overlay SOPRA il contenuto.
// Prima di questa modifica available=false SOSTITUIVA il Terminal con un
// placeholder: xterm veniva distrutto e il contenuto aperto spariva.

const mounts = vi.hoisted(() => ({ n: 0 }));

vi.mock('./Terminal.jsx', () => ({
  default: function StubTerminal() {
    // Conta i MONTAGGI (useEffect con deps vuote): un remount invisibile
    // (stesso DOM, istanza nuova) incrementa comunque.
    React.useEffect(() => { mounts.n += 1; }, []);
    return <div data-testid="stub-terminal" />;
  },
}));
vi.mock('./ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPopup.jsx', () => ({ default: () => <div /> }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));

import GridTile from './GridTile.jsx';

function tile(available) {
  return (
    <GridTile
      session="cloud-Dev" node="vps" token="t"
      available={available}
      onFocus={vi.fn()} decks={[]}
    />
  );
}

describe('GridTile: il terminale sopravvive ai flip di disponibilità', () => {
  it('available false→true NON smonta il Terminal (stessa istanza) e mostra l\'overlay', async () => {
    const view = render(tile(true));
    expect(screen.getByTestId('stub-terminal')).toBeTruthy();
    expect(mounts.n).toBe(1);
    expect(view.container.querySelector('.nc-tile-unavailable')).toBe(null);

    // L'owner sparisce: overlay SOPRA il terminale, che resta montato.
    view.rerender(tile(false));
    expect(screen.getByTestId('stub-terminal')).toBeTruthy();
    expect(mounts.n).toBe(1);
    const overlay = view.container.querySelector('.nc-tile-unavailable');
    expect(overlay).not.toBe(null);
    expect(overlay.textContent).toContain('reconnect');

    // L'owner torna: overlay via, terminale intatto, NESSUN remount.
    view.rerender(tile(true));
    expect(screen.getByTestId('stub-terminal')).toBeTruthy();
    expect(mounts.n).toBe(1);
    expect(view.container.querySelector('.nc-tile-unavailable')).toBe(null);
  });
});
