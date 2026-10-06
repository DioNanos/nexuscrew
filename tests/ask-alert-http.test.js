'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodes = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const headers = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
async function boot(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-owner-access-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    ...extra, filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: false, sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  runtime.server.prependListener('request', (req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/federation/route/') || !req.url.endsWith('/asks')) return;
    const entry = { url: `http://127.0.0.1:${runtime.server.address().port}${req.url}` };
    const end = res.end; res.end = function(chunk, ...args) {
      entry.status = res.statusCode;
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) { try { entry.reply = JSON.parse(String(chunk)); } catch (_) {} }
      return end.call(this, chunk, ...args);
    };
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { entry.body = JSON.parse(Buffer.concat(chunks).toString()); observed.push(entry); });
  });
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { ...runtime, nodesPath, port: runtime.server.address().port, id: nodes.loadStoreStrict(nodesPath).nodeId };
}

let observed = [];
const access = require('../lib/nodes/access-presets.js');
function pair(local, remote, name, preset = 'admin') {
  let st = nodes.addNode(nodes.loadStoreStrict(local.nodesPath), { name, nodeId: remote.id, direction: 'outbound', token: 'paired-admin-fixture', acceptToken: 'paired-admin-fixture',
    localPort: remote.port, remotePort: 41999, shared: true, visibility: 'network', ssh: 'demo@example.invalid' });
  if (preset !== 'legacy') st = nodes.setPeerAccessPreset(st, name, preset === 'custom' ? 'admin' : preset);
  if (preset === 'custom') st = nodes.updateNode(st, name, { liveHostAccess: false, filesReadAccess: false });
  nodes.atomicWriteStore(local.nodesPath, st);
  const view = access.grantsOf(st.nodes.find(p => p.name === name));
  assert.equal(view.label, preset === 'legacy' ? 'unconfigured' : preset);
}
function observe() { observed = []; return observed; }
async function until(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail(message);
}
async function sse(t, node) {
  const ctrl = new AbortController(); const frames = [];
  const response = await fetch(`http://127.0.0.1:${node.port}/api/events`, { headers: headers(node.token), signal: ctrl.signal });
  assert.equal(response.status, 200); const reader = response.body.getReader();
  const finished = (async () => {
    let buffer = ''; const decoder = new TextDecoder();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value); let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) { const part = buffer.slice(0, end); buffer = buffer.slice(end + 2); const line = part.split('\n').find(s => s.startsWith('data: ')); if (line) frames.push(JSON.parse(line.slice(6))); }
    } } catch (_) { /* owned stream aborted during cleanup */ }
  })();
  t.after(async () => { ctrl.abort(); await finished; }); return frames;
}
for (const feedFirst of [false, true]) test(`real fan-out and owner feed alert once while both ASK frames reach SSE (${feedFirst ? 'feed first' : 'fan-out first'})`, async t => {
  const pushed = [];
  const webpushImpl = { generateVAPIDKeys: () => ({ publicKey: 'pub-test', privateKey: 'priv-test' }), sendNotification: async (_sub, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; } };
  const origin = await boot(t, { eventFeedClientPollMs: 50 });
  const remote = await boot(t, { eventFeedClientPollMs: 50, webpushImpl, pushLookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] });
  pair(origin, remote, 'remote', feedFirst ? 'user' : 'admin'); pair(remote, origin, 'origin');
  nodes.atomicWriteStore(origin.nodesPath, nodes.updateNode(nodes.loadStoreStrict(origin.nodesPath), 'remote', { direction: 'inbound', transport: 'inbound' }));
  nodes.atomicWriteStore(remote.nodesPath, nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath), 'origin', { eventsReceive: true }));
  await until(async () => { const state = await fetch(`http://127.0.0.1:${remote.port}/api/feed-state`, { headers: headers(remote.token) }).then(r => r.json()); return state.views.some(v => v.ownerId === origin.id && v.stale === false); }, 'authoritative owner view must be live');
  const subscribed = await fetch(`http://127.0.0.1:${remote.port}/api/push/subscribe`, { method: 'POST', headers: headers(remote.token), body: JSON.stringify({ subscription: { endpoint: 'https://push.example/a', keys: { p256dh: 'k1', auth: 'a1' } } }) });
  assert.equal(subscribed.status, 200);
  const frames = await sse(t, remote); const session = tmuxSessionForCell('reviewer');
  const created = await fetch(`http://127.0.0.1:${origin.port}/api/asks`, { method: 'POST', headers: headers(origin.token), body: JSON.stringify({ question: 'review?', options: ['yes'], session, target: remote.id }) });
  assert.equal(created.status, 201); const body = await created.json();
  await until(() => pushed.length >= 1 && frames.some(f => f.type === 'notify'), 'first ingress alerts through real notifier or imported relay');
  const asks = await fetch(`http://127.0.0.1:${origin.port}/api/asks?open=1`, { headers: headers(origin.token) }).then(r => r.json());
  const ask = asks.asks.find(a => a.id === body.id); assert.ok(ask);
  if (feedFirst) nodes.atomicWriteStore(origin.nodesPath, nodes.setPeerAccessPreset(nodes.loadStoreStrict(origin.nodesPath), 'remote', 'admin'));
  const replay = await fetch(`http://127.0.0.1:${origin.port}/api/route/remote/_/asks`, { method: 'POST', headers: headers(origin.token), body: JSON.stringify({ target: remote.id, originNode: origin.id, originCell: session, ownerNode: origin.id, askId: ask.id, ownerAskTs: ask.ts, question: ask.question, options: ask.options, session }) });
  assert.equal(replay.status, 200, await replay.text());
  await until(() => frames.filter(f => f.type === 'ask').length >= 2, 'both canonical ASK frames remain delivered despite alert suppression');
  assert.equal(pushed.length, 1, 'one push across direct and feed paths');
  assert.equal(frames.filter(f => f.type === 'notify').length, 1, 'one UI toast input across paths');
  assert.equal(pushed[0].ownerId, origin.id); assert.equal(pushed[0].askId, ask.id); assert.equal(pushed[0].ownerAskTs, ask.ts);
  assert.match(pushed[0].tag, /^nc:ask:[a-f0-9]{64}$/);
});

