import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelEditor from './ModelEditor.jsx';

// La finestra di dichiarazione di un modello, con la prova sull'API accanto al
// campo. Il momento in cui la prova serve e' PRIMA di salvare — «e' uscito X,
// funziona?» — e scoprire un id sbagliato dopo, quando la cella non parte, e'
// il difetto che questa finestra esiste per togliere.

const PROFILI = [
  { id: 'claude.alibaba-token-plan', label: 'Alibaba Token Plan' },
  { id: 'codex-vl.alibaba-token-plan', label: 'Alibaba (Codex)' },
];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
});

function renderEditor(over = {}) {
  const onSave = vi.fn();
  const onTest = vi.fn().mockResolvedValue({ outcome: 'ok', latencyMs: 42 });
  const state = { mode: 'new', form: { id: '', engine: '' }, ...(over.state || {}) };
  const view = render(<ModelEditor
    state={state} setState={vi.fn()} busy={false} onSave={onSave} onTest={onTest}
    profiles={PROFILI} {...over.props}
  />);
  return { ...view, onSave, onTest };
}

describe('ModelEditor', () => {
  it('non si salva finche\' non ci sono profilo e id', () => {
    renderEditor();
    expect(screen.getByRole('button', { name: /save/i }).disabled).toBe(true);
  });

  it('con profilo e id il salvataggio si apre', () => {
    renderEditor({ state: { mode: 'new', form: { id: 'qwen9', engine: PROFILI[0].id } } });
    expect(screen.getByRole('button', { name: /save/i }).disabled).toBe(false);
  });

  it('la prova riporta l\'esito e la latenza', async () => {
    const { onTest } = renderEditor({ state: { mode: 'new', form: { id: 'qwen9', engine: PROFILI[0].id } } });
    fireEvent.click(screen.getByRole('button', { name: /Test against the API/i }));
    await waitFor(() => expect(onTest).toHaveBeenCalledWith(PROFILI[0].id, 'qwen9'));
    await waitFor(() => expect(screen.getByText(/responds/i)).toBeTruthy());
    expect(screen.getByText(/42ms/)).toBeTruthy();
  });

  it('«non verificato» non si spaccia per un successo, e lo spiega', async () => {
    // La distinzione che rende la prova onesta: un fornitore che non espone
    // l'elenco non dice che il modello e' sbagliato.
    const onTest = vi.fn().mockResolvedValue({ outcome: 'unverified', detail: 'catalogo non esposto' });
    renderEditor({ state: { mode: 'new', form: { id: 'qwen9', engine: PROFILI[0].id } }, props: { onTest } });
    fireEvent.click(screen.getByRole('button', { name: /Test against the API/i }));
    await waitFor(() => expect(screen.getByText(/not verified/i)).toBeTruthy());
    expect(screen.getByText(/does not expose a model list/i)).toBeTruthy();
    expect(screen.queryByText(/responds/i)).toBeNull();
  });

  it('una prova fallita non lascia la finestra senza risposta', async () => {
    // Se la chiamata stessa esplode, l'operatore deve vedere un esito, non un
    // pulsante che torna cliccabile senza spiegazioni.
    const onTest = vi.fn().mockRejectedValue(new Error('rete giu'));
    renderEditor({ state: { mode: 'new', form: { id: 'qwen9', engine: PROFILI[0].id } }, props: { onTest } });
    fireEvent.click(screen.getByRole('button', { name: /Test against the API/i }));
    await waitFor(() => expect(screen.getByText(/not verified/i)).toBeTruthy());
  });

  it('cambiando l\'id l\'esito precedente sparisce', async () => {
    // Un esito riferito a un altro id e' peggio di nessun esito: si leggerebbe
    // come se riguardasse quello che si sta scrivendo adesso.
    const setState = vi.fn();
    const { rerender } = render(<ModelEditor
      state={{ mode: 'new', form: { id: 'qwen9', engine: PROFILI[0].id } }} setState={setState}
      busy={false} onSave={vi.fn()} onTest={vi.fn().mockResolvedValue({ outcome: 'ok', latencyMs: 10 })}
      profiles={PROFILI}
    />);
    fireEvent.click(screen.getByRole('button', { name: /Test against the API/i }));
    await waitFor(() => expect(screen.getByText(/responds/i)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('qwen3.9-max'), { target: { value: 'altro-modello' } });
    expect(setState).toHaveBeenCalled();
    rerender(<ModelEditor
      state={{ mode: 'new', form: { id: 'altro-modello', engine: PROFILI[0].id } }} setState={setState}
      busy={false} onSave={vi.fn()} onTest={vi.fn()} profiles={PROFILI}
    />);
    expect(screen.queryByText(/responds/i)).toBeNull();
  });

  it('i profili disponibili arrivano dal catalogo, non da un elenco fisso', () => {
    renderEditor();
    for (const p of PROFILI) expect(screen.getByRole('option', { name: new RegExp(p.id) })).toBeTruthy();
  });
});

// Ogni finestra deve avere un'uscita che non sia «salva». Questa non ce l'aveva:
// la modale si chiude con Escape o cliccando lo sfondo, ma su un telefono non
// c'e' Escape e lo sfondo puo' non essere raggiungibile — quindi l'unico modo di
// uscire era salvare un modello che magari non si voleva. Segnalato da chi la
// usava, non trovato da un test.
describe('ModelEditor — si puo\' uscire senza salvare', () => {
  it('offre annulla accanto a salva, e annullare chiude senza salvare', () => {
    const setState = vi.fn();
    const onSave = vi.fn();
    render(<ModelEditor
      state={{ mode: 'new', form: { id: 'qwen9', engine: 'claude.native' } }}
      setState={setState} busy={false} onSave={onSave} onTest={vi.fn()}
      profiles={[{ id: 'claude.native', label: 'N' }]}
    />);
    const annulla = screen.getByRole('button', { name: 'cancel' });
    expect(annulla).toBeTruthy();
    fireEvent.click(annulla);
    expect(setState).toHaveBeenCalledWith(null);
    expect(onSave).not.toHaveBeenCalled();
  });
});
