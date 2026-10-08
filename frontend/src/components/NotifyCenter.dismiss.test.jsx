// Pulizia delle notifiche importate dal punto di vista dell'operatore: X per
// voce, «Pulisci» su tutti gli owner visibili, e la memoria delle scartate che
// impedisce all'arretrato (o a un frame live ripetuto) di rimettere la card.
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventHandler: null,
  openHandler: null,
  speaker: { enqueue: vi.fn(), stop: vi.fn(), dispose: vi.fn() },
  closeEvents: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  getAsks: vi.fn(() => Promise.resolve({ asks: [] })),
  answerAsk: vi.fn(() => Promise.resolve({})),
  dismissAsk: vi.fn(() => Promise.resolve({})),
  getFeedState: vi.fn(() => Promise.resolve({ views: [] })),
  getAskRelayState: vi.fn(() => Promise.resolve({ attempts: [] })),
  getAskReplyCapability: vi.fn(() => Promise.resolve({ canReply: false, status: 'unsupported' })),
  relayAskAnswer: vi.fn(() => Promise.resolve({ status: 'committed' })),
  relayAskDismiss: vi.fn(() => Promise.resolve({ dismissed: true })),
  relayAskDismissLocal: vi.fn(() => Promise.resolve({ dismissed: true, scope: 'local', ownerSync: 'pending' })),
  relayAskVerify: vi.fn(() => Promise.resolve({ state: 'committed' })),
  relayNoticeDismiss: vi.fn(() => Promise.resolve({ dismissed: true })),
  relayNoticeDismissAll: vi.fn(() => Promise.resolve({ results: {} })),
}));

vi.mock('../lib/events.js', () => ({
  connectEvents: vi.fn((_token, onFrame, onOpen) => {
    mocks.openHandler = onOpen;
    mocks.eventHandler = onFrame;
    return mocks.closeEvents;
  }),
}));

vi.mock('../hooks/useNotificationSpeech.js', () => ({
  useNotificationSpeech: () => [false, vi.fn()],
}));

vi.mock('../lib/notification-speech.js', () => ({
  NOTIFICATION_SPEECH_PREVIEW_EVENT: 'nc-notification-speech-preview',
  createNotificationSpeaker: () => mocks.speaker,
  notificationSpeechFrameLang: (frame, uiLang) => frame.lang || uiLang,
}));

import { getFeedState, relayNoticeDismiss, relayNoticeDismissAll } from '../lib/api.js';
import NotifyCenter from './NotifyCenter.jsx';

// Un proprietario (e un evento) per test: la memoria delle scartate e' di
// modulo, e due test che condividessero un id si accoppierebbero.
const OWNER_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_C = 'cccccccccccccccccccccccccccccccc';
const OWNER_D = 'dddddddddddddddddddddddddddddddd';
const OWNER_E = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const OWNER_F = 'ffffffffffffffffffffffffffffffff';
const OWNER_G = '99999999999999999999999999999999';
const E1 = 'd4550000-0000-4000-8000-000000000001';
const E2 = 'd4550000-0000-4000-8000-000000000002';
const E3 = 'd4550000-0000-4000-8000-000000000003';
const E4 = 'd4550000-0000-4000-8000-000000000004';
const E5 = 'd4550000-0000-4000-8000-000000000005';
const E6 = 'd4550000-0000-4000-8000-000000000006';
const E7 = 'd4550000-0000-4000-8000-000000000007';
const E8 = 'd4550000-0000-4000-8000-000000000008';

const notice = (ownerId, eventId, title, ts = 1760000000000) => ({
  v: 1, ownerId, eventId, scope: 'cell', cellId: 'dev', hop: 1, emittedAt: ts,
  frame: { type: 'notify', title, body: '', urgency: 'normal', ts },
});

const viewsOf = (...views) => ({ views });
const view = (ownerId, notifications) => ({ ownerId, askReplyAccess: false, stale: false, asks: [], notifications });

// Le card consultabili: il toast live porta lo stesso titolo, quindi il
// conteggio va SEMPRE sugli elementi .nc-remote-notice.
const cardTitles = () => [...document.querySelectorAll('.nc-remote-notice')].map((c) => c.textContent || '');

const openPanel = async () => {
  const badge = await screen.findByTitle('questions from the cells');
  act(() => { badge.click(); });
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  mocks.eventHandler = null;
  mocks.openHandler = null;
  mocks.closeEvents.mockReset();
});