test('server adopts a historical fan-out alert from its real authoritative feed snapshot before replay', async t => {
  const pushed = [];
  const origin = await boot(t, { eventFeedClientPollMs: 50 });
  const remote = await boot(t, { eventFeedClientPollMs: 50,
    webpushImpl: { generateVAPIDKeys: () => ({ publicKey: 'pub-test', privateKey: 'priv-test' }), sendNotification: async (_s, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; } },
    pushLookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  pair(origin, remote, 'remote', 'user'); pair(remote, origin, 'origin');
  nodes.atomicWriteStore(origin.nodesPath, nodes.updateNode(nodes.loadStoreStrict(origin.nodesPath), 'remote', { direction: 'inbound', transport: 'inbound', eventsReceive: false }));
  nodes.atomicWriteStore(remote.nodesPath, nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath), 'origin', { eventsReceive: false }));
  const session = tmuxSessionForCell('reviewer');
  const created = await fetch(`http://127.0.0.1:${origin.port}/api/asks`, { method: 'POST', headers: headers(origin.token), body: JSON.stringify({ question: 'historical?', options: ['yes'], session, target: remote.id }) });
  assert.equal(created.status, 201); const { id } = await created.json();
  const listed = await fetch(`http://127.0.0.1:${origin.port}/api/asks`, { headers: headers(origin.token) }).then(r => r.json());
  const ask = listed.asks.find(a => a.id === id); assert.ok(ask);
  nodes.atomicWriteStore(origin.nodesPath, nodes.setPeerAccessPreset(nodes.loadStoreStrict(origin.nodesPath), 'remote', 'admin'));
  const subscribed = await fetch(`http://127.0.0.1:${remote.port}/api/push/subscribe`, { method: 'POST', headers: headers(remote.token), body: JSON.stringify({ subscription: { endpoint: 'https://push.example/history', keys: { p256dh: 'k1', auth: 'a1' } } }) });
  assert.equal(subscribed.status, 200);
  const send = async generation => {
    const response = await fetch(`http://127.0.0.1:${origin.port}/api/route/remote/_/asks`, { method: 'POST', headers: headers(origin.token), body: JSON.stringify({ target: remote.id, originNode: origin.id, originCell: session, ownerNode: origin.id, askId: id, question: ask.question, options: ask.options, session, ...generation }) });
    assert.equal(response.status, 200); return response.json();
  };
  await send({}); assert.equal(pushed.length, 1); assert.equal(pushed[0].ownerAskTs, undefined);
  assert.match(pushed[0].ownerAskFingerprint, /^[a-f0-9]{64}$/);
  nodes.atomicWriteStore(origin.nodesPath, nodes.updateNode(nodes.loadStoreStrict(origin.nodesPath), 'remote', { direction: 'inbound', transport: 'inbound' }));
  nodes.atomicWriteStore(remote.nodesPath, nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath), 'origin', { eventsReceive: true }));
  await until(async () => { const state = await fetch(`http://127.0.0.1:${remote.port}/api/feed-state`, { headers: headers(remote.token) }).then(r => r.json()); return state.views.some(v => v.ownerId === origin.id && !v.stale && v.asks.some(a => a.id === id)); }, 'real owner snapshot must include this ASK');
  const { canonicalAskAlert } = require('../lib/notify/ask-alert-identity.js');
  const known = canonicalAskAlert({ ownerId: origin.id, askId: id, ownerAskTs: ask.ts });
  const ledger = JSON.parse(fs.readFileSync(path.join(path.dirname(remote.nodesPath), 'ask-alerts.json')));
  assert.equal(ledger.entries[known.tag]?.push, 'delivered', 'real server callback persists adoption under the authoritative generation');
  assert.equal(ledger.entries[pushed[0].tag], undefined, 'historical record is renamed rather than duplicated');
  await send({ ownerAskTs: ask.ts });
  assert.equal(pushed.length, 1, 'server snapshot wiring must adopt the historical admission before a known-generation replay');
});

