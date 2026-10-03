import React, { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
const api = vi.hoisted(() => ({ getNodes: vi.fn(), getTopology: vi.fn(), getNodeAliases: vi.fn(), getRouteSessions: vi.fn(), fleetStatus: vi.fn(), getVlNodes: vi.fn(), getRouteConfig: vi.fn(), apiFetch: vi.fn(), getDecks: vi.fn(), getRouteTopology: vi.fn(), createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(), saveDeckKeepalive: vi.fn(), ROSTER_READ_TIMEOUT_MS: 8000 }));
vi.mock('../lib/api.js', () => api);
import { useNodes } from './useNodes.js';
import { useDecks } from './useDecks.js';
import { loadLastRoster } from '../lib/last-roster.js';
import { emptyLayout } from '../lib/grid-model.js';
const local = 'a'.repeat(32), owner = 'b'.repeat(32);
const direct = { name: 'peer', nodeId: owner, paired: true, tunnel: { status: 'up' } };
const transit = { name: 'leaf', instanceId: owner, route: ['hop', 'leaf'], label: 'Leaf' };
const session = (name) => ({ sessions: [{ name }] });
const roster = { available: true, cells: [{ cell: 'Worker', tmuxSession: 'cloud-Worker', tmux: true }] };
const deferreds = [];
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); promise.catch(() => {}); const d = { promise, resolve, reject }; deferreds.push(d); return d; }
const flush = async () => { await act(async () => { for (let i=0;i<30;i++) await Promise.resolve(); }); };
const tick = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const group = (r) => r.current.find(g => g.instanceId === owner);
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); localStorage.clear();
  api.getNodes.mockResolvedValue({ nodes: [direct] }); api.getTopology.mockResolvedValue({ nodes: [] });
  api.getRouteConfig.mockResolvedValue({ instanceId: local });
  api.apiFetch.mockImplementation(async () => ({ json: async () => await api.getRouteConfig() }));
  api.getNodeAliases.mockResolvedValue({ aliasesByInstanceId: {} }); api.getVlNodes.mockResolvedValue({ nodes: [] });
  api.getRouteSessions.mockResolvedValue(session('old')); api.fleetStatus.mockResolvedValue(roster);
  api.getRouteTopology.mockResolvedValue({ nodes: [] });
  api.getDecks.mockResolvedValue({ decks: [{ name: 'main', revision: 1, layout: emptyLayout() }] });
});
afterEach(() => { cleanup(); for (const d of deferreds.splice(0)) d.resolve({nodes:[],sessions:[],available:true,cells:[]}); vi.useRealTimers(); });
it('direct discovery publishes reads before topology settles and after its failure', async () => {
  const slow = deferred(); api.getTopology.mockReturnValue(slow.promise);
  const r = renderHook(() => useNodes('token')); await flush();
  expect(group(r.result)?.sessions.map(s=>s.name)).toEqual(['old']);
  slow.reject(new Error('topology unavailable')); await flush();
  expect(group(r.result).status).toBe('up');
});
it('transitive discovery publishes despite failed direct discovery', async () => {
  api.getNodes.mockRejectedValue(new Error('nodes unavailable')); api.getTopology.mockResolvedValue({ nodes: [transit] });
  const r=renderHook(() => useNodes('token')); await flush();
  expect(api.getRouteSessions).toHaveBeenCalledWith('token', transit.route, expect.any(Object));
  expect(group(r.result)?.sessions.map(s=>s.name)).toEqual(['old']);
});
it('pending topology keeps a known owner current without starting absence grace', async () => {
  api.getNodes.mockResolvedValue({nodes: []}); api.getTopology.mockResolvedValue({nodes: [transit]});
  const r=renderHook(()=>useNodes('token')); await flush();
  const slow=deferred(); api.getTopology.mockReturnValue(slow.promise); await tick(4000);
  expect(group(r.result)).toMatchObject({status:'up', stale:false, checking:true});
  expect(JSON.parse(localStorage.getItem('nc-sticky-owners-v1')).topology[0].stale).not.toBe(true);
  slow.resolve({nodes:[transit]}); await flush();
});
it('refresh retains only the pending source and its original verification time', async () => {
  const r=renderHook(()=>useNodes('token')); await flush(); const at=group(r.result).verifiedAt;
  const sessions=deferred(), fleet=deferred(); api.getRouteSessions.mockReturnValue(sessions.promise); api.fleetStatus.mockReturnValue(fleet.promise);
  await tick(4000);
  expect(group(r.result)).toMatchObject({status:'up', checking:true, verifiedAt:at});
  expect(group(r.result).sessions.map(s=>s.name)).toEqual(['old']);
  fleet.resolve({available:false,reason:'disabled'}); await flush();
  expect(group(r.result).cells).toEqual([]); expect(group(r.result).fleetState).toBe('disabled');
  expect(group(r.result).verifiedAt).toBe(at);
  sessions.resolve(session('new')); await flush(); expect(group(r.result).sessions.map(s=>s.name)).toEqual(['new']);
});
it('available empty fleet replaces cached cells before pending sessions complete', async () => {
  const r=renderHook(()=>useNodes('token')); await flush();
  const slow=deferred(); api.getRouteSessions.mockReturnValue(slow.promise); api.fleetStatus.mockResolvedValue({available:true,cells:[]});
  await tick(4000); expect(group(r.result)).toMatchObject({checking:true,fleetState:'available',cells:[]});
  expect(group(r.result).sessions.map(s=>s.name)).toEqual(['old']); slow.resolve(session('new')); await flush();
});
it('new route is pending before results, then fresh fleet is visible before sessions', async () => {
  const sessions=deferred(), fleet=deferred(); api.getRouteSessions.mockReturnValue(sessions.promise); api.fleetStatus.mockReturnValue(fleet.promise);
  const r=renderHook(()=>useNodes('token')); await flush();
  expect(group(r.result)).toMatchObject({status:'pending',checking:true}); expect(group(r.result).downSince ?? null).toBeNull();
  fleet.resolve(roster); await flush(); expect(group(r.result).cells.map(c=>c.cell)).toEqual(['Worker']);
  sessions.resolve(session('new')); await flush(); expect(group(r.result).sessions.map(s=>s.name)).toEqual(['new']);
});
it('fresh sessions are visible while fleet retains its previous roster', async () => {
  const r=renderHook(()=>useNodes('token')); await flush();
  const slow=deferred(); api.fleetStatus.mockReturnValue(slow.promise); api.getRouteSessions.mockResolvedValue(session('new'));
  await tick(4000); expect(group(r.result).sessions.map(s=>s.name)).toEqual(['new']);
  expect(group(r.result).cells.map(c=>c.cell)).toEqual(['Worker']); expect(group(r.result).checking).toBe(true);
  slow.reject(new Error('HTTP 502')); await flush(); expect(group(r.result).fleetState).toBe('stale');
});
it('token and local identity changes cannot reuse the previous group before config validation', async () => {
  const r=renderHook(({token})=>useNodes(token),{initialProps:{token:'old-token'}}); await flush();
  const config=deferred(), sessions=deferred(); api.getRouteConfig.mockReturnValue(config.promise); api.getRouteSessions.mockReturnValue(sessions.promise);
  r.rerender({token:'new-token'}); await flush(); expect(r.result.current).toEqual([]);
  config.resolve({instanceId:'c'.repeat(32)}); await flush();
  expect(group(r.result).sessions).toEqual([]); expect(group(r.result).checking).toBe(true);
  sessions.resolve(session('new')); await flush(); expect(group(r.result).sessions.map(s=>s.name)).toEqual(['new']);
});
it('late discarded discovery cannot write storage or release the new round', async () => {
  const old=deferred(); api.getTopology.mockReturnValueOnce(old.promise);
  const r=renderHook(({token})=>useNodes(token),{initialProps:{token:'old-token'}}); await flush();
  const active=deferred(); api.getRouteSessions.mockReturnValue(active.promise); r.rerender({token:'new-token'}); await flush();
  const storage=localStorage.getItem('nc-sticky-owners-v1'), count=api.getNodes.mock.calls.length;
  old.resolve({nodes:[transit]}); await flush(); expect(localStorage.getItem('nc-sticky-owners-v1')).toBe(storage);
  await tick(4000); expect(api.getNodes.mock.calls.length).toBe(count);
  active.resolve(session('new')); await flush();
});
it('real node output preserves deck availability while checking, degrades on confirmed down, and reloads on return', async () => {
  const r=renderHook(()=>{
    const groups=useNodes('token'); const [layout,setLayout]=useState(emptyLayout());
    const owners=groups.filter(g=>g.instanceId).map(g=>({instanceId:g.instanceId,route:g.route,label:g.label,status:g.status,stale:g.stale,checking:g.checking}));
    const decks=useDecks('token','main',layout,setLayout,owners); return {groups,decks};
  }); await tick(500);
  const remote=()=>r.result.current.decks.records.filter(d=>!d.local);
  expect(remote().length).toBe(1); expect(remote()[0].available).toBe(true);
  const slow=deferred(), slowFleet=deferred(); api.getRouteSessions.mockReturnValue(slow.promise); api.fleetStatus.mockReturnValue(slowFleet.promise);
  await tick(3500);
  await tick(2000);
  expect(remote()[0].available).toBe(true); expect(remote()[0].stale === true).toBe(false);
  expect(r.result.current.groups[0].checking).toBe(true);
  slow.resolve(session('old')); slowFleet.resolve(roster); await flush(); api.getNodes.mockResolvedValue({nodes:[{...direct,tunnel:{status:'down'}}]});
  await tick(2000); expect(r.result.current.groups[0].status).toBe('down');
  await tick(3000); expect(remote()[0].available).toBe(false);
  const before=api.getDecks.mock.calls.filter(([,route])=>route?.length).length;
  api.getNodes.mockResolvedValue({nodes:[direct]}); api.getRouteSessions.mockResolvedValue(session('back'));
  await tick(4000); expect(remote()[0].available).toBe(true);
  expect(api.getDecks.mock.calls.filter(([,route])=>route?.length).length).toBeGreaterThan(before);
});

