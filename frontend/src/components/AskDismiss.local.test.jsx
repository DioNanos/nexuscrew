import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ getAsks: vi.fn(), getFeedState: vi.fn(), getAskRelayState: vi.fn(),
  getAskReplyCapability: vi.fn(), relayAskDismissLocal: vi.fn(), relayAskDismiss: vi.fn(), relayAskAnswer: vi.fn(),
  relayAskVerify: vi.fn(), dismissAsk: vi.fn(), connectEvents: vi.fn(), frame: null, open: null }));
vi.mock('../lib/api.js', async original => ({ ...(await original()), ...mocks }));
vi.mock('../lib/events.js', () => ({ connectEvents: mocks.connectEvents }));
import NotifyCenter from './NotifyCenter.jsx';
let sequence = 0, alias;
const OWNER = 'c'.repeat(32), OTHER = 'd'.repeat(32);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const cap = (extra = {}) => ({ ownerId: OWNER, askId: alias.ownerAskId, canReply: false, status: 'unreachable', canDismissLocal: true, canDismissRemote: false, ...extra });
beforeEach(() => {
  vi.resetAllMocks(); localStorage.setItem('nc_lang', 'en');
  alias = { id: `alias-${++sequence}`, ownerId: OWNER, ownerAskId: `owner-${sequence}`, ownerAskTs: 100,
    question: `Question ${sequence}`, session: 'reviewer', options: ['Yes'], imported: true };
  mocks.getAsks.mockResolvedValue({ asks: [alias] });
  mocks.getFeedState.mockResolvedValue({ views: [{ ownerId: OWNER, stale: false, asks: [] }] });
  mocks.getAskRelayState.mockResolvedValue({ attempts: [] });
  mocks.getAskReplyCapability.mockImplementation(async () => cap());
  mocks.relayAskDismissLocal.mockResolvedValue({ dismissed: true, scope: 'local', ownerSync: 'pending' });
  mocks.relayAskDismiss.mockResolvedValue({ dismissed: true });
  mocks.relayAskAnswer.mockResolvedValue({ status: 'committed' });
  mocks.connectEvents.mockImplementation((_token, frame, open) => { mocks.frame = frame; mocks.open = open; return () => {}; });
});
async function mount() {
  const view = render(<NotifyCenter token="fixture-token" />);
  fireEvent.click(await screen.findByTitle((_title, element) => element.className === 'nc-ask-badge'));
  await act(async () => {}); return view;
}
const dismissButton = () => document.querySelector('.nc-ask-dismiss');
const emit = async frame => act(async () => mocks.frame(frame));

