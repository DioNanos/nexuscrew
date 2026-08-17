import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  nodeAction: vi.fn(),
  removeNode: vi.fn(),
  updateNode: vi.fn(),
  setNodeVisibility: vi.fn(),
  sendVlNodeCommand: vi.fn(),
  fleetDefinitions: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  nodeAction: mocks.nodeAction,
  removeNode: mocks.removeNode,
  updateNode: mocks.updateNode,
  setNodeVisibility: mocks.setNodeVisibility,
  sendVlNodeCommand: mocks.sendVlNodeCommand,
  fleetDefinitions: mocks.fleetDefinitions,
}));
vi.mock('./PairingCard.jsx', () => ({ default: () => null }));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => [] }));

import { NodesTab } from './SettingsPanel.jsx';
import NodeSheet from './NodeSheet.jsx';
import { vlNodeToPeer } from '../lib/vl-nodes-model.js';

const peer = {
  name: 'portatile', label: 'Portatile', direction: 'inbound', kind: 'direct',
  shared: true, visibility: 'network', tunnel: { status: 'up' },
  actions: { edit: true, test: true, remove: true, visibility: true },
};

function renderTab(nodes = [peer], props = {}) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const view = render(<NodesTab
    token="token" nodes={nodes} roster={[]} settings={{ deviceName: 'Phone' }}
    readonly={false} refresh={refresh} refreshAliases={vi.fn()} {...props}
  />);
  return { ...view, refresh };
}

function renderSheet(node = peer, nodes = [peer], props = {}) {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const view = render(<NodeSheet
    node={node} nodes={nodes} token="token" readonly={false}
    refresh={refresh} onClose={onClose} {...props}
  />);
  return { ...view, refresh, onClose };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  mocks.nodeAction.mockReset().mockResolvedValue({ ok: true, result: 'reachable' });
  mocks.removeNode.mockReset().mockResolvedValue({});
  mocks.updateNode.mockReset().mockResolvedValue({});
  mocks.setNodeVisibility.mockReset().mockResolvedValue({});
  mocks.sendVlNodeCommand.mockReset().mockResolvedValue({ id: 'cmd-1', status: 'submitted' });
  mocks.fleetDefinitions.mockReset().mockResolvedValue({ cells: [{ cell: 'Dev' }, { cell: 'Research' }] });
});

