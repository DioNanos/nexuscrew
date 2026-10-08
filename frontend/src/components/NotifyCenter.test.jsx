import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventHandler: null,
  openHandler: null,
  speechEnabled: true,
  speaker: { enqueue: vi.fn(), stop: vi.fn(), dispose: vi.fn() },
  resolveLang: vi.fn((frame, uiLang) => frame.lang || uiLang),
  closeEvents: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  getAsks: vi.fn(() => Promise.resolve({ asks: [] })),
  answerAsk: vi.fn(() => Promise.resolve({})),
  dismissAsk: vi.fn(() => Promise.resolve({})),
  // The feed-state read feeds the per-owner reply grants (empty = read-only).
  getFeedState: vi.fn(() => Promise.resolve({ views: [] })),
  getAskRelayState: vi.fn(() => Promise.resolve({ attempts: [] })),
  getAskReplyCapability: vi.fn((_token, { ownerId, askId }) => Promise.resolve({ ownerId, askId, canReply: true, status: 'open' })),
  relayAskAnswer: vi.fn(() => Promise.resolve({ status: 'committed' })),
  relayAskDismiss: vi.fn(() => Promise.resolve({ dismissed: true })),
  relayAskVerify: vi.fn(() => Promise.resolve({ state: 'committed' })),
}));

vi.mock('../lib/events.js', () => ({
  connectEvents: vi.fn((_token, onFrame, onOpen) => {
    mocks.openHandler = onOpen;
    mocks.eventHandler = onFrame;
    return mocks.closeEvents;
  }),
}));

vi.mock('../hooks/useNotificationSpeech.js', () => ({
  useNotificationSpeech: () => [mocks.speechEnabled, vi.fn()],
}));

vi.mock('../lib/notification-speech.js', () => ({
  NOTIFICATION_SPEECH_PREVIEW_EVENT: 'nc-notification-speech-preview',
  createNotificationSpeaker: () => mocks.speaker,
  notificationSpeechFrameLang: (frame, uiLang) => mocks.resolveLang(frame, uiLang),
}));

import { getAsks, dismissAsk } from '../lib/api.js';
import NotifyCenter from './NotifyCenter.jsx';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  mocks.eventHandler = null;
  mocks.speechEnabled = true;
  mocks.speaker.enqueue.mockReset();
  mocks.speaker.stop.mockReset();
  mocks.speaker.dispose.mockReset();
  mocks.resolveLang.mockClear();
  mocks.closeEvents.mockReset();
});

describe('NotifyCenter notification speech integration', () => {
  it('speaks only live notify frames and prefers an explicit content language', async () => {
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));

    const notify = {
      type: 'notify', title: 'Build ready', body: 'Correzione completata', urgency: 'normal', lang: 'it',
    };
    act(() => mocks.eventHandler(notify));
    expect(await screen.findByText('Build ready')).toBeTruthy();
    expect(mocks.resolveLang).toHaveBeenCalledWith(notify, 'en');
    expect(mocks.speaker.enqueue).toHaveBeenCalledWith(notify, 'it');

    mocks.speaker.enqueue.mockClear();
    act(() => mocks.eventHandler({
      type: 'ask',
      ask: { id: 'a1', session: 'cloud-Dev', question: 'Publish now?', options: [] },
    }));
    act(() => screen.getByTitle('questions from the cells').click());
    expect(await screen.findByText('Publish now?')).toBeTruthy();
    expect(mocks.speaker.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the UI language as the legacy fallback when a frame has no language', async () => {
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    const notify = { type: 'notify', title: 'Short mixed title', body: 'build ok' };
    act(() => mocks.eventHandler(notify));
    expect(mocks.resolveLang).toHaveBeenCalledWith(notify, 'en');
    expect(mocks.speaker.enqueue).toHaveBeenCalledWith(notify, 'en');
  });

  it('keeps visual toasts but does not speak after local opt-out', async () => {
    mocks.speechEnabled = false;
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    const notify = { type: 'notify', title: 'Visual only', urgency: 'normal' };
    act(() => mocks.eventHandler(notify));
    expect(await screen.findByText('Visual only')).toBeTruthy();
    expect(mocks.speaker.enqueue).not.toHaveBeenCalled();
    expect(mocks.speaker.stop).toHaveBeenCalled();
  });

  it('keeps toast delivery and SSE handling alive when the optional speaker throws', async () => {
    mocks.speaker.enqueue.mockImplementationOnce(() => { throw new Error('native speech failed'); });
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));

    act(() => mocks.eventHandler({ type: 'notify', title: 'Still visible', ts: 1 }));
    expect(await screen.findByText('Still visible')).toBeTruthy();
    act(() => mocks.eventHandler({ type: 'notify', title: 'Next frame', ts: 2 }));
    expect(await screen.findByText('Next frame')).toBeTruthy();
    expect(mocks.speaker.enqueue).toHaveBeenCalledTimes(2);
  });

  it('closes SSE and stops speech on unmount', async () => {
    const view = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    act(() => window.dispatchEvent(new Event('nc-notification-speech-preview')));
    expect(mocks.speaker.stop).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mocks.closeEvents).toHaveBeenCalled();
    expect(mocks.speaker.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.speaker.stop).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event('nc-notification-speech-preview')));
    expect(mocks.speaker.stop).toHaveBeenCalledTimes(1);
  });
});

