import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Le finestre staccate sopravvivono ai passaggi che NON sono il caricamento:
// il cambio di deck, la rinomina del deck corrente, e il merge del poll quando
// un'altra finestra ha aggiunto una flottante mentre questa era sporca. In
// tutti e tre i casi il PUT successivo deve portarle, non svuotarle.
const mocks = vi.hoisted(() => ({
  getDecks: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(),
  saveDeckKeepalive: vi.fn(),
}));

vi.mock('../lib/api.js', () => mocks);

import { useDecks } from './useDecks.js';
import { emptyLayout, reattachTile, updateFloatGeom, zoomTile } from '../lib/grid-model.js';

const localId = 'a'.repeat(32);
const griglia = (sessione) => ({ columns: [{ width: 1, tiles: [{ session: sessione, height: 1, fontSize: 11 }] }] });
const flottante = { session: 'fl', x: 0.5, y: 0.2, w: 0.4, h: 0.5, fontSize: 11 };

// Replica il cablaggio di App: il deck corrente è stato React, select/rename
// installano come layout visibile la vista che il hook restituisce.
function Probe({ start = 'uno' }) {
  const [current, setCurrent] = useState(`${localId}:${start}`);
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', current, layout, setLayout, []);
  const seleziona = async (name) => {
    const id = `local:${name}`;
    const next = await value.select(id);
    setCurrent(id); setLayout(next);
  };
  const rinomina = async (from, to) => {
    const saved = await value.rename(`local:${from}`, to);
    setCurrent(saved.id);
    setLayout(value.vistaMaterializzata(saved));
  };
  return (
    <div>
      <button type="button" onClick={() => { seleziona('due').catch(() => {}); }}>seleziona</button>
      <button type="button" onClick={() => { rinomina('due', 'tre').catch(() => {}); }}>rinomina</button>
      <button type="button" onClick={() => setLayout((l) => updateFloatGeom(l, 'fl', { x: 0.1, y: 0.1, w: 0.4, h: 0.5 }))}>sposta</button>
      <button type="button" onClick={() => setLayout((l) => zoomTile(l, 0, 0, 1))}>zoom</button>
      <button type="button" onClick={() => setLayout((l) => reattachTile(l, 'fl'))}>riattacca</button>
      <pre data-testid="probe">{JSON.stringify({
        ready: value.ready,
        tiles: layout.columns.flatMap((c) => c.tiles.map((t) => ({ s: t.session, f: t.float || null }))),
      })}</pre>
    </div>
  );
}

const stato = () => JSON.parse(screen.getByTestId('probe').textContent);
const networkDown = () => Object.assign(new Error('network down'), { status: 0 });
const ultimoPut = () => mocks.saveDeck.mock.calls[mocks.saveDeck.mock.calls.length - 1];

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
  mocks.saveDeck.mockImplementation(async (_t, name, layout, revision, _route, floating) => ({
    name, revision: revision + 1, layout, ...(floating && floating.length ? { floating } : {}),
  }));
});