// --- scope celle (NC-E in UI) --------------------------------------------
// Il permesso per-cella esisteva gia' lato server ed era impostabile SOLO da
// riga di comando: chi amministra dalla PWA non poteva restringere un nodo, che
// e' il caso d'uso per cui il permesso e' nato.
describe('scope celle', () => {
  const scoped = (extra = {}) => ({ ...peer, ...extra });

  it('un peer diretto NON condiviso resta restringibile', async () => {
    // Differenza deliberata dalla visibilita' di transito: un nodo privato e'
    // proprio quello che si vuole restringere per primo.
    renderSheet(scoped({ shared: false }));
    expect(screen.getByText(/Cells this node can see/i)).toBeTruthy();
  });

  it('un nodo raggiunto in transito non offre il controllo', () => {
    renderSheet(scoped({ kind: 'transitive', route: ['hub', 'altro'], actions: { inspect: true } }));
    expect(screen.queryByText(/Cells this node can see/i)).toBeNull();
  });

  it('passando a "nessuna cella" non si manda un elenco che il server ignora', async () => {
    const { container } = renderSheet(scoped({ cellVisibility: 'selected', cells: ['Dev'] }));
    const select = [...container.querySelectorAll('select')]
      .find((el) => [...el.options].some((o) => o.value === 'none'));
    fireEvent.change(select, { target: { value: 'none' } });
    await waitFor(() => expect(mocks.updateNode).toHaveBeenCalled());
    const [, , patch] = mocks.updateNode.mock.calls[0];
    expect(patch).toEqual({ cellVisibility: 'none' });
    expect(patch.cells).toBeUndefined();
  });

  it('togliere una cella manda l\'elenco senza quella, non un elenco vuoto', async () => {
    renderSheet(scoped({ cellVisibility: 'selected', cells: ['Dev', 'Research'] }));
    const rows = [...document.querySelectorAll('.nc-detail-grant')];
    const devRow = rows.find((r) => r.textContent.includes('Dev'));
    fireEvent.click(devRow.querySelector('button'));
    await waitFor(() => expect(mocks.updateNode).toHaveBeenCalled());
    const [, , patch] = mocks.updateNode.mock.calls[0];
    expect(patch).toEqual({ cellVisibility: 'selected', cells: ['Research'] });
  });

  it('su un nodo gia\' ristretto l\'elenco si chiede subito', async () => {
    // Trovato guardando la UI vera: senza, una cella concessa che non esiste
    // piu' resta indistinguibile da una viva finche' qualcuno non apre il
    // picker — e chi apre il foglio per controllare i permessi e' proprio chi
    // ha bisogno di saperlo.
    renderSheet(scoped({ cellVisibility: 'selected', cells: ['Dev', 'Sparita'] }));
    await waitFor(() => expect(mocks.fleetDefinitions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelectorAll('.nc-detail-grant.unknown')).toHaveLength(1));
  });

  it('nel primo istante, prima della risposta, nessuna concessione e\' marcata', () => {
    // «Non lo so» non deve leggersi come «e' morta»: il render iniziale non
    // deve mostrare un falso allarme per il tempo di una richiesta di rete.
    renderSheet(scoped({ cellVisibility: 'selected', cells: ['Dev', 'Sparita'] }));
    expect(document.querySelectorAll('.nc-detail-grant.unknown')).toHaveLength(0);
  });

  it('avverte che cambiando modo l\'elenco scelto viene perso', () => {
    // Il server azzera l'elenco quando si lascia `selected`, ed e' giusto: un
    // residuo tornerebbe buono al ritorno, concedendo in silenzio cio' che si
    // credeva tolto. Ma perdere una scelta senza saperlo e' un'altra cosa.
    renderSheet(scoped({ cellVisibility: 'selected', cells: ['Dev'] }));
    expect(screen.getByText(/Switching mode clears the list/i)).toBeTruthy();
  });

  it('non avverte quando non c\'e\' ancora nulla da perdere', () => {
    // Un avviso che compare sempre smette di essere letto.
    renderSheet(scoped({ cellVisibility: 'selected', cells: [] }));
    expect(screen.queryByText(/Switching mode clears the list/i)).toBeNull();
    renderSheet(scoped({ cellVisibility: 'all' }));
    expect(screen.queryByText(/Switching mode clears the list/i)).toBeNull();
  });

  it('se l\'elenco non arriva, le concessioni NON diventano "sparite"', async () => {
    // Un errore di rete non deve leggersi come una revoca: prima il catch
    // metteva una lista vuota, e ogni cella concessa risultava inesistente —
    // cioe' il foglio annunciava una perdita di permessi che non era avvenuta.
    mocks.fleetDefinitions.mockRejectedValue(new Error('rete giu\''));
    renderSheet(scoped({ cellVisibility: 'selected', cells: ['Dev', 'Research'] }));
    await waitFor(() => expect(mocks.fleetDefinitions).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Cell list unavailable/i)).toBeTruthy());
    expect(document.querySelectorAll('.nc-detail-grant.unknown')).toHaveLength(0);
    expect(document.querySelectorAll('.nc-detail-grant')).toHaveLength(2);
  });

  it('dopo un errore non ritenta a ogni render', async () => {
    // Senza il flag, la guardia su `localCells === null` resterebbe vera e
    // l'apertura del foglio diventerebbe un ciclo di richieste.
    mocks.fleetDefinitions.mockRejectedValue(new Error('rete giu\''));
    const { rerender } = renderSheet(scoped({ cellVisibility: 'selected', cells: ['Dev'] }));
    await waitFor(() => expect(mocks.fleetDefinitions).toHaveBeenCalledTimes(1));
    rerender(<NodeSheet node={scoped({ cellVisibility: 'selected', cells: ['Dev'] })} nodes={[peer]}
      token="token" readonly={false} refresh={vi.fn()} onClose={vi.fn()} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.fleetDefinitions).toHaveBeenCalledTimes(1);
    // Legato al comportamento, non solo al conteggio: con la vecchia versione
    // il ritentativo era fermato da una lista VUOTA, che pero' marcava ogni
    // concessione come inesistente. Fermare il ciclo non basta: bisogna
    // fermarlo senza mentire.
    expect(document.querySelectorAll('.nc-detail-grant.unknown')).toHaveLength(0);
  });

  it('dopo un fallimento, "aggiungi una cella" RIPROVA invece di aprire un picker muto', async () => {
    // Rilievo dell'audit: col flag alzato, il click apriva il picker senza
    // richiedere nulla e mostrava "nessuna cella corrisponde" — che dice la
    // cosa sbagliata: non e' che le celle non ci sono, e' che non si e'
    // riusciti a chiederle.
    mocks.fleetDefinitions.mockRejectedValueOnce(new Error('rete giu\''));
    renderSheet(scoped({ cellVisibility: 'selected', cells: ['Dev'] }));
    await waitFor(() => expect(screen.getByText(/Cell list unavailable/i)).toBeTruthy());
    mocks.fleetDefinitions.mockResolvedValue({ cells: [{ cell: 'Research' }] });
    fireEvent.click(screen.getByText(/Add a cell/i));
    await waitFor(() => expect(mocks.fleetDefinitions).toHaveBeenCalledTimes(2));
    // Riuscito il secondo tentativo, l'avviso sparisce e il candidato compare.
    await waitFor(() => expect(screen.queryByText(/Cell list unavailable/i)).toBeNull());
    await waitFor(() => expect(screen.getByText('Research')).toBeTruthy());
  });

  it('la select dello scope ha un nome accessibile', () => {
    // Sta dentro una <label> senza testo: senza aria-label uno screen reader
    // legge un controllo anonimo che decide dei permessi.
    renderSheet(scoped({ cellVisibility: 'all' }));
    expect(screen.getByLabelText(/Cells this node can see/i)).toBeTruthy();
  });

  it('un nodo senza restrizione non paga nessuna richiesta in piu\'', () => {
    // Un foglio aperto per riavviare un tunnel non deve chiedere le celle.
    renderSheet(scoped({ cellVisibility: 'all' }));
    expect(mocks.fleetDefinitions).not.toHaveBeenCalled();
  });

  it('l\'elenco si chiede una volta sola, non a ogni apertura del picker', async () => {
    renderSheet(scoped({ cellVisibility: 'selected', cells: [] }));
    await waitFor(() => expect(mocks.fleetDefinitions).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText(/Add a cell/i));
    await waitFor(() => expect(mocks.fleetDefinitions).toHaveBeenCalledTimes(1));
    // Una seconda apertura non ripaga la richiesta.
    fireEvent.click(screen.getByText(/Cancel|Annulla/i));
    fireEvent.click(screen.getByText(/Add a cell/i));
    await waitFor(() => expect(mocks.fleetDefinitions).toHaveBeenCalledTimes(1));
  });
});

