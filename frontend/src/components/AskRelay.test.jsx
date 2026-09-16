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
