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

it('a direct imported owner closure with the actual server shape removes the canonical alias', async () => {
  await mount();
  await emit({ type: 'ask-dismissed', id: alias.id, ownerId: OWNER });
  expect(screen.queryByText(alias.question)).toBeNull();
});

for (const type of ['ask-dismissed', 'ask-answered']) for (const legacy of [true, false]) it(`${type} resolves ${legacy ? 'legacy alias' : 'canonical'} identity without cross-owner removal`, async () => {
  mocks.getAsks.mockResolvedValue({ asks: [alias, { ...alias, id: 'other-alias', ownerId: OTHER, question: 'Other owner' }] });
  await mount(); await emit({ type, id: alias.id, ownerId: OWNER, ...(legacy ? {} : { ownerAskId: alias.ownerAskId }) });
  expect(screen.queryByText(alias.question)).toBeNull(); expect(screen.getByText('Other owner')).toBeTruthy();
});
it('a delayed legacy feed frame cannot invent a replacement generation after local dismissal', async () => {
  await mount(); fireEvent.click(dismissButton()); await act(async () => {});
  await emit({ type: 'ask', ask: { id: alias.ownerAskId, ownerId: OWNER, ownerAskTs: null, question: alias.question, options: alias.options, session: alias.session, ts: 999 } });
  expect(screen.queryByText(alias.question)).toBeNull();
});