test('real imported feed stays read-only for alert admission and still distributes ASK and closure frames', async t => {
  const pushed = []; const origin = await boot(t, { eventFeedClientPollMs: 50 });
  const remote = await boot(t, { eventFeedClientPollMs: 50,
    webpushImpl: { generateVAPIDKeys: () => ({ publicKey: 'pub-test', privateKey: 'priv-test' }), sendNotification: async (_s, payload) => { pushed.push(JSON.parse(payload)); return { statusCode: 201 }; } },
    pushLookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  const subscribed = await fetch(`http://127.0.0.1:${remote.port}/api/push/subscribe`, { method: 'POST', headers: headers(remote.token), body: JSON.stringify({ subscription: { endpoint: 'https://push.example/readonly', keys: { p256dh: 'k1', auth: 'a1' } } }) });
  assert.equal(subscribed.status, 200); remote.cfg.readonlyDefault = true;
  pair(origin, remote, 'remote', 'user'); pair(remote, origin, 'origin');
  nodes.atomicWriteStore(origin.nodesPath, nodes.updateNode(nodes.loadStoreStrict(origin.nodesPath), 'remote', { direction: 'inbound', transport: 'inbound' }));
  nodes.atomicWriteStore(remote.nodesPath, nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath), 'origin', { eventsReceive: true }));
  await until(async () => { const state = await fetch(`http://127.0.0.1:${remote.port}/api/feed-state`, { headers: headers(remote.token) }).then(r => r.json()); return state.views.some(v => v.ownerId === origin.id && !v.stale); }, 'read-only feed view becomes authoritative');
  const frames = await sse(t, remote);
  const created = await fetch(`http://127.0.0.1:${origin.port}/api/asks`, { method: 'POST', headers: headers(origin.token), body: JSON.stringify({ question: 'read-only view?', session: tmuxSessionForCell('reviewer'), target: remote.id }) });
  assert.equal(created.status, 201); const { id } = await created.json();
  await until(() => frames.some(f => f.type === 'ask') && frames.some(f => f.type === 'notify'), 'ASK and notify still reach the read-only UI');
  assert.equal(pushed.length, 0, 'read-only imported notify never sends push');
  assert.equal(fs.existsSync(path.join(path.dirname(remote.nodesPath), 'ask-alerts.json')), false, 'read-only ingress creates no admission file');
  const closed = await fetch(`http://127.0.0.1:${origin.port}/api/asks/${id}`, { method: 'DELETE', headers: headers(origin.token), body: '{}' });
  assert.equal(closed.status, 200);
  await until(() => frames.some(f => f.type === 'ask-dismissed' && f.ownerAskId === id), 'closure remains delivered to read-only UI');
  assert.equal(fs.existsSync(path.join(path.dirname(remote.nodesPath), 'ask-alerts.json')), false);
});

