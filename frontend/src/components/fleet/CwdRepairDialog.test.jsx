import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// i18n: pass-through delle chiavi, con template per i placeholder che testiamo.
const TEMPLATES = {
  'fleet-cwd-repair-title': 'TITLE {id}',
  'fleet-cwd-repair-preview': 'PREVIEW {path}',
  'fleet-cwd-repair-confirm': 'CONFIRM {id} {path}',
  'fleet-cwd-repair-use-suggestion': 'USE {path}',
};
vi.mock('../../lib/i18n.js', () => ({ t: (k) => (Object.prototype.hasOwnProperty.call(TEMPLATES, k) ? TEMPLATES[k] : k) }));

// API mock: fleetEditCell e listDirs sono vi.fn controllabili per testare payload,
// route preservation, conferma, assenza di mutation automatica, suggestion.
const api = vi.hoisted(() => ({
  fleetEditCell: vi.fn(),
  listDirs: vi.fn(),
}));
vi.mock('../../lib/api.js', () => ({
  fleetEditCell: api.fleetEditCell,
  listDirs: api.listDirs,
}));

import CwdRepairDialog from './CwdRepairDialog.jsx';
import { fleetEditCell, listDirs } from '../../lib/api.js';

const FOREIGN_CWD = '/home/foreign/secret/device/path';
const ROUTE = ['relay', 'vps'];