it('live feed and explicit offline capability enable only the local action', async () => {
  await mount(); expect(dismissButton().disabled).toBe(false);
  expect(dismissButton().title).toBe('Dismiss on this node');
  fireEvent.click(dismissButton());
  await waitFor(() => expect(mocks.relayAskDismissLocal).toHaveBeenCalledWith('fixture-token', { ownerId: OWNER, askId: alias.ownerAskId }));
  expect(mocks.relayAskDismiss).not.toHaveBeenCalled(); expect(mocks.dismissAsk).not.toHaveBeenCalled(); expect(mocks.relayAskAnswer).not.toHaveBeenCalled();
});
it('a stale feed and open capability retain remote dismissal', async () => {
  mocks.getFeedState.mockResolvedValue({ views: [{ ownerId: OWNER, stale: true, asks: [] }] });
  mocks.getAskReplyCapability.mockImplementation(async () => cap({ status: 'open', canReply: true, canDismissLocal: false, canDismissRemote: true }));
  await mount(); expect(dismissButton().disabled).toBe(false);
  expect(dismissButton().title).not.toBe('Dismiss on this node'); fireEvent.click(dismissButton());
  await waitFor(() => expect(mocks.relayAskDismiss).toHaveBeenCalledWith('fixture-token', { ownerId: OWNER, askId: alias.ownerAskId }));
  expect(mocks.relayAskDismissLocal).not.toHaveBeenCalled();
});
for (const [label, state] of [
  ['reachable permission denial', { status: 'denied', canDismissLocal: false }],
  ['unsupported owner', { status: 'unsupported', canDismissLocal: false }],
  ['missing dismissal bits', { status: 'unreachable', canDismissLocal: undefined, canDismissRemote: undefined }],
  ['reply permission without dismissal permission', { status: 'open', canReply: true, canDismissLocal: false, canDismissRemote: false }],
  ['nonboolean local permission', { canDismissLocal: 'true' }],
]) it(`does not infer a local action from ${label}`, async () => {
  mocks.getAskReplyCapability.mockImplementation(async () => cap(state)); await mount();
  expect(dismissButton().disabled).toBe(true); fireEvent.click(dismissButton()); expect(mocks.relayAskDismissLocal).not.toHaveBeenCalled();
});
it('capability loading blocks dismiss even with a live feed grant', async () => {
  const pending = deferred(); mocks.getAskReplyCapability.mockReturnValue(pending.promise);
  await mount(); expect(dismissButton().disabled).toBe(true); fireEvent.click(dismissButton());
  expect(mocks.relayAskDismissLocal).not.toHaveBeenCalled();
  await act(async () => pending.resolve(cap())); expect(dismissButton().disabled).toBe(false);
});
it('an offline user without reply permission can explicitly dismiss locally', async () => {
  mocks.getAskReplyCapability.mockImplementation(async () => cap({ status: 'denied' }));
  await mount(); expect(screen.queryByText(/^send$/i)).toBeNull(); expect(dismissButton().disabled).toBe(false);
});
it('uncertain relay state arriving after the card blocks both dismissal paths', async () => {
  const pending = deferred(); mocks.getAskRelayState.mockReturnValue(pending.promise);
  await mount(); await act(async () => pending.resolve({ attempts: [{ ownerId: OWNER, askId: alias.ownerAskId, requestId: 'original', state: 'uncertain' }] }));
  expect(dismissButton().disabled).toBe(true); expect(screen.getByText(/uncertain outcome/i)).toBeTruthy();
});
it('an answer in progress takes priority over either dismissal permission', async () => {
  const pending = deferred(); mocks.relayAskAnswer.mockReturnValue(pending.promise);
  mocks.getAskReplyCapability.mockImplementation(async () => cap({ status: 'open', canReply: true, canDismissRemote: true }));
  await mount(); fireEvent.click(screen.getByText('Yes')); expect(dismissButton().disabled).toBe(true);
  fireEvent.click(dismissButton()); expect(mocks.relayAskDismissLocal).not.toHaveBeenCalled(); expect(mocks.relayAskDismiss).not.toHaveBeenCalled();
});
it('a previous unknown request blocks dismissal and cannot verify a new unsent request', async () => {
  mocks.getAskReplyCapability.mockImplementation(async () => cap({ status: 'open', canReply: true, canDismissRemote: true }));
  mocks.relayAskAnswer.mockResolvedValue({ uncertain: true, reason: 'delivery-unknown-block', requestId: 'unsent', originalRequestId: null });
  await mount(); fireEvent.click(screen.getByText('Yes')); await act(async () => {});
  expect(dismissButton().disabled).toBe(true); expect(screen.getByText(/reconcil/i)).toBeTruthy();
  expect(screen.queryByText(/verify status/i)).toBeNull(); expect(mocks.relayAskVerify).not.toHaveBeenCalled();
});
it('a local click stays visible until durable ACK and reports pending origin closure', async () => {
  const pending = deferred(); mocks.relayAskDismissLocal.mockReturnValue(pending.promise);
  await mount(); fireEvent.click(dismissButton()); expect(screen.getByText(alias.question)).toBeTruthy();
  expect(dismissButton().disabled).toBe(true);
  await act(async () => pending.resolve({ dismissed: true, scope: 'local', ownerSync: 'pending' }));
  expect(screen.queryByText(alias.question)).toBeNull();
  expect(screen.getByText('Closure on the origin node is pending')).toBeTruthy();
  expect(screen.queryByText(/globally dismissed|dismissed on the origin/i)).toBeNull();
});
it('blocked local ACK states that remote closure is not authorized', async () => {
  mocks.relayAskDismissLocal.mockResolvedValue({ dismissed: true, scope: 'local', ownerSync: 'blocked' });
  await mount(); fireEvent.click(dismissButton()); await act(async () => {});
  expect(screen.getByText('Local dismissal only: remote closure is not authorized')).toBeTruthy();
});
it('a disk write failure keeps the card with a readable reason', async () => {
  mocks.relayAskDismissLocal.mockRejectedValue(new Error('dismissal store unavailable'));
  await mount(); fireEvent.click(dismissButton()); await act(async () => {});
  expect(screen.getByText(alias.question)).toBeTruthy(); expect(screen.getByText('dismissal store unavailable')).toBeTruthy();
});
it('a malformed local ACK never hides the card or claims origin closure', async () => {
  mocks.relayAskDismissLocal.mockResolvedValue({ dismissed: true });
  await mount(); fireEvent.click(dismissButton()); await act(async () => {});
  expect(screen.getByText(alias.question)).toBeTruthy(); expect(document.querySelector('.nc-err')).toBeTruthy();
});
it('a confirmed local ACK removes the canonical alias and feed while keeping another owner', async () => {
  const feed = { ...alias, id: alias.ownerAskId, ownerAskId: undefined, ts: 100 };
  const other = { ...feed, ownerId: OTHER, question: 'Other owner question' };
  mocks.getAsks.mockResolvedValue({ asks: [alias, other] });
  mocks.getFeedState.mockResolvedValue({ views: [{ ownerId: OWNER, asks: [feed] }] });
  mocks.getAskReplyCapability.mockImplementation(async (_token, body) => ({ ...cap(), ownerId: body.ownerId, askId: body.askId }));
  await mount(); expect(document.querySelectorAll('.nc-ask-card')).toHaveLength(2); fireEvent.click(dismissButton()); await act(async () => {});
  expect(screen.queryByText(alias.question)).toBeNull(); expect(screen.getByText(other.question)).toBeTruthy();
  await emit({ type: 'ask', ask: alias }); await emit({ type: 'ask', ask: feed });
  expect(screen.queryByText(alias.question)).toBeNull(); expect(document.querySelectorAll('.nc-ask-card')).toHaveLength(1);
});
it('a local SSE closure uses ownerAskId rather than alias id and filters later snapshots', async () => {
  const local = deferred(), feed = { ...alias, id: alias.ownerAskId, ownerAskId: undefined };
  mocks.getAsks.mockReturnValue(local.promise); mocks.getFeedState.mockResolvedValue({ views: [{ ownerId: OWNER, asks: [feed] }] });
  await mount(); await emit({ type: 'ask-dismissed', id: alias.id, ownerId: OWNER, ownerAskId: alias.ownerAskId, scope: 'local' });
  expect(screen.queryByText(alias.question)).toBeNull();
  await act(async () => local.resolve({ asks: [alias] })); expect(screen.queryByText(alias.question)).toBeNull();
});
it('a local SSE closure suppresses a feed snapshot already in flight', async () => {
  const feed = deferred(); mocks.getFeedState.mockReturnValue(feed.promise); await mount();
  await emit({ type: 'ask-dismissed', id: alias.id, ownerId: OWNER, ownerAskId: alias.ownerAskId, scope: 'local' });
  await act(async () => feed.resolve({ views: [{ ownerId: OWNER, asks: [{ ...alias, id: alias.ownerAskId, ownerAskId: undefined }] }] }));
  expect(screen.queryByText(alias.question)).toBeNull();
});
it('local suppression survives the legacy TTL while a new known generation stays visible', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await mount(); fireEvent.click(dismissButton()); await act(async () => {}); clock.mockReturnValue(now + 11 * 60 * 1000);
    await emit({ type: 'ask', ask: alias }); expect(screen.queryByText(alias.question)).toBeNull();
    await emit({ type: 'ask', ask: { ...alias, ownerAskTs: 101 } }); expect(screen.getByText(alias.question)).toBeTruthy();
  } finally { clock.mockRestore(); }
});
it('SSE deduplicates an alias against its canonical feed card', async () => {
  await mount(); await emit({ type: 'ask', ask: { ...alias, id: alias.ownerAskId, ownerAskId: undefined } });
  expect(document.querySelectorAll('.nc-ask-card')).toHaveLength(1);
});
it('a token change cannot reuse a previous local dismissal capability', async () => {
  const view = await mount(); const pending = deferred(); mocks.getAskReplyCapability.mockReturnValue(pending.promise);
  view.rerender(<NotifyCenter token="replacement-token" />); await act(async () => {});
  expect(dismissButton().disabled).toBe(true);
});