it('replacing a remote identity on the same route cannot inherit previous sessions or roster', async () => {
  const r=renderHook(()=>useNodes('token')); await flush();
  api.getNodes.mockResolvedValue({nodes:[{...direct,nodeId:'d'.repeat(32)}]});
  const slow=deferred(); api.getRouteSessions.mockReturnValue(slow.promise); api.fleetStatus.mockRejectedValue(new Error('HTTP 502'));
  await tick(4000); const next=r.result.current.find(g=>g.instanceId==='d'.repeat(32));
  expect(next).toBeTruthy(); expect(next.sessions).toEqual([]); expect(next.cells).toEqual([]);
  slow.resolve(session('replacement')); await flush();
});

it('late session, fleet and VL outcomes cannot alter the new identity or free its occupied guard',async()=>{
  const oldSessions=deferred(),oldFleet=deferred(),oldVl=deferred(),active=deferred();
  api.getRouteSessions.mockReturnValueOnce(oldSessions.promise).mockReturnValue(active.promise);
  api.fleetStatus.mockReturnValueOnce(oldFleet.promise).mockResolvedValue({available:true,cells:[]});
  api.getVlNodes.mockReturnValueOnce(oldVl.promise).mockResolvedValue({nodes:[]});
  const r=renderHook(({token})=>useNodes(token),{initialProps:{token:'old'}}); await flush();
  api.getNodes.mockResolvedValue({nodes:[{...direct,nodeId:'d'.repeat(32)}]});
  r.rerender({token:'new'}); await flush(); const snapshot=localStorage.getItem('nc-sticky-owners-v1');
  oldSessions.reject(Object.assign(new Error('HTTP 502'),{status:502}));
  oldFleet.resolve(roster); oldVl.resolve({nodes:[{nodeId:'old-device',label:'Old device',online:true}]}); await flush();
  expect(localStorage.getItem('nc-sticky-owners-v1')).toBe(snapshot);
  expect(loadLastRoster(`id:${owner}`)).toEqual([]); expect(JSON.stringify(r.result.current)).not.toContain('Old device');
  expect(r.result.current[0]).toMatchObject({instanceId:'d'.repeat(32),sessions:[],cells:[],checking:true});
  const calls=api.getRouteSessions.mock.calls.length; await tick(4000); expect(api.getRouteSessions).toHaveBeenCalledTimes(calls);
  active.resolve(session('new')); await flush(); await tick(4000); expect(api.getRouteSessions).toHaveBeenCalledTimes(calls+1);
});
it('checking never makes an unverified remote deck available',async()=>{
  const pending=deferred(); api.getRouteSessions.mockReturnValue(pending.promise); api.fleetStatus.mockResolvedValue(roster);
  const r=renderHook(()=>{const groups=useNodes('token');const [layout,setLayout]=useState(emptyLayout());
    const owners=groups.map(g=>({instanceId:g.instanceId,route:g.route,status:g.status,checking:g.checking}));
    return useDecks('token','main',layout,setLayout,owners);
  }); await tick(500);
  expect(r.result.current.records.filter(d=>!d.local && d.available)).toEqual([]);
  expect(api.getDecks.mock.calls.filter(([,route])=>route?.length)).toEqual([]);
  pending.resolve(session('verified')); await flush(); await tick(0);
  expect(r.result.current.records.some(d=>!d.local && d.available)).toBe(true);
});
