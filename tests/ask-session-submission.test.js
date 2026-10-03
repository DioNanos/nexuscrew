
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodes = require('../lib/nodes/store.js');
async function boot(t, engine = 'claude.native', failure = '') {
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-submit-')); const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
 const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
 const log = path.join(home,'commands.jsonl'), binary = path.join(home,'tmux'); const presence = { value: true };
 fs.writeFileSync(log,'');
 fs.writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'); const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
if(a[0]==='load-buffer') { const p=a.at(-1); fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['payload',fs.readFileSync(p,'utf8'),fs.statSync(p).mode&511])+'\\n'); }
if(a[0]===${JSON.stringify(failure)})process.exit(1);
if(a[0]==='display-message')process.stdout.write(a.at(-1)==='#{pane_id}'?'%7\\n':'cell-reviewer\\t0\\t%7\\n');
`,{mode:0o700});
 const runtime=createServer({ home,configDir,nodesPath,configPath:path.join(configDir,'config.json'),tokenPath:path.join(configDir,'token'),
 port:0,tmuxBin:binary,fleetEnabled:false,sessionExistsSeam:()=>presence.value,filesRoot:path.join(home,'files'),
 settingsSeams:{platform:'linux',uid:1000,execImpl:()=>{throw Error('disabled');},serviceInstallPath:path.join(home,'service'),keygen:()=> 'ssh-ed25519 AAAAFIXTURE demo',spawnImpl:()=>({pid:4100000,unref(){}}),sshVersion:()=>({major:9,minor:6})}});
 const fleet=await runtime.fleetP; fleet.available=true; fleet.cellStatus=async()=>({available:true,cells:[{cell:'Reviewer',tmuxSession:'cell-reviewer',engine,active:true,tmux:true}]});
 await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{runtime.server.closeAllConnections();await new Promise(r=>runtime.server.close(r));runtime.watcher.close();fs.rmSync(home,{recursive:true,force:true});});
 const request=async(url,body)=>{const r=await fetch('http://127.0.0.1:'+runtime.server.address().port+'/api'+url,{method:'POST',headers:{authorization:'Bearer '+runtime.token,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const created=await request('/asks',{question:'Proceed?',session:'cell-reviewer'});assert.equal(created.status,201);
 return {request,id:created.body.id,commands:()=>fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),fleet,presence};
}
for(const engine of ['claude.native','codex.native']) test(`ASK answer submits once using the server Fleet engine ${engine}`,async t=>{
 const s=await boot(t,engine);const out=await s.request('/asks/'+s.id+'/answer',{text:'Proceed\n',engine:'shell.local'});assert.equal(out.status,200);
 const c=s.commands();assert.equal(c.filter(a=>a[0]==='send-keys'&&a.at(-1)==='Enter').length,1);
 assert.equal(c.filter(a=>a[0]==='send-keys'&&a.at(-1)==='C-e').length,engine.startsWith('codex')?1:0);
 const payload=c.find(a=>a[0]==='payload');assert.ok(payload);assert.equal(payload[2],0o600);assert.ok(payload[1].endsWith('Proceed'));
 assert.equal((await s.request('/asks/'+s.id+'/answer',{text:'Again'})).status,409);assert.equal(s.commands().filter(a=>a[0]==='paste-buffer').length,1);
});
test('ASK retry after an attempted paste does not paste or submit again',async t=>{
 const s=await boot(t,'claude.native','paste-buffer');assert.equal((await s.request('/asks/'+s.id+'/answer',{text:'Proceed'})).status,502);
 assert.equal((await s.request('/asks/'+s.id+'/answer',{text:'Again'})).status,409);
 assert.equal(s.commands().filter(a=>a[0]==='paste-buffer').length,1);assert.equal(s.commands().filter(a=>a.at(-1)==='Enter').length,0);
});
test('an unavailable Fleet refuses ASK before paste and releases the claim',async t=>{
 const s=await boot(t);s.fleet.available=false;assert.equal((await s.request('/asks/'+s.id+'/answer',{text:'Proceed'})).status,502);assert.equal(s.commands().length,0);
 s.fleet.available=true;s.fleet.cellStatus=async()=>({available:true,cells:[{cell:'Reviewer',tmuxSession:'cell-reviewer',engine:'claude.native',active:true,tmux:true}]});assert.equal((await s.request('/asks/'+s.id+'/answer',{text:'Proceed'})).status,200);
});

const { createAsksStore } = require('../lib/notify/asks.js');
const { createAskReceipts } = require('../lib/notify/ask-receipts.js');
const { createAskAnswerService } = require('../lib/notify/ask-answer-service.js');
const { submitToSession } = require('../lib/tmux/actions.js');
for (const federated of [false, true]) test(`an uncertain ${federated ? 'federated' : 'local'} submission stays blocked after restart`, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ask-receipt-submit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const asks=createAsksStore({dir});const id=asks.create({question:'Proceed?',session:'cell-reviewer'}).ask.id;
 const filePath=path.join(dir,'receipts.json');let receipts=createAskReceipts({filePath});let calls=0;
 const submit=async()=>{calls++;return {outcome:'delivery-unknown',reason:'paste timeout'};};
 const service=createAskAnswerService({asks,receipts,submit,paste:async()=>{calls++;return false;}});
 const args={askId:id,text:'Proceed',peerId:'paired-peer',requestId:'11111111-1111-4111-8111-111111111111'};
 const out=await (federated?service.answerFederated(args):service.answerLocal(args));assert.equal(out.ok,false);
 assert.equal(receipts.isBlocked(id),true);assert.equal(asks.get(id).answered,false);
 assert.equal(Object.values(JSON.parse(fs.readFileSync(filePath)).attempts)[0].state,'delivery-unknown');
 receipts=createAskReceipts({filePath});const restarted=createAskAnswerService({asks,receipts,submit,paste:async()=>{calls++;return false;}});
 assert.equal((await restarted.answerLocal({askId:id,text:'Again'})).code,409);
 assert.equal((await restarted.answerFederated({...args,requestId:'22222222-2222-4222-8222-222222222222'})).code,409);
 assert.equal(calls,1);
});
for(const failure of ['load-buffer','paste-buffer','Enter','pane-replaced']) test(`submission classifies ${failure} before or after the paste attempt`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ask-helper-phase-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const calls=[];
 const execFileImpl=(_bin,args,_opts,cb)=>{
  calls.push(args);if(args[0]===failure||(failure==='Enter'&&args.at(-1)==='Enter'))return cb(Error('transport failed'),'');
  if(args[0]==='display-message')return cb(null,args.at(-1)==='#{pane_id}'?'%7\n':failure==='pane-replaced'?'cell-reviewer\t0\t%8\n':'cell-reviewer\t0\t%7\n');
  cb(null,'');
 };
 const out=await submitToSession('fake-tmux','cell-reviewer','Proceed',{execFileImpl,tmpdir:dir,delay:async()=>{},engine:'claude.native'});
 assert.equal(out.outcome,failure==='load-buffer'?'failed-pre-paste':'delivery-unknown');
 assert.equal(calls.filter(a=>a[0]==='paste-buffer').length,failure==='load-buffer'?0:1);
 assert.equal(calls.filter(a=>a.at(-1)==='Enter').length,failure==='Enter'?1:0);
});
test('a failed durable unknown receipt keeps the answer claim held',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ask-unknown-write-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const asks=createAsksStore({dir}),id=asks.create({question:'Proceed?',session:'cell-reviewer'}).ask.id;
 const filePath=path.join(dir,'receipts.json'),receipts=createAskReceipts({filePath});let calls=0;
 const service=createAskAnswerService({asks,receipts,submit:async()=>{calls++;return {outcome:'delivery-unknown'};},paste:async()=>{calls++;return false;}});
 const rename=fs.renameSync;let writes=0;
 fs.renameSync=(a,b)=>{if(b===filePath&&++writes===2)throw Error('disk unavailable');return rename(a,b);};
 try {await assert.rejects(service.answerLocal({askId:id,text:'Proceed'}));}finally{fs.renameSync=rename;}
 assert.equal(asks.isAnswering(id),true);assert.equal(calls,1);
 assert.equal((await service.answerLocal({askId:id,text:'Again'})).code,409);
});

for (const state of ['inactive', 'missing-tmux']) test(`ASK refuses a Fleet cell that is ${state} before paste`, async t => {
 const s=await boot(t);s.fleet.cellStatus=async()=>({available:true,cells:[{cell:'Reviewer',tmuxSession:'cell-reviewer',engine:'codex.native',active:state!=='inactive',tmux:state!=='missing-tmux'}]});
 assert.equal((await s.request('/asks/'+s.id+'/answer',{text:'Proceed'})).status,502);assert.equal(s.commands().length,0);
});

test('a manual tmux session keeps paste-only ASK answers without a presumed engine', async t => {
 const s=await boot(t);s.fleet.cellStatus=async()=>({available:true,cells:[]});
 const out=await s.request('/asks/'+s.id+'/answer',{text:'Proceed',engine:'codex.native'});assert.equal(out.status,200);assert.equal(out.body.answered,true);
 const c=s.commands();assert.equal(c.filter(a=>a[0]==='send-keys'&&a.includes('-l')).length,1);
 assert.equal(c.filter(a=>a.at(-1)==='Enter'||a.at(-1)==='C-e').length,0);
 assert.equal((await s.request('/asks/'+s.id+'/answer',{text:'Again'})).status,409);assert.equal(s.commands().filter(a=>a[0]==='send-keys').length,1);
});
test('an absent manual tmux session refuses ASK before any paste', async t => {
 const s=await boot(t);s.fleet.cellStatus=async()=>({available:true,cells:[]});s.presence.value=false;
 assert.equal((await s.request('/asks/'+s.id+'/answer',{text:'Proceed'})).status,502);assert.equal(s.commands().length,0);
});