function renderDialog(over = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <CwdRepairDialog
      token="tok"
      route={ROUTE}
      cell={{ id: 'Orphan', engine: 'claude', cwd: FOREIGN_CWD, needsRepair: true }}
      onSaved={onSaved}
      onClose={onClose}
      {...over}
    />,
  );
  return { ...utils, onSaved, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const input = () => screen.getByPlaceholderText('fleet-cwd-repair-placeholder');
const applyBtn = () => screen.getByRole('button', { name: 'save' });

describe('CwdRepairDialog — source path isolation', () => {
  it('never renders the source-device absolute cwd (cell.cwd)', () => {
    renderDialog();
    expect(screen.queryByText(FOREIGN_CWD)).toBeNull();
    // nessun segmento del path foreign esposto
    expect(document.body.textContent).not.toContain(FOREIGN_CWD);
  });

  it('offers a target-validated initial suggestion without mutating or exposing the source cwd', () => {
    renderDialog({
      cell: { id: 'Orphan', cwd: FOREIGN_CWD, needsRepair: true, cwdSuggestion: 'Dev' },
    });
    expect(screen.getByRole('button', { name: 'USE ~/Dev' })).toBeTruthy();
    expect(fleetEditCell).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(FOREIGN_CWD);
  });
});

describe('CwdRepairDialog — repair flow + cwdRel-only payload + route preservation', () => {
  it('sends ONLY { cwdRel } to edit-cell (no cwd key) and preserves the route', async () => {
    api.fleetEditCell.mockResolvedValue({ ok: true });
    const { onSaved } = renderDialog();
    fireEvent.change(input(), { target: { value: 'Dev' } });
    fireEvent.click(applyBtn());

    await waitFor(() => expect(fleetEditCell).toHaveBeenCalledTimes(1));
    const args = fleetEditCell.mock.calls[0];
    expect(args[0]).toBe('tok'); // token
    expect(args[1]).toBe('Orphan'); // id
    // payload: ESATTAMENTE { cwdRel }, nessun cwd assoluto
    expect(Object.keys(args[2]).sort()).toEqual(['cwdRel']);
    expect(args[2].cwdRel).toBe('Dev');
    expect(args[2].cwd).toBeUndefined();
    // route preservation: il 4° argomento e' lo stesso array route passato in
    expect(args[3]).toBe(ROUTE);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('normalizes the cwdRel before sending (collapse ./, trailing slash)', async () => {
    api.fleetEditCell.mockResolvedValue({ ok: true });
    renderDialog();
    fireEvent.change(input(), { target: { value: 'a/./b/' } });
    fireEvent.click(applyBtn());
    await waitFor(() => expect(fleetEditCell).toHaveBeenCalledTimes(1));
    expect(fleetEditCell.mock.calls[0][2].cwdRel).toBe('a/b');
  });

  it('home cwdRel (empty) is valid and sends cwdRel=""', async () => {
    api.fleetEditCell.mockResolvedValue({ ok: true });
    renderDialog();
    // nessun input: resta '' (home)
    fireEvent.click(applyBtn());
    await waitFor(() => expect(fleetEditCell).toHaveBeenCalledTimes(1));
    expect(fleetEditCell.mock.calls[0][2].cwdRel).toBe('');
  });
});

describe('CwdRepairDialog — confirmation + no automatic mutation', () => {
  it('does NOT mutate on mount (no edit-cell call until Apply)', () => {
    renderDialog();
    expect(fleetEditCell).not.toHaveBeenCalled();
  });

  it('does NOT mutate when confirmation is dismissed', async () => {
    window.confirm.mockReturnValue(false);
    api.fleetEditCell.mockResolvedValue({ ok: true });
    renderDialog();
    fireEvent.change(input(), { target: { value: 'Dev' } });
    fireEvent.click(applyBtn());
    expect(window.confirm).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(fleetEditCell).not.toHaveBeenCalled();
  });

  it('rejects invalid cwdRel (absolute / traversal) without calling edit-cell', () => {
    api.fleetEditCell.mockResolvedValue({ ok: true });
    renderDialog();
    for (const bad of ['/etc', '../x', 'a/..', 'a\\b', 'C:x']) {
      fireEvent.change(input(), { target: { value: bad } });
      fireEvent.click(applyBtn());
      expect(fleetEditCell).not.toHaveBeenCalled();
    }
    // window.confirm non deve essere stato richiamato per input invalido
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.getByText('fleet-cwd-repair-invalid')).toBeTruthy();
  });

  it('browse is read-only: listDirs is called, edit-cell is not', async () => {
    api.listDirs.mockResolvedValue({ path: '/home/u', home: '/home/u', parent: null, dirs: ['Dev'] });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'fleet-cwd-repair-browse' }));
    await waitFor(() => expect(listDirs).toHaveBeenCalledTimes(1));
    // listDirs riceve la cwdRel (confine home), mai un path assoluto
    expect(listDirs.mock.calls[0][1]).toBe('');
    expect(listDirs.mock.calls[0][2]).toBe(ROUTE);
    expect(fleetEditCell).not.toHaveBeenCalled();
    // il picker rappresenta la radice come ~, MAI il path assoluto del target
    expect(screen.getByText('~')).toBeTruthy();
    expect(document.body.textContent).not.toContain('/home/u');
  });

  it('selecting a folder from the picker is a local preview, not a mutation', async () => {
    let n = 0;
    api.listDirs.mockImplementation(async (tok, rel) => {
      n += 1;
      if (!rel) return { path: '/home/u', home: '/home/u', parent: null, dirs: ['Dev'] };
      return { path: `/home/u/${rel}`, home: '/home/u', parent: '/home/u', dirs: [] };
    });
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'fleet-cwd-repair-browse' }));
    const devBtn = await screen.findByRole('button', { name: /Dev/ });
    fireEvent.click(devBtn); // entra in ~/Dev
    await waitFor(() => expect(n).toBe(2));
    // "use this folder": setta il campo localmente
    fireEvent.click(screen.getByRole('button', { name: 'fleet-cwd-repair-use-current' }));
    expect(input().value).toBe('Dev');
    expect(fleetEditCell).not.toHaveBeenCalled();
  });

  it('navigates one level up without exposing absolute paths', async () => {
    api.listDirs.mockImplementation(async (_tok, rel) => ({
      path: rel ? `/home/u/${rel}` : '/home/u', home: '/home/u',
      parent: rel ? '/home/u' : null, dirs: rel === 'Dev' ? ['Nested'] : ['Dev'],
    }));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'fleet-cwd-repair-browse' }));
    fireEvent.click(await screen.findByRole('button', { name: /Dev/ }));
    await waitFor(() => expect(screen.getByText('~/Dev')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /fs-parent/ }));
    await waitFor(() => expect(screen.getByText('~')).toBeTruthy());
    expect(api.listDirs.mock.calls.at(-1)[1]).toBe('');
    expect(document.body.textContent).not.toContain('/home/u');
  });

  it('does not offer a failed picker location as selectable', async () => {
    api.listDirs.mockRejectedValueOnce(new Error('offline'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'fleet-cwd-repair-browse' }));
    const use = await screen.findByRole('button', { name: 'fleet-cwd-repair-use-current' });
    await waitFor(() => expect(use.disabled).toBe(true));
    expect(fleetEditCell).not.toHaveBeenCalled();
  });
});

