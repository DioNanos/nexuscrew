'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodes = require('../lib/nodes/store.js');
const { parseDefinitions } = require('../lib/fleet/definitions.js');
const headers = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
async function boot(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-owner-access-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const fleetDefsPath = path.join(configDir, 'fleet.json');
  fs.writeFileSync(fleetDefsPath, JSON.stringify({ schemaVersion:1, engines:[{id:'fixture',label:'fixture',command:'/bin/true',args:[],env:{},promptMode:'send-keys'}], cells:extra.cells || [{id:'reviewer',engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:'lab-reviewer'}] }));
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    ...extra, fleetDefsPath, fleetSeam: { available:true, cellStatus:async()=>({available:true,cells:(parseDefinitions(fs.readFileSync(fleetDefsPath,'utf8'))?.cells||[]).map(c=>({cell:c.id,tmuxSession:c.tmuxSession,active:false}))}) }, filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: extra.fleetEnabled ?? true, tmuxBin: '/bin/true', sessionExistsSeam: () => true, pasteSeam: () => true,
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
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); runtime.watcher.close(); const fleet=await runtime.fleetP; await fleet.close?.(); fs.rmSync(home, { recursive: true, force: true }); });
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

async function askOn(owner, session) {
 const r=await fetch(`http://127.0.0.1:${owner.port}/api/asks`,{method:'POST',headers:headers(owner.token),body:JSON.stringify({question:'resolver question',options:['yes'],session})});
 assert.equal(r.status,201,await r.clone().text());return (await r.json()).id;
}
async function routed(reader,route) {
 return fetch(`http://127.0.0.1:${reader.port}/api/route/owner/_/${route}`,{headers:headers(reader.token)});
}
async function fixture(t,extra={}) {
 const owner=await boot(t,extra),reader=await boot(t);pair(owner,reader,'reader');pair(reader,owner,'owner');nodes.atomicWriteStore(owner.nodesPath,nodes.updateNode(nodes.loadStoreStrict(owner.nodesPath),'reader',{direction:'inbound',transport:'inbound'}));nodes.atomicWriteStore(reader.nodesPath,nodes.updateNode(nodes.loadStoreStrict(reader.nodesPath),'owner',{eventsReceive:false}));return {owner,reader};
}
for(const session of ['lab-reviewer','edge-reviewer']) test(`defined inactive session ${session} keeps owner capability and snapshot scope`,async t=>{
 const {owner,reader}=await fixture(t,{cells:[{id:'reviewer',engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:session}]});
 const id=await askOn(owner,session);const cap=await routed(reader,`event-feed/asks/${id}/capability`);assert.equal(cap.status,200);const body=await cap.json();assert.equal(body.status,'open');assert.equal(body.canReply,true);
 const snap=await routed(reader,'event-feed/snapshot');assert.equal(snap.status,200);assert.ok((await snap.json()).asks.some(a=>a.id===id));
});
test('undefined noncanonical session remains denied',async t=>{
 const {owner,reader}=await fixture(t);const id=await askOn(owner,'lab-Unknown');const cap=await routed(reader,`event-feed/asks/${id}/capability`);assert.equal(cap.status,200);const body=await cap.json();assert.equal(body.status,'denied');assert.equal(body.canReply,false);
 const snap=await routed(reader,'event-feed/snapshot');assert.equal(snap.status,200);assert.equal((await snap.json()).asks.some(a=>a.id===id),false);
});

test('snapshot includes an owner ASK on a defined noncanonical session',async t=>{
 const {owner,reader}=await fixture(t);const id=await askOn(owner,'lab-reviewer');const snap=await routed(reader,'event-feed/snapshot');assert.equal(snap.status,200);assert.ok((await snap.json()).asks.some(a=>a.id===id));
});
test('two definitions with the same noncanonical session are denied fail closed',async t=>{
 const cells=['reviewer','other'].map(id=>({id,engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:'lab-reviewer'}));
 const {owner,reader}=await fixture(t,{cells});const id=await askOn(owner,'lab-reviewer');const cap=await routed(reader,`event-feed/asks/${id}/capability`);assert.equal(cap.status,200);assert.equal((await cap.json()).status,'denied');
});
test('defined canonical cloud session retains its existing capability',async t=>{
 const {owner,reader}=await fixture(t,{cells:[{id:'reviewer',engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:'cloud-reviewer'}]});const id=await askOn(owner,'cloud-reviewer');const cap=await routed(reader,`event-feed/asks/${id}/capability`);assert.equal(cap.status,200);const body=await cap.json();assert.equal(body.status,'open');assert.equal(body.canReply,true);
});

