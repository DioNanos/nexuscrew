'use strict';
// 0.9.80 strato 2c, fix R1: le otto controprove dell'audit come test del
// repo (stesso comportamento osservato, nessuna correzione al prodotto qui).
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net'),Module=require('node:module');
const os=require('node:os');
const ROOT=path.join(__dirname,'..');
const {mondoStato,SESSIONE}=require(ROOT+'/tests/helpers/prompt-stato-world.js');
const activity=require(ROOT+'/lib/files/activity.js');
const {createLeaseManager}=require(ROOT+'/lib/fleet/cell-lease-server.js');
const {createDiagnostics}=require(ROOT+'/lib/diagnostics/store.js');
const L='a1b2c3d4e5f60718';
function registro(w){assert.equal(activity.registraLancioCorrente(w.filesRoot,SESSIONE,{launchId:L,canale:'none'}),true);}
function lease(){return {status:()=>({state:'live'}),readPromptSnapshot:async()=>({ok:true,launchId:L,applicable:true,generation:0,epoch:1,leaseId:'x'}),promptSnapshotBinding:()=>true};}
async function cell(w,l){const rt=w.apri(l);try{return (await rt.cellStatus()).cells[0];}finally{rt.shutdown();}}
function clean(w){fs.rmSync(w.root,{recursive:true,force:true});}

test('R1 CONTROL: tmux conclusively absent omits; generic protocol failure is unknown',async()=>{
 const w=mondoStato({engineExtra:{submit:'enter'}});registro(w);
 try{
  w.imposta({viva:false,errore:'no server running on /tmp/fixture'});assert.equal((await cell(w,lease())).promptDelivery,undefined);
  w.imposta({viva:false,errore:'protocol version mismatch'});assert.deepEqual((await cell(w,lease())).promptDelivery,{state:'unknown',launchId:L});
 }finally{clean(w);}
});

test('R1 CP01: permission denied connecting to tmux is not proof of a closed launch',async()=>{
 const w=mondoStato({engineExtra:{submit:'enter'}});registro(w);
 try{w.imposta({viva:false,errore:'error connecting to /tmp/fixture/default (Permission denied)'});
  const c=await cell(w,lease());assert.deepEqual(c.promptDelivery,{state:'unknown',launchId:L});
 }finally{clean(w);}
});

test('R1 CP02: unverified liveness with no readable launch registry keeps a possible delivery unknown',async()=>{
 const w=mondoStato({engineExtra:{submit:'enter'}});
 try{w.imposta({viva:false,errore:'protocol version mismatch'});const c=await cell(w);
  assert.deepEqual(c.promptDelivery,{state:'unknown'});
 }finally{clean(w);}
});

test('R1 CP03: editing the current definition must not hide the admitted delivery when authority is lost',async()=>{
 const w=mondoStato({engineExtra:{submit:'enter'}});registro(w);const l=lease();const rt=w.apri(l);
 try{
  assert.equal(activity.scriviRecordPrompt(w.dirSessione,{version:1,event:'prompt-delivery',launchId:L,generation:0,state:'submitted',ts:Date.now()}),true);
  assert.equal((await rt.cellStatus()).cells[0].promptDelivery.state,'submitted');
  const defs=JSON.parse(fs.readFileSync(w.defsPath,'utf8'));defs.cells[0].prompt='';fs.writeFileSync(w.defsPath,JSON.stringify(defs));rt.commitDefs(defs);l.status=()=>({state:'none'});
  const c=(await rt.cellStatus()).cells[0];assert.deepEqual(c.promptDelivery,{state:'unknown',launchId:L});
 }finally{rt.shutdown();clean(w);}
});

// Reuse the existing synthetic managed-world fixture without registering its suite.
// Only TEST code is compiled in memory with a no-op node:test and exported helper;
// production files and frozen Git archive bytes are never changed.
function managedFixture({onLease,onWrite}={}){
 const filename=ROOT+'/tests/fleet-prompt-delivery.test.js';const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));const req=m.require.bind(m);
 m.require=(name)=>{
  if(name==='node:test')return {test:()=>{}};
  const found=req(name);
  if(name==='./helpers/prompt-canonico.js')return {...found,
   attestaProprietario:(...args)=>{const l=found.attestaProprietario(...args);if(onLease)onLease(l);return l;},
   scriviCanonico:(...args)=>{const r=found.scriviCanonico(...args);if(onWrite)onWrite(...args);return r;},
  };
  return found;
 };
 m._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports={makeManagedWorld};\n',filename);return m.exports.makeManagedWorld;
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('R1 CP04: an authority await crossing the observer deadline must not emit a terminal event',async()=>{
 const clock={t:0};let reads=0;const d=createDiagnostics();
 const fixture=managedFixture({onLease:(l)=>{const read=l.readPromptSnapshot;l.readPromptSnapshot=async(...a)=>{reads++;if(reads>=2)clock.t=5000;return read(...a);};}});
 const w=fixture({client:'kimi',provider:'native',delivery:'submitted',readyWaitMs:1000,cfgExtra:{diagnostics:d,monotonicNow:()=>clock.t,sleepImpl:async()=>{clock.t+=500;},log:()=>{}}});
 try{await w.runtime.up('Dev');await delay(60);const ev=d.logs().records.filter(x=>x.code==='PROMPT_DELIVERY_TERMINAL');assert.equal(ev.length,0,'the 3010ms observation budget was crossed inside the await');}
 finally{w.runtime.shutdown();w.cleanup();}
});

