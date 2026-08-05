import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  nodeAction: vi.fn(),
  removeNode: vi.fn(),
  updateNode: vi.fn(),
  setNodeVisibility: vi.fn(),
  sendVlNodeCommand: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  nodeAction: mocks.nodeAction,
  removeNode: mocks.removeNode,
  updateNode: mocks.updateNode,
  setNodeVisibility: mocks.setNodeVisibility,
  sendVlNodeCommand: mocks.sendVlNodeCommand,
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
    expect(screen.getByText(/per-node powers do not exist yet/i)).toBeTruthy();
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

  it('shows "not federated", never "private", for the network-view section', () => {
    renderSheet(vlNode(), []);
    expect(screen.getByText(/not federated/i)).toBeTruthy();
    expect(screen.queryByText(/private client node/i)).toBeNull();
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
