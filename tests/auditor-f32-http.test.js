const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { createAskReceipts } = require('../lib/notify/ask-receipts.js');
const { createAskAnswerService } = require('../lib/notify/ask-answer-service.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const A_ID = 'a'.repeat(32);
const B_ID = 'b'.repeat(32);
const SECRET = 'pairing-secret-token';

function boot(t, { pasteCalls = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskhttp-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    sessionExistsSeam: () => true,
    pasteSeam: pasteCalls ? (session, text) => { pasteCalls.push({ session, text }); return true; } : undefined,
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
    },
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, ...paths });
  }));
}

async function pair(t, preset = 'admin') {
  const pasteCalls = [];
  const B = await boot(t, { pasteCalls });
  const A = await boot(t);
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'client', remotePort: 41999, localPort: 44777, nodeId: selfA,
    acceptToken: SECRET, direction: 'inbound', shared: false, visibility: 'network',
  });
  stB = nodesStore.setPeerAccessPreset(stB, 'client', preset);
  nodesStore.atomicWriteStore(B.nodesPath, stB);
  const stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: B.port, nodeId: selfB,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  return { A, B, selfA, selfB, pasteCalls };
}

const createAsk = (B, session) => fetch(`${B.base}/api/asks`, {
  method: 'POST', headers: H(B.token),
  body: JSON.stringify({ question: 'proceed?', options: ['yes', 'no'], session }),
}).then(async (r) => ({ status: r.status, id: (await r.json()).id }));