test('real push provider failure stays visible in ASK receipts and does not undo persistence or explicit replay', async t => {
  let fail = true; const attempted = [];
  const origin = await boot(t); const remote = await boot(t, {
    webpushImpl: { generateVAPIDKeys: () => ({ publicKey: 'pub-test', privateKey: 'priv-test' }), sendNotification: async (_s, payload) => { attempted.push(JSON.parse(payload)); if (fail) throw new Error('fixture provider unavailable'); return { statusCode: 201 }; } },
    pushLookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  pair(origin, remote, 'remote'); pair(remote, origin, 'origin');
  const subscribed = await fetch(`http://127.0.0.1:${remote.port}/api/push/subscribe`, { method: 'POST', headers: headers(remote.token), body: JSON.stringify({ subscription: { endpoint: 'https://push.example/failure', keys: { p256dh: 'k1', auth: 'a1' } } }) });
  assert.equal(subscribed.status, 200); const session = tmuxSessionForCell('reviewer');
  const created = await fetch(`http://127.0.0.1:${origin.port}/api/asks`, { method: 'POST', headers: headers(origin.token), body: JSON.stringify({ question: 'provider failure?', options: ['yes'], session, target: remote.id }) });
  assert.equal(created.status, 201); const body = await created.json();
  assert.equal(body.fanout[0].status, 'delivered'); assert.equal(body.fanout[0].alertStatus, 'no-delivery');
  assert.equal(body.fanout[0].alert.push, 0); assert.equal(body.fanout[0].alert.pushAttempted, true);
  const listed = await fetch(`http://127.0.0.1:${origin.port}/api/asks?open=1`, { headers: headers(origin.token) }).then(r => r.json());
  const ask = listed.asks.find(a => a.id === body.id); assert.ok(ask); fail = false;
  const replay = await fetch(`http://127.0.0.1:${origin.port}/api/route/remote/_/asks`, { method: 'POST', headers: headers(origin.token), body: JSON.stringify({ target: remote.id, originNode: origin.id, originCell: session, ownerNode: origin.id, askId: ask.id, ownerAskTs: ask.ts, question: ask.question, options: ask.options, session }) });
  assert.equal(replay.status, 200); const receipt = await replay.json();
  assert.equal(receipt.status, 'delivered'); assert.equal(receipt.deduped, true); assert.equal(receipt.alert.push, 1);
  assert.equal(receipt.alert.pushAttempted, true); assert.equal(attempted.length, 2);
  assert.equal(attempted[1].askId, ask.id); assert.equal(attempted[1].ownerAskTs, ask.ts);
});

test('an authoritative empty feed snapshot reaches the connected browser through the real server resync wiring', async t => {
  const origin=await boot(t,{eventFeedClientPollMs:50}), remote=await boot(t,{eventFeedClientPollMs:50});
  pair(origin,remote,'remote','user');pair(remote,origin,'origin');
  nodes.atomicWriteStore(origin.nodesPath,nodes.updateNode(nodes.loadStoreStrict(origin.nodesPath),'remote',{direction:'inbound',transport:'inbound',eventsReceive:false}));
  nodes.atomicWriteStore(remote.nodesPath,nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath),'origin',{eventsReceive:false}));
  const frames=await sse(t,remote);
  nodes.atomicWriteStore(remote.nodesPath,nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath),'origin',{eventsReceive:true}));
  await until(()=>frames.some(f=>f.type==='feed-state-changed'&&f.ownerId===origin.id),'the applied empty owner snapshot must signal the connected browser');
  const state=await fetch(`http://127.0.0.1:${remote.port}/api/feed-state`,{headers:headers(remote.token)}).then(r=>r.json());
  const view=state.views.find(v=>v.ownerId===origin.id);assert.ok(view);assert.equal(view.stale,false);assert.deepEqual(view.asks,[]);
  assert.equal(frames.filter(f=>f.type==='notify').length,0,'resync is a state refresh, not a new alert');
});

