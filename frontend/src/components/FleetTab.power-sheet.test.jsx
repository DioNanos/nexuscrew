import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Secondo punto di avvio: Impostazioni → Flotta. Stessi esiti del roster —
// ok e benigni chiudono il foglio, gli errori veri restano — più la regola
// specifica di questa superficie: il foglio NON aspetta il refresh per
// chiudersi. Si stubba `fetch` globale (non il modulo api) perché il grafo di
// FleetTab importa decine di funzioni api: un solo stub copre tutto.

const state = vi.hoisted(() => ({ upImpl: null, hangStatusAfter: Infinity, statusCalls: 0 }));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

vi.stubGlobal('fetch', vi.fn(async (url) => {
  const path = String(url);
  if (path.includes('/api/fleet/up')) {
    if (state.upImpl) return state.upImpl(path);
    return json({ ok: true });
  }
  if (path.includes('/api/fleet/status')) {
    state.statusCalls += 1;
    if (state.statusCalls > state.hangStatusAfter) return new Promise(() => {}); // refresh appeso
    return json({
      available: true, provider: 'builtin',
      capabilities: ['up', 'down', 'edit', 'definitions', 'restore'],
      cells: [{ cell: 'X', active: false, engine: 'shell.local' }],
      engines: [],
    });
  }
  if (path.includes('/api/fleet/definitions')) {
    return json({ engines: [], cells: [{ id: 'X', engine: 'shell.local', cwd: '/tmp/x', boot: false }] });
  }
  return json({});
}));

import FleetTab from './FleetTab.jsx';

beforeEach(() => {
  vi.clearAllMocks();
  state.upImpl = null;
  state.hangStatusAfter = Infinity;
  state.statusCalls = 0;
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
});

async function apriFoglio() {
  const user = userEvent.setup();
  render(<FleetTab token="test-token" />);
  const start = await screen.findByRole('button', { name: 'start' });
  await user.click(start);
  const submit = await screen.findByRole('button', { name: 'save and start' });
  return { user, submit };
}

describe('FleetTab power sheet', () => {
  it('timeout client: foglio chiuso, nota di avvio in corso', async () => {
    state.upImpl = () => Promise.reject(new DOMException('timeout', 'TimeoutError'));
    const { user, submit } = await apriFoglio();
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'save and start' })).toBeNull());
    await waitFor(() => expect(document.querySelector('.nc-set-note').textContent)
      .toBe('start still in progress: check the cell state'));
  });

  it('502 upstream-timeout della route federata: benigno, come il timeout', async () => {
    state.upImpl = () => json({ error: 'node non raggiungibile', cause: 'upstream-timeout' }, 502);
    const { user, submit } = await apriFoglio();
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'save and start' })).toBeNull());
    await waitFor(() => expect(document.querySelector('.nc-set-note').textContent)
      .toBe('start still in progress: check the cell state'));
  });

  it('il foglio NON aspetta il refresh per chiudersi: up ok + refresh appeso = chiuso', async () => {
    // Il refresh iniziale (mount) riesce; dal successivo, fleetStatus pende.
    state.hangStatusAfter = 1;
    const { user, submit } = await apriFoglio();
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'save and start' })).toBeNull());
  });

  it('errore vero 500: il foglio resta aperto con il messaggio', async () => {
    state.upImpl = () => json({ error: 'boom' }, 500);
    const { user, submit } = await apriFoglio();
    await user.click(submit);
    const foglio = () => document.querySelector('form.nc-power-sheet');
    await waitFor(() => expect(foglio().textContent).toContain('boom'));
    expect(foglio() && screen.getByRole('button', { name: 'save and start' }).disabled).toBe(false);
  });
});
