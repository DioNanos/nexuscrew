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
      events: [{ seq: 1, kind: 'text', text: 'ciao dal VL-Node-A' }], cursor: 1,
    });
    mount();
    await waitFor(() => expect(screen.getByText(/ciao dal VL-Node-A/)).toBeTruthy());
  });

  // Il difetto visto sul dispositivo: il ring consegna frammenti, e un `<li>`
  // per frammento spezza le parole a metà («ACT» / «IVE_WORK.md»). Il testo
  // che l'operatore legge deve essere quello che il device ha mandato.
  it('un messaggio arrivato in frammenti è una riga sola', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [
        { seq: 1, kind: 'text', text: 'Update ACT' },
        { seq: 2, kind: 'text', text: 'IVE_WORK.md' },
        { seq: 3, kind: 'tool_start', name: 'bash' },
      ],
      cursor: 3,
    });
    mount();
    await waitFor(() => expect(screen.getByText(/Update ACTIVE_WORK\.md/)).toBeTruthy());
    expect(screen.queryByText(/^Update ACT$/)).toBeNull();
    expect(screen.queryByText(/^IVE_WORK\.md$/)).toBeNull();
  });

  // Il difetto visto sul dispositivo: la conversazione mostrava eventi della
  // sessione PRECEDENTE, con l'ora vecchia. Il confine di sessione non e' il
  // nodo: cambio sessione -> si riparte da zero, non si appende al cursore di
  // prima.
  it('al cambio di sessione la vista riparte da zero, non dal cursore vecchio', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [{ seq: 1, kind: 'text', text: 'della sessione vecchia' }], cursor: 1,
    });
    const vista = mount({ sessionKey: 'vecchia' });
    await waitFor(() => expect(screen.getByText('della sessione vecchia')).toBeTruthy());

    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [{ seq: 1, kind: 'text', text: 'della sessione nuova' }], cursor: 1,
    });
    vista.rerender(<VlNodeEvents token="token" nodeId={NODE_ID} route={[]} sessionKey="nuova" />);
    await waitFor(() => expect(screen.getByText('della sessione nuova')).toBeTruthy());
    expect(screen.queryByText('della sessione vecchia')).toBeNull();
    const chiamate = vi.mocked(getVlNodeEvents).mock.calls;
    expect(chiamate[chiamate.length - 1][2], 'il nuovo giro riparte dal cursore zero').toBe(0);
  });

  it('un evento strutturale chiude il blocco: dopo un tool il testo riparte', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [
        { seq: 1, kind: 'text', text: 'prima' },
        { seq: 2, kind: 'tool_end', name: 'bash', isError: false },
        { seq: 3, kind: 'text', text: 'dopo' },
      ],
      cursor: 3,
    });
    mount();
    await waitFor(() => expect(screen.getByText('prima')).toBeTruthy());
    expect(screen.getByText('dopo')).toBeTruthy();
    expect(screen.queryByText(/primadopo/)).toBeNull();
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

  it('un evento gia visto non si appende due volte (consegna duplicata)', async () => {
    // Il difetto visto sul campo: su un collegamento lento due poll partono con
    // lo stesso cursore e ricevono gli stessi eventi — o un server rimanda
    // indietro cio' che il client ha gia'. La lista deve restare idempotente
    // per seq: il filtro del server e' un'ottimizzazione, non una garanzia.
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [{ seq: 1, kind: 'text', text: 'solo una volta' }], cursor: 1,
    });
    mount();
    await waitFor(() => expect(screen.getByText(/solo una volta/)).toBeTruthy());
    await waitFor(() => expect(vi.mocked(getVlNodeEvents).mock.calls.length).toBeGreaterThan(1), { timeout: 4000 });
    expect(screen.getAllByText(/solo una volta/)).toHaveLength(1);
  });

  it('non accavalla i poll: mai due richieste in volo insieme', async () => {
    // Su mobile la latenza supera il periodo di poll: senza guardia il tick
    // successivo parte col cursore VECCHIO mentre il primo e' ancora in volo,
    // e le due risposte identiche si appendono entrambe.
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(getVlNodeEvents).mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      inFlight -= 1;
      return { events: [], cursor: 0 };
    });
    mount();
    await waitFor(() => expect(vi.mocked(getVlNodeEvents).mock.calls.length).toBeGreaterThan(1), { timeout: 9000 });
    expect(maxInFlight).toBe(1);
  }, 12000);

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

  // La freschezza del peer non e' l'identita' della sessione: passare a
  // non corrente SOSPENDE la lettura periodica, non azzera quello che
  // l'operatore sta gia' leggendo. Il caso con la fonte eventi muta (il testo
  // che spariva lasciando il solo riquadro d'errore) e' coperto alla catena
  // vera, in App.vl-session-live.test.jsx.

  // E il ritorno alla corrente non azzera nemmeno lui — il cursore segue
  // la sessione, non la freschezza: si chiede solo il nuovo anche cambiando
  // stato.
  it('tornare corrente conserva eventi e cursore', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValueOnce({
      events: [{ seq: 1, kind: 'text', text: 'primo' }], cursor: 1,
    });
    const vista = mount();
    await waitFor(() => expect(screen.getByText('primo')).toBeTruthy());

    vi.mocked(getVlNodeEvents).mockClear();
    vi.mocked(getVlNodeEvents).mockResolvedValue({ events: [], cursor: 1 });
    vista.rerender(<VlNodeEvents token="token" nodeId={NODE_ID} route={[]} sospeso />);
    await waitFor(() => expect(vi.mocked(getVlNodeEvents)).toHaveBeenCalled(), { timeout: 4000 });
    expect(vi.mocked(getVlNodeEvents).mock.calls[0][2],
      'andare in sospeso non riporta il cursore a zero').toBe(1);

    vista.rerender(<VlNodeEvents token="token" nodeId={NODE_ID} route={[]} />);
    await waitFor(() => {
      const calls = vi.mocked(getVlNodeEvents).mock.calls;
      expect(calls[calls.length - 1][2], 'e nemmeno tornare corrente').toBe(1);
    }, { timeout: 4000 });
    expect(screen.getByText('primo'), 'la conversazione gia letta resta').toBeTruthy();
  }, 10000);

  // L'unico cambio che deve azzerare e' quello che cambia davvero la
  // generazione — anche se la vista era sospesa nel frattempo.
  it('il cambio di generazione azzera anche dopo un passaggio a stale', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValueOnce({
      events: [{ seq: 1, kind: 'text', text: 'della generazione vecchia' }], cursor: 1,
    });
    const vista = mount({ sessionKey: 'ollama|true|1' });
    await waitFor(() => expect(screen.getByText('della generazione vecchia')).toBeTruthy());
    vista.rerender(<VlNodeEvents token="token" nodeId={NODE_ID} route={[]} sessionKey="ollama|true|1" sospeso />);
    await waitFor(() => expect(vi.mocked(getVlNodeEvents).mock.calls.length).toBeGreaterThan(1), { timeout: 4000 });

    vi.mocked(getVlNodeEvents).mockClear();
    vi.mocked(getVlNodeEvents).mockResolvedValue({ events: [], cursor: 0 });
    vista.rerender(<VlNodeEvents token="token" nodeId={NODE_ID} route={[]} sessionKey="ollama|true|2" sospeso />);
    await waitFor(() => expect(vi.mocked(getVlNodeEvents)).toHaveBeenCalled(), { timeout: 4000 });
    expect(vi.mocked(getVlNodeEvents).mock.calls[0][2], 'generazione nuova: cursore da zero').toBe(0);
    expect(screen.queryByText('della generazione vecchia')).toBeNull();
  }, 10000);
});
