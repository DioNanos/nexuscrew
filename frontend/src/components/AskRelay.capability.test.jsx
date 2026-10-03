import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getAsks: vi.fn(), getFeedState: vi.fn(), getAskRelayState: vi.fn(),
  getAskReplyCapability: vi.fn(), relayAskAnswer: vi.fn(), relayAskVerify: vi.fn(),
  connectEvents: vi.fn(), onFrame: null, onOpen: null,
}));
vi.mock('../lib/api.js', async (original) => ({ ...(await original()), ...mocks }));
vi.mock('../lib/events.js', () => ({ connectEvents: mocks.connectEvents }));
import NotifyCenter from './NotifyCenter.jsx';

const OWNER = 'c'.repeat(32);
const HUB = 'b'.repeat(32);
const alias = { id: '11223344', ownerAskId: 'aabbccdd', ownerId: OWNER,
  question: 'Proceed with the review?', session: 'Reviewer', imported: true };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); localStorage.setItem('nc_lang', 'en');
  mocks.getAsks.mockResolvedValue({ asks: [alias] });
  mocks.getFeedState.mockResolvedValue({ views: [{ ownerId: HUB, stale: false, askReplyAccess: true }] });
  mocks.getAskRelayState.mockResolvedValue({ attempts: [] });
  mocks.getAskReplyCapability.mockResolvedValue({ ownerId: OWNER, askId: alias.ownerAskId,
    canReply: true, status: 'open' });
  mocks.relayAskAnswer.mockResolvedValue({ status: 'committed', requestId: 'fixture-request-id' });
  mocks.relayAskVerify.mockResolvedValue({ state: 'committed' });
  mocks.connectEvents.mockImplementation((_token, frame, open) => {
    mocks.onFrame = frame; mocks.onOpen = open; return () => {};
  });
});
async function mount(token = 'fixture-token') {
  const view = render(<NotifyCenter token={token} />);
  const badge = await screen.findByTitle((_title, element) => element.className === 'nc-ask-badge');
  fireEvent.click(badge);
  return view;
}
async function send() {
  const button = await screen.findByText(/^send$/i);
  fireEvent.change(document.querySelector('.nc-ask-reply textarea'), { target: { value: 'Proceed' } });
  fireEvent.click(button);
}

it('uses the owner action capability through a hub and preserves the owner ask id', async () => {
  await mount(); await send();
  await waitFor(() => expect(mocks.relayAskAnswer).toHaveBeenCalledTimes(1));
  const [token, body] = mocks.relayAskAnswer.mock.calls[0];
  expect(token).toBe('fixture-token');
  expect(body).toMatchObject({ ownerId: OWNER, askId: 'aabbccdd', text: 'Proceed' });
  expect(mocks.getAskReplyCapability).toHaveBeenCalledWith('fixture-token',
    { ownerId: OWNER, askId: 'aabbccdd' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

it('a valid action capability permits replying with no subscribed feed or owner view', async () => {
  mocks.getFeedState.mockResolvedValue({ views: [] });
  await mount(); await send();
  await waitFor(() => expect(mocks.relayAskAnswer).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/enable.*receiv|not receiving this node/i)).toBeNull();
});

it('denied action capability blocks sending even when the feed grant is live', async () => {
  mocks.getFeedState.mockResolvedValue({ views: [{ ownerId: OWNER, stale: false, askReplyAccess: true }] });
  mocks.getAskReplyCapability.mockResolvedValue({ ownerId: OWNER, askId: alias.ownerAskId, canReply: false, status: 'denied' });
  await mount();
  await waitFor(() => expect(screen.getByText(/read-only|not granted/i)).toBeTruthy());
  expect(screen.queryByText(/^send$/i)).toBeNull();
  expect(mocks.relayAskAnswer).not.toHaveBeenCalled();
});

it('a deferred independent capability is checked before it resolves and cannot borrow a feed grant', async () => {
  const pending = deferred();
  mocks.getFeedState.mockResolvedValue({ views: [{ ownerId: OWNER, stale: false, askReplyAccess: true }] });
  mocks.getAskReplyCapability.mockReturnValue(pending.promise);
  await mount();
  expect(screen.queryByText(/^send$/i)).toBeNull();
  expect(mocks.relayAskAnswer).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ ownerId: OWNER, askId: alias.ownerAskId, canReply: true, status: 'open' }));
  expect(await screen.findByText(/^send$/i)).toBeTruthy();
});

it('an ASK delivered by SSE after mount gets its own capability without a feed view', async () => {
  mocks.getAsks.mockResolvedValue({ asks: [] });
  mocks.getFeedState.mockResolvedValue({ views: [] });
  render(<NotifyCenter token="fixture-token" />);
  await act(async () => mocks.onFrame({ type: 'ask', ask: alias }));
  fireEvent.click(await screen.findByTitle((_title, element) => element.className === 'nc-ask-badge'));
  expect(await screen.findByText(/^send$/i)).toBeTruthy();
  expect(mocks.getAskReplyCapability).toHaveBeenCalledTimes(1);
});

it('one capability request per owner ask stays in flight across panel opening and cancels on token change', async () => {
  const old = deferred();
  mocks.getAskReplyCapability.mockReturnValueOnce(old.promise).mockResolvedValue({ ownerId: OWNER,
    askId: alias.ownerAskId, canReply: false, status: 'denied' });
  const view = await mount();
  await waitFor(() => expect(mocks.getAskReplyCapability).toHaveBeenCalledTimes(1));
  const signal = mocks.getAskReplyCapability.mock.calls[0][2].signal;
  view.rerender(<NotifyCenter token="replacement-token" />);
  await waitFor(() => expect(signal.aborted).toBe(true));
  await waitFor(() => expect(mocks.getAskReplyCapability).toHaveBeenCalledTimes(2));
  await act(async () => old.resolve({ ownerId: OWNER, askId: alias.ownerAskId, canReply: true, status: 'open' }));
  expect(screen.queryByText(/^send$/i)).toBeNull();
});

it('an uncertain answer verifies its original request without sending a second POST', async () => {
  mocks.relayAskAnswer.mockResolvedValue({ uncertain: true, requestId: '11111111-2222-3333-4444-555555555555' });
  await mount(); await send();
  fireEvent.click(await screen.findByText(/verify status/i));
  await waitFor(() => expect(mocks.relayAskVerify).toHaveBeenCalledTimes(1));
  expect(mocks.relayAskVerify.mock.calls[0][1]).toMatchObject({ ownerId: OWNER, askId: alias.ownerAskId,
    requestId: '11111111-2222-3333-4444-555555555555' });
  expect(mocks.relayAskAnswer).toHaveBeenCalledTimes(1);
});