for (const viaFeed of [false, true]) test(`real owner closure preserves creation generation through ${viaFeed ? 'feed' : 'fan-out'} to browser SSE`, async t => {
  const origin = await boot(t, { eventFeedClientPollMs: 50 });
  const remote = await boot(t, { eventFeedClientPollMs: 50 });
  pair(origin, remote, 'remote', viaFeed ? 'user' : 'admin'); pair(remote, origin, 'origin');
  if (viaFeed) {
    nodes.atomicWriteStore(origin.nodesPath, nodes.updateNode(nodes.loadStoreStrict(origin.nodesPath), 'remote', { direction: 'inbound', transport: 'inbound' }));
    nodes.atomicWriteStore(remote.nodesPath, nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath), 'origin', { eventsReceive: true }));
    await until(async () => {
      const state = await fetch(`http://127.0.0.1:${remote.port}/api/feed-state`, { headers: headers(remote.token) }).then(r => r.json());
      return state.views.some(v => v.ownerId === origin.id && v.stale === false);
    }, 'owner feed must be connected before creation');
  }
  const frames = await sse(t, remote);
  const response = await fetch(`http://127.0.0.1:${origin.port}/api/asks`, { method: 'POST', headers: headers(origin.token),
    body: JSON.stringify({ question: 'generation survives closure?', session: tmuxSessionForCell('reviewer'), target: remote.id }) });
  assert.equal(response.status, 201); const { id } = await response.json();
  await until(() => frames.some(f => f.type === 'ask' && (f.ask.ownerAskId || f.ask.id) === id), 'created ASK reaches browser');
  const listing = await fetch(`http://127.0.0.1:${origin.port}/api/asks?open=1`, { headers: headers(origin.token) }).then(r => r.json());
  const ask = listing.asks.find(a => a.id === id); assert.ok(ask);
  const closed = await fetch(`http://127.0.0.1:${origin.port}/api/asks/${id}`, { method: 'DELETE', headers: headers(origin.token), body: '{}' });
  assert.equal(closed.status, 200);
  await until(() => frames.some(f => f.type === 'ask-dismissed' && f.ownerAskId === id), 'owner closure reaches browser');
  const frame = frames.find(f => f.type === 'ask-dismissed' && f.ownerAskId === id);
  assert.equal(frame.ownerAskTs, ask.ts, 'closure carries ASK creation generation, never its emission time');
});

test('real direct stale generation closure cannot mutate a newer imported ASK or emit its removal', async t => {
  const origin = await boot(t); const remote = await boot(t);
  pair(origin, remote, 'remote'); pair(remote, origin, 'origin');
  const frames = await sse(t, remote);
  async function route(body) {
    return fetch(`http://127.0.0.1:${origin.port}/api/route/remote/_/asks`, { method: 'POST', headers: headers(origin.token),
      body: JSON.stringify({ target: remote.id, originNode: origin.id, originCell: tmuxSessionForCell('reviewer'), ownerNode: origin.id, askId: 'abcdef01', ...body }) });
  }
  const create = await route({ question: 'new generation?', session: tmuxSessionForCell('reviewer'), ownerAskTs: 200 });
  assert.equal(create.status, 200);
  await until(() => frames.some(f => f.type === 'ask'), 'new generation reaches browser');
  const stale = await route({ closeOutcome: 'dismissed', ownerAskTs: 100 });
  assert.equal(stale.status, 200); const receipt = await stale.json();
  assert.equal(receipt.status, 'delivered', 'old peer receipt contract is retained');
  assert.equal(receipt.closed, false, 'stale generation is an idempotent non-closure');
  const list = await fetch(`http://127.0.0.1:${remote.port}/api/asks?open=1`, { headers: headers(remote.token) }).then(r => r.json());
  assert.ok(list.asks.some(a => a.ownerAskId === 'abcdef01' && a.ownerAskTs === 200), 'new generation remains open durably');
  assert.equal(frames.filter(f => f.type === 'ask-dismissed').length, 0, 'stale closure cannot remove browser card');
  const legacy = await route({ closeOutcome: 'dismissed' });
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).closed, true, 'legacy unknown closure remains accepted');
});

