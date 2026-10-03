import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';

// Il pannello impostazioni non deve far pagare la lista dei peer alle fonti
// lente: settings e peer partono in parallelo, i peer si pubblicano al loro
// arrivo, e l'arricchimento VL (4 s per owner) resta un arricchimento. La
// guardia di refresh non avvia un secondo giro mentre uno e' in volo.
const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getPeers: vi.fn(),
  getTopology: vi.fn(),
  getVlNodes: vi.fn(),
  apiFetch: vi.fn(),
  getRouteConfig: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: mocks.getSettings,
  getPeers: mocks.getPeers,
  getTopology: mocks.getTopology,
  getVlNodes: mocks.getVlNodes,
  apiFetch: mocks.apiFetch,
  getRouteConfig: mocks.getRouteConfig,
}));
vi.mock('./NodeSheet.jsx', () => ({default: ({refresh,node}) => <><button onClick={refresh}>Refresh owner</button><pre data-testid="device-state">{JSON.stringify(node)}</pre></>}));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => [] }));

import SettingsPanel from './SettingsPanel.jsx';

const pendingResolvers = [];
const flushMicrotask = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  vi.clearAllMocks();
  // Config locale per la scoperta VL: solo l'owner locale (nessun federato).
  mocks.apiFetch.mockImplementation((_path, _token) => Promise.resolve({
    ok: true, status: 200, json: async () => ({ instanceId: 'local-instance', readonlyDefault: false }),
  }));
  mocks.getRouteConfig.mockResolvedValue({ instanceId: 'local-instance' });
  mocks.getTopology.mockResolvedValue({ nodes: [] });
  mocks.getSettings.mockResolvedValue({
    version: '0.9.55', platform: 'linux', port: 41820,
    service: { installed: true, active: true, boot: true }, autoUpdate: true, alternateScreen: false,
  });
  mocks.getPeers.mockResolvedValue({
    peers: [{ name: 'peer-a', label: 'Peer A', host: 'a', kind: 'direct' }],
    accessRevision: 7,
  });
});

afterEach(() => {
  cleanup();
  for (const resolve of pendingResolvers.splice(0)) resolve({nodes:[],peers:[]});
  vi.useRealTimers();
});

const renderPanel = () => render(
  <SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />,
);

