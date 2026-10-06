import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ getAsks: vi.fn(), getFeedState: vi.fn(), frame: null, open: null, enqueue: vi.fn() }));
vi.mock('../lib/api.js', async original => ({ ...(await original()), getAsks: m.getAsks, getFeedState: m.getFeedState,
  getAskRelayState: vi.fn(async () => ({ attempts: [] })), getAskReplyCapability: vi.fn(async (_t, {ownerId,askId}) => ({ownerId,askId,canReply:false,status:'unreachable',canDismissLocal:false,canDismissRemote:false})) }));
vi.mock('../lib/events.js', () => ({ connectEvents: (_t, frame, open) => { m.frame=frame; m.open=open; return () => {}; } }));
vi.mock('../hooks/useNotificationSpeech.js', () => ({ useNotificationSpeech: () => [true, () => {}] }));
vi.mock('../lib/notification-speech.js', () => ({ NOTIFICATION_SPEECH_PREVIEW_EVENT:'preview', notificationSpeechFrameLang: () => 'en', createNotificationSpeaker: () => ({enqueue:m.enqueue,stop:()=>{},dispose:()=>{}}) }));
import NotifyCenter from './NotifyCenter.jsx';

// An owner closure that reached the server view (fan-out or feed) must survive
// a page reload: a fresh mount rebuilds its cards from /api/feed-state alone,
// with no local tombstone to help. This pins the export contract — the view
// no longer carries a closed generation — while the second test keeps the
// import path honest: an OPEN ask from the same view still becomes a card.
const owner = 'a'.repeat(32);
const view = asks => ({ views: [{ ownerId: owner, cursor: '1:0', viewEpoch: 1, stale: false, lastError: null,
  askReplyAccess: true, asks, notifications: [], fleetState: null }] });
const openAsk = { id: 'abcdef01', ownerId: owner, ownerAskTs: 100, question: 'Shared question', options: [], session: 'reviewer', imported: true };

beforeEach(() => { vi.clearAllMocks(); localStorage.setItem('nc_lang', 'en'); m.getAsks.mockResolvedValue({ asks: [] }); m.getFeedState.mockResolvedValue({ views: [] }); });

const mount = async () => { render(<NotifyCenter token="fixture" />); await waitFor(() => expect(m.frame).toBeTypeOf('function')); };
const badge = () => screen.queryByTitle((_t, e) => e.className === 'nc-ask-badge');

it('a fresh mount must not resurrect an ASK closed on the server view', async () => {
  m.getFeedState.mockResolvedValue(view([]));
  await mount();
  await act(async () => {});
  expect(badge()).toBeNull();
});

it('a fresh mount still imports an open ask from the same view', async () => {
  m.getFeedState.mockResolvedValue(view([{ ...openAsk }]));
  await mount();
  await act(async () => {});
  expect(badge()).not.toBeNull();
});