describe('NotifyCenter ask dismiss', () => {
  beforeEach(() => {
    vi.mocked(dismissAsk).mockReset();
    vi.mocked(dismissAsk).mockResolvedValue({});
  });

  it('dismisses an ask from its card: DELETE called and the card disappears', async () => {
    vi.mocked(getAsks).mockResolvedValueOnce({
      asks: [{ id: 'a1', session: 'cloud-Dev', question: 'Skip me?', options: [] }],
    });
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    act(() => screen.getByTitle('questions from the cells').click());
    expect(await screen.findByText('Skip me?')).toBeTruthy();

    act(() => screen.getByTitle('Dismiss question').click());
    await waitFor(() => expect(dismissAsk).toHaveBeenCalledWith('token', 'a1'));
    await waitFor(() => expect(screen.queryByText('Skip me?')).toBeNull());
  });

  it('removes the card when another UI dismisses the ask (ask-dismissed frame)', async () => {
    vi.mocked(getAsks).mockResolvedValueOnce({
      asks: [{ id: 'a2', session: 'cloud-Dev', question: 'From a peer?', options: [] }],
    });
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    act(() => screen.getByTitle('questions from the cells').click());
    expect(await screen.findByText('From a peer?')).toBeTruthy();

    act(() => mocks.eventHandler({ type: 'ask-dismissed', id: 'a2' }));
    await waitFor(() => expect(screen.queryByText('From a peer?')).toBeNull());
    // non e' stata chiamata la DELETE: lo scarto viene dal frame, non da qui
    expect(dismissAsk).not.toHaveBeenCalled();
  });
});