describe('lista nodi: i peer non aspettano le fonti lente', () => {
  it('un owner VL che non risponde non trattiene la pubblicazione dei peer', async () => {
    // Owner VL appeso: la promessa non si risolve (il tetto di 4 s del fix
    // la chiuderebbe, ma la prova qui e' che i peer esistono GIA' prima).
    let rilasciaVl;
    mocks.getVlNodes.mockImplementation(() => new Promise((resolve) => { rilasciaVl = resolve; pendingResolvers.push(resolve); }));
    renderPanel();
    await act(async () => { await flushMicrotask(); });
    // I peer sono pubblicati AL LORO ARRIVO, senza attendere il VL.
    expect(screen.getByText('Peer A')).toBeTruthy();
    // E il VL e' ancora pendente: nessun avanzamento di tempo o rilascio.
    expect(typeof rilasciaVl).toBe('function');
    rilasciaVl({ nodes: [] });
    await act(async () => { await flushMicrotask(); });
    expect(screen.getByText('Peer A')).toBeTruthy();
  });

  it('getPeers parte in parallelo a getSettings: settings appesa non blocca i peer', async () => {
    let rilasciaSettings;
    mocks.getSettings.mockImplementation(() => new Promise((resolve) => { rilasciaSettings = resolve; pendingResolvers.push(resolve); }));
    mocks.getVlNodes.mockResolvedValue({ nodes: [] });
    renderPanel();
    await act(async () => { await flushMicrotask(); });
    // I peer sono pubblicati anche con settings ancora pendente.
    expect(screen.getByText('Peer A')).toBeTruthy();
    rilasciaSettings({
      version: '0.9.55', platform: 'linux', port: 41820,
      service: { installed: true, active: true, boot: true }, autoUpdate: true, alternateScreen: false,
    });
    await act(async () => { await flushMicrotask(); });
    expect(screen.getByText('Peer A')).toBeTruthy();
  });

  it('la guardia di refresh: un tick su un giro occupato non apre un secondo giro', async () => {
    vi.useFakeTimers();
    let rilasciaVl;
    mocks.getVlNodes.mockImplementation(() => new Promise((resolve) => { rilasciaVl = resolve; pendingResolvers.push(resolve); }));
    renderPanel();
    // Flusso del primo giro (appeso sul VL).
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const chiamateAlPrimoGiro = mocks.getPeers.mock.calls.length;
    expect(chiamateAlPrimoGiro).toBeGreaterThan(0);
    // Tick del poll a 5 s con il giro ancora in volo: nessun secondo giro.
    await act(async () => { vi.advanceTimersByTime(5000); await flushMicrotask(); });
    expect(mocks.getPeers.mock.calls.length).toBe(chiamateAlPrimoGiro);
    // Chiusura del giro (tutte le letture terminano): il tick successivo riparte.
    rilasciaVl({ nodes: [] });
    await act(async () => { await flushMicrotask(); });
    await act(async () => { vi.advanceTimersByTime(5000); await flushMicrotask(); });
    expect(mocks.getPeers.mock.calls.length).toBeGreaterThan(chiamateAlPrimoGiro);
  });
});

 it('settings and peers retain the round guard and cleanup controller after enrichment completes', async () => {
  vi.useFakeTimers();
  const pending = [];
  for (const method of ['getSettings','getPeers']) mocks[method].mockImplementation((_token,opts)=>new Promise((resolve,reject)=>{
    pending.push({resolve,signal:opts.signal}); opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});
  }));
  mocks.getVlNodes.mockResolvedValue({nodes:[]});
  const view=renderPanel(); await act(async()=>{await flushMicrotask();});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(mocks.getPeers).toHaveBeenCalledTimes(1); expect(mocks.getSettings).toHaveBeenCalledTimes(1);
  view.unmount(); expect(pending.every(p=>p.signal.aborted)).toBe(true);
  await act(async()=>{await flushMicrotask();});
 });
 it('a fast remote VL owner is published before the slow owner finishes, with the round signal', async () => {
  mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'remote',route:['peer'],label:'Remote'}]});
  let finish, slowSignal;
  mocks.getVlNodes.mockImplementation((_token,route,opts)=>route.length
    ? Promise.resolve({nodes:[{nodeId:'device',label:'Fast device',online:true,canManage:true}]})
    : new Promise(resolve=>{finish=resolve;pendingResolvers.push(resolve);slowSignal=opts?.signal;}));
  const view=renderPanel(); await act(async()=>{await flushMicrotask();});
  expect(screen.getByText('Fast device')).toBeTruthy(); expect(screen.getByText('Peer A')).toBeTruthy();
  expect(slowSignal).toBeInstanceOf(AbortSignal); view.unmount(); expect(slowSignal.aborted).toBe(true);
  finish({nodes:[]}); await act(async()=>{await flushMicrotask();});
 });