test('real owner queued closure preserves generation after its peer returns',async t=>{
 observe();const origin=await boot(t),remote=await boot(t);pair(origin,remote,'remote');pair(remote,origin,'origin');
 const created=await fetch(`http://127.0.0.1:${origin.port}/api/asks`,{method:'POST',headers:headers(origin.token),body:JSON.stringify({question:'retry generation?',session:tmuxSessionForCell('reviewer'),target:remote.id})});
 assert.equal(created.status,201);const {id}=await created.json();
 const listing=await fetch(`http://127.0.0.1:${origin.port}/api/asks?open=1`,{headers:headers(origin.token)}).then(r=>r.json());const ask=listing.asks.find(a=>a.id===id);assert.ok(ask);
 remote.server.closeAllConnections();await new Promise(resolve=>remote.server.close(resolve));
 const closed=await fetch(`http://127.0.0.1:${origin.port}/api/asks/${id}`,{method:'DELETE',headers:headers(origin.token),body:'{}'});assert.equal(closed.status,200);
 await new Promise(resolve=>remote.server.listen(remote.port,'127.0.0.1',resolve));
 const frames=await sse(t,remote);
 await fetch(`http://127.0.0.1:${origin.port}/api/asks?open=1`,{headers:headers(origin.token)});
 await until(()=>frames.some(f=>f.type==='ask-dismissed'&&f.ownerAskId===id),'queued closure reaches returned peer');
 assert.equal(frames.find(f=>f.type==='ask-dismissed'&&f.ownerAskId===id).ownerAskTs,ask.ts,'server retry wiring retains original generation');
 const delivery=observed.find(e=>e.body.askId===id&&e.body.closeOutcome==='dismissed'&&e.status===200);assert.ok(delivery);
 assert.equal(delivery.body.ownerAskTs,ask.ts,'the actual retried HTTP body carries the original generation');
});

test('a local owner closure carries creation generation in its real browser SSE frame',async t=>{
 const node=await boot(t);const frames=await sse(t,node);
 const response=await fetch(`http://127.0.0.1:${node.port}/api/asks`,{method:'POST',headers:headers(node.token),body:JSON.stringify({question:'local generation?',session:tmuxSessionForCell('reviewer')})});assert.equal(response.status,201);const {id}=await response.json();
 const listing=await fetch(`http://127.0.0.1:${node.port}/api/asks?open=1`,{headers:headers(node.token)}).then(r=>r.json());const ask=listing.asks.find(a=>a.id===id);assert.ok(ask);
 const closed=await fetch(`http://127.0.0.1:${node.port}/api/asks/${id}`,{method:'DELETE',headers:headers(node.token),body:'{}'});assert.equal(closed.status,200);
 await until(()=>frames.some(f=>f.type==='ask-dismissed'&&f.id===id),'local closure reaches browser');
 assert.equal(frames.find(f=>f.type==='ask-dismissed'&&f.id===id).ownerAskTs,ask.ts,'local closure identifies its creation generation');
});
test('a real fan-out ASK is retained in the exported owner view before any new owner snapshot', async t => {
 const origin=await boot(t,{eventFeedClientPollMs:50}), remote=await boot(t,{eventFeedClientPollMs:50});
 pair(origin,remote,'remote');pair(remote,origin,'origin');
 nodes.atomicWriteStore(origin.nodesPath,nodes.updateNode(nodes.loadStoreStrict(origin.nodesPath),'remote',{direction:'inbound',transport:'inbound'}));
 nodes.atomicWriteStore(remote.nodesPath,nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath),'origin',{eventsReceive:true}));
 const read=async()=>fetch(`http://127.0.0.1:${remote.port}/api/feed-state`,{headers:headers(remote.token)}).then(r=>r.json());
 await until(async()=> (await read()).views.some(v=>v.ownerId===origin.id && !v.stale),'initial owner snapshot is healthy');
 const frames=await sse(t,remote);
 const response=await fetch(`http://127.0.0.1:${origin.port}/api/route/remote/_/asks`,{method:'POST',headers:headers(origin.token),body:JSON.stringify({target:remote.id,originNode:origin.id,originCell:tmuxSessionForCell('reviewer'),ownerNode:origin.id,askId:'abcdef01',ownerAskTs:100,question:'Fan-out survives cached read',session:tmuxSessionForCell('reviewer')})});
 assert.equal(response.status,200);
 await until(()=>frames.some(f=>f.type==='ask'),'authenticated fan-out reaches browser SSE');
 const view=(await read()).views.find(v=>v.ownerId===origin.id);
 assert.ok(view.asks.some(a=>(a.ownerAskId||a.id)==='abcdef01' && a.ownerAskTs===100),'cached owner view must retain a received live ASK');
 assert.equal(view.stale,false);assert.equal(view.cursor,'1:0','fan-out does not invent an owner feed cursor');
});
