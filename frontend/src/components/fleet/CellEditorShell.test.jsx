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

// --- panelUrl: il campo che rende attivabile il pannello (0.9.1 punto 3) ---
// La guardia che conta non e' "il campo esiste": e' che scrivendo un valore
// NON-loopback l'utente LEGGA PERCHE' e' rifiutato, prima ancora di salvare —
// il backend lo rifiuterebbe comunque, ma con un messaggio generico che non
// dice quale campo ne e' la causa (mutate() in lib/fleet/builtin.js incarta
// qualunque errore di parseDefinitions in "definizioni non valide: <msg>").
describe('CellEditor panelUrl', () => {
  it('espone un campo scrivibile per panelUrl, che finisce nel form', () => {
    const state = { mode: 'new', form: { id: 'Dev', cwd: '/home/user/work', engine: 'claude.native', panelUrl: '' } };
    const setState = vi.fn();
    render(<CellEditor
      token="t" route={null} targets={[]} location={null} setLocation={vi.fn()}
      state={state} setState={setState} engines={engines} busy={false} onSave={vi.fn()}
    />);
    const field = screen.getByPlaceholderText('fleet-panel-url');
    fireEvent.change(field, { target: { value: 'https://127.0.0.1:6901' } });
    const patched = setState.mock.calls.at(-1)[0];
    const form = typeof patched === 'function' ? patched(state).form : patched.form;
    expect(form.panelUrl).toBe('https://127.0.0.1:6901');
  });

  it('un panelUrl NON-loopback mostra il messaggio che spiega perche — non un campo rosso muto', () => {
    const state = { mode: 'new', form: { id: 'Dev', cwd: '/home/user/work', engine: 'claude.native', panelUrl: 'http://172.17.0.2:6901' } };
    render(<CellEditor
      token="t" route={null} targets={[]} location={null} setLocation={vi.fn()}
      state={state} setState={vi.fn()} engines={engines} busy={false} onSave={vi.fn()}
    />);
    expect(screen.getByText('fleet-panel-url-invalid')).toBeTruthy();
  });

  it('un panelUrl loopback valido non mostra alcun errore', () => {
    const state = { mode: 'new', form: { id: 'Dev', cwd: '/home/user/work', engine: 'claude.native', panelUrl: 'https://127.0.0.1:6901' } };
    render(<CellEditor
      token="t" route={null} targets={[]} location={null} setLocation={vi.fn()}
      state={state} setState={vi.fn()} engines={engines} busy={false} onSave={vi.fn()}
    />);
    expect(screen.queryByText('fleet-panel-url-invalid')).toBeNull();
  });

  it('campo vuoto: opt-in, nessun errore mostrato', () => {
    const state = { mode: 'new', form: { id: 'Dev', cwd: '/home/user/work', engine: 'claude.native', panelUrl: '' } };
    render(<CellEditor
      token="t" route={null} targets={[]} location={null} setLocation={vi.fn()}
      state={state} setState={vi.fn()} engines={engines} busy={false} onSave={vi.fn()}
    />);
    expect(screen.queryByText('fleet-panel-url-invalid')).toBeNull();
  });
});
