import { renderHook, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The authority of the live source: what an answer may say, and to whom what
// was published still belongs. Two properties, both about WHO is speaking and
// FOR WHOM the value held by the hook is valid:
//  - an answer is bound to the owner the selection expects: the answer declares
//    its own instance (envelope and nodes) and a mismatch, or no declaration,
//    is "unknown" (null), never an authoritative list;
//  - a published outcome is bound to the key that produced it (owner, node,
//    route, credential) and to its sequence: after the key changes it is not
//    handed to the consumer, and an error advances the order like a success.

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api.js', () => ({ getVlNodes: mocks.get }));

import { VL_LIVE_POLL_MS, useVlNodeLive } from './useVlNodeLive.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const NODE = 'c'.repeat(32);
const NODE2 = 'd'.repeat(32);

const sel = (extra = {}) => ({ nodeId: NODE, ownerInstanceId: A, route: ['r1'], ...extra });
const answer = (owner, generation, nodeId = NODE, node = {}) => ({
  instanceId: owner,
  protocol: 'vl-node/1',
  nodes: [{
    nodeId, instanceId: owner, id: `${owner}:VL-${nodeId}`, online: true, lastSeen: Date.now(), generation, ...node,
  }],
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('useVlNodeLive — the authority of the source', () => {
  beforeEach(() => mocks.get.mockReset());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  // ── binding of the answer to the expected owner ──────────────────────────
  it('control: the source that declares the expected owner attests the node', async () => {
    mocks.get.mockResolvedValue(answer(A, 2));
    const h = renderHook(() => useVlNodeLive('t', sel(), true));
    await act(async () => {});
    expect(h.result.current, 'the right source answered: the peer is there').not.toBeNull();
    expect(h.result.current.trovato).toBe(true);
    expect(h.result.current.peer.ownerInstanceId).toBe(A);
  });

  it('an answer whose envelope declares another owner is not an absence', async () => {
    mocks.get.mockResolvedValue({ instanceId: B, protocol: 'vl-node/1', nodes: [] });
    const h = renderHook(() => useVlNodeLive('t', sel(), true));
    await act(async () => {});
    expect(h.result.current,
      'another owner answered with no nodes: that is not "the node is gone" for owner A').toBeNull();
  });

  it('an envelope of the expected owner over a node of another owner is not attested', async () => {
    mocks.get.mockResolvedValue({ ...answer(A, 2), nodes: answer(B, 2).nodes });
    const h = renderHook(() => useVlNodeLive('t', sel(), true));
    await act(async () => {});
    expect(h.result.current, 'the node declares another owner: the answer is not bound').toBeNull();
  });

  it('an answer that declares no owner cannot be attested', async () => {
    const { instanceId: _gone, ...bare } = answer(A, 2);
    mocks.get.mockResolvedValue(bare);
    const h = renderHook(() => useVlNodeLive('t', sel(), true));
    await act(async () => {});
    expect(h.result.current, 'no declared identity: unknown, not an authoritative list').toBeNull();
  });

  it('a selection with no owner cannot be attested by anyone', async () => {
    mocks.get.mockResolvedValue(answer(A, 2));
    const h = renderHook(() => useVlNodeLive('t', sel({ ownerInstanceId: null }), true));
    await act(async () => {});
    expect(h.result.current, 'nothing to bind the answer to: unknown').toBeNull();
  });

  // ── a published outcome belongs to the key that produced it ──────────────
  const changes = [
    ['owner', sel({ ownerInstanceId: B }), 't'],
    ['node', sel({ nodeId: NODE2 }), 't'],
    ['route', sel({ route: ['r2'] }), 't'],
    ['credential', sel(), 'other-token'],
  ];

  it.each(changes)('after a %s change the outcome published for the old key is not handed over', async (_name, next, nextToken) => {
    const first = deferred();
    const second = deferred();
    mocks.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const h = renderHook(({ s, token }) => useVlNodeLive(token, s, true), { initialProps: { s: sel(), token: 't' } });
    await act(async () => first.resolve(answer(A, 1)));
    expect(h.result.current?.peer?.ownerInstanceId, 'precondition: the old key published').toBe(A);
    h.rerender({ s: next, token: nextToken });
    expect(h.result.current,
      'the new key has not answered yet: unknown, not the outcome of the old key').toBeNull();
    // control: the new key answering gets its own value
    await act(async () => second.resolve(answer(next.ownerInstanceId, 2, next.nodeId)));
    expect(h.result.current?.trovato, 'positive control: the new key answers for itself').toBe(true);
    expect(h.result.current.peer.generation).toBe(2);
  });

  it('the same key re-rendered keeps what it published', async () => {
    mocks.get.mockResolvedValue(answer(A, 1));
    const h = renderHook(({ s }) => useVlNodeLive('t', s, true), { initialProps: { s: sel() } });
    await act(async () => {});
    h.rerender({ s: sel() });
    expect(h.result.current?.trovato, 'a new object with the same key is the same key').toBe(true);
  });

  // ── order: an error advances it like a success ───────────────────────────
  it('an error that is newer than a published success is not overwritten by an older success', async () => {
    vi.useFakeTimers();
    const older = deferred();
    const newer = deferred();
    mocks.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const h = renderHook(() => useVlNodeLive('t', sel(), true));
    await act(async () => vi.advanceTimersByTime(VL_LIVE_POLL_MS));
    await act(async () => newer.reject(new Error('down')));
    await act(async () => older.resolve(answer(A, 1)));
    expect(h.result.current, 'the newest word was "I do not know"').toBeNull();
  });

  it('a success newer than an older error stands (control for the order)', async () => {
    vi.useFakeTimers();
    const older = deferred();
    const newer = deferred();
    mocks.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const h = renderHook(() => useVlNodeLive('t', sel(), true));
    await act(async () => vi.advanceTimersByTime(VL_LIVE_POLL_MS));
    await act(async () => newer.resolve(answer(A, 2)));
    await act(async () => older.reject(new Error('late failure')));
    expect(h.result.current?.trovato, 'a late old error does not cancel a newer success').toBe(true);
    expect(h.result.current.peer.generation).toBe(2);
  });

  it('an answer that cannot be bound advances the order too', async () => {
    vi.useFakeTimers();
    const older = deferred();
    const newer = deferred();
    mocks.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const h = renderHook(() => useVlNodeLive('t', sel(), true));
    await act(async () => vi.advanceTimersByTime(VL_LIVE_POLL_MS));
    await act(async () => newer.resolve(answer(B, 2)));
    await act(async () => older.resolve(answer(A, 1)));
    expect(h.result.current, 'the newest answer came from another source: older cannot restore').toBeNull();
  });
});
