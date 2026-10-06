import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// Un solo treno di letture per route, per finestra: la vista singola in
// doppia vista (striscia principale + cella affiancata) NON deve fare due
// serie di fetch separate per gli stessi endpoint. Il test conta le letture
// /api/sessions e /fleet/status su 8 s con clock controllato: due poll
// separati (il comportamento pre-correzione, uno per pannello) fanno 6
// letture per endpoint (avvio + tick a 4 s + tick a 8 s, per ciascuno); un
// solo treno condiviso ne fa 3. L'atteso e' quello del treno.
const counts = vi.hoisted(() => ({ sessions: 0, fleet: 0 }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async (url) => {
    if (String(url).endsWith('/sessions')) counts.sessions += 1;
    return { json: async () => ({ sessions: [] }) };
  }),
  fleetStatus: vi.fn(async () => {
    counts.fleet += 1;
    return { available: true, cells: [] };
  }),
  fleetUp: vi.fn(), fleetDown: vi.fn(), killSession: vi.fn(),
  getSettings: vi.fn(), nodeAction: vi.fn(), setSessionTechnical: vi.fn(),
}));

vi.mock('./Terminal.jsx', () => ({ default: () => <div data-testid="term" /> }));
vi.mock('./KeyBar.jsx', () => ({ default: () => null }));
vi.mock('./ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('./SessionList.jsx', () => ({ default: () => null }));
vi.mock('./Sidebar.jsx', () => ({ default: () => null }));
vi.mock('./GridView.jsx', () => ({ default: () => null }));
vi.mock('./PowerSheet.jsx', () => ({ default: () => null }));
vi.mock('./DeckBar.jsx', () => ({ default: () => null }));
vi.mock('./SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./Wizard.jsx', () => ({ default: () => null }));
vi.mock('./NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import { SingleView } from '../App.jsx';

// jsdom non implementa matchMedia: polyfill minimale (lo stato iniziale del
// composer su touch lo consulta).
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (q) => ({
      matches: false, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    });
  }
});

beforeEach(() => {
  counts.sessions = 0;
  counts.fleet = 0;
  localStorage.clear();
});

describe('polling: un solo treno di letture per route', () => {
  it('doppia vista locale: una sola lettura sessions+fleet per tick, non una per pannello', async () => {
    vi.useFakeTimers();
    render(<SingleView session="cloud-Dev" side={{ session: 'cloud-Other' }} token="t" onBack={vi.fn()} />);
    // 8 s: avvio + due tick completi. Con un solo treno: 3 letture per
    // endpoint. Con un poll per pannello (pre-correzione): 6.
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(counts.sessions).toBeLessThanOrEqual(3);
    expect(counts.fleet).toBeLessThanOrEqual(3);
    vi.useRealTimers();
  });

  it('vista singola senza affiancata: il treno resta uno anche cambiando cella', async () => {
    vi.useFakeTimers();
    const view = render(<SingleView session="cloud-Dev" token="t" onBack={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    // Cambio cella sulla stessa route: la sottoscrizione si sposta, ma la
    // lettura resta quella del treno (coalescing): nessun ciclo extra.
    view.rerender(<SingleView session="cloud-Other" token="t" onBack={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(counts.sessions).toBeLessThanOrEqual(3);
    expect(counts.fleet).toBeLessThanOrEqual(3);
    vi.useRealTimers();
  });
});
