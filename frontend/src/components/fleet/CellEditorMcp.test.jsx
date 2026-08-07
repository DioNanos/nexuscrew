import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../lib/i18n.js', () => ({ t: (key) => key }));
vi.mock('../../lib/api.js', () => ({ listDirs: vi.fn() }));

import CellEditor from './CellEditor.jsx';

// Il selettore degli strumenti MCP ha TRE stati, non due, e la distinzione non
// è cosmetica: ASSENTE significa «eredita tutto», che è il comportamento di
// sempre; `[]` significa «nessuno strumento». Se l'editor li confondesse,
// aprire una cella e salvarla senza toccare nulla le cambierebbe i poteri.
const engines = [
  { id: 'claude.native', label: 'Claude', managed: { client: 'claude', model: '' } },
  { id: 'shell.local', label: 'Shell', managed: { client: 'shell', model: '' } },
];
const SERVERS = ['nexuscrew', 'webfetch', 'nextcloud'];

function apri(form, setState = vi.fn()) {
  render(<CellEditor
    token="tok" route={[]} targets={[]} location="" setLocation={vi.fn()}
    state={{ mode: 'edit', form: { id: 'Dev', cwd: '/home/user/dev', engine: 'claude.native', boot: false, ...form } }}
    setState={setState} engines={engines} mcpServers={SERVERS} busy={false} onSave={vi.fn()}
  />);
  // getter pigro: il caso Shell verifica proprio che il selettore NON ci sia,
  // e un harness che lo cerca sempre farebbe fallire il test per conto suo.
  return { setState, get select() { return screen.getByLabelText('cell-mcp'); } };
}
const formDi = (setState) => setState.mock.calls.at(-1)[0].form;

describe('CellEditor — strumenti MCP per cella', () => {
  it('una cella senza `mcp` mostra «tutti», non «nessuno»', () => {
    const { select } = apri({});
    expect(select.value).toBe('all');
    // E non elenca caselle: non c'è niente da scegliere finché non si sceglie.
    expect(screen.queryByLabelText('webfetch')).toBeNull();
  });

  it('«nessuno» produce un elenco VUOTO, che è una dichiarazione esplicita', () => {
    const { setState, select } = apri({});
    fireEvent.change(select, { target: { value: 'none' } });
    expect(formDi(setState).mcp).toEqual([]);
  });

  it('passando a «scelti» si parte da TUTTI selezionati', () => {
    // Il primo click non deve togliere niente per sbaglio: togliere è un gesto
    // deliberato, e chi apre il selettore per curiosità non deve disarmare una
    // cella senza accorgersene.
    const { setState, select } = apri({});
    fireEvent.change(select, { target: { value: 'some' } });
    expect(formDi(setState).mcp).toEqual([...SERVERS].sort());
  });

  it('togliere una casella lascia esattamente il resto', () => {
    const { setState } = apri({ mcp: ['nexuscrew', 'webfetch'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'webfetch' }));
    expect(formDi(setState).mcp).toEqual(['nexuscrew']);
  });

  it('un nome che la cella ha ma il nodo non elenca resta visibile e selezionato', () => {
    // Un server dichiarato nel file di progetto della cella non compare
    // nell'elenco del nodo. Se sparisse dalla finestra, aprire e salvare lo
    // toglierebbe in silenzio.
    apri({ mcp: ['crew-di-progetto'] });
    const casella = screen.getByRole('checkbox', { name: 'crew-di-progetto' });
    expect(casella.checked).toBe(true);
  });

  it('tornare a «tutti» rimette il campo ad ASSENTE, non a vuoto', () => {
    // È la distinzione che il backend traduce in `null` per cancellare la
    // chiave. Se qui tornasse `[]`, «tutti» diventerebbe «nessuno» — cioè
    // l'esatto contrario.
    const { setState, select } = apri({ mcp: ['nexuscrew'] });
    fireEvent.change(select, { target: { value: 'all' } });
    expect(formDi(setState).mcp).toBeUndefined();
  });

  it('una cella Shell non mostra affatto il selettore', () => {
    apri({ engine: 'shell.local', commands: {}, command: '' });
    expect(screen.queryByLabelText('cell-mcp')).toBeNull();
  });
});