describe('federated ask cards: identity per owner and reload', () => {
  const openPanel = (container) => {
    const badge = container.querySelector('.nc-ask-badge');
    expect(badge).toBeTruthy();
    act(() => { badge.click(); });
  };

  it('keys the cards by (owner, ask): the same id from two owners stays two cards', async () => {
    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    act(() => mocks.eventHandler({ type: 'ask', ask: { id: 'dup1', ownerId: 'ownerA', session: 'a', question: 'da A' } }));
    act(() => mocks.eventHandler({ type: 'ask', ask: { id: 'dup1', ownerId: 'ownerB', session: 'b', question: 'da B' } }));
    openPanel(container);
    expect(container.querySelectorAll('.nc-ask-card').length).toBe(2);
    // Closing the ask of ONE owner leaves the other card in place.
    act(() => mocks.eventHandler({ type: 'ask-answered', id: 'dup1', ownerId: 'ownerA' }));
    expect(container.querySelectorAll('.nc-ask-card').length).toBe(1);
    expect(screen.getByText('da B')).toBeTruthy();
  });

  it('rebuilds the imported asks from the feed state on reload', async () => {
    getAsks.mockResolvedValueOnce({ asks: [] });
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce({ views: [{
      ownerId: 'ownerA', askReplyAccess: true,
      asks: [{ id: 'rem1', question: 'remota', session: 's', options: [] }],
    }] });
    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
    openPanel(container);
    expect(screen.getByText('remota')).toBeTruthy();
  });

  it('compacts the two sources: the local snapshot that arrives LAST does not erase an imported ask', async () => {
    let finishLocal;
    getAsks.mockReturnValueOnce(new Promise((resolve) => { finishLocal = resolve; }));
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce({ views: [{
      ownerId: 'ownerA', askReplyAccess: true,
      asks: [{ id: 'rem2', question: 'remota tardiva', session: 's', options: [] }],
    }] });
    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
    // La risposta locale arriva DOPO quella del feed-state: compatta, non sostituisce.
    await act(async () => { finishLocal({ asks: [{ id: 'loc2', session: 's', question: 'locale tardiva', options: [] }] }); });
    openPanel(container);
    expect(screen.getByText('remota tardiva')).toBeTruthy();
    expect(screen.getByText('locale tardiva')).toBeTruthy();
    expect(container.querySelectorAll('.nc-ask-card').length).toBe(2);
  });

  it('compacts the two sources: the feed-state that arrives LAST adds to the locals', async () => {
    getAsks.mockResolvedValueOnce({ asks: [{ id: 'loc3', session: 's', question: 'locale prima', options: [] }] });
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce({ views: [{
      ownerId: 'ownerA', askReplyAccess: true,
      asks: [{ id: 'rem3', question: 'remota dopo', session: 's', options: [] }],
    }] });
    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
    openPanel(container);
    await waitFor(() => expect(screen.getByText('remota dopo')).toBeTruthy());
    expect(screen.getByText('locale prima')).toBeTruthy();
    expect(container.querySelectorAll('.nc-ask-card').length).toBe(2);
  });

  it('lo snapshot locale resta autorevole sulle proprie card: una ask locale sparita non resta appesa', async () => {
    let finishLocal;
    getAsks.mockReturnValueOnce(new Promise((resolve) => { finishLocal = resolve; }));
    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    act(() => mocks.eventHandler({ type: 'ask', ask: { id: 'loc4', session: 's', question: 'locale viva' } }));
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
    // A fresh read started after the live card is authoritative; the older
    // in-flight empty read cannot prove that a later live card was closed.
    getAsks.mockResolvedValue({ asks: [] });
    await act(async () => { mocks.openHandler(); });
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeNull());
    await act(async () => { finishLocal({ asks: [] }); });
    expect(container.querySelector('.nc-ask-badge')).toBeNull();
  });
});

describe('NotifyCenter — arretrato notifiche importate (lista consultabile silenziosa)', () => {
  const REMOTE = {
    views: [{
      ownerId: 'nodeX', askReplyAccess: false, stale: false,
      notifications: [
        { type: 'notify', eventId: 'e1', title: 'Titolo arretrato', body: 'Corpo arretrato', urgency: 'normal', ts: 1700000000000 },
        { type: 'fleet-state', eventId: 'e2', title: 'non ammesso' },
      ],
      asks: [],
    }],
  };

  it('arretrato dallo snapshot: lista consultabile, silenziosa (niente toast/TTS), tipi non ammessi filtrati', async () => {
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce(REMOTE);
    render(<NotifyCenter token="token" />);
    const badge = await screen.findByTitle('questions from the cells');
    act(() => badge.click());
    expect(await screen.findByText('Titolo arretrato')).toBeTruthy();
    expect(screen.getByText('Corpo arretrato')).toBeTruthy();
    expect(screen.queryByText('non ammesso')).toBeNull();
    expect(mocks.speaker.enqueue).not.toHaveBeenCalled();
  });

  it('dedup unica snapshot+SSE per (ownerId,eventId): la card non si duplica', async () => {
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce(REMOTE);
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    act(() => mocks.eventHandler({ type: 'notify', ownerId: 'nodeX', eventId: 'e1', title: 'Titolo arretrato', body: 'x', urgency: 'normal' }));
    await screen.findAllByText('Titolo arretrato');
    expect(screen.getAllByText('Titolo arretrato').length).toBe(1);
  });

  it('view revocata: le sue card spariscono al feed-state successivo', async () => {
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce(REMOTE);
    const { rerender } = render(<NotifyCenter token="token" />);
    const badge = await screen.findByTitle('questions from the cells');
    act(() => badge.click());
    await screen.findByText('Titolo arretrato');
    const api = await import('../lib/api.js');
    api.getFeedState.mockResolvedValueOnce({ views: [] });
    rerender(<NotifyCenter token="token-b" />);
    await waitFor(() => expect(screen.queryByText('Titolo arretrato')).toBeNull());
  });
});

