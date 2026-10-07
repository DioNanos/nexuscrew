import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ getAsks: vi.fn(), getFeedState: vi.fn(), source: null }));
vi.mock('../lib/api.js', async original => ({ ...(await original()), getAsks: m.getAsks, getFeedState: m.getFeedState,
  getAskRelayState: vi.fn(async () => ({ attempts: [] })), getAskReplyCapability: vi.fn(async (_t, {ownerId,askId}) => ({ownerId,askId,canReply:false,status:'unreachable',canDismissLocal:false,canDismissRemote:false})) }));
// Keep the real events.js bridge; only the browser transport is simulated.
class TestEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor() { this.readyState = TestEventSource.CONNECTING; m.source = this; }
  open() { this.readyState = TestEventSource.OPEN; this.onopen?.({}); }
  fail(state) { this.readyState = state; this.onerror?.({}); }
  close() { this.readyState = TestEventSource.CLOSED; }
}
vi.mock('../hooks/useNotificationSpeech.js', () => ({ useNotificationSpeech: () => [true, () => {}] }));
vi.mock('../lib/notification-speech.js', () => ({ NOTIFICATION_SPEECH_PREVIEW_EVENT: 'preview', notificationSpeechFrameLang: () => 'en', createNotificationSpeaker: () => ({ enqueue: vi.fn(), stop: () => {}, dispose: () => {} }) }));
import NotifyCenter from './NotifyCenter.jsx';

const owner = 'a'.repeat(32);
const ask = { id: 'abcdef01', ownerId: owner, ownerAskTs: 100, question: 'Recovered question', options: [], session: 'reviewer', imported: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('EventSource', TestEventSource);
  localStorage.setItem('nc_lang', 'en');
  m.getAsks.mockResolvedValue({ asks: [] });
  m.getFeedState.mockResolvedValue({ views: [] });
});

describe('recupero ASK senza SSE (polling limitato)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('con la SSE mai aperta, una ASK nuova compare entro il periodo di recupero, senza reload', async () => {
    vi.useFakeTimers();
    try {
      render(<NotifyCenter token="fixture" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // Nessuna ASK: né badge né pannello apribile.
      expect(screen.queryByTitle((_t, e) => e.className === 'nc-ask-badge')).toBeNull();
      // Una ASK nuova diventa disponibile nelle API DOPO il mount.
      m.getFeedState.mockResolvedValue({ views: [{ ownerId: owner, stale: false, viewEpoch: 1, cursor: '1:0', asks: [ask] }] });
      m.getAsks.mockResolvedValue({ asks: [{ ...ask, ownerId: undefined, imported: false, ts: 100 }] });
      // Il periodo di recupero: il primo tick parte a 30 s, senza reload.
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      fireEvent.click(screen.getByTitle((_t, e) => e.className === 'nc-ask-badge'));
      expect(screen.getAllByText(ask.question).length).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });

  it('una rilettura con owner guasto non rimuove le card già visibili', async () => {
    vi.useFakeTimers();
    try {
      const view = { ownerId: owner, stale: false, viewEpoch: 1, cursor: '1:0', asks: [ask] };
      m.getFeedState.mockResolvedValue({ views: [view] });
      render(<NotifyCenter token="fixture" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByTitle((_t, e) => e.className === 'nc-ask-badge'));
      expect(screen.getAllByText(ask.question).length).toBeGreaterThan(0);
      // L'owner va in errore (stale, lastError, cursor nullo, elenco vuoto):
      // la rilettura non deve rimuovere le card già visibili.
      m.getFeedState.mockResolvedValue({ views: [{ ownerId: owner, stale: true, lastError: 'unreachable', cursor: null, asks: [] }] });
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(screen.getAllByText(ask.question).length).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });

  it('con la SSE aperta non c’è polling di recupero', async () => {
    vi.useFakeTimers();
    try {
      render(<NotifyCenter token="fixture" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // La SSE apre subito: il recupero si ferma.
      await act(async () => { m.source.open(); await vi.advanceTimersByTimeAsync(0); });
      const readsBefore = m.getAsks.mock.calls.length + m.getFeedState.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(65000); });
      const readsAfter = m.getAsks.mock.calls.length + m.getFeedState.mock.calls.length;
      expect(readsAfter).toBe(readsBefore);
    } finally { vi.useRealTimers(); }
  });

  it.each([TestEventSource.CONNECTING, TestEventSource.CLOSED])('recovers after an opened stream fails with readyState %s and stops on reopening', async state => {
    vi.useFakeTimers();
    render(<NotifyCenter token="fixture" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); m.source.open(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { m.source.fail(state); });
    m.getAsks.mockResolvedValue({ asks: [{ id: 'recover-local', ts: 200, question: 'Question after disconnect', options: [], session: 'reviewer' }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    fireEvent.click(screen.getByTitle((_t, e) => e.className === 'nc-ask-badge'));
    expect(screen.getByText('Question after disconnect')).toBeTruthy();

    m.getAsks.mockResolvedValue({ asks: [{ id: 'reopened-local', ts: 300, question: 'Question on reopening', options: [], session: 'reviewer' }] });
    await act(async () => { m.source.open(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Question on reopening')).toBeTruthy();
    const reads = m.getAsks.mock.calls.length + m.getFeedState.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(m.getAsks.mock.calls.length + m.getFeedState.mock.calls.length).toBe(reads);

    // A later disconnection starts again at the base period.
    await act(async () => { m.source.fail(state); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(m.getAsks.mock.calls.length + m.getFeedState.mock.calls.length).toBe(reads + 2);
  });

  it('a new token recovers without inheriting an earlier open stream or its late callbacks', async () => {
    vi.useFakeTimers();
    const view = render(<NotifyCenter token="first" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); m.source.open(); });
    const oldOpen = m.source.onopen;
    view.rerender(<NotifyCenter token="second" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { oldOpen({}); });
    m.getAsks.mockResolvedValue({ asks: [{ id: 'next-token', ts: 400, question: 'Question for the new token', options: [], session: 'reviewer' }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    fireEvent.click(screen.getByTitle((_t, e) => e.className === 'nc-ask-badge'));
    expect(screen.getByText('Question for the new token')).toBeTruthy();
  });

  it('a rapid open and error cycle still rearms recovery', async () => {
    vi.useFakeTimers();
    render(<NotifyCenter token="fixture" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { m.source.open(); m.source.fail(TestEventSource.CONNECTING); });
    m.getAsks.mockResolvedValue({ asks: [{ id: 'rapid-recovery', ts: 500, question: 'Question after rapid disconnect', options: [], session: 'reviewer' }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    fireEvent.click(screen.getByTitle((_t, e) => e.className === 'nc-ask-badge'));
    expect(screen.getByText('Question after rapid disconnect')).toBeTruthy();
  });
});