it('a local closure received before either snapshot prevents their stale copies from appearing', async () => {
  const local = deferred(), feed = deferred(); mocks.getAsks.mockReturnValue(local.promise); mocks.getFeedState.mockReturnValue(feed.promise);
  render(<NotifyCenter token="fixture-token" />); await act(async () => {});
  await emit({ type: 'ask-dismissed', id: alias.id, ownerId: OWNER, ownerAskId: alias.ownerAskId, scope: 'local', ownerAskTs: 100 });
  await act(async () => { local.resolve({ asks: [alias] }); feed.resolve({ views: [{ ownerId: OWNER, asks: [{ ...alias, id: alias.ownerAskId, ownerAskId: undefined, ts: 100 }] }] }); });
  expect(document.querySelector('.nc-ask-badge')).toBeNull();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
  try { await emit({ type: 'ask', ask: alias }); expect(document.querySelector('.nc-ask-badge')).toBeNull(); } finally { clock.mockRestore(); }
});
it('unsupported capability never enables local dismissal even with a contradictory bit', async () => {
  mocks.getAskReplyCapability.mockImplementation(async () => cap({ status: 'unsupported' })); await mount();
  expect(dismissButton().disabled).toBe(true);
});
it('an answered response removes the canonical alias without affecting another owner', async () => {
  mocks.getAsks.mockResolvedValue({ asks: [alias, { ...alias, id: 'other-alias', ownerId: OTHER, question: 'Other owner' }] });
  mocks.getAskReplyCapability.mockImplementation(async (_token, body) => ({ ...cap({ status: 'open', canReply: true }), ownerId: body.ownerId, askId: body.askId }));
  await mount(); fireEvent.click(screen.getAllByText('Yes')[0]); await act(async () => {});
  expect(screen.queryByText(alias.question)).toBeNull(); expect(screen.getByText('Other owner')).toBeTruthy();
});
for (const [lang, action, state] of [
  ['it', 'Scarta su questo nodo', 'Scarto solo locale: chiusura remota non autorizzata'],
  ['es', 'Descartar en este nodo', 'Descarte solo local: el cierre remoto no está autorizado'],
]) it(`uses localized local dismissal copy in ${lang}`, async () => {
  localStorage.setItem('nc_lang', lang); mocks.relayAskDismissLocal.mockResolvedValue({ dismissed: true, scope: 'local', ownerSync: 'blocked' });
  await mount(); expect(dismissButton().title).toBe(action); fireEvent.click(dismissButton()); await act(async () => {});
  expect(screen.getByText(state)).toBeTruthy();
});
it('an early unknown-generation closure suppresses matching content and permits a different question', async () => {
  const local = deferred(); mocks.getAsks.mockReturnValue(local.promise); mocks.getFeedState.mockResolvedValue({ views: [] });
  render(<NotifyCenter token="fixture-token" />); await act(async () => {});
  const historical = { ...alias, ownerAskTs: undefined };
  await emit({ type: 'ask-dismissed', id: alias.id, ownerId: OWNER, ownerAskId: alias.ownerAskId, scope: 'local',
    askGeneration: { question: alias.question, options: alias.options, session: alias.session } });
  await act(async () => local.resolve({ asks: [historical] })); expect(document.querySelector('.nc-ask-badge')).toBeNull();
  await emit({ type: 'ask', ask: { ...historical, question: 'A different new question' } });
  fireEvent.click(await screen.findByTitle((_title, element) => element.className === 'nc-ask-badge'));
  expect(screen.getByText('A different new question')).toBeTruthy();
});