describe('rebuild dall arretrato: la rilettura compatta per (ownerId,eventId)', () => {
  // Le due forme VERE del server per la stessa notifica (owner O, eventId E,
  // cella dev, emissione T0): l'envelope spedito dallo snapshot (event-feed-routes)
  // e il ribroadcast live (event-feed-client), con ts del ribroadcast T1 > T0.
  // Il conteggio va sugli elementi card: il toast live porta lo stesso titolo.
  const T0 = 1760000000000;
  const T1 = T0 + 60 * 60 * 1000;
  const OWNER = '4f0c1d2e3a4b5c6d7e8f9a0b1c2d3e4f';
  const EVENT = 'd4550000-0000-4000-8000-0000000000e1';
  const TITLE = 'Approva NC 0.9.64 su npmjs.com';
  const BACKLOG_VIEW = {
    views: [{
      ownerId: OWNER, askReplyAccess: false, stale: false, asks: [],
      notifications: [{ v: 1, ownerId: OWNER, eventId: EVENT, scope: 'cell', cellId: 'dev',
        hop: 1, emittedAt: T0, frame: { type: 'notify', title: TITLE, body: '', urgency: 'normal', ts: T0 } }],
    }],
  };
  const LIVE_FRAME = { type: 'notify', title: TITLE, body: '', urgency: 'normal',
    originNode: OWNER, ownerId: OWNER, originCell: 'dev', eventId: EVENT, ts: T1 };

  it('la stessa notifica riletta dall arretrato non si duplica (merge, non concatenazione)', async () => {
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce(BACKLOG_VIEW);
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    const badge = await screen.findByTitle('questions from the cells');
    act(() => badge.click());
    await screen.findByText(TITLE);
    expect(document.querySelectorAll('.nc-remote-notice').length).toBe(1);
    // La stessa notifica arriva live: il merge per chiave compatta (vero anche oggi).
    act(() => mocks.eventHandler(LIVE_FRAME));
    expect(document.querySelectorAll('.nc-remote-notice').length).toBe(1);
    // La SSE si riapre e feed-state rilegge lo STESSO arretrato con la card
    // gia in stato: deve restare una card sola.
    getFeedState.mockResolvedValueOnce(BACKLOG_VIEW);
    await act(async () => { mocks.openHandler(); });
    await waitFor(() => expect(getFeedState).toHaveBeenCalledTimes(2));
    await act(async () => {});
    const cards = document.querySelectorAll('.nc-remote-notice');
    expect(cards.length).toBe(1);
    expect([...cards].filter((c) => c.textContent.includes(TITLE)).length).toBe(1);
  });

  it('l ora mostrata e quella di emissione (emittedAt): arretrato e live della stessa notifica', async () => {
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce(BACKLOG_VIEW);
    render(<NotifyCenter token="token" />);
    const badge = await screen.findByTitle('questions from the cells');
    act(() => badge.click());
    await screen.findByText(TITLE);
    // La card dell arretrato mostra T0, l ora in cui l owner ha emesso — non
    // l ora di chi la legge (fallback n.ts || Date.now() con n.ts = 0).
    let meta = document.querySelector('.nc-remote-notice-meta');
    expect(meta.textContent).toContain(new Date(T0).toLocaleString());
    // La stessa notifica arriva live: il ribroadcast porta il ts di origine
    // (emittedAt), non l istante in cui e stato ritrasmesso (T1).
    act(() => mocks.eventHandler({ ...LIVE_FRAME, ts: T0 }));
    const cards = document.querySelectorAll('.nc-remote-notice');
    expect(cards.length).toBe(1);
    meta = cards[0].querySelector('.nc-remote-notice-meta');
    expect(meta.textContent).toContain(new Date(T0).toLocaleString());
    expect(meta.textContent).not.toContain(new Date(T1).toLocaleString());
  });
});

