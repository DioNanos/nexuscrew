import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventHandler: null,
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
  relayAskAnswer: vi.fn(() => Promise.resolve({ status: 'committed' })),
  relayAskDismiss: vi.fn(() => Promise.resolve({ dismissed: true })),
  relayAskVerify: vi.fn(() => Promise.resolve({ state: 'committed' })),
}));

vi.mock('../lib/events.js', () => ({
  connectEvents: vi.fn((_token, onFrame) => {
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
    // Risposta altrove: la domanda locale non e' piu' aperta e deve sparire.
    await act(async () => { finishLocal({ asks: [] }); });
    expect(container.querySelector('.nc-ask-badge')).toBeNull();
  });
});

it('canonical identity deduplicates the direct alias and the feed copy',async()=>{
 const owner='a'.repeat(32),question='same canonical question';
 getAsks.mockResolvedValueOnce({asks:[{id:'11111111',ownerId:owner,ownerAskId:'22222222',originNode:owner,question,session:'cloud-dev',options:[]}]});
 const {getFeedState}=await import('../lib/api.js');getFeedState.mockResolvedValueOnce({views:[{ownerId:owner,askReplyAccess:true,asks:[{id:'22222222',question,session:'cloud-dev',options:[]}]}]});
 const {container}=render(<NotifyCenter token="token"/>);await waitFor(()=>expect(container.querySelector('.nc-ask-badge')).toBeTruthy());
 await act(async()=>{});act(()=>container.querySelector('.nc-ask-badge').click());
 expect(container.querySelectorAll('.nc-ask-card').length).toBe(1);
});