test('R1 CP05: the observer budget starts with launch, not after delayed preparation/readiness',async()=>{
 const clock={t:0};const d=createDiagnostics();const fixture=managedFixture({onWrite:()=>{clock.t=10000;}});
 const w=fixture({client:'kimi',provider:'native',delivery:'submitted',readyWaitMs:1000,cfgExtra:{diagnostics:d,monotonicNow:()=>clock.t,sleepImpl:async()=>{clock.t+=500;},log:()=>{}}});
 try{await w.runtime.up('Dev');await delay(60);const ev=d.logs().records.filter(x=>x.code==='PROMPT_DELIVERY_TERMINAL');assert.equal(ev.length,0,'ten seconds spent after payload issue already consumed the 3010ms window');}
 finally{w.runtime.shutdown();w.cleanup();}
});

function pair(){return new Promise((resolve,reject)=>{let serverSide;const s=net.createServer(c=>{serverSide=c;});s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const client=net.createConnection(s.address().port,'127.0.0.1',()=>{const wait=()=>serverSide?(s.close(),resolve({serverSide,client})):setTimeout(wait,1);wait();});client.on('error',reject);});});}
function recv(c){return new Promise((resolve,reject)=>{let b='';const timer=setTimeout(()=>{c.off('data',data);reject(Error('fixture timeout'));},2000);const data=x=>{b+=x.toString();for(;;){let i=b.indexOf('\n');if(i<0)return;let line=b.slice(0,i);b=b.slice(i+1);let x;try{x=JSON.parse(line);}catch{continue;}if(x.type==='promptSnapshot'){clearTimeout(timer);c.off('data',data);return resolve(x);}}};c.on('data',data);});}
const response=n=>({type:'promptSnapshotResult',v:1,nonce:n,launchId:L,applicable:true,generation:0});

test('R1 CP06: a late response is rejected even if the timeout callback has not run yet',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'promptfix-late-'));const held=[];
 const mgr=createLeaseManager({home,log:()=>{}},{setTimeout:(fn,ms)=>ms===250?(held.push(fn),{unref(){}}):setTimeout(fn,ms),clearTimeout:h=>{if(h&&typeof h.unref==='function'&&!(h instanceof Object&&'_onTimeout' in h))return;clearTimeout(h);}});
 const p=await pair();
 try{await mgr.track('Fixture');assert.equal(mgr.attachInitial('Fixture',p.serverSide),true);const seen=recv(p.client);const start=process.hrtime.bigint();const q=mgr.readPromptSnapshot('Fixture');const req=await seen;await delay(300);p.client.write(JSON.stringify(response(req.nonce))+'\n');const out=await q;assert.equal(out.ok,false,'response was received beyond the 250ms deadline');}
 finally{p.client.destroy();mgr.close();fs.rmSync(home,{recursive:true,force:true});}
});

test('R1 CP07: revocation invalidates an in-flight snapshot rather than accepting it afterwards',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'promptfix-revoke-'));const mgr=createLeaseManager({home,log:()=>{}});const p=await pair();
 try{await mgr.track('Fixture');mgr.armControl('Fixture',{launchId:L,token:'synthetic-test-token'});assert.equal(mgr.attachInitial('Fixture',p.serverSide),true);const seen=recv(p.client);const q=mgr.readPromptSnapshot('Fixture');const req=await seen;mgr.revokeControl('Fixture');p.client.write(JSON.stringify(response(req.nonce))+'\n');const out=await q;assert.equal(out.ok,false,'response after lifecycle revocation is not qualified');}
 finally{p.client.destroy();mgr.close();fs.rmSync(home,{recursive:true,force:true});}
});

