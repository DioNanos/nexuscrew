import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// L'i18n è mockato con le traduzioni italiane REALI delle cause nuove: il test
// verifica che il messaggio dica la causa GIUSTA (nonGranted dice «concedere
// sul nodo», denied dice «biglietto»), non solo che la chiave esista.
vi.mock('../lib/i18n.js', () => ({
  t: (k) => ({
    'panel-not-granted': 'Questo nodo non concede il pannello a chi lo chiede: l\'accesso va concesso sul nodo che possiede la cella, non riprovando qui.',
    'panel-denied': 'Ingresso al pannello rifiutato: il biglietto non è più valido. Riprova: verrà chiesto un biglietto nuovo.',
    'panel-node-refused': 'Il nodo che possiede la cella rifiuta la richiesta: è in sola lettura, o la sua policy blocca questa operazione. Riprovare qui non cambia l\'esito.',
    'panel-unauthorized': 'Credenziale non valida per questo nodo: va corretta dove è configurata, non riprovando da qui.',
    'panel-frame-loading': 'pannello montato: caricamento in corso',
    'panel-frame-error': 'Il frame del pannello non si è caricato: il biglietto può essere scaduto (30 s di vita, monouso) o la destinazione è irraggiungibile. Riprova: verrà chiesto un biglietto nuovo.',
  }[k] || k),
}));

// Il ticket arriva da requestPanelTicket: qui si mocka SOLO il trasporto —
// i casi danno gli esiti classificati che il vero modulo produce.
vi.mock('../lib/api.js', () => ({
  requestPanelTicket: vi.fn(),
  routeBase: (route) => Array.isArray(route) && route.length
    ? `/api/route/${route.map(encodeURIComponent).join('/')}/_` : '',
}));

import CellPanel from './CellPanel.jsx';
import { requestPanelTicket } from '../lib/api.js';

const ticketOk = (ticket = 'TK-1234567890') => requestPanelTicket.mockResolvedValue({ ok: true, ticket });