describe('arretrato: dedup che discrimina e cap per ts', () => {
  const viewWith = (notices) => ({
    views: [{ ownerId: 'nodeX', askReplyAccess: false, stale: false, notifications: notices, asks: [] }],
  });
  const mk = (eventId, ts) => ({ type: 'notify', eventId, title: 'T ' + eventId, urgency: 'normal', ts });

  it('dedup: snapshot arriva DOPO l SSE della stessa (ownerId,eventId) -> una card sola', async () => {
    let resolveFeed;
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockImplementationOnce(() => new Promise((r) => { resolveFeed = r; }));
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    act(() => mocks.eventHandler({ type: 'notify', ownerId: 'nodeX', eventId: 'e9', title: 'T e9', urgency: 'normal' }));
    const badge = await screen.findByTitle('questions from the cells');
    act(() => badge.click());
    expect(document.querySelectorAll('.nc-remote-notice').length).toBe(1);
    act(() => mocks.eventHandler({ type: 'notify', ownerId: 'nodeX', eventId: 'e9', title: 'T e9', urgency: 'normal' }));
    expect(document.querySelectorAll('.nc-remote-notice').length).toBe(1);
    resolveFeed(viewWith([mk('e9', 5)]));
    await waitFor(() => expect(document.querySelectorAll('.nc-remote-notice').length).toBe(1));
  });

  it('dedup: snapshot arriva PRIMA e l SSE dopo -> una card sola', async () => {
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce(viewWith([mk('e7', 3)]));
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    const badge = await screen.findByTitle('questions from the cells');
    act(() => badge.click());
    await screen.findByText('T e7');
    act(() => mocks.eventHandler({ type: 'notify', ownerId: 'nodeX', eventId: 'e7', title: 'T e7', urgency: 'normal' }));
    await waitFor(() => expect(document.querySelectorAll('.nc-remote-notice').length).toBe(1));
  });

  it('cap 50: tiene le piu recenti per ts, non le ultime inserite', async () => {
    const notices = [];
    for (let i = 0; i < 55; i += 1) notices.push(mk('e' + i, 1000 + i));
    notices.unshift(mk('prima-ts-alto', 99999));
    const { getFeedState } = await import('../lib/api.js');
    getFeedState.mockResolvedValueOnce(viewWith(notices));
    render(<NotifyCenter token="token" />);
    const badge = await screen.findByTitle('questions from the cells');
    act(() => badge.click());
    expect(await screen.findByText('T prima-ts-alto')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('T e0')).toBeNull());
    expect(screen.getByText('T e6')).toBeTruthy();
    expect(screen.queryByText('T e5')).toBeNull();
    expect(document.querySelectorAll('.nc-remote-notice').length).toBe(50);
  });
});