test('authoritative snapshot does not dismiss an imported alias of a defined owner session',async t=>{
 const {owner,reader}=await fixture(t);const id=await askOn(owner,'lab-reviewer');
 const res=await fetch(`http://127.0.0.1:${reader.port}/api/asks?open=1`,{headers:headers(reader.token)});assert.equal(res.status,200);
 const rows=(await res.json()).asks;const alias=rows.find(a=>a.ownerId===owner.id&&a.ownerAskId===id);assert.ok(alias,'the imported owner alias remains open');assert.equal(alias.dismissed,false);
});
async function ownerStream(t,owner,reader) {
 const frames=[];let response;let buffer='';
 const request=require('node:http').get(`http://127.0.0.1:${owner.port}/federation/route/_/event-feed`,{headers:{...headers('paired-admin-fixture'),'x-nexuscrew-visited':reader.id}});
 const ready=new Promise((resolve,reject)=>{request.once('error',reject);request.once('response',res=>{response=res;res.setEncoding('utf8');res.on('error',()=>{});res.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n\n'))>=0){const part=buffer.slice(0,n);buffer=buffer.slice(n+2);const line=part.split('\n').find(x=>x.startsWith('data: '));if(line)frames.push(JSON.parse(line.slice(6)));}});resolve(res.statusCode);});});
 const stop=()=>{response?.destroy();request.destroy();};t.after(stop);assert.equal(await ready,200);return {frames,stop};
}
for(const session of ['cloud-reviewer','lab-reviewer']) test(`owner feed publishes both ASK and closure for ${session}`,async t=>{
 const {owner,reader}=await fixture(t,{cells:[{id:'reviewer',engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:session}]});await (await routed(reader,'event-feed/snapshot')).json();const {frames,stop}=await ownerStream(t,owner,reader);try {const id=await askOn(owner,session);
 await until(()=>frames.some(f=>f.frame?.type==='ask'&&f.frame.askId===id),'defined noncanonical ASK must be emitted on the owner feed');
 const closed=await fetch(`http://127.0.0.1:${owner.port}/api/asks/${id}`,{method:'DELETE',headers:headers(owner.token)});assert.equal(closed.status,200);await closed.json();
 await until(()=>frames.some(f=>f.frame?.type==='ask-closed'&&f.frame.askId===id),'defined noncanonical closure must be emitted on the owner feed');}finally{await stop();}
});

test('undefined cloud session on a disabled Fleet retains legacy capability and snapshot',async t=>{
 const {owner,reader}=await fixture(t,{fleetEnabled:false});const id=await askOn(owner,'cloud-legacy');const cap=await routed(reader,`event-feed/asks/${id}/capability`);assert.equal(cap.status,200);assert.equal((await cap.json()).status,'open');const snap=await routed(reader,'event-feed/snapshot');assert.equal(snap.status,200);assert.ok((await snap.json()).asks.some(a=>a.id===id));
});

for(const fault of ['missing','malformed']) test(`enabled Fleet ${fault} definitions cannot certify an authoritative snapshot`,async t=>{
 const {owner,reader}=await fixture(t);if(fault==='missing')fs.rmSync(owner.cfg.fleetDefsPath);else fs.writeFileSync(owner.cfg.fleetDefsPath,'{bad');
 const snap=await routed(reader,'event-feed/snapshot');const body=await snap.json();assert.equal(snap.status,503);assert.equal(Array.isArray(body.asks),false);
});
test('disabled Fleet with invalid definitions still preserves the cloud legacy snapshot',async t=>{
 const {owner,reader}=await fixture(t,{fleetEnabled:false});fs.writeFileSync(owner.cfg.fleetDefsPath,'{bad');const id=await askOn(owner,'cloud-legacy');const snap=await routed(reader,'event-feed/snapshot');assert.equal(snap.status,200);assert.ok((await snap.json()).asks.some(a=>a.id===id));
});
for(const session of ['cloud-reviewer','lab-reviewer']) test(`owner feed emits a closure independently for ${session}`,async t=>{
 const {owner,reader}=await fixture(t,{cells:[{id:'reviewer',engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:session}]});const id=await askOn(owner,session);await (await routed(reader,'event-feed/snapshot')).json();const {frames,stop}=await ownerStream(t,owner,reader);
 try{const r=await fetch(`http://127.0.0.1:${owner.port}/api/asks/${id}`,{method:'DELETE',headers:headers(owner.token)});assert.equal(r.status,200);await r.json();await until(()=>frames.some(f=>f.frame?.type==='ask-closed'&&f.frame.askId===id),'owner closure must retain scope even when the cell is inactive');}finally{await stop();}
});

test('selected grants continue to filter resolved cells on capability and snapshot',async t=>{
 const cells=[{id:'reviewer',engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:'lab-reviewer'},{id:'other',engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:'cloud-other'}];
 const {owner,reader}=await fixture(t,{cells});const store=nodes.loadStoreStrict(owner.nodesPath);const grants=access.grantsOf(store.nodes.find(n=>n.name==='reader')).grants;nodes.atomicWriteStore(owner.nodesPath,nodes.setPeerAccessGrants(store,'reader',{...grants,liveHostAccess:false,cellVisibility:'selected',cells:['reviewer']}));
 const hidden=await askOn(owner,'cloud-other');const visible=await askOn(owner,'lab-reviewer');
 const cap=await routed(reader,`event-feed/asks/${hidden}/capability`);assert.equal((await cap.json()).status,'denied');const snap=await routed(reader,'event-feed/snapshot');assert.equal(snap.status,200);const asks=(await snap.json()).asks;assert.equal(asks.some(a=>a.id===hidden),false);assert.equal(asks.some(a=>a.id===visible),true);
});
test('readonly owner still denies reply after its exact local cell resolves',async t=>{
 const {owner,reader}=await fixture(t);const id=await askOn(owner,'lab-reviewer');owner.cfg.readonlyDefault=true;
 const cap=await routed(reader,`event-feed/asks/${id}/capability`);assert.equal(cap.status,200);const body=await cap.json();assert.equal(body.status,'denied');assert.equal(body.canReply,false);
});