describe('X per voce su una notifica importata', () => {
  it('scarta la coppia (ownerId,eventId) e la card non rientra ne dallo snapshot ne dal live ripetuto', async () => {
    getFeedState.mockResolvedValueOnce(viewsOf(view(OWNER_A, [notice(OWNER_A, E1, 'Notifica A1'), notice(OWNER_A, E2, 'Notifica A2')])));
    render(<NotifyCenter token="token" />);
    await openPanel();
    await screen.findByText('Notifica A1');
    expect(cardTitles().length).toBe(2);

    const cardA1 = [...document.querySelectorAll('.nc-remote-notice')].find((c) => c.textContent.includes('Notifica A1'));
    const x = cardA1.querySelector('button');
    expect(x).toBeTruthy();
    await act(async () => { x.click(); });

    expect(relayNoticeDismiss).toHaveBeenCalledTimes(1);
    expect(relayNoticeDismiss).toHaveBeenCalledWith('token', { ownerId: OWNER_A, eventId: E1 });
    await waitFor(() => expect(cardTitles().length).toBe(1));
    expect(cardTitles()[0]).toContain('Notifica A2');

    // Stesso arretrato riletto (giro successivo o reload): la scartata NON torna.
    getFeedState.mockResolvedValueOnce(viewsOf(view(OWNER_A, [notice(OWNER_A, E1, 'Notifica A1'), notice(OWNER_A, E2, 'Notifica A2')])));
    await act(async () => { mocks.openHandler(); });
    await waitFor(() => expect(getFeedState).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(cardTitles().length).toBe(1);
    expect(cardTitles()[0]).toContain('Notifica A2');

    // La stessa notifica ripassata live: nemmeno il frame la rimette nella lista.
    act(() => mocks.eventHandler({ type: 'notify', ownerId: OWNER_A, eventId: E1, title: 'Notifica A1', body: '', urgency: 'normal' }));
    await act(async () => {});
    expect(cardTitles().length).toBe(1);
    expect(cardTitles()[0]).toContain('Notifica A2');
  });

  it('fallimento duro dello scarto: la card resta e l avviso lo dichiara', async () => {
    getFeedState.mockResolvedValueOnce(viewsOf(view(OWNER_C, [notice(OWNER_C, E3, 'Notifica C1')])));
    relayNoticeDismiss.mockRejectedValueOnce(Object.assign(new Error('HTTP 403'), { status: 403 }));
    render(<NotifyCenter token="token" />);
    await openPanel();
    await screen.findByText('Notifica C1');

    const x = document.querySelector('.nc-remote-notice button');
    await act(async () => { x.click(); });

    await waitFor(() => expect(screen.getByText('dismissal not confirmed: the notice stays')).toBeTruthy());
    expect(cardTitles().length).toBe(1);
    expect(cardTitles()[0]).toContain('Notifica C1');
  });
});

describe('«Pulisci» su tutti gli owner visibili', () => {
  it('un solo dismiss-all con gli owner distinti, e gli esiti parziali sono dichiarati', async () => {
    getFeedState.mockResolvedValueOnce(viewsOf(
      view(OWNER_D, [notice(OWNER_D, E4, 'Notifica D1')]),
      view(OWNER_E, [notice(OWNER_E, E5, 'Notifica E1'), notice(OWNER_E, E6, 'Notifica E2')]),
    ));
    relayNoticeDismissAll.mockResolvedValueOnce({ results: { [OWNER_D]: { ok: true, dismissed: 1 }, [OWNER_E]: { failed: 'refused' } } });
    render(<NotifyCenter token="token" />);
    await openPanel();
    await screen.findByText('Notifica D1');
    await screen.findByText('Notifica E1');
    expect(cardTitles().length).toBe(3);

    act(() => { screen.getByText('Clear').click(); });

    await waitFor(() => expect(relayNoticeDismissAll).toHaveBeenCalledTimes(1));
    const owners = relayNoticeDismissAll.mock.calls[0][1].owners;
    expect([...owners].sort()).toEqual([OWNER_D, OWNER_E]);
    expect(relayNoticeDismissAll.mock.calls[0][0]).toBe('token');
    expect(relayNoticeDismiss).not.toHaveBeenCalled();

    // Owner D raggiunto: le sue card escono. Owner E rifiutato: le sue RESTANO.
    await waitFor(() => expect(cardTitles().length).toBe(2));
    expect(cardTitles().join(' ')).not.toContain('Notifica D1');
    expect(cardTitles().join(' ')).toContain('Notifica E1');
    await waitFor(() => expect(screen.getByText('clear not confirmed: the notices stay')).toBeTruthy());
  });
});

describe('frame SSE notify-dismissed', () => {
  it('toglie la card dell owner giusto, lascia le altre, e lo snapshot non la resuscita', async () => {
    getFeedState.mockResolvedValueOnce(viewsOf(
      view(OWNER_F, [notice(OWNER_F, E7, 'Notifica F1')]),
      view(OWNER_G, [notice(OWNER_G, E8, 'Notifica G1')]),
    ));
    render(<NotifyCenter token="token" />);
    await openPanel();
    await screen.findByText('Notifica F1');
    await screen.findByText('Notifica G1');

    act(() => mocks.eventHandler({ type: 'notify-dismissed', ownerId: OWNER_F, eventId: E7 }));
    await waitFor(() => expect(cardTitles().length).toBe(1));
    expect(cardTitles()[0]).toContain('Notifica G1');

    // Tombstone: lo snapshot dell owner F (ancora con la voce) non la rimette.
    getFeedState.mockResolvedValueOnce(viewsOf(
      view(OWNER_F, [notice(OWNER_F, E7, 'Notifica F1')]),
      view(OWNER_G, [notice(OWNER_G, E8, 'Notifica G1')]),
    ));
    await act(async () => { mocks.openHandler(); });
    await waitFor(() => expect(getFeedState).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(cardTitles().length).toBe(1);
    expect(cardTitles()[0]).toContain('Notifica G1');
  });
});