describe('CellPanel (D8: ingresso al pannello via ticket)', () => {
  beforeEach(() => { requestPanelTicket.mockReset(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('senza cella o senza token: stato reso (panel-none), nessun iframe, nessuna richiesta', () => {
    const { container } = render(<CellPanel cellId="" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} token="t" title="A" />);
    expect(screen.getByRole('status').textContent).toContain('panel-none');
    expect(container.querySelector('iframe')).toBeNull();
    expect(requestPanelTicket).not.toHaveBeenCalled();
  });

  it('flusso locale: ticket ok → iframe alla NOSTRA route con la pagina del panelUrl, mai al panelUrl grezzo', async () => {
    ticketOk();
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    const src = container.querySelector('iframe').getAttribute('src');
    expect(src.startsWith('/panel/A/vnc.html?ticket=TK-1234567890')).toBe(true);
    expect(src.includes('127.0.0.1:6901')).toBe(false, 'il loopback del container non compare mai nell\'iframe');
    expect(requestPanelTicket).toHaveBeenCalledWith('t', [], 'A', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('flusso REMOTO: il ticket e l\'iframe passano dalla via federata del nodo', async () => {
    ticketOk('TK-REMOTE');
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={['Pixel']} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    expect(requestPanelTicket).toHaveBeenCalledWith('t', ['Pixel'], 'A', expect.anything());
    const src = container.querySelector('iframe').getAttribute('src');
    expect(src.startsWith('/api/route/Pixel/_/panel/A/?ticket=TK-REMOTE')).toBe(true);
  });

  it('not-granted: causa NOMINATA con la sua azione (concedere sul nodo), non collassata', async () => {
    requestPanelTicket.mockResolvedValue({ ok: false, cause: 'not-granted' });
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('non concede il pannello'); });
    expect(screen.getByRole('status').textContent).toContain('nodo che possiede la cella');
    expect(container.querySelector('iframe')).toBeNull();
    // E NESSUN Riprova: il testo dice «non riprovando qui», offrire quel gesto
    // contraddirebbe la causa appena nominata. Vale per i tre stati che
    // dipendono da una decisione presa ALTROVE (questo, node-refused,
    // unauthorized); dove la condizione può essere già cambiata — biglietto,
    // timeout, rete — il pulsante resta.
    expect(screen.queryByTitle('panel-retry')).toBeNull();
  });

  it('denied (biglietto rifiutato): messaggio proprio, e Riprova chiede un biglietto NUOVO', async () => {
    requestPanelTicket.mockResolvedValueOnce({ ok: false, cause: 'denied' });
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('biglietto non è più valido'); });
    requestPanelTicket.mockResolvedValueOnce({ ok: true, ticket: 'TK-NUOVO' });
    fireEvent.click(screen.getByTitle('panel-retry'));
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    expect(container.querySelector('iframe').getAttribute('src')).toContain('ticket=TK-NUOVO');
    expect(requestPanelTicket).toHaveBeenCalledTimes(2);
  });

  it('node-refused (il nodo owner è in sola lettura): causa propria e NESSUN Riprova', async () => {
    // Un audit indipendente ha percorso questa catena: peer autorizzato, nodo
    // owner READONLY, 403 senza `reason` → il frontend lo classificava
    // `denied`, cioè «biglietto scaduto», e offriva Riprova. La richiesta
    // successiva è identica e resta 403 finché non cambia la policy del nodo:
    // il pulsante prometteva un recupero che non poteva avvenire.
    requestPanelTicket.mockResolvedValue({ ok: false, cause: 'node-refused' });
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('sola lettura'); });
    // La causa deve essere DISTINTA da quella del biglietto, non un sinonimo.
    expect(screen.getByRole('status').textContent).not.toContain('biglietto');
    expect(screen.queryByTitle('panel-retry')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  // —— R20: il CONSUMO del biglietto non è più invisibile ——————————————————
  // Prima: stato `ready` appena arriva il ticket e da lì il componente non
  // osservava più nulla — consumo fallito (biglietto scaduto: 30 s, monouso;
  // destinazione morta) = frame bianco e NESSUNO stato a dirlo. Gli stati
  // denied/panel-denied coprivano solo l'EMISSIONE. Ora il frame si osserva
  // col canale che l'iframe offre già (load/error), e i due momenti — montato
  // e caricato — sono distinti e visibili.

  it('R20: biglietto ok → frame MONTATO (ready): hint visibile e data-frame-state, prima del load', async () => {
    ticketOk('TK-MONTATO');
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    const frame = container.querySelector('iframe');
    // La distinzione «montato, non ancora caricato» è DICHIARATA, non chiusa
    // nel componente: hint visibile + stato esposto sul DOM.
    expect(frame.getAttribute('data-frame-state')).toBe('ready');
    expect(screen.getByRole('status').textContent).toContain('caricamento in corso');
  });

  it('R20: il load del frame porta a loaded — l\'hint sparisce e il frame NON si ricarica', async () => {
    ticketOk('TK-LOAD');
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    const frame = container.querySelector('iframe');
    const srcPrima = frame.getAttribute('src');
    fireEvent.load(frame);
    await waitFor(() => { expect(container.querySelector('iframe').getAttribute('data-frame-state')).toBe('loaded'); });
    expect(screen.queryByText(/caricamento in corso/)).toBeNull();
    // Il passaggio di stato NON deve rimontare/ricaricare il frame: un login
    // dentro il pannello non deve ricominciare da capo (stesso difetto storico
    // del ricaricamento continuo, altra forma).
    expect(container.querySelector('iframe').getAttribute('src')).toBe(srcPrima);
  });

  it('R20: error del frame → frame-error NOMINATO con Riprova; il biglietto nuovo ripristina il frame', async () => {
    requestPanelTicket.mockResolvedValueOnce({ ok: true, ticket: 'TK-PRIMO' });
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    fireEvent.error(container.querySelector('iframe'));
    // Il frame bianco ora ha un nome e un'azione — la promessa di recupero
    // che il vecchio commento faceva solo per l'emissione.
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('non si è caricato'); });
    expect(screen.getByRole('status').textContent).toContain('biglietto');
    expect(container.querySelector('iframe')).toBeNull();
    requestPanelTicket.mockResolvedValueOnce({ ok: true, ticket: 'TK-SECONDO' });
    fireEvent.click(screen.getByTitle('panel-retry'));
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    expect(container.querySelector('iframe').getAttribute('src')).toContain('ticket=TK-SECONDO');
    expect(requestPanelTicket).toHaveBeenCalledTimes(2);
  });

  it('unauthorized e no-panel: cause distinte dal backend, rese con lo stato giusto', async () => {
    requestPanelTicket.mockResolvedValueOnce({ ok: false, cause: 'unauthorized' });
    const { container, rerender } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />,
    );
    // 401 è una credenziale locale non valida, non un biglietto scaduto:
    // messaggio proprio, e nessun Riprova, perché riprovare con la stessa
    // credenziale dà lo stesso esito.
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Credenziale non valida'); });
    expect(screen.queryByTitle('panel-retry')).toBeNull();
    // La seconda causa si prova su una CELLA diversa, non con un rerender
    // identico: da quando il pannello non si riapre a ogni render del padre
    // (era il difetto del ricaricamento continuo), un rerender uguale non
    // ripete la richiesta — ed è la proprietà voluta. Qui interessa che le due
    // cause siano rese distinte, non come si arriva alla seconda.
    requestPanelTicket.mockResolvedValueOnce({ ok: false, cause: 'no-panel' });
    rerender(<CellPanel cellId="B" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="B" />);
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('panel-none'); });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('timeout deterministico: il nostro timer chiude la partita, stato panel-timeout NON unreachable', async () => {
    requestPanelTicket.mockImplementation((_t, _route, _cell, { signal }) => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    render(<CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" requestTimeoutMs={30} />);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('panel-timeout');
    }, { timeout: 2000 });
    expect(screen.getByRole('status').textContent).not.toContain('unreachable');
    expect(screen.queryByTitle('panel-open')).toBeNull();
  });

  it('rete che cade: panel-unreachable (verso la NOSTRA origine) con Riprova', async () => {
    requestPanelTicket.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />);
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('panel-unreachable'); });
    expect(screen.getByTitle('panel-retry')).toBeTruthy();
  });
});