describe('NC-I: riga → foglio', () => {
  it('la riga non porta azioni: le mostra il foglio che apre', () => {
    const { container } = renderTab();
    // Prima dell'apertura la riga non deve offrire nulla da premere per
    // sbaglio: era il difetto della card precedente, che teneva rimozione e
    // spunte a portata di pollice dentro una lista che si scorre.
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(container.querySelector('.nc-node-row'));

    const sheet = screen.getByRole('dialog');
    expect(sheet).toBeTruthy();
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy();
  });

  it('la riga porta identita\' e riassunto, e nessun dettaglio di trasporto', () => {
    const { container } = renderTab([{ ...peer, ssh: 'user@host', token: 'segreto' }]);
    const row = container.querySelector('.nc-node-row');
    expect(row.textContent).toContain('Portatile');
    expect(row.textContent).toContain('portatile');
    expect(row.textContent).not.toContain('user@host');
    expect(row.textContent).not.toContain('segreto');
  });

  it('Esc chiude il foglio', () => {
    const { container } = renderTab();
    fireEvent.click(container.querySelector('.nc-node-row'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('il foglio segue l\'inventario: un nodo rimosso non resta aperto', async () => {
    // Il foglio si risolve per chiave a ogni render. Se tenesse una copia
    // dell'oggetto, dopo la rimozione mostrerebbe lo stato di un peer che non
    // esiste piu', con i suoi bottoni ancora premibili.
    const { container, rerender } = renderTab();
    fireEvent.click(container.querySelector('.nc-node-row'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    rerender(<NodesTab token="token" nodes={[]} roster={[]} settings={{}} readonly={false}
      refresh={vi.fn()} refreshAliases={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('NC-I: cosa dice il foglio', () => {
  it('dice che un nodo accoppiato e\' fidato quanto l\'operatore', () => {
    renderSheet();
    // La sezione «cosa puo' fare» e' quella che potrebbe mentire piu'
    // facilmente: senza questa frase resterebbe solo la visibilita', che dice
    // cosa il nodo VEDE e si leggerebbe come un limite di potere.
    expect(screen.getByText(/authority equal to yours/i)).toBeTruthy();
    // La frase diceva che i poteri per-nodo «non esistono ancora». Con lo scope
    // celle non e' piu' vero — e restava scritta due sezioni sopra il controllo
    // che li concede. L'intento del test non cambia: questa sezione deve
    // continuare a dire che dentro cio' che vede l'autorita' e' PIENA, perche'
    // un limite di visibilita' si legge facilmente come un limite di potere.
    expect(screen.getByText(/the authority stays full/i)).toBeTruthy();
    expect(screen.queryByText(/do not exist yet/i)).toBeNull();
  });

  it('non attribuisce a un nodo in transito un\'autorita\' su questa macchina', () => {
    renderSheet({ name: 'lontano', label: 'Lontano', kind: 'transitive', route: ['hub', 'lontano'] }, []);
    expect(screen.queryByText(/authority equal to yours/i)).toBeNull();
    expect(screen.getByText(/not paired with this machine/i)).toBeTruthy();
    expect(screen.getByText('hub › lontano')).toBeTruthy();
  });

  it('non porta segreti nemmeno nel dettaglio', () => {
    const { container } = renderSheet({ ...peer, token: 'segreto', acceptToken: 'segreto2' });
    expect(container.textContent).not.toContain('segreto');
  });
});

describe('NC-I: concessioni e picker', () => {
  const altri = [
    { ...peer, visibility: 'selected', selected: ['id-fisso'] },
    { name: 'fisso', label: 'Fisso', nodeId: 'id-fisso', kind: 'direct' },
    { name: 'telefono', label: 'Telefono', nodeId: 'id-telefono', kind: 'direct' },
  ];

  it('mostra le concessioni, non l\'universo dei nodi con le spunte', () => {
    renderSheet(altri[0], altri);
    expect(screen.getByText('Fisso')).toBeTruthy();
    // «Telefono» non e' concesso: deve comparire solo dentro il picker, dopo
    // che qualcuno lo ha cercato. Una lista di caselle con tutta la rete e'
    // esattamente cio' che questo ridisegno toglie.
    expect(screen.queryByText('Telefono')).toBeNull();
  });

  it('aggiunge una concessione tenendo quelle esistenti', async () => {
    renderSheet(altri[0], altri);
    fireEvent.click(screen.getByRole('button', { name: /add a node/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Telefono' }));
    await waitFor(() => expect(mocks.setNodeVisibility).toHaveBeenCalled());
    expect(mocks.setNodeVisibility).toHaveBeenCalledWith('token', 'portatile', 'selected', ['id-fisso', 'id-telefono']);
  });

  it('toglie una concessione senza toccare le altre', async () => {
    const node = { ...peer, visibility: 'selected', selected: ['id-fisso', 'id-telefono'] };
    renderSheet(node, [node, altri[1], altri[2]]);
    const rows = document.querySelectorAll('.nc-detail-grant');
    fireEvent.click(rows[0].querySelector('button'));
    await waitFor(() => expect(mocks.setNodeVisibility).toHaveBeenCalled());
    expect(mocks.setNodeVisibility).toHaveBeenCalledWith('token', 'portatile', 'selected', ['id-telefono']);
  });
});

describe('NC-I: azioni', () => {
  it('la rimozione chiede conferma, poi chiude il foglio', async () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    const confirm = document.querySelector('.nc-set-confirm');
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm.querySelector('.nc-btn.danger'));
    await waitFor(() => expect(mocks.removeNode).toHaveBeenCalledWith('token', 'portatile'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('in sola lettura la prova resta viva e le mutazioni no', () => {
    renderSheet(peer, [peer], { readonly: true });
    expect(screen.getByRole('button', { name: /test/i }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: /delete/i }).disabled).toBe(true);
  });
});

describe('NC_UI_NODI_VL step 2: comandi VL da capabilities + stato da lastAck', () => {
  const vlNode = (overrides = {}) => vlNodeToPeer({
    nodeId: 'a'.repeat(32), label: 'N900', cell: 'VL-aaaaaaaa',
    pairedAt: 1700000000000, online: true, lastSeen: 1700000100000,
    health: { state: 'running', detail: 'nominal' },
    capabilities: ['status', 'restart', 'unpair'],
    inflight: null, lastAck: null,
    ...overrides,
  });

  it('shows a button only for capabilities the node declares, and never update_candidate', () => {
    renderSheet(vlNode({ capabilities: ['status', 'update_candidate'] }), []);
    expect(screen.getByRole('button', { name: 'status' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /update.candidate/i })).toBeNull();
    // "restart" is a real device command in general, but THIS node did not
    // declare it — the brief's discriminating test.
    expect(screen.queryByRole('button', { name: 'restart' })).toBeNull();
  });

  it('shows "submitted" right after sending — not a success that has not happened yet', async () => {
    renderSheet(vlNode(), []);
    fireEvent.click(screen.getByRole('button', { name: 'restart' }));
    await waitFor(() => expect(mocks.sendVlNodeCommand).toHaveBeenCalledWith('token', 'a'.repeat(32), 'restart', {}, []));
    expect(await screen.findByText(/sent, awaiting confirmation/)).toBeTruthy();
    expect(screen.queryByText('completed')).toBeNull();
  });

  it('shows "in progress" once the node reports the command inflight', async () => {
    const { refresh } = renderSheet(vlNode(), []);
    fireEvent.click(screen.getByRole('button', { name: 'restart' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // Il refresh() reale ricaricherebbe /api/vl-nodes; nel test lo simuliamo
    // ri-renderizzando lo stesso NodeSheet con il nodo aggiornato che il
    // prossimo poll avrebbe restituito.
    const inflightNode = vlNode({ inflight: { id: 'cmd-1', kind: 'restart', status: 'sent' } });
    const view = render(<NodeSheet node={inflightNode} nodes={[]} token="token" readonly={false}
      refresh={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    expect(view.getByText(/in progress/)).toBeTruthy();
  });

  it('shows the real result only once lastAck matches the submitted command — never optimistic', () => {
    const acked = vlNode({ lastAck: { id: 'cmd-1', status: 'ok', result: { detail: 'restarted cleanly' }, at: 2000 } });
    // Nessun comando sottomesso in QUESTA sessione (foglio riaperto piu'
    // tardi): mostra comunque l'ultimo esito noto, mai un campo vuoto.
    render(<NodeSheet node={acked} nodes={[]} token="token" readonly={false}
      refresh={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    expect(screen.getByText(/completed/)).toBeTruthy();
    expect(screen.getByText(/restarted cleanly/)).toBeTruthy();
  });

  it('reports a failed command honestly instead of a silent/optimistic success', () => {
    const failed = vlNode({ lastAck: { id: 'cmd-1', status: 'error', result: { detail: 'device offline' }, at: 2000 } });
    render(<NodeSheet node={failed} nodes={[]} token="token" readonly={false}
      refresh={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    expect(screen.getByText(/failed/)).toBeTruthy();
    expect(screen.queryByText('completed')).toBeNull();
  });

  it('does not treat health.state as Fleet health.status — a running VL node is not shown as broken', () => {
    renderSheet(vlNode({ health: { state: 'running', detail: 'all good' } }), []);
    const box = screen.getByText('all good').closest('.nc-set-test');
    expect(box.className).toContain(' ok');
    expect(box.className).not.toContain(' ko');
  });

  // /vl-nodes/* e' federato (2026-08-05): il foglio deve dire "federated",
  // mai "not federated" (la bugia precedente) ne' "private client node".
  it('shows the VL node as federated, never "not federated" nor "private"', () => {
    renderSheet(vlNode(), []);
    expect(screen.queryByText(/not federated/i)).toBeNull();
    expect(screen.queryByText(/private client node/i)).toBeNull();
    expect(screen.getByText(/federated/i)).toBeTruthy();
  });
});

// Step 3 (NC_UI_NODI_VL_REMOTI): la federazione di /vl-nodes/* e' stata
// ripristinata (b0e8bd1) — un nodo VL puo' appartenere a un owner remoto, e
// un comando DEVE arrivare a quell'owner, non sempre a /api/vl-nodes locale.
describe('NC_UI_NODI_VL_REMOTI step 3: owner remoti', () => {
  const vlNode = (overrides = {}) => vlNodeToPeer({
    nodeId: 'a'.repeat(32), label: 'N900', cell: 'VL-aaaaaaaa',
    pairedAt: 1700000000000, online: true, lastSeen: 1700000100000,
    health: { state: 'running', detail: 'nominal' },
    capabilities: ['status', 'restart'],
    inflight: null, lastAck: null,
  }, overrides.owner ?? {});

  it('shows the owner in the sheet for a remote node', () => {
    renderSheet(vlNode({ owner: { instanceId: 'b'.repeat(16), route: ['vps3'], label: 'VPS3' } }), []);
    expect(screen.getByText('VPS3')).toBeTruthy();
  });

  // L'invariante piu' delicato del brief: un comando su un nodo REMOTO deve
  // essere instradato sulla route di QUELL'owner, mai su /api/vl-nodes
  // locale — sbagliare qui manda il comando al device sbagliato.
  it('sends the command to the REMOTE owner route, not to the local endpoint', async () => {
    const remote = vlNode({ owner: { instanceId: 'b'.repeat(16), route: ['vps3'], label: 'VPS3' } });
    renderSheet(remote, []);
    fireEvent.click(screen.getByRole('button', { name: 'restart' }));
    await waitFor(() => expect(mocks.sendVlNodeCommand).toHaveBeenCalledWith(
      'token', 'a'.repeat(32), 'restart', {}, ['vps3'],
    ));
  });

  it('still sends to the local route (empty) for a local node — unchanged from step 2', async () => {
    const local = vlNode();
    renderSheet(local, []);
    fireEvent.click(screen.getByRole('button', { name: 'restart' }));
    await waitFor(() => expect(mocks.sendVlNodeCommand).toHaveBeenCalledWith(
      'token', 'a'.repeat(32), 'restart', {}, [],
    ));
  });

  it('two same-label nodes on different owners are NOT the same row/sheet target', () => {
    // nodeId diversi (come nella realta': due device VL non condividono un
    // id a 32 esadecimali) ma STESSA label — il caso che l'owner deve
    // distinguere, non un caso limite di nodeId duplicato.
    const nodeA = vlNodeToPeer(
      { nodeId: 'a'.repeat(32), label: 'N900', capabilities: [] },
      { instanceId: 'a'.repeat(16), route: ['vps3'], label: 'VPS3' },
    );
    const nodeB = vlNodeToPeer(
      { nodeId: 'b'.repeat(32), label: 'N900', capabilities: [] },
      { instanceId: 'b'.repeat(16), route: ['nova'], label: 'NovaLNX' },
    );
    const { container } = render(<NodesTab
      token="token" nodes={[nodeA, nodeB]} roster={[]} settings={{}} readonly={false}
      refresh={vi.fn().mockResolvedValue(undefined)} refreshAliases={vi.fn()}
    />);
    // Stesso label del device ("N900") ma due righe distinte, distinguibili
    // per owner nel sottotitolo.
    const rows = container.querySelectorAll('.nc-node-row');
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain('VPS3');
    expect(container.textContent).toContain('NovaLNX');
  });
});

// Il verbo `prompt` richiede args.text: come bottone "spara e via" produceva
// {kind:'prompt', args:{}} e il device lo rifiutava — correttamente — con
// `invalid bounded command`. Il contratto funzionava, la UI no: mancava il
// campo dove scrivere. Da qui: prompt apre un input, il vuoto non parte, il
// testo viaggia come args.text; e nessun verbo con argomenti resta nella
// lista dei bottoni senza argomenti.
describe('VL prompt: un campo, non un grilletto', () => {
  const vlNode = (overrides = {}) => vlNodeToPeer({
    nodeId: 'a'.repeat(32), label: 'N900', cell: 'VL-aaaaaaaa',
    pairedAt: 1700000000000, online: true, lastSeen: 1700000100000,
    health: { state: 'running', detail: 'nominal' },
    capabilities: ['status', 'prompt'],
    inflight: null, lastAck: null,
    ...overrides,
  });

  function renderVl(node) {
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<NodeSheet node={node} nodes={[]} token="token" readonly={false} refresh={refresh} onClose={vi.fn()} />);
    return { refresh };
  }

  it('click su prompt apre il campo e NON invia nulla; il vuoto non parte mai', () => {
    renderVl(vlNode());
    fireEvent.click(screen.getByRole('button', { name: 'prompt' }));
    expect(mocks.sendVlNodeCommand).not.toHaveBeenCalled();
    const send = screen.getByRole('button', { name: 'send prompt' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('write the prompt for the device session…'), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: 'send prompt' }).disabled).toBe(true);
    expect(mocks.sendVlNodeCommand).not.toHaveBeenCalled();
  });

  it('il testo viaggia come args.text (trim) e l\'esito resta "inviato", mai un successo anticipato', async () => {
    renderVl(vlNode());
    fireEvent.click(screen.getByRole('button', { name: 'prompt' }));
    fireEvent.change(screen.getByPlaceholderText('write the prompt for the device session…'), {
      target: { value: '  controlla lo stato della sessione  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'send prompt' }));
    await waitFor(() => expect(mocks.sendVlNodeCommand).toHaveBeenCalledWith(
      'token', 'a'.repeat(32), 'prompt', { text: 'controlla lo stato della sessione' }, [],
    ));
    expect(await screen.findByText(/sent, awaiting confirmation/)).toBeTruthy();
    expect(screen.queryByText('completed')).toBeNull();
  });

  it('logs viaggia con il default esplicito: la stessa trappola non morde due volte', async () => {
    renderVl(vlNode({ capabilities: ['logs'] }));
    fireEvent.click(screen.getByRole('button', { name: 'logs' }));
    await waitFor(() => expect(mocks.sendVlNodeCommand).toHaveBeenCalledWith(
      'token', 'a'.repeat(32), 'logs', { limit: 50 }, [],
    ));
  });
});

// Il difetto mobile: a ogni giro di polling NodesTab ricrea le prop (node
// nuovo, onClose nuovo) e l'effetto di DetailSheet — armato su [onClose] —
// rifaceva sheet.focus(): il fuoco moriva sotto le dita e la tastiera si
// chiudeva. Il test fa QUELLO che succede dal telefono: digita, arriva il
// polling, e testo E fuoco devono sopravvivere. Senza far scattare il
// "polling" (rerender con identita' nuove) questo test non proverebbe niente.
describe('VL prompt: digitare sopravvive al polling', () => {
  const vlNode = (overrides = {}) => vlNodeToPeer({
    nodeId: 'a'.repeat(32), label: 'N900', cell: 'VL-aaaaaaaa',
    pairedAt: 1700000000000, online: true, lastSeen: 1700000100000,
    health: { state: 'running', detail: 'nominal' },
    capabilities: ['status', 'prompt'],
    inflight: null, lastAck: null,
    ...overrides,
  });

  it('testo e focus restano sul campo quando il genitore ripassa prop nuove', () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = render(<NodeSheet node={vlNode()} nodes={[]} token="token"
      readonly={false} refresh={refresh} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'prompt' }));
    const field = screen.getByPlaceholderText('write the prompt for the device session…');
    field.focus();
    fireEvent.change(field, { target: { value: 'c' } });
    expect(document.activeElement).toBe(field);

    // il giro di polling: node RICOSTRUITO e onClose con identita' NUOVA,
    // esattamente come NodesTab a ogni load().
    view.rerender(<NodeSheet node={vlNode()} nodes={[]} token="token"
      readonly={false} refresh={refresh} onClose={() => {}} />);

    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('c');
  });
});

// IL CASO CHE IL FIX DELLA PAIRING CARD NON COPRE: un nodo accoppiato PRIMA
// che la riga authorized_keys esistesse ha una sola permitopen e non rifara'
// mai il pairing — aggiornando non passa da onSuccess. L'unico canale che gli
// resta e' l'hint della sonda, che il prodotto conservava e non mostrava a
// nessuno: l'utente vedeva un nodo guasto senza l'azione che lo ripara.
describe('hint di salute — l azione che ripara il nodo', () => {
  const riga = 'restrict,port-forwarding,permitopen="127.0.0.1:41800",permitopen="127.0.0.1:41821",command="/bin/false" ssh-ed25519 AAAAC3Test peer';
  const guasto = {
    ...peer,
    tunnel: { status: 'degraded' },
    health: {
      status: 'degraded', detail: 'forward-channel-blocked',
      hint: `canale rifiutato dal NODO remoto: la chiave in ~/.ssh/authorized_keys non autorizza queste destinazioni. Riga da usare: ${riga}`,
    },
  };

  it('mostra la riga da sostituire, separata dalla spiegazione e copiabile', async () => {
    renderSheet(guasto);
    const campo = await screen.findByLabelText('Line to replace in ~/.ssh/authorized_keys on the peer');
    expect(campo.value).toBe(riga);
    // la spiegazione resta, ma senza la riga annegata dentro
    expect(screen.getByText(/canale rifiutato dal NODO remoto/)).toBeTruthy();
    expect(screen.getByText(/canale rifiutato dal NODO remoto/).textContent).not.toContain('permitopen');
  });

  // Il contratto robusto: la riga arriva come CAMPO, non ritagliata da una
  // frase che il backend puo' riscrivere o tradurre. Qui la frase e' diversa e
  // non contiene affatto la riga: il ritaglio fallirebbe, il campo no.
  it('preferisce il campo strutturato alla frase, e regge se la frase cambia', async () => {
    renderSheet({
      ...peer,
      tunnel: { status: 'degraded' },
      health: {
        status: 'degraded', detail: 'forward-channel-blocked',
        hint: 'una frase riscritta domani che non contiene piu la riga',
        authorizedKeys: riga,
      },
    });
    const campo = await screen.findByLabelText('Line to replace in ~/.ssh/authorized_keys on the peer');
    expect(campo.value).toBe(riga);
    expect(screen.getByText('una frase riscritta domani che non contiene piu la riga')).toBeTruthy();
  });

  it('un nodo sano non mostra nessun blocco di riparazione', () => {
    renderSheet({ ...peer, health: { status: 'healthy', detail: 'ok' } });
    expect(screen.queryByLabelText('Line to replace in ~/.ssh/authorized_keys on the peer')).toBeNull();
  });
});
