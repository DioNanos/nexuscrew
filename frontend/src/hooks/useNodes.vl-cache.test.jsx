import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Cache of the last known VL state per owner: a VL node must stay in the
// sidebar while its owner's read is in flight, failing, backed off, or the
// owner is temporarily gone from the topology — published as not-verified
// (stale) instead of blinking away. Only a confirmed read (even an empty
// one) or the owner grace may remove it. Every cache write, publication,
// backoff success and backoff failure is scoped to the CURRENT owner of
// the route: a reply from a superseded owner must not touch any of them.
//
// The scenario mirrors the federated one: a VL node owned by a remote
// owner, watched from another node. Time is driven with fake timers, like
// the backoff tests.

const LOCAL_INSTANCE = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const OWNER_INSTANCE = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const NODE_ID = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';

const OWNER_ROUTE = ['hub-example'];
const OWNER_KEY = OWNER_ROUTE.join('/');
const TOPOLOGY_WITH_OWNER = {
  nodes: [{ name: 'hub-example', instanceId: OWNER_INSTANCE, route: OWNER_ROUTE, stale: false, label: 'Hub' }],
};
const TOPOLOGY_WITHOUT_OWNER = { nodes: [] };

const VL_PAYLOAD = {
  instanceId: OWNER_INSTANCE,
  nodes: [{
    nodeId: NODE_ID,
    label: 'VL-Node-A',
    pairedAt: 1785601321838,
    online: true,
    lastSeen: 1785982674769,
    generation: 1,
    version: '0.1.0',
    capabilities: ['status', 'health'],
    health: { status: 'healthy', state: 'running', uptimeSec: 371554, rssBytes: 2097152 },
    session: { attached: true, profile: 'ollama' },
    inflight: null,
    lastAck: null,
  }],
};

const state = vi.hoisted(() => ({ vlForOwner: async () => ({ nodes: [] }) }));

vi.mock('../lib/api.js', () => ({
  ROSTER_READ_TIMEOUT_MS: 8000,
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: LOCAL_INSTANCE, version: 'test' }) })),
  getRouteConfig: vi.fn(async () => ({ instanceId: LOCAL_INSTANCE, version: 'test' })),
  getNodes: vi.fn(async () => ({ nodes: [] })),
  getTopology: vi.fn(async () => TOPOLOGY_WITH_OWNER),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(async () => ({ sessions: [] })),
  fleetStatus: vi.fn(async () => ({ available: false })),
  getVlNodes: vi.fn(async (_token, route = []) => {
    if (Array.isArray(route) && route.join('/') === OWNER_KEY) return state.vlForOwner(_token, route);
    return { nodes: [] };
  }),
}));

import { useNodes } from './useNodes.js';
import { OWNER_GRACE_MS } from './useNodes.js';
import { getRouteConfig, getTopology, getVlNodes } from '../lib/api.js';

const vlGroups = (result) => (result.current || []).filter((g) => g.kind === 'vl');
const vlLabels = (result) => vlGroups(result).map((g) => g.label);