// --- P0 sicurezza (2026-08-16): origin separata per il pannello -------------
// La guardia che conta non e' "il campo panelPort esiste": e' che, quando la
// porta pannello PER QUESTA CELLA e' nota, il browser riceva un frameUrl
// ASSOLUTO verso una PORTA DIVERSA — e' quello che rende l'origin diversa, non
// un dettaglio di path. La prop e' per-cella: la porta del nodo LOCALE per le
// celle locali, la porta INOLTRATA del nodo remoto (negoziata nel pairing,
// mappata da /api/config) per le celle remote. Senza panelPort (0: config non
// ancora arrivata, o nodo vecchio senza porta negoziata) resta la via storica:
// mai un frame verso porta 0.
describe('CellPanel — origin separata (panelPort)', () => {
  it('locale + panelPort noto: frameUrl e\' ASSOLUTO verso quella porta, non un path relativo', async () => {
    ticketOk('TK-ORIGIN');
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} panelPort={41821} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    const src = container.querySelector('iframe').getAttribute('src');
    expect(src.startsWith('http://127.0.0.1:41821/panel/A/vnc.html?ticket=TK-ORIGIN')).toBe(true);
  });

  it('senza panelPort (0, config non ancora arrivata): resta la via storica relativa, MAI porta 0', async () => {
    ticketOk('TK-FALLBACK');
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} panelPort={0} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    const src = container.querySelector('iframe').getAttribute('src');
    expect(src).toBe('/panel/A/vnc.html?ticket=TK-FALLBACK');
    expect(src.includes(':0')).toBe(false, 'mai un frame verso una porta 0');
  });

  it('REMOTO con porta pannello negoziata: frameUrl ASSOLUTO verso la porta inoltrata del nodo', async () => {
    // La meta' remota del P0: il tunnel porta la porta pannello del peer sul
    // NOSTRO loopback, e il frame ci punta sopra. Il ticket viene comunque
    // chiesto per la route federata: lo emette il processo del nodo remoto,
    // lo consuma la sua porta pannello — stesso processo, biglietto valido.
    ticketOk('TK-REMOTE-ORIGIN');
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={['Pixel']} panelPort={43101} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    expect(requestPanelTicket).toHaveBeenCalledWith('t', ['Pixel'], 'A', expect.anything());
    const src = container.querySelector('iframe').getAttribute('src');
    expect(src.startsWith('http://127.0.0.1:43101/panel/A/?ticket=TK-REMOTE-ORIGIN')).toBe(true,
      'origin separata anche per la cella remota: e\' la seconda meta\' del P0');
    expect(src.startsWith('/api/route/')).toBe(false, 'niente via federata same-origin quando la porta c\'e\'');
  });

  it('REMOTO senza porta negoziata (nodo vecchio): via federata storica, nessun errore', async () => {
    // Il punto 4 visto dal frame: un peer che non ha annunciato la porta
    // pannello non deve diventare un pannello rotto — il frame prende la via
    // di sempre, stessa origin del control plane, come oggi.
    ticketOk('TK-REMOTE-VECCHIO');
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={['Pixel']} panelPort={0} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    const src = container.querySelector('iframe').getAttribute('src');
    expect(src.startsWith('/api/route/Pixel/_/panel/A/?ticket=TK-REMOTE-VECCHIO')).toBe(true);
    expect(src.includes(':0')).toBe(false);
  });

  it('il padre che ri-renderizza NON fa ricaricare il pannello (un solo biglietto)', async () => {
    // Il difetto visto sul campo: il frame si ricaricava senza sosta e non
    // dava il tempo di interagire — un login dentro il pannello non arrivava
    // mai a compimento. `route` è un array: una prop NUOVA a ogni render del
    // padre anche a contenuto identico, e il padre ri-renderizza di continuo
    // per il polling della flotta. Con l'array fra le dipendenze, ogni giro
    // chiedeva un biglietto nuovo e rimontava l'iframe.
    //
    // Il test isolato non poteva vederlo: senza un padre che ri-renderizza, il
    // difetto non esiste. Qui il padre c'è, ed è la sola differenza.
    ticketOk('TK-STABILE');
    const Padre = ({ giro }) => (
      <div data-giro={giro}>
        {/* array LETTERALE, come nell'app: nuova referenza a ogni render */}
        <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />
      </div>
    );
    const { container, rerender } = render(<Padre giro={1} />);
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    const primoSrc = container.querySelector('iframe').getAttribute('src');

    for (let g = 2; g <= 6; g += 1) rerender(<Padre giro={g} />);
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });

    expect(requestPanelTicket).toHaveBeenCalledTimes(1);
    // E l'iframe non deve nemmeno cambiare src: cambiarlo È il ricaricamento.
    expect(container.querySelector('iframe').getAttribute('src')).toBe(primoSrc);
  });

  it('ma se la route cambia DAVVERO, il pannello si riapre', async () => {
    // Il verso opposto: la stabilizzazione non deve congelare il componente su
    // un nodo quando l'utente ne guarda un altro.
    ticketOk('TK-1');
    const { rerender } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(requestPanelTicket).toHaveBeenCalledTimes(1); });
    rerender(<CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={['Pixel']} token="t" title="A" />);
    await waitFor(() => { expect(requestPanelTicket).toHaveBeenCalledTimes(2); });
  });
});