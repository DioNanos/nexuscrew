'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const W=require('./helpers/launch-world.js');const A=require('../lib/files/activity.js');
test('CP08 il binding dal registro persistito usa il launchId del record',async t=>{
 const d=W.scriviMondo({famiglia:'other'});t.after(()=>W.pulisci(d));let id=null;
 const mgr={readiness:()=>({booted:true}),status:()=>({state:'live'}),track:async()=>({stablePath:'/fixture',launchEpoch:'ab'.repeat(8)}),armControl:(_,{launchId})=>{id=launchId;return {hash:'a'.repeat(64)};},controlArmato:()=>true,controlConnesso:()=>true,controlLaunchId:()=>id,revokeControl:()=>true};
 const first=W.apriRuntime(d,{leaseManager:mgr}).runtime;t.after(()=>first.shutdown());
 await first.up(d.cella);
 assert.equal((await first.status()).cells[0].ncControl,'attested','positivo ramo memoria');
 const saved=A.leggiLancioCorrente(d.filesRoot,d.sessione);
 assert.equal(saved.launchId,id,'positivo registro persistito reale del vero up');
 // Nuova vista read-only: nessun up/riarmo/adozione o reconnect finto.
 // Stessa fonte iniettata valida, assenza della mappa volatile del primo runtime.
 const reader=W.apriRuntime(d,{leaseManager:mgr}).runtime;t.after(()=>reader.shutdown());
 const c=(await reader.status()).cells[0];
 assert.equal(c.active,true,'sessione elencata dalla fonte tmux di prova');
 assert.equal(c.ncControl,'attested','stesso control e stesso id sul registro persistito');
});
