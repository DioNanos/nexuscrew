import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  relayAskAnswer: vi.fn(),
  onFrame: null,
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

vi.mock('../lib/events.js', () => ({connectEvents: (_token, cb) => { mocks.onFrame=cb; return () => {}; }}));
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


it('audit SSE incoming same ID from two owners keeps BOTH cards', async () => {
 await renderCenter();
 act(()=>mocks.onFrame({type:'ask',ownerId:other,ask:remoteAsk({ownerId:other})}));
 expect(screen.getAllByText(/procedo\?/i)).toHaveLength(2);
});
it('audit SSE closure removes only its owner card', async () => {
 mocks.getAsks.mockResolvedValue({asks:[remoteAsk(),remoteAsk({ownerId:other})]});
 await renderCenter();
 act(()=>mocks.onFrame({type:'ask-answered',id:'abc12345',ownerId:owner}));
 expect(screen.queryAllByText(/procedo\?/i)).toHaveLength(1);
});
it('audit imported snapshot asks are restored on reload', async () => {
 mocks.getAsks.mockResolvedValue({asks:[]});
 mocks.getFeedState.mockResolvedValue({views:[{ownerId:owner,askReplyAccess:true,asks:[remoteAsk()]}]});
 render(<NotifyCenter token="token"/>);
 await waitFor(()=>expect(mocks.getFeedState).toHaveBeenCalled());
 await act(async()=>{});
 expect(document.querySelector('.nc-ask-badge')).not.toBeNull();
});