describe('federated ask dismiss: confirmed only, remembered, nothing silent', () => {
  const openPanel = (container) => {
    const badge = container.querySelector('.nc-ask-badge');
    expect(badge).toBeTruthy();
    act(() => { badge.click(); });
  };
  const importedView = (id, question, extra = []) => ({
    views: [{
      ownerId: 'ownerA', askReplyAccess: true,
      asks: [{ id, question, session: 's', options: [] }, ...extra],
    }],
  });

  it('a confirmed dismiss does not come back when the feed state is read again', async () => {
    const { getFeedState, relayAskDismiss } = await import('../lib/api.js');
    getAsks.mockResolvedValue({ asks: [] });
    getFeedState.mockResolvedValue(importedView('a1-reload', 'ricompare?'));
    relayAskDismiss.mockResolvedValue({ dismissed: true });

    const first = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(first.container.querySelector('.nc-ask-badge')).toBeTruthy());
    openPanel(first.container);
    expect(screen.getByText('ricompare?')).toBeTruthy();
    await act(async () => { first.container.querySelector('.nc-ask-dismiss').click(); });
    await waitFor(() => expect(screen.queryByText('ricompare?')).toBeNull());
    expect(relayAskDismiss).toHaveBeenCalled();
    first.unmount();

    // Reload: the owner's view can still list the ask for a moment (its closing
    // frame and this read race). The local tombstone keeps the card out — and a
    // fresh ask in the SAME view proves the list was read, not just empty.
    getFeedState.mockResolvedValue(importedView('a1-reload', 'ricompare?', [
      { id: 'a1-reload-2', question: 'nuova, resta', session: 's', options: [] },
    ]));
    const second = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(second.container.querySelector('.nc-ask-badge')).toBeTruthy());
    openPanel(second.container);
    expect(screen.getByText('nuova, resta')).toBeTruthy();
    expect(screen.queryByText('ricompare?')).toBeNull();
  });

  it('a failed dismiss keeps the card and shows the cause', async () => {
    const { getFeedState, relayAskDismiss } = await import('../lib/api.js');
    getAsks.mockResolvedValue({ asks: [] });
    getFeedState.mockResolvedValue(importedView('a1-fail', 'non deve sparire'));
    relayAskDismiss.mockRejectedValueOnce(new Error('owner non tra i peer autorizzati'));

    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
    openPanel(container);
    expect(screen.getByText('non deve sparire')).toBeTruthy();
    await act(async () => { container.querySelector('.nc-ask-dismiss').click(); });
    expect(await screen.findByText('owner non tra i peer autorizzati')).toBeTruthy();
    expect(screen.getByText('non deve sparire')).toBeTruthy();
  });

  it('an uncertain receipt disables the X and says why', async () => {
    const { getFeedState, getAskRelayState } = await import('../lib/api.js');
    getAsks.mockResolvedValue({ asks: [] });
    getFeedState.mockResolvedValue(importedView('a1-unc', 'esito incerto'));
    getAskRelayState.mockResolvedValue({
      attempts: [{ state: 'uncertain', ownerId: 'ownerA', askId: 'a1-unc', requestId: 'rid-1' }],
    });

    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
    openPanel(container);
    const x = container.querySelector('.nc-ask-dismiss');
    await waitFor(() => expect(x.disabled).toBe(true));
    expect(x.getAttribute('title')).toBe(
      'Uncertain outcome: the answer may have arrived. Verify the status before retrying.',
    );
  });
});

describe('NotifyCenter ask card feed state (Pixel fix)', () => {
  const staleView = (id, question) => ({
    views: [{
      ownerId: 'ownerA', askReplyAccess: true, stale: true, lastError: 'resync-exhausted',
      asks: [{ id, question, session: 's', options: [] }],
    }],
  });

  it('a degraded view shows the stale note and the X explains why, even with reply access', async () => {
    const { getFeedState } = await import('../lib/api.js');
    getAsks.mockResolvedValue({ asks: [] });
    getFeedState.mockResolvedValue(staleView('a3977abd', 'la card che torna'));

    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
    act(() => { container.querySelector('.nc-ask-badge').click(); });
    expect(await screen.findByText('la card che torna')).toBeTruthy();
    // Il badge stale è visibile ANCHE con il permesso di risposta: è la card
    // che ricompariva con il feed fermo (Pixel 2026-09-29).
    expect(await screen.findByText(/feed is inactive/)).toBeTruthy();
    // La X dice perché, al posto del titolo di dismiss ordinario.
    const x = container.querySelector('.nc-ask-dismiss');
    expect(x.getAttribute('title')).toBe(
      'Dismiss anyway: the dismissal is forwarded directly to the node, but while the feed is down the card may not reflect the live state.',
    );
  });

  it('a live view keeps the plain dismiss title and shows no stale note', async () => {
    const { getFeedState } = await import('../lib/api.js');
    getAsks.mockResolvedValue({ asks: [] });
    getFeedState.mockResolvedValue({
      views: [{
        ownerId: 'ownerA', askReplyAccess: true,
        asks: [{ id: 'live1', question: 'normale', session: 's', options: [] }],
      }],
    });

    const { container } = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
    act(() => { container.querySelector('.nc-ask-badge').click(); });
    expect(await screen.findByText('normale')).toBeTruthy();
    expect(container.querySelector('.nc-ask-dismiss').getAttribute('title')).toBe('Dismiss question');
    expect(screen.queryByText(/feed is inactive/)).toBeNull();
  });
});
