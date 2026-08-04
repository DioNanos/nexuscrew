import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  nodeAction: vi.fn(),
  removeNode: vi.fn(),
  updateNode: vi.fn(),
  setNodeVisibility: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  nodeAction: mocks.nodeAction,
  removeNode: mocks.removeNode,
  updateNode: mocks.updateNode,
  setNodeVisibility: mocks.setNodeVisibility,
}));
vi.mock('./PairingCard.jsx', () => ({ default: () => null }));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => [] }));

import { NodesTab } from './SettingsPanel.jsx';
import NodeSheet from './NodeSheet.jsx';

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
