import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PowerSheet from './PowerSheet.jsx';
import { fleetDefinitions, fleetStatus } from '../lib/api.js';
import { setLang, t } from '../lib/i18n.js';

// Rendering REALE della riga «Controllo NC» nel FOGLIO della cella, per le
// due prove di supervisione migrate al disegno S5: in card resta solo
// «expired», l'etichetta intera vive qui. Il file node
// tests/control-supervision-probe.test.js (rev.3) prova modello e testi
// it/en/es e richiama questo file per il rendering; qui si monta il foglio
// vero e si legge il testo renderizzato, lo stesso che vede chi lo apre.

vi.mock('../lib/api.js', () => ({
  fleetStatus: vi.fn(),
  fleetDefinitions: vi.fn(),
}));

function monta(extra, cell) {
  return render(
    <PowerSheet
      cell={cell}
      token="test-token" onConfirm={vi.fn()} onClose={vi.fn()}
      {...extra}
    />,
  );
}

async function testoSezione() {
  const titolo = await screen.findByText(t('prompt-initial-title'));
  return titolo.closest('div').textContent;
}

describe('PowerSheet: supervisione NC nel foglio (S5) — CP05/CP07', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fleetStatus.mockResolvedValue({ provider: 'builtin', capabilities: [], engines: [] });
    fleetDefinitions.mockResolvedValue({ engines: [] });
  });

  it('CP05 server vecchio: la riga «Controllo NC» del foglio dichiara non verificabile in it/en/es, mai attestato', async () => {
    // Un server vecchio non manda il campo ncControl: il foglio non puo'
    // chiamarlo attestato — lo NOMINA per esteso e lo dichiara non
    // verificabile, visibile in ogni lingua.
    for (const lang of ['it', 'en', 'es']) {
      localStorage.setItem('nc_lang', lang);
      setLang(lang);
      const { unmount } = monta({}, {
        cell: 'A', active: true, tmux: true, engine: 'claude.native',
        promptDelivery: { state: 'skipped', reason: 'not-ready', notReady: 'busy', ts: 0, launchId: 'x', generation: 0 },
      });
      const testo = await testoSezione();
      expect(testo).toContain(t('prompt-initial-control'));
      expect(testo).toContain(t('nc-control-unverifiable'));
      expect(testo).not.toContain(t('nc-control-attested'));
      unmount();
    }
  });

  it('CP07 fleet stale: il foglio dichiara il dato non corrente, mai attestato; lettura viva → attestato visibile', async () => {
    localStorage.setItem('nc_lang', 'en');
    setLang('en');
    const cella = {
      cell: 'B', active: true, tmux: true, engine: 'claude.native', ncControl: 'attested',
      promptDelivery: { state: 'skipped', reason: 'not-ready', notReady: 'busy', ts: 0, launchId: 'x', generation: 0 },
    };
    // Fleet conservata: l'attestazione dell'ultimo elenco buono non e' un
    // dato CORRENTE — la riga «NC control» del foglio dichiara non
    // verificabile e non presta l'attestato.
    const stale = monta({ fleetStale: true }, cella);
    const testoStale = await testoSezione();
    expect(testoStale).toContain(t('prompt-initial-control'));
    expect(testoStale).toContain(t('nc-control-unverifiable'));
    expect(testoStale).not.toContain(t('nc-control-attested'));
    stale.unmount();
    // Controllo positivo (sensibilità del degrado): la STESSA cella letta
    // da una fleet fresca mostra l'attestato nel foglio.
    const viva = monta({ fleetStale: false }, cella);
    const testoVivo = await testoSezione();
    expect(testoVivo).toContain(t('nc-control-attested'));
    viva.unmount();
  });
});
