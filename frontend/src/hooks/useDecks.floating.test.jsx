import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Finestre flottanti nel ciclo del deck: il record porta `floating` ACCANTO
// alla griglia; la vista le materializza come tile col flag `float`; il PUT
// le separa di nuovo (griglia pura + lista). Il merge del poll e il flush di
// chiusura pagina non le perdono.
const mocks = vi.hoisted(() => ({
  getDecks: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(),
  saveDeckKeepalive: vi.fn(),
}));

vi.mock('../lib/api.js', () => mocks);

import { useDecks } from './useDecks.js';
import { emptyLayout, updateFloatGeom } from '../lib/grid-model.js';

const localId = 'a'.repeat(32);
const griglia = (sessione) => ({ columns: [{ width: 1, tiles: [{ session: sessione, height: 1, fontSize: 11 }] }] });
const flottante = { session: 'fl', x: 0.5, y: 0.2, w: 0.4, h: 0.5, fontSize: 11 };

function Probe() {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', `${localId}:p-s-t`, layout, setLayout, []);
  return (
    <div>
      <button type="button" onClick={() => setLayout((l) => updateFloatGeom(l, 'fl', { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }))}>sposta</button>
      <pre data-testid="probe">{JSON.stringify({
        ready: value.ready,
        error: value.error,
        tiles: layout.columns.flatMap((c) => c.tiles.map((t) => ({ s: t.session, f: t.float || null }))),
      })}</pre>
    </div>
  );
}

const stato = () => JSON.parse(screen.getByTestId('probe').textContent);
const store = (rev, layout, floating) => ({
  decks: [
    { name: 'main', revision: 1, layout: emptyLayout() },
    { name: 'p-s-t', revision: rev, layout, ...(floating ? { floating } : {}) },
  ],
});
const networkDown = () => Object.assign(new Error('network down'), { status: 0 });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
});

// Il hook tiene acceso per 1500ms il timer che riporta lo stato a idle dopo un
// salvataggio riuscito: se un test lo lascia in sospeso, scatta dopo lo
// smontaggio dell'ambiente e il worker esce con un errore non gestito
// (RC=1 intermittente). Lo lasciamo spegnere qui, con l'ambiente ancora vivo,
// solo nei test che hanno davvero chiamato il salvataggio.
afterEach(async () => {
  if (mocks.saveDeck.mock.calls.length + mocks.renameDeck.mock.calls.length > 0) {
    await act(async () => { await new Promise((risolvi) => { setTimeout(risolvi, 1600); }); });
  }
});

describe('useDecks — finestre flottanti nel record', () => {
  it('record con floating: la vista ha il tile col flag; il PUT separa griglia e lista', async () => {
    mocks.getDecks.mockImplementation(async () => store(1, griglia('dev'), [flottante]));
    mocks.saveDeck.mockImplementation(async (_t, name, layout, revision, _route, floating) => ({
      name, revision: revision + 1, layout, ...(floating && floating.length ? { floating } : {}),
    }));
    render(<Probe />);
    await waitFor(() => expect(stato().tiles.map((t) => t.s).sort()).toEqual(['dev', 'fl']));
    expect(stato().tiles.find((t) => t.s === 'fl').f).toEqual({ x: 0.5, y: 0.2, w: 0.4, h: 0.5 });

    fireEvent.click(screen.getByRole('button', { name: 'sposta' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    const [, , layout, , , floating] = mocks.saveDeck.mock.calls[0];
    // griglia pura: la flottante NON sta nel layout
    expect(layout.columns.flatMap((c) => c.tiles.map((t) => t.session))).toEqual(['dev']);
    // e viaggia nella lista, con la geometria nuova
    expect(floating).toEqual([{ session: 'fl', x: 0.1, y: 0.1, w: 0.4, h: 0.5, fontSize: 11 }]);
  });

  it('record senza floating (nodo vecchio): vista = griglia, nessuna flottante inventata', async () => {
    mocks.getDecks.mockImplementation(async () => store(1, griglia('dev')));
    render(<Probe />);
    await waitFor(() => expect(stato().ready).toBe(true));
    await waitFor(() => expect(stato().tiles).toEqual([{ s: 'dev', f: null }]));
  });

  it('merge del poll (finestra sporca, remoto più nuovo): la flottante locale resta', async () => {
    let revision = 1;
    mocks.getDecks.mockImplementation(async () => store(revision, revision === 1 ? griglia('dev') : {
      columns: [{ width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11 }, { session: 'nuova', height: 1, fontSize: 11 }] }],
    }, [flottante]));
    mocks.saveDeck.mockRejectedValue(networkDown());
    render(<Probe />);
    await waitFor(() => expect(stato().tiles.map((t) => t.s)).toContain('fl'));
    fireEvent.click(screen.getByRole('button', { name: 'sposta' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });

    revision = 2; // un'altra finestra salva la griglia mentre questa è sporca
    await waitFor(() => expect(stato().tiles.map((t) => t.s)).toContain('nuova'), { timeout: 9000 });
    const fl = stato().tiles.find((t) => t.s === 'fl');
    expect(fl).toBeDefined();
    expect(fl.f).toEqual({ x: 0.1, y: 0.1, w: 0.4, h: 0.5 }); // la geometria LOCALE vince
  });

  it('chiusura pagina: il flush keepalive porta anche le flottanti', async () => {
    mocks.getDecks.mockImplementation(async () => store(1, griglia('dev'), [flottante]));
    mocks.saveDeck.mockRejectedValue(networkDown());
    render(<Probe />);
    await waitFor(() => expect(stato().tiles.map((t) => t.s)).toContain('fl'));
    fireEvent.click(screen.getByRole('button', { name: 'sposta' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    window.dispatchEvent(new Event('pagehide'));
    expect(mocks.saveDeckKeepalive).toHaveBeenCalledTimes(1);
    expect(mocks.saveDeckKeepalive.mock.calls[0][5]).toEqual([{ session: 'fl', x: 0.1, y: 0.1, w: 0.4, h: 0.5, fontSize: 11 }]);
  });
});
