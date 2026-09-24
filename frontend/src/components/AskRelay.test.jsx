import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  relayAskAnswer: vi.fn(),
  relayAskVerify: vi.fn(),
  getAsks: vi.fn(),
  getFeedState: vi.fn(),
  answerAsk: vi.fn(),
  dismissAsk: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  relayAskAnswer: mocks.relayAskAnswer,
  relayAskVerify: mocks.relayAskVerify,
  getAsks: mocks.getAsks,
  getFeedState: mocks.getFeedState,
  answerAsk: mocks.answerAsk,
  dismissAsk: mocks.dismissAsk,
}));

import NotifyCenter from './NotifyCenter.jsx';

const owner = 'a'.repeat(32);
const other = 'b'.repeat(32);
const remoteAsk = (over = {}) => ({
  id: 'abc12345', question: 'procedo?', options: ['si', 'no'],
  session: 'cell-a', ownerId: owner, ...over,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  mocks.relayAskAnswer.mockReset().mockResolvedValue({ status: 'committed', requestId: 'r1' });
  mocks.relayAskVerify.mockReset().mockResolvedValue({ state: 'committed' });
  mocks.getAsks.mockReset().mockResolvedValue({ asks: [remoteAsk()] });
  mocks.getFeedState.mockReset().mockResolvedValue({
    views: [{ ownerId: owner, stale: false, askReplyAccess: true },
            { ownerId: other, stale: false, askReplyAccess: false }],
  });
  mocks.answerAsk.mockReset();
  mocks.dismissAsk.mockReset();
});

async function renderCenter() {
  const view = render(<NotifyCenter token="token" />);
  // The badge shows up once the asks arrive; clicking it opens the panel.
  await waitFor(() => expect(screen.getByTitle((c, el) => el.className === 'nc-ask-badge')).toBeTruthy());
  fireEvent.click(screen.getByTitle((c, el) => el.className === 'nc-ask-badge'));
  return view;
}

describe('federated ask cards', () => {
  it('la risposta porta (ownerId, askId): chiavi per proprietario, mai id solo', async () => {
    await renderCenter();
    const ta = document.querySelector('.nc-ask-reply textarea');
    fireEvent.change(ta, { target: { value: 'vai' } });
    fireEvent.click(screen.getByText(/^send$/i));
    await waitFor(() => expect(mocks.relayAskAnswer).toHaveBeenCalledTimes(1));
    const [, payload] = mocks.relayAskAnswer.mock.calls[0];
    expect(payload.ownerId).toBe(owner);
    expect(payload.askId).toBe('abc12345');
  });

  it('due owner con lo stesso ask id: la card rimossa è quella giusta', async () => {
    mocks.getAsks.mockResolvedValue({ asks: [remoteAsk(), remoteAsk({ ownerId: other })] });
    await renderCenter();
    expect(screen.getAllByText(/procedo\?/i)).toHaveLength(2);
    const ta = document.querySelector('.nc-ask-reply textarea');
    fireEvent.change(ta, { target: { value: 'vai' } });
    fireEvent.click(screen.getByText(/^send$/i));
    await waitFor(() => expect(mocks.relayAskAnswer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText(/procedo\?/i)).toHaveLength(1), { timeout: 2000 });
  });

  it('senza askReplyAccess nello snapshot: card in sola lettura', async () => {
    mocks.getAsks.mockResolvedValue({ asks: [remoteAsk({ ownerId: other })] });
    await renderCenter();
    await waitFor(() => expect(screen.getByText(/read-only/i)).toBeTruthy());
    expect(screen.queryByText(/^send$/i)).toBeNull();
  });

  it('esito incerto: nessun retry, offre «verify status» che chiude la card', async () => {
    mocks.relayAskAnswer.mockResolvedValueOnce({
      uncertain: true, reason: 'delivery-unknown', requestId: 'rid-1',
    });
    await renderCenter();
    fireEvent.change(document.querySelector('.nc-ask-reply textarea'), { target: { value: 'vai' } });
    fireEvent.click(screen.getByText(/^send$/i));
    await waitFor(() => expect(screen.getByText(/uncertain/i)).toBeTruthy());
    expect(screen.getByText(/verify status/i)).toBeTruthy();
    expect(mocks.relayAskVerify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/verify status/i));
    await waitFor(() => expect(mocks.relayAskVerify).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/procedo\?/i)).toBeNull(), { timeout: 2000 });
  });

  it('un errore 403 resta visibile sulla card', async () => {
    mocks.relayAskAnswer.mockRejectedValueOnce(Object.assign(new Error('not granted'), { status: 403 }));
    await renderCenter();
    const ta = document.querySelector('.nc-ask-reply textarea');
    fireEvent.change(ta, { target: { value: 'vai' } });
    fireEvent.click(screen.getByText(/^send$/i));
    await waitFor(() => expect(screen.getByText(/not granted/i)).toBeTruthy());
  });
});

describe('federated ask cards — l\'hint distingue il feed non importato dal grant negato', () => {
  // Owner senza view nel feed-state: la card esiste ma la sottoscrizione no.
  const absent = 'c'.repeat(32);

  it('view dell\'owner assente: hint di ricezione da attivare, non il grant negato', async () => {
    mocks.getAsks.mockResolvedValue({ asks: [remoteAsk({ ownerId: absent })] });
    await renderCenter();
    await waitFor(() => expect(screen.getByText(/not receiving this node/i)).toBeTruthy());
    expect(screen.queryByText(/read-only/i)).toBeNull();
    expect(screen.queryByText(/^send$/i)).toBeNull();
  });

  it('view stale o in errore: stesso hint di ricezione da attivare', async () => {
    mocks.getAsks.mockResolvedValue({ asks: [remoteAsk()] });
    mocks.getFeedState.mockResolvedValue({
      views: [{ ownerId: owner, stale: true, lastError: 'boom', askReplyAccess: false }],
    });
    await renderCenter();
    await waitFor(() => expect(screen.getByText(/not receiving this node/i)).toBeTruthy());
    expect(screen.queryByText(/read-only/i)).toBeNull();
    expect(screen.queryByText(/^send$/i)).toBeNull();
  });

  it('view viva con grant negato: resta il messaggio del grant, mai quello della ricezione', async () => {
    mocks.getAsks.mockResolvedValue({ asks: [remoteAsk({ ownerId: other })] });
    await renderCenter();
    await waitFor(() => expect(screen.getByText(/read-only/i)).toBeTruthy());
    expect(screen.queryByText(/not receiving this node/i)).toBeNull();
  });

  it('mutazione: i due hint non sono intercambiabili, ciascuno al proprio posto', async () => {
    mocks.getAsks.mockResolvedValue({ asks: [remoteAsk({ ownerId: absent }), remoteAsk({ id: 'def67890', ownerId: other })] });
    await renderCenter();
    const noFeed = await screen.findAllByText(/not receiving this node/i);
    const readonly = await screen.findAllByText(/read-only/i);
    expect(noFeed).toHaveLength(1);
    expect(readonly).toHaveLength(1);
    expect(noFeed[0].textContent).not.toBe(readonly[0].textContent);
  });
});