beforeEach(() => {
  localStorage.clear();
  state.vlForOwner = async () => ({ nodes: [] });
  vi.mocked(getRouteConfig).mockResolvedValue({ instanceId: LOCAL_INSTANCE, version: 'test' });
  vi.mocked(getTopology).mockResolvedValue(TOPOLOGY_WITH_OWNER);
  vi.mocked(getVlNodes).mockClear();
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

const runFirstRound = async (hook) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return hook;
};

describe('useNodes — VL sidebar cache per owner', () => {
  it('keeps the node through intermediate publishes while the read is in flight', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    // Next round: the owner read hangs; discovery publishes first and the
    // node must stay in the sidebar, marked as not verified by this round.
    let resolveVl;
    state.vlForOwner = () => new Promise((resolve) => { resolveVl = resolve; });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(true);

    // The read lands in the same round: fresh again.
    await act(async () => { resolveVl(VL_PAYLOAD); await vi.advanceTimersByTimeAsync(0); });
    expect(vlGroups(hook.result)[0].stale).toBe(false);
  });

  it('keeps the node when its owner disappears from the topology, marked stale', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    // The owner drops out of the topology: its read is no longer started,
    // but the cached node must stay published (stale), not blink away.
    vi.mocked(getTopology).mockResolvedValue(TOPOLOGY_WITHOUT_OWNER);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(true);
  });

  it('drops the node only after the owner grace expires, not at the first absence', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    vi.mocked(getTopology).mockResolvedValue(TOPOLOGY_WITHOUT_OWNER);
    // Well within the grace: still there, still marked stale.
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(true);

    // Past the grace (10 minutes since the last confirmed read): gone.
    await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60 * 1000); });
    expect(vlLabels(hook.result)).toEqual([]);
  });

  it('keeps a stale node through read failures; a confirmed empty read removes it', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    // The read fails: cached node stays, marked stale.
    state.vlForOwner = async () => {
      const e = new Error('HTTP 502');
      e.status = 502;
      throw e;
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(true);

    // A confirmed empty read is authoritative: the node is really gone.
    state.vlForOwner = async () => ({ nodes: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual([]);
  });

  it('marks a recovered read as fresh again', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlGroups(hook.result)[0].stale).toBe(false);

    state.vlForOwner = async () => {
      const e = new Error('HTTP 502');
      e.status = 502;
      throw e;
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(true);

    state.vlForOwner = async () => VL_PAYLOAD;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(false);
  });

  it('drops the cache on a token change; the node returns only from a fresh read', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(({ token }) => useNodes(token, true), {
      initialProps: { token: 'token-a' },
    });
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    // A different token is a different session: cached peers from the old
    // token must not be republished, even while the new first read runs.
    let resolveVl;
    state.vlForOwner = () => new Promise((resolve) => { resolveVl = resolve; });
    await act(async () => { hook.rerender({ token: 'token-b' }); await vi.advanceTimersByTimeAsync(0); });
    expect(vlLabels(hook.result)).toEqual([]);

    await act(async () => { resolveVl(VL_PAYLOAD); await vi.advanceTimersByTimeAsync(0); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(false);
  });

  it('ignores a late response from a superseded round', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(({ token }) => useNodes(token, true), {
      initialProps: { token: 'token-a' },
    });
    await runFirstRound(hook);
    expect(vlGroups(hook.result)[0].stale).toBe(false);

    // Round 2 hangs; a token change supersedes it (guard reset + abort):
    // the new session drops the cache and publishes nothing until its own
    // first read lands.
    let resolveStaleRound;
    state.vlForOwner = () => new Promise((resolve) => { resolveStaleRound = resolve; });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(true);

    state.vlForOwner = async () => ({ nodes: [] });
    await act(async () => { hook.rerender({ token: 'token-b' }); await vi.advanceTimersByTimeAsync(0); });
    expect(vlLabels(hook.result)).toEqual([]);

    // The superseded round finally resolves with a payload: it must not
    // resurrect the node nor touch what the confirmed read decided.
    await act(async () => { resolveStaleRound(VL_PAYLOAD); await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual([]);
  });

  it('expires the node after the owner grace even when reads keep failing', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    // From now on every read fails (the retry cap spreads the attempts):
    // failures must not renew the grace, so once the ten minutes since the
    // last confirmed read are spent, the node goes away.
    state.vlForOwner = async () => {
      const e = new Error('HTTP 502');
      e.status = 502;
      throw e;
    };
    await act(async () => { await vi.advanceTimersByTimeAsync(9 * 60 * 1000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].stale).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60 * 1000); });
    expect(vlLabels(hook.result)).toEqual([]);
  });

  it('invalidates the cached node when a different owner takes the same route', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    // Same route, different owner instance: the cached node belongs to the
    // previous owner. While the new owner's read is in flight, nothing of
    // the old owner may be published under the new one.
    const OTHER_INSTANCE = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d';
    vi.mocked(getTopology).mockResolvedValue({
      nodes: [{ name: 'hub-example', instanceId: OTHER_INSTANCE, route: OWNER_ROUTE, stale: false, label: 'Hub2' }],
    });
    let resolveNewOwner;
    state.vlForOwner = () => new Promise((resolve) => { resolveNewOwner = resolve; });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual([]);

    // The new owner confirms an empty directory: the old node stays gone.
    await act(async () => { resolveNewOwner({ nodes: [] }); await vi.advanceTimersByTimeAsync(0); });
    expect(vlLabels(hook.result)).toEqual([]);
  });

  it('ignores an old owner reply after a replacement owner confirmed empty on the same route', async () => {
    // Round 1: the previous owner holds the route; its node is published.
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    // Round 2: the fresh topology hangs. The sticky snapshot still lists
    // the previous owner, so its read starts first; only after the fresh
    // topology hands the same route to a replacement owner does the
    // replacement's read start. Replies are controlled by call order.
    let calls = 0;
    let resolveTopology, resolveOld, resolveNew;
    vi.mocked(getTopology).mockImplementation(() => new Promise((resolve) => { resolveTopology = resolve; }));
    state.vlForOwner = () => new Promise((resolve) => {
      if (++calls === 1) { resolveOld = resolve; }
      else { resolveNew = resolve; }
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls).toBe(1);

    const REPLACEMENT_INSTANCE = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d';
    await act(async () => {
      resolveTopology({ nodes: [{ name: 'hub-example', instanceId: REPLACEMENT_INSTANCE, route: OWNER_ROUTE, stale: false, label: 'Hub' }] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(2);

    // The replacement owner confirms an empty directory.
    await act(async () => { resolveNew({ instanceId: REPLACEMENT_INSTANCE, nodes: [] }); await vi.advanceTimersByTimeAsync(0); });
    expect(vlLabels(hook.result)).toEqual([]);

    // The old owner's late reply lands in the same round: it must not
    // republish its node over the replacement owner's confirmed answer.
    await act(async () => { resolveOld(VL_PAYLOAD); await vi.advanceTimersByTimeAsync(0); });
    expect(vlLabels(hook.result)).toEqual([]);
  });

  it('keeps an explicitly stale owner without starting a new read for it', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    const readsBefore = vi.mocked(getVlNodes).mock.calls.filter((args) => args[1].join('/') === OWNER_KEY).length;

    // An owner marked stale in the topology is not polled anymore, but its
    // cached node stays published with the not-verified marker.
    vi.mocked(getTopology).mockResolvedValue({ nodes: TOPOLOGY_WITH_OWNER.nodes.map((n) => ({ ...n, stale: true })) });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);
    expect(vlGroups(hook.result)[0].fleetState).toBe('stale');
    expect(vi.mocked(getVlNodes).mock.calls.filter((args) => args[1].join('/') === OWNER_KEY).length).toBe(readsBefore);
  });

  it('drops the cached nodes when the local instance changes', async () => {
    state.vlForOwner = async () => VL_PAYLOAD;
    const hook = renderHook(() => useNodes('token', true));
    await runFirstRound(hook);
    expect(vlLabels(hook.result)).toEqual(['VL-Node-A']);

    // A different local instance is a different device: cached vl nodes
    // must not survive it (the new instance's first read is left in flight
    // and must publish nothing while pending).
    vi.mocked(getRouteConfig).mockResolvedValue({ instanceId: 'e6'.repeat(16) });
    let resolveOwner;
    state.vlForOwner = () => new Promise((resolve) => { resolveOwner = resolve; });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(vlLabels(hook.result)).toEqual([]);
    await act(async () => { resolveOwner({ nodes: [] }); await vi.advanceTimersByTimeAsync(0); });
    expect(vlLabels(hook.result)).toEqual([]);
  });

describe('replacement outcome and identity scoped errors', () => {
 for (const mode of ['success', 'error', 'error-control']) it(`old owner ${mode} cannot change the replacement result or retry schedule`, async () => {
 const error = mode !== 'success';
  state.vlForOwner = async () => VL_PAYLOAD;
  const hook = renderHook(() => useNodes('token', true)); await runFirstRound(hook);
  let resolveTopology, resolveOld, rejectOld, resolveNew, rejectNew;
  vi.mocked(getTopology).mockImplementation(() => new Promise(resolve => {resolveTopology=resolve;}));
  let calls=0;
  state.vlForOwner = () => new Promise((resolve,reject) => {if (++calls===1) {resolveOld=resolve;rejectOld=reject;} else {resolveNew=resolve;rejectNew=reject;}});
  await act(async () => {await vi.advanceTimersByTimeAsync(4000);});expect(calls).toBe(1);
  const replacement='d4'.repeat(16);
  const topology={nodes:[{name:'hub-example',instanceId:replacement,route:OWNER_ROUTE,stale:false}]};
  await act(async () => {resolveTopology(topology);await vi.advanceTimersByTimeAsync(0);});expect(calls).toBe(2);
  vi.mocked(getTopology).mockResolvedValue(topology);
  const payload={instanceId:replacement,nodes:VL_PAYLOAD.nodes.map(n=>({...n,nodeId:'e7'.repeat(16),label:'New-VL'}))};
  if (!error) {
   await act(async () => {resolveNew(payload);await vi.advanceTimersByTimeAsync(0);});expect(vlLabels(hook.result)).toEqual(['New-VL']);
   await act(async () => {resolveOld(VL_PAYLOAD);await vi.advanceTimersByTimeAsync(0);});
   console.log('AUDITOR_REPLACEMENT_NONEMPTY',JSON.stringify(vlLabels(hook.result)));
   expect(vlLabels(hook.result)).toEqual(['New-VL']);
  } else {
   await act(async () => {rejectNew(Object.assign(new Error('replacement unavailable'),{status:502}));await vi.advanceTimersByTimeAsync(0);});
   await act(async () => {if (mode === 'error') rejectOld(Object.assign(new Error('old unavailable'),{status:502})); else resolveOld(VL_PAYLOAD);await vi.advanceTimersByTimeAsync(0);});
   // Replacement failed only ONCE. Its first retry is due next poll (4s),
   // independent of the old owner's terminal error in the previous poll.
   let retryCalls=0;
   state.vlForOwner=async()=>{retryCalls++;return payload;};
   await act(async () => {await vi.advanceTimersByTimeAsync(4000);});
   const retryAtFour = retryCalls; const labelsAtFour = vlLabels(hook.result);
   await act(async () => {await vi.advanceTimersByTimeAsync(4000);});
   console.log('AUDITOR_OLD_ERROR_RETRY',JSON.stringify({mode,retryAtFour,labelsAtFour,retryAtEight:retryCalls,labelsAtEight:vlLabels(hook.result)}));
   expect(retryAtFour).toBe(1);expect(labelsAtFour).toEqual(['New-VL']);
  }
 });
});


describe('local and unknown owner routes', () => {
 it('local vl: cache is kept through failure and replaced by confirmed empty', async () => {
  vi.mocked(getTopology).mockResolvedValue({nodes:[]});
  let reads=0;let fail=false;let empty=false;
  vi.mocked(getVlNodes).mockImplementation(async (_token,route=[]) => {
   if (route.length) return {nodes:[]};reads++;
   if (fail) throw Object.assign(new Error('local down'),{status:502});
   return empty?{nodes:[]}:VL_PAYLOAD;
  });
  const h=renderHook(()=>useNodes('token',true));await runFirstRound(h);
  expect(vlLabels(h.result)).toEqual(['VL-Node-A']);expect(vlGroups(h.result)[0].peer.ownerInstanceId).toBe(LOCAL_INSTANCE);
  fail=true;await act(async()=>{await vi.advanceTimersByTimeAsync(4000);});
  expect(vlLabels(h.result)).toEqual(['VL-Node-A']);expect(vlGroups(h.result)[0].fleetState).toBe('stale');
  fail=false;empty=true;await act(async()=>{await vi.advanceTimersByTimeAsync(4000);});expect(vlLabels(h.result)).toEqual([]);expect(reads).toBe(3);
  vi.mocked(getVlNodes).mockImplementation(async (_token,route=[]) => route.join('/')===OWNER_KEY ? state.vlForOwner(_token,route):{nodes:[]});
 });
 it('temporarily unknown owner identity retains last known data as stale', async () => {
  state.vlForOwner=async()=>VL_PAYLOAD;
  const h=renderHook(()=>useNodes('token',true));await runFirstRound(h);expect(vlLabels(h.result)).toEqual(['VL-Node-A']);
  const before=vi.mocked(getVlNodes).mock.calls.filter(a=>a[1].join('/')===OWNER_KEY).length;
  vi.mocked(getTopology).mockResolvedValue({nodes:[{name:'hub-example',route:OWNER_ROUTE,stale:false}]});
  await act(async()=>{await vi.advanceTimersByTimeAsync(4000);});
  expect(vlLabels(h.result)).toEqual(['VL-Node-A']);expect(vlGroups(h.result)[0].stale).toBe(true);
  expect(vi.mocked(getVlNodes).mock.calls.filter(a=>a[1].join('/')===OWNER_KEY).length).toBe(before);
 });
});

  it('exposes the owner grace window as the same constant used for owners', async () => {
    // One grace number for owners and their VL nodes: no diverging values.
    expect(OWNER_GRACE_MS).toBe(10 * 60 * 1000);
  });
});
