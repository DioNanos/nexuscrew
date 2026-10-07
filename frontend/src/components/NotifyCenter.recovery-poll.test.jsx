import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ getAsks: vi.fn(), getFeedState: vi.fn(), frame: null, open: null }));
vi.mock('../lib/api.js', async original => ({ ...(await original()), getAsks: m.getAsks, getFeedState: m.getFeedState,
  getAskRelayState: vi.fn(async () => ({ attempts: [] })), getAskReplyCapability: vi.fn(async (_t, {ownerId,askId}) => ({ownerId,askId,canReply:false,status:'unreachable',canDismissLocal:false,canDismissRemote:false})) }));
// La SSE simulata NON si apre mai finché il test non chiama m.open(): è il
// Caso (EventSource assente o giù senza riapertura).
vi.mock('../lib/events.js', () => ({ connectEvents: (_t, frame, open) => { m.frame = frame; m.open = open; return () => {}; } }));
vi.mock('../hooks/useNotificationSpeech.js', () => ({ useNotificationSpeech: () => [true, () => {}] }));
vi.mock('../lib/notification-speech.js', () => ({ NOTIFICATION_SPEECH_PREVIEW_EVENT: 'preview', notificationSpeechFrameLang: () => 'en', createNotificationSpeaker: () => ({ enqueue: vi.fn(), stop: () => {}, dispose: () => {} }) }));
import NotifyCenter from './NotifyCenter.jsx';

const owner = 'a'.repeat(32);
const ask = { id: 'abcdef01', ownerId: owner, ownerAskTs: 100, question: 'Recovered question', options: [], session: 'reviewer', imported: true };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('nc_lang', 'en');
  m.getAsks.mockResolvedValue({ asks: [] });
  m.getFeedState.mockResolvedValue({ views: [] });
});

describe('recupero ASK senza SSE (polling limitato)', () => {
  afterEach(() => { vi.useRealTimers(); });

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
      await act(async () => { m.open(); await vi.advanceTimersByTimeAsync(0); });
      const readsBefore = m.getAsks.mock.calls.length + m.getFeedState.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(65000); });
      const readsAfter = m.getAsks.mock.calls.length + m.getFeedState.mock.calls.length;
      expect(readsAfter).toBe(readsBefore);
    } finally { vi.useRealTimers(); }
  });
});