test('R1 CP08: shutdown during the immediate consultation must not create a new observer afterwards',async()=>{
 let enteredResolve,release;const entered=new Promise(r=>{enteredResolve=r;});let first=true;const d=createDiagnostics();
 const fixture=managedFixture({onLease:l=>{const read=l.readPromptSnapshot;l.readPromptSnapshot=async(...a)=>{if(first){first=false;enteredResolve();await new Promise(r=>{release=r;});}return read(...a);};}});
 const w=fixture({client:'kimi',provider:'native',delivery:'submitted',readyWaitMs:1000,cfgExtra:{diagnostics:d,log:()=>{}}});
 try{const up=w.runtime.up('Dev');await entered;w.runtime.shutdown();release();await up;await delay(80);const ev=d.logs().records.filter(x=>x.code==='PROMPT_DELIVERY_TERMINAL');assert.equal(ev.length,0,'observer was created only after shutdown had already aborted all cycles');}
 finally{if(release)release();w.runtime.shutdown();w.cleanup();}
});

test('R1 01: uscita anomala o lettura interrotta non provano la chiusura, nemmeno con il messaggio di assenza', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } }); registro(w);
  try {
    // il messaggio di assenza ma con uscita diversa da 1 (processo interrotto)
    w.imposta({ viva: false, errore: 'no server running on /tmp/fixture', codice: 137 });
    assert.deepEqual((await cell(w, lease())).promptDelivery, { state: 'unknown', launchId: L });
    // assenza vera per socket mancante
    w.imposta({ viva: false, errore: 'error connecting to /tmp/fixture/default (No such file or directory)', codice: 1 });
    assert.equal((await cell(w, lease())).promptDelivery, undefined);
    // timeout / errore di esecuzione senza messaggio
    w.imposta({ viva: false, errore: 'terminated', codice: 124 });
    assert.deepEqual((await cell(w, lease())).promptDelivery, { state: 'unknown', launchId: L });
  } finally { clean(w); }
});

test('R1 02: la stessa definizione mutata, su una NUOVA istanza dopo il restart, non nasconde la consegna ammessa', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } }); registro(w);
  try {
    assert.equal(activity.scriviRecordPrompt(w.dirSessione, { version: 1, event: 'prompt-delivery', launchId: L, generation: 0, state: 'submitted', ts: Date.now() }), true);
    const defs = JSON.parse(fs.readFileSync(w.defsPath, 'utf8'));
    defs.cells[0].prompt = '';
    fs.writeFileSync(w.defsPath, JSON.stringify(defs));
    const l = lease(); l.status = () => ({ state: 'none' });
    assert.deepEqual((await cell(w, l)).promptDelivery, { state: 'unknown', launchId: L });
    // un lancio senza alcun record di consegna e con definizione non applicabile: nulla da mostrare
    fs.rmSync(path.join(w.dirSessione, `prompt-${L}.json`));
    assert.equal((await cell(w, l)).promptDelivery, undefined);
  } finally { clean(w); }
});

test('R1 03: il tetto viene dai budget EFFETTIVI del payload (readyMs clampato), non dalla config', async () => {
  const clock = { t: 0 }; const d = createDiagnostics();
  const fixture = managedFixture({ onWrite: () => { clock.t = 50000; } });
  const w = fixture({
    client: 'kimi', provider: 'native', delivery: 'submitted', readyWaitMs: 1000,
    cfgExtra: { diagnostics: d, monotonicNow: () => clock.t, sleepImpl: async () => { clock.t += 500; }, log: () => {}, sendKeysReadyMs: 99999 },
  });
  try {
    await w.runtime.up('Dev');
    assert.equal(w.ticket().restartPrompt.readyMs, 30000, 'il payload clampa readyMs');
    await delay(60);
    // payload: 30000 + 1000 + 2000 = 33000 < 50000 gia' consumati prima dell'issue
    assert.equal(d.logs().records.filter((x) => x.code === 'PROMPT_DELIVERY_TERMINAL').length, 0);
  } finally { w.runtime.shutdown(); w.cleanup(); }
});

test('R1 03: dentro la finestra effettiva l\'evento terminale c\'e\' ed e\' uno solo', async () => {
  const clock = { t: 0 }; const d = createDiagnostics();
  const fixture = managedFixture({});
  const w = fixture({
    client: 'kimi', provider: 'native', delivery: 'submitted', readyWaitMs: 1000,
    cfgExtra: { diagnostics: d, monotonicNow: () => clock.t, sleepImpl: async () => { clock.t += 100; }, log: () => {} },
  });
  try {
    await w.runtime.up('Dev');
    await delay(100);
    assert.equal(d.logs().records.filter((x) => x.code === 'PROMPT_DELIVERY_TERMINAL').length, 1);
  } finally { w.runtime.shutdown(); w.cleanup(); }
});