describe('CwdRepairDialog — unportable-cwd + suggestion as explicit choice', () => {
  it('surfaces unportable-cwd and shows suggestion as an EXPLICIT, non-auto choice', async () => {
    const unportable = Object.assign(new Error('cwd non portabile'), {
      status: 400,
      data: { code: 'unportable-cwd', cells: [{ id: 'Orphan', suggestion: 'Dev' }], hint: 'sotto la home' },
    });
    api.fleetEditCell.mockRejectedValueOnce(unportable);
    renderDialog();
    fireEvent.change(input(), { target: { value: 'nope' } });
    fireEvent.click(applyBtn());
    await waitFor(() => expect(fleetEditCell).toHaveBeenCalledTimes(1));
    // code surfaceato come errore esplicito
    expect(screen.getByText('fleet-cwd-repair-unportable')).toBeTruthy();
    // suggestion resa come scelta esplicita (pulsante), rappresenta ~/Dev
    const sugBtn = screen.getByRole('button', { name: 'USE ~/Dev' });
    expect(sugBtn).toBeTruthy();
    // IMPORTANTE: la suggestion auto-riempie solo il campo; nessuna nuova mutation
    fireEvent.click(sugBtn);
    expect(input().value).toBe('Dev');
    expect(fleetEditCell).toHaveBeenCalledTimes(1); // invariato: niente auto-submit
    // un secondo Apply esplicito (conferma) ora esegue la mutation con il valore suggerito
    api.fleetEditCell.mockResolvedValueOnce({ ok: true });
    fireEvent.click(applyBtn());
    await waitFor(() => expect(fleetEditCell).toHaveBeenCalledTimes(2));
    expect(fleetEditCell.mock.calls[1][2].cwdRel).toBe('Dev');
  });

  it('unportable-cwd without suggestion shows the error and no suggestion button', async () => {
    const unportable = Object.assign(new Error('cwd non portabile'), {
      status: 400,
      data: { code: 'unportable-cwd', cells: [{ id: 'Orphan' }], hint: 'sotto la home' },
    });
    api.fleetEditCell.mockRejectedValueOnce(unportable);
    renderDialog();
    fireEvent.change(input(), { target: { value: 'nope' } });
    fireEvent.click(applyBtn());
    await waitFor(() => expect(fleetEditCell).toHaveBeenCalledTimes(1));
    expect(screen.getByText('fleet-cwd-repair-unportable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /USE/ })).toBeNull();
  });

  it('shows a generic error for non-unportable failures', async () => {
    api.fleetEditCell.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500, data: {} }));
    renderDialog();
    fireEvent.change(input(), { target: { value: 'Dev' } });
    fireEvent.click(applyBtn());
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });
});

describe('CwdRepairDialog — cancel', () => {
  it('Cancel invokes onClose without mutating', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fleetEditCell).not.toHaveBeenCalled();
  });
});
