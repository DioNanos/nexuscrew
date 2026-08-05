import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

vi.mock('../lib/api.js', () => ({ getVlNodeEvents: vi.fn() }));

import { getVlNodeEvents } from '../lib/api.js';
import VlNodeEvents from './VlNodeEvents.jsx';

const NODE_ID = 'b'.repeat(32);

function mount(props = {}) {
  return render(<VlNodeEvents token="token" nodeId={NODE_ID} route={[]} {...props} />);
}

describe('VlNodeEvents — la conversazione del nodo, in sola lettura', () => {
  beforeEach(() => vi.mocked(getVlNodeEvents).mockReset());
  afterEach(() => cleanup());

  it('mostra il testo che arriva dal nodo', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [{ seq: 1, kind: 'text', text: 'ciao dal N900' }], cursor: 1,
    });
    mount();
    await waitFor(() => expect(screen.getByText(/ciao dal N900/)).toBeTruthy());
  });

  it('dichiara il buco invece di nasconderlo: un gap dice QUANTI eventi mancano', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [
        { seq: 1, kind: 'text', text: 'prima' },
        { seq: 2, kind: 'gap', count: 17 },
        { seq: 3, kind: 'text', text: 'dopo' },
      ],
      cursor: 3,
    });
    mount();
    // L'assenza silenziosa si legge come "non e' successo niente": il conteggio
    // deve essere visibile, non solo un puntino.
    await waitFor(() => expect(screen.getByText(/17/)).toBeTruthy());
  });

  it('un tool fallito si vede che e fallito', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [{ seq: 1, kind: 'tool_end', name: 'read_file', isError: true }], cursor: 1,
    });
    mount();
    await waitFor(() => expect(screen.getByTestId('vl-ev-1').className).toMatch(/error/));
  });

  it('senza eventi lo dice, invece di mostrare un riquadro vuoto ambiguo', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({ events: [], cursor: 0 });
    mount();
    await waitFor(() => expect(screen.getByTestId('vl-events-empty')).toBeTruthy());
  });

  it('chiede solo il nuovo: il secondo giro passa il cursore', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [{ seq: 7, kind: 'text', text: 'uno' }], cursor: 7,
    });
    mount();
    await waitFor(() => expect(screen.getByText(/uno/)).toBeTruthy());
    await waitFor(() => {
      const calls = vi.mocked(getVlNodeEvents).mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      expect(calls[calls.length - 1][2]).toBe(7);
    }, { timeout: 4000 });
  });

  it('un giro senza novita non svuota quello che si e gia letto', async () => {
    // La garanzia: la lista si APPENDE, non si sostituisce. Un riquadro che si
    // azzera da solo racconterebbe una bugia sullo stato della sessione.
    // (Il caso "errore di rete" percorre lo stesso ramo: il catch segnala e
    // non tocca mai `events`.)
    vi.mocked(getVlNodeEvents)
      .mockResolvedValueOnce({ events: [{ seq: 1, kind: 'text', text: 'resta visibile' }], cursor: 1 })
      .mockResolvedValue({ events: [], cursor: 1 });
    mount();
    await waitFor(() => expect(screen.getByText(/resta visibile/)).toBeTruthy());
    await waitFor(() => expect(vi.mocked(getVlNodeEvents).mock.calls.length).toBeGreaterThan(1), { timeout: 4000 });
    expect(screen.getByText(/resta visibile/)).toBeTruthy();
  });
});