test('audit nonlocal reconcile denied and status opaque for missing hidden other-peer receipts',async t=>{
 const {A,B,selfA,pasteCalls}=await pair(t);
 const {id}=await createAsk(B,tmuxSessionForCell('dev'));
 const rid='11111111-1111-4111-8111-111111111111';
 const denied=await fetch(`${A.base}/api/route/owner/_/asks/${id}/reconcile`,{method:'POST',headers:H(A.token),body:JSON.stringify({decision:'mark-delivered'})});
 console.log('FEDERATED_RECONCILE',denied.status);assert.ok(denied.status>=400);
 const ask2=await createAsk(B,tmuxSessionForCell('secret'));
 const answers=[];for(const askid of [id,ask2.id,'deadbeef']){const r=await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${askid}/requests/${rid}`,{headers:H(A.token)});answers.push([r.status,await r.text()]);}
 console.log('STATUS_OPAQUE',JSON.stringify(answers));assert.deepEqual(answers[0],answers[1]);assert.deepEqual(answers[1],answers[2]);assert.equal(answers[0][0],404);
 for(const key of ['session','to','originCell']){const r=await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`,{method:'POST',headers:H(A.token),body:JSON.stringify({text:'x',requestId:rid,[key]:'x'})});assert.equal(r.status,400)}
 assert.equal(pasteCalls.length,0);
});
test('audit dedicated rate 6/peer 30/global',()=>{const {createAskRateLimiter}=require('../lib/notify/event-feed-asks-routes');const rate=createAskRateLimiter({now:()=>10000});for(let p=0;p<5;p++){for(let i=0;i<6;i++)assert.equal(rate.check('p'+p).allowed,true);assert.equal(rate.check('p'+p).allowed,false)}assert.equal(rate.check('sixth').allowed,false)});
test('audit REAL other peer status and hidden status identical to missing',async t=>{
 const {A,B,selfA,selfB}=await pair(t);const C=await boot(t);const selfC=nodesStore.loadStoreStrict(C.nodesPath).nodeId;
 let bs=nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath),{name:'client2',remotePort:41999,localPort:44778,nodeId:selfC,acceptToken:'test-peer-two',direction:'inbound',shared:false,visibility:'network'});bs=nodesStore.setPeerAccessPreset(bs,'client2','admin');nodesStore.atomicWriteStore(B.nodesPath,bs);
 let cs=nodesStore.addNode(nodesStore.loadStoreStrict(C.nodesPath),{name:'owner',remotePort:41999,localPort:B.port,nodeId:selfB,token:'test-peer-two',direction:'outbound',shared:true,visibility:'network',ssh:'u@owner'});nodesStore.atomicWriteStore(C.nodesPath,cs);
 const {id}=await createAsk(B,tmuxSessionForCell('dev'));const rid='22222222-2222-4222-8222-222222222222';
 const post=await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`,{method:'POST',headers:H(A.token),body:JSON.stringify({text:'yes',requestId:rid})});assert.equal(post.status,200);
 const result=[];
 for(const askid of [id,'deadbeef']){const r=await fetch(`${C.base}/api/route/owner/_/event-feed/asks/${askid}/requests/${rid}`,{headers:H(C.token)});result.push([r.status,await r.text()])}
 bs=nodesStore.setPeerAccessGrants(nodesStore.loadStoreStrict(B.nodesPath),'client',{cellVisibility:'selected',cells:['other'],eventsAccess:true,nodeEventsAccess:true,askReplyAccess:true,filesReadAccess:false,liveHostAccess:false,panelAccess:false,peerOperatorAccess:false});nodesStore.atomicWriteStore(B.nodesPath,bs);
 const hidden=await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/requests/${rid}`,{headers:H(A.token)});result.push([hidden.status,await hidden.text()]);console.log('REAL_SCOPED_STATUS',JSON.stringify(result));assert.deepEqual(result[0],result[1]);assert.deepEqual(result[1],result[2]);assert.equal(result[0][0],404);
});
test('audit gate exact hop and inbound direction',async t=>{
 const {B,selfA,selfB}=await pair(t);const {createFeedGate}=require('../lib/notify/event-feed-routes');let resolved={ok:true,trust:'federated',visited:[selfA,selfB]};const gate=createFeedGate({nodesPath:B.nodesPath,eventsEnabled:()=>true,localNodeId:()=>selfB,originResolver:{resolve:async()=>resolved}});let code,body;const res={status(n){code=n;return this},json(o){body=o;return this}};
 assert.ok(await gate({},res));for(const visited of [[selfA],[selfA,selfB,'third'],[selfA,'wrong']]){resolved={ok:true,trust:'federated',visited};assert.equal(await gate({},res),null);assert.equal(body.reason,'hop-chain')}
 resolved={ok:true,trust:'local',visited:[selfA,selfB]};assert.equal(await gate({},res),null);assert.equal(body.reason,'federated-origin-required');
 resolved={ok:true,trust:'federated',visited:[selfA,selfB]};const st=nodesStore.loadStoreStrict(B.nodesPath);st.nodes=st.nodes.filter(n=>n.nodeId!==selfA);const changed=nodesStore.addNode(st,{name:'outbound-only',remotePort:41999,localPort:44999,nodeId:selfA,token:'test',direction:'outbound',shared:true,visibility:'network',ssh:'u@client'});nodesStore.atomicWriteStore(B.nodesPath,changed);assert.equal(await gate({},res),null);assert.equal(body.reason,'peer-unknown');console.log('GATE_HOP_DIRECTION',code,body.reason);
});

test('audit READONLY refuses owner route before paste',async t=>{const {A,B,pasteCalls}=await pair(t);const {id}=await createAsk(B,tmuxSessionForCell('dev'));const previous=process.env.NEXUSCREW_READONLY;process.env.NEXUSCREW_READONLY='1';try{const r=await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`,{method:'POST',headers:H(A.token),body:JSON.stringify({text:'yes',requestId:'33333333-3333-4333-8333-333333333333'})});console.log('READONLY',r.status,await r.text());assert.equal(r.status,403);assert.equal(pasteCalls.length,0)}finally{if(previous===undefined)delete process.env.NEXUSCREW_READONLY;else process.env.NEXUSCREW_READONLY=previous}});