it('manual refresh shares the occupied settings guard and the seven second completion releases it', async () => {
  vi.useFakeTimers(); let finish;
  mocks.getSettings.mockImplementation(()=>new Promise(resolve=>{finish=resolve;pendingResolvers.push(resolve);})); mocks.getVlNodes.mockResolvedValue({nodes:[]});
  const view=renderPanel(); await act(async()=>{await flushMicrotask();});
  fireEvent.click(screen.getByRole('button',{name:/Peer A —/}));
  fireEvent.click(screen.getByText('Refresh owner')); await act(async()=>{await flushMicrotask();});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(mocks.getPeers).toHaveBeenCalledTimes(1);
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000);finish({});await flushMicrotask();});
  await act(async()=>{await vi.advanceTimersByTimeAsync(3000);}); expect(mocks.getPeers).toHaveBeenCalledTimes(2);
  view.unmount(); finish({}); await act(async()=>{await flushMicrotask();});
});
it.each([403,404])('explicit VL denial %s clears previously available devices immediately', async status => {
  vi.useFakeTimers();
  mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'remote',route:['peer'],label:'Remote'}]});
  mocks.getVlNodes.mockImplementation(async(_token,route)=>({nodes:route.length?[{nodeId:'device',label:'Device',online:true,canManage:true}]:[]}));
  renderPanel(); await act(async()=>{await flushMicrotask();}); expect(screen.getByText('Device')).toBeTruthy();
  mocks.getVlNodes.mockImplementation(async()=>{throw Object.assign(new Error(`HTTP ${status}`),{status});});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);}); expect(screen.queryByText('Device')).toBeNull(); expect(screen.getByText('Peer A')).toBeTruthy();
});
it('transient VL failure preserves a visibly stale device without available management access', async()=>{
  vi.useFakeTimers(); mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'remote',route:['peer'],label:'Remote'}]});
  mocks.getVlNodes.mockImplementation(async(_token,route)=>({nodes:route.length?[{nodeId:'device',label:'Device',online:true,canManage:true,capabilities:['manage']}]:[]}));
  renderPanel(); await act(async()=>{await flushMicrotask();});
  mocks.getVlNodes.mockRejectedValue(new DOMException('timeout','TimeoutError'));
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(screen.getByText('Peer A')).toBeTruthy(); fireEvent.click(screen.getByRole('button',{name:/Device —/}));
  expect(JSON.parse(screen.getByTestId('device-state').textContent)).toMatchObject({stale:true,online:false,canManage:false,capabilities:[]});
});
it('token changes and replacement owners do not republish the previous VL cache', async()=>{
  mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'old-owner',route:['peer'],label:'Remote'}]});
  mocks.getVlNodes.mockImplementation(async(_token,route)=>({nodes:route.length?[{nodeId:'device',label:'Old device',online:true}]:[]}));
  const view=renderPanel(); await act(async()=>{await flushMicrotask();}); expect(screen.getByText('Old device')).toBeTruthy();
  mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'new-owner',route:['peer'],label:'Remote'}]});
  let finish; mocks.getVlNodes.mockImplementation(()=>new Promise(resolve=>{finish=resolve;pendingResolvers.push(resolve);}));
  view.rerender(<SettingsPanel token="replacement" onClose={vi.fn()} initialTab="nodes"/>);
  await act(async()=>{await flushMicrotask();}); expect(screen.queryByText('Old device')).toBeNull();
  view.unmount(); finish({nodes:[]}); await act(async()=>{await flushMicrotask();});
});
it('confirmed topology removal clears devices',async()=>{
  vi.useFakeTimers(); mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'remote',route:['peer'],label:'Remote'}]});
  mocks.getVlNodes.mockImplementation(async(_token,route)=>({nodes:route.length?[{nodeId:'device',label:'Device',online:true}]:[]}));
  renderPanel(); await act(async()=>{await flushMicrotask();}); expect(screen.getByText('Device')).toBeTruthy();
  mocks.getTopology.mockResolvedValue({nodes:[]}); await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(screen.queryByText('Device')).toBeNull();
});

it('a replacement owner on the same route does not inherit old devices while its VL read is pending',async()=>{
  vi.useFakeTimers(); mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'old',route:['peer'],label:'Remote'}]});
  mocks.getVlNodes.mockImplementation(async(_token,route)=>({nodes:route.length?[{nodeId:'device',label:'Old device',online:true}]:[]}));
  renderPanel(); await act(async()=>{await flushMicrotask();}); expect(screen.getByText('Old device')).toBeTruthy();
  mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'new',route:['peer'],label:'Remote'}]});
  mocks.getVlNodes.mockImplementation((_token,route)=>route.length?new Promise(resolve=>pendingResolvers.push(resolve)):Promise.resolve({nodes:[]}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);}); expect(screen.queryByText('Old device')).toBeNull();
});
it('local identity changes and missing local capability remove the old local VL devices',async()=>{
  vi.useFakeTimers(); mocks.getVlNodes.mockResolvedValue({nodes:[{nodeId:'local-device',label:'Local device',online:true}]});
  renderPanel(); await act(async()=>{await flushMicrotask();}); expect(screen.getByText('Local device')).toBeTruthy();
  mocks.getRouteConfig.mockResolvedValue({instanceId:'different-local'});
  mocks.getVlNodes.mockRejectedValue(Object.assign(new Error('HTTP 404'),{status:404}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);}); expect(screen.queryByText('Local device')).toBeNull();
});
it('failed topology preserves cached devices as stale rather than treating pending discovery as removal',async()=>{
  vi.useFakeTimers(); mocks.getTopology.mockResolvedValue({nodes:[{instanceId:'remote',route:['peer'],label:'Remote'}]});
  mocks.getVlNodes.mockImplementation(async(_token,route)=>({nodes:route.length?[{nodeId:'device',label:'Device',online:true,canManage:true}]:[]}));
  renderPanel(); await act(async()=>{await flushMicrotask();}); expect(screen.getByText('Device')).toBeTruthy();
  mocks.getTopology.mockImplementation(()=>new Promise((_resolve,reject)=>{pendingResolvers.push(()=>reject(new Error('timeout')));}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(5000);}); expect(screen.getByText('Device')).toBeTruthy();
  pendingResolvers.shift()(); await act(async()=>{await flushMicrotask();});
  fireEvent.click(screen.getByRole('button',{name:/Device —/}));
  expect(JSON.parse(screen.getByTestId('device-state').textContent)).toMatchObject({stale:true,online:false,canManage:false});
});