describe('useDecks — flottanti al cambio e alla rinomina del deck', () => {
  it('select: la vista del deck di arrivo porta la sua flottante e il PUT dopo non la cancella', async () => {
    mocks.getDecks.mockResolvedValue({ decks: [
      { name: 'main', revision: 1, layout: emptyLayout() },
      { name: 'uno', revision: 1, layout: griglia('a') },
      { name: 'due', revision: 1, layout: griglia('b'), floating: [flottante] },
    ] });
    render(<Probe />);
    await waitFor(() => expect(stato().tiles.map((t) => t.s)).toEqual(['a']));

    fireEvent.click(screen.getByRole('button', { name: 'seleziona' }));
    await waitFor(() => expect(stato().tiles.map((t) => t.s).sort()).toEqual(['b', 'fl']));
    expect(stato().tiles.find((t) => t.s === 'fl').f).toEqual({ x: 0.5, y: 0.2, w: 0.4, h: 0.5 });

    fireEvent.click(screen.getByRole('button', { name: 'zoom' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    const [, name, layout, , , floating] = ultimoPut();
    expect(name).toBe('due');
    expect(layout.columns.flatMap((c) => c.tiles.map((t) => t.session))).toEqual(['b']);
    expect(floating).toEqual([flottante]);
  });

  it('rename del deck corrente: la flottante resta nella vista e nel PUT successivo', async () => {
    mocks.getDecks.mockResolvedValue({ decks: [
      { name: 'main', revision: 1, layout: emptyLayout() },
      { name: 'due', revision: 1, layout: griglia('b'), floating: [flottante] },
    ] });
    mocks.renameDeck.mockImplementation(async (_t, _from, to, revision) => ({
      name: to, revision: revision + 1, layout: griglia('b'), floating: [flottante],
    }));
    render(<Probe start="due" />);
    await waitFor(() => expect(stato().tiles.map((t) => t.s).sort()).toEqual(['b', 'fl']));

    fireEvent.click(screen.getByRole('button', { name: 'rinomina' }));
    await waitFor(() => expect(mocks.renameDeck).toHaveBeenCalled());
    // dopo la rinomina la vista NON perde la flottante
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(stato().tiles.map((t) => t.s).sort()).toEqual(['b', 'fl']);

    fireEvent.click(screen.getByRole('button', { name: 'sposta' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    const [, name, , , , floating] = ultimoPut();
    expect(name).toBe('tre');
    expect(floating).toEqual([{ ...flottante, x: 0.1, y: 0.1 }]);
  });
});

describe('useDecks — merge del poll con una flottante aggiunta altrove', () => {
  it('finestra sporca, remoto più nuovo con una flottante nuova: il merge la tiene e il PUT la porta', async () => {
    let revision = 1;
    mocks.getDecks.mockImplementation(async () => ({ decks: [
      { name: 'main', revision: 1, layout: emptyLayout() },
      revision === 1
        ? { name: 'uno', revision: 1, layout: griglia('a') }
        : { name: 'uno', revision: 2, layout: griglia('a'), floating: [{ ...flottante, session: 'remota' }] },
    ] }));
    mocks.saveDeck.mockRejectedValue(networkDown()); // resta sporca
    render(<Probe />);
    await waitFor(() => expect(stato().tiles.map((t) => t.s)).toEqual(['a']));
    fireEvent.click(screen.getByRole('button', { name: 'zoom' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });

    revision = 2; // un'altra finestra stacca 'remota' e salva
    await waitFor(() => expect(stato().tiles.map((t) => t.s)).toContain('remota'), { timeout: 9000 });
    expect(stato().tiles.find((t) => t.s === 'remota').f).toEqual({ x: 0.5, y: 0.2, w: 0.4, h: 0.5 });

    const prima = mocks.saveDeck.mock.calls.length;
    await waitFor(() => expect(mocks.saveDeck.mock.calls.length).toBeGreaterThan(prima), { timeout: 4000 });
    const [, , , rev, , floating] = ultimoPut();
    expect(rev).toBe(2);
    expect(floating).toEqual([{ ...flottante, session: 'remota' }]);
  }, 20000);
});

// Chi non usa le finestre staccate manda esattamente il body della 0.9.50:
// nessun campo `floating`. Il campo parte solo se la vista ne ha, o se il
// record ne aveva e vanno svuotate (l'ultima riattaccata: `floating: []`).
describe('useDecks — il campo floating solo quando serve', () => {
  it('deck senza flottanti: PUT e keepalive senza il campo floating', async () => {
    mocks.getDecks.mockResolvedValue({ decks: [
      { name: 'main', revision: 1, layout: emptyLayout() },
      { name: 'uno', revision: 1, layout: griglia('a') },
    ] });
    render(<Probe />);
    await waitFor(() => expect(stato().tiles.map((t) => t.s)).toEqual(['a']));
    fireEvent.click(screen.getByRole('button', { name: 'zoom' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    expect(ultimoPut()[5]).toBeUndefined();

    mocks.saveDeck.mockRejectedValue(networkDown());
    fireEvent.click(screen.getByRole('button', { name: 'zoom' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalledTimes(2), { timeout: 4000 });
    window.dispatchEvent(new Event('pagehide'));
    expect(mocks.saveDeckKeepalive).toHaveBeenCalledTimes(1);
    expect(mocks.saveDeckKeepalive.mock.calls[0][5]).toBeUndefined();
  });

  it('record con una flottante, riattaccata: il PUT svuota il record con floating []', async () => {
    mocks.getDecks.mockResolvedValue({ decks: [
      { name: 'main', revision: 1, layout: emptyLayout() },
      { name: 'uno', revision: 1, layout: griglia('a'), floating: [flottante] },
    ] });
    render(<Probe />);
    await waitFor(() => expect(stato().tiles.map((t) => t.s).sort()).toEqual(['a', 'fl']));
    fireEvent.click(screen.getByRole('button', { name: 'riattacca' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    const [, , layout, , , floating] = ultimoPut();
    expect(layout.columns.flatMap((c) => c.tiles.map((t) => t.session)).sort()).toEqual(['a', 'fl']);
    expect(floating).toEqual([]);
  });
});
