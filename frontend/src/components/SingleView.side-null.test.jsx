import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// La cella affiancata puo' sparire DURANTE la vita della vista (onSideGone,
// chiusura manuale): la sottoscrizione del treno deve andare via con lei. La
// regressione da custodire: l'effetto dipendeva solo da route e token, e la
// side senza route esplicita (node assente) lasciava la dipendenza invariata
// quando side diventava null — niente unsubscribe, e la consegna del tick
// successivo chiamava la policy con side nullo: rifiuzione non gestita ad
// App.jsx (2 a giro di suite completa, misurate in verifica).
const mocks = vi.hoisted(() => ({ rifiuti: [], sottoscrizioni: [] }));

// Spia delegante sul treno: conta le sottoscrizioni e registra quando la
// loro chiusura viene invocata. Serve a vedere cio' che il crash rendeva
// invisibile: la sottoscrizione della side deve CHIUDERSI quando la cella
// sparisce, non solo smettere di rompersi.
vi.mock('../lib/fleet-poll.js', async (importOriginal) => {
  const reale = await importOriginal();
  return {
    ...reale,
    subscribeFleetRoute: (token, route, cb) => {
      const chiudiDavvero = reale.subscribeFleetRoute(token, route, cb);
      const record = { route: JSON.stringify(route || []), chiusa: false };
      mocks.sottoscrizioni.push(record);
      return () => { record.chiusa = true; chiudiDavvero(); };
    },
  };
});

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ sessions: [] }) })),
  fleetStatus: vi.fn(async () => ({ available: true, cells: [] })),
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
  mocks.rifiuti = [];
  mocks.sottoscrizioni = [];
  localStorage.clear();
});

describe('side rimossa: la sottoscrizione va via con lei', () => {
  it('side a null senza cambio route: nessuna rifiuzione non gestita al tick successivo', async () => {
    const onRifiuto = (reason) => { mocks.rifiuti.push(reason); };
    process.on('unhandledRejection', onRifiuto);
    try {
      vi.useFakeTimers();
      const view = render(
        <SingleView session="cloud-Dev" side={{ session: 'cloud-Other' }} token="t" onBack={vi.fn()} />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // La side sparisce SENZA cambio di route (node assente su entrambi):
      // qui la sottoscrizione deve lasciare il treno.
      view.rerender(<SingleView session="cloud-Dev" token="t" onBack={vi.fn()} />);
      // Il tick successivo consegna: la vecchia callback non deve esserci piu'.
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    } finally {
      process.off('unhandledRejection', onRifiuto);
      vi.useRealTimers();
    }
    expect(mocks.rifiuti).toHaveLength(0);
    // Due sottoscrizioni aperte al mount (principale + side, stessa route):
    // quando la side sparisce, la SUA chiusura deve essere invocata.
    expect(mocks.sottoscrizioni.length).toBe(2);
    expect(mocks.sottoscrizioni[1].chiusa).toBe(true);
  });
});
