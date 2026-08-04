import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../lib/i18n.js', () => ({ t: (key) => key }));
vi.mock('../../lib/api.js', () => ({ listDirs: vi.fn() }));

import CellEditor from './CellEditor.jsx';

const engines = [
  { id: 'claude.native', label: 'Claude', managed: { client: 'claude', model: '' } },
  { id: 'shell.local', label: 'Shell', managed: { client: 'shell', model: '' } },
];

describe('CellEditor — Shell locale', () => {
  it('shows the per-cell command and hides model/prompt controls', () => {
    const setState = vi.fn();
    render(<CellEditor
      token="tok" route={[]} targets={[]} location="" setLocation={vi.fn()}
      state={{ mode: 'edit', form: { id: 'Ops', cwd: '/home/user/work', engine: 'shell.local', boot: false, model: 'stale', prompt: 'preserve', commands: {}, command: '' } }}
      setState={setState} engines={engines} busy={false} onSave={vi.fn()}
    />);
    expect(screen.getByPlaceholderText('fleet-shell-command-placeholder')).toBeTruthy();
    expect(screen.queryByPlaceholderText('fleet-model-override')).toBeNull();
    expect(screen.queryByPlaceholderText('prompt')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('fleet-shell-command-placeholder'), { target: { value: "printf '$HOME' | sed s/x/y/" } });
    expect(setState).toHaveBeenCalledWith(expect.objectContaining({
      form: expect.objectContaining({
        command: "printf '$HOME' | sed s/x/y/",
        commands: { 'shell.local': "printf '$HOME' | sed s/x/y/" },
      }),
    }));
  });
});

// --- NC-D: il nome dev'essere SCRIVIBILE, non solo leggibile ---------------
// Propagare un campo che l'operatore non puo' impostare lascia la funzione
// irraggiungibile: la label esisterebbe solo per chi modifica il file a mano.
describe('CellEditor cell label', () => {
  it('espone un campo per il nome leggibile, distinto dall id', () => {
    const state = { mode: 'new', form: { id: 'Dev', cwd: '/home/user/work', engine: 'claude.native', label: '' } };
    const setState = vi.fn();
    render(<CellEditor
      token="t" route={null} targets={[]} location={null} setLocation={vi.fn()}
      state={state} setState={setState} engines={engines} busy={false} onSave={vi.fn()}
    />);
    const field = screen.getByPlaceholderText('fleet-cell-label');
    expect(field).toBeTruthy();
    fireEvent.change(field, { target: { value: 'Cella di sviluppo' } });
    expect(setState).toHaveBeenCalled();
    const patched = setState.mock.calls.at(-1)[0];
    const form = typeof patched === 'function' ? patched(state).form : patched.form;
    expect(form.label).toBe('Cella di sviluppo');
    // L'id non viene toccato: resta la chiave di indirizzamento.
    expect(form.id).toBe('Dev');
  });

  it('il campo del nome resta scrivibile anche in modifica, dove l id e' + "' bloccato", () => {
    const state = { mode: 'edit', form: { id: 'Dev', cwd: '/home/user/work', engine: 'claude.native', label: 'Vecchio' } };
    render(<CellEditor
      token="t" route={null} targets={[]} location={null} setLocation={vi.fn()}
      state={state} setState={vi.fn()} engines={engines} busy={false} onSave={vi.fn()}
    />);
    expect(screen.getByDisplayValue('Dev').disabled).toBe(true);
    expect(screen.getByDisplayValue('Vecchio').disabled).toBeFalsy();
  });
});
