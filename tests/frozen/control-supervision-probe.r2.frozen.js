'use strict';
// ---------------------------------------------------------------------------
// STORICO — CP05/CP07 rev.2, congelate VERBATIM dal file
// tests/control-supervision-probe.test.js alla revisione d2daa397
// (corpo byte-identico al file attivo prima della migrazione, sha256
// 30baba16f25fe0ef4253384f98940dab2c20247abcf351e66537ba224e09d6a0).
//
// Questo file NON fa parte della suite: il runner raccoglie solo
// tests/*.test.js. È conservato perché la rev.2 pretendeva l'etichetta NC
// nel campo DEDICATO della riga (ncControlLabel) anche per «unverifiable»:
// con il disegno S5 approvato (in card resta solo «expired», tutti gli
// altri esiti vivono nel FOGLIO della cella) quelle due aspettative sono
// state migrate in CP05/CP07 rev.3 nel file attivo — la riga non presta
// più alcuna etichetta corrente, e la dichiarazione «non verificabile» /
// «non corrente» si legge sulla riga «Controllo NC» del foglio. Niente
// prove cancellate: le stesse garanzie (mai attestato prestato, mai none
// ricostruito, controllo positivo con lettura viva) e la prova del
// rendering REALE del foglio stanno in rev.3 qui accanto e in
// frontend/src/components/PowerSheet.nc-supervision.test.jsx (CP05/CP07).
// ---------------------------------------------------------------------------
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const W=require('./helpers/launch-world.js');
function world(t){
 const d=W.scriviMondo({famiglia:'other'}); t.after(()=>W.pulisci(d));
 const state={lease:{state:'live'},id:null,booted:true};
 const manager={readiness:()=>({booted:state.booted}),status:()=>state.lease,
  track:async()=>({cellId:d.cella,stablePath:'/fixture',launchEpoch:'ab'.repeat(8)}),
  armControl:(_id,{launchId})=>{state.id=launchId;return {hash:'a'.repeat(64)};},
  controlArmato:()=>true,controlConnesso:()=>true,controlLaunchId:()=>state.id,revokeControl:()=>true};
 const {runtime}=W.apriRuntime(d,{leaseManager:manager}); t.after(()=>runtime.shutdown());
 return {d,state,manager,runtime,cell:async()=> (await runtime.status()).cells.find(c=>c.cell===d.cella)};
}
test('CP01 controllo di un altro lancio non attesta quello corrente',async t=>{
 const w=world(t);await w.runtime.up(w.d.cella);
 assert.equal((await w.cell()).ncControl,'attested','controllo positivo: id armato dal vero up');
 const previous=w.state.id;w.state.id=previous==='aa'.repeat(8)?'bb'.repeat(8):'aa'.repeat(8);
 assert.notEqual((await w.cell()).ncControl,'attested','il solo id non vuoto non prova il binding');
});
test('CP02 risposta lease senza stato non significa none attestato',async t=>{
 const w=world(t);await w.runtime.up(w.d.cella);
 for(const v of [null,{}, {state:''}]){
  w.state.lease=v;
  assert.equal((await w.cell()).ncControl,'unverifiable',JSON.stringify(v));
 }
});
test('CP03 readiness assente non attesta una fonte pronta',async t=>{
 const w=world(t);await w.runtime.up(w.d.cella);delete w.manager.readiness;
 const st=await w.runtime.status();
 assert.equal(st.supervision.control,'starting','controllo positivo del nodo');
 assert.equal(st.cells.find(c=>c.cell===w.d.cella).ncControl,'unverifiable');
});
test('CP04 lettura sessioni fallita non attesta inactive',async t=>{
 const w=world(t);w.state.lease={state:'none'};
 let s=fs.readFileSync(w.d.tmuxBin,'utf8');
 s=s.replace("if (args[0] === 'list-sessions') {", "if (args[0] === 'list-sessions') { process.stderr.write('permission denied\\n');process.exit(1);");
 fs.writeFileSync(w.d.tmuxBin,s);
 assert.equal((await w.cell()).ncControl,'unverifiable','sessione non letta, non assente attestata');
});
test('CP05 server vecchio ha una presentazione visibile non verificabile in tre lingue',async()=>{
 // rev.2: l'etichetta NC vive nel campo DEDICATO della riga (ncControlLabel),
 // renderizzato accanto allo stato in un elemento suo — non piu' concatenata
 // al subtitle. Le prove di rendering REALE (testo di stato esatto + etichetta
 // separata e visibile) stanno su SessionList e Sidebar in
 // frontend/src/components/NcControlRow.test.jsx. rev.1 conservata in
 // tests/frozen/control-supervision-probe.r1.frozen.js.
 const {cellRuntime,buildLocalRoster}=await import('../frontend/src/lib/roster-view-model.js');
 const {setLang,t}=await import('../frontend/src/lib/i18n.js');
 for(const lang of ['it','en','es']){
  setLang(lang);const r=cellRuntime({cell:'A',tmux:true,active:true},{});
  assert.equal(r.ncControl,'unverifiable');
  assert.equal(r.ncControlLabel,t('nc-control-unverifiable'),lang+': non basta un campo non renderizzato');
  assert.ok(!r.subtitle.includes(t(`nc-control-unverifiable`)),lang+': il testo di stato resta quello che era');
 }
 // La riga che i roster consegnano alla vista porta il campo dedicato COM'E':
 // e' lì che il rendering lo mostra accanto allo stato.
 setLang('it');
 const riga=buildLocalRoster([{cell:'A',tmuxSession:'cloud-A',tmux:true,active:true}],[],new Map(),{getItem:()=>null})[0];
 assert.equal(riga.ncControlLabel,t('nc-control-unverifiable'),'la riga porta l\'etichetta al rendering');
 assert.ok(!riga.subtitle.includes('NC'),'il subtitle resta testo di stato');
});
test('CP06 cella preserved da nodo down non presenta controllo corrente attestato',async()=>{
 const {buildRemoteRoster}=await import('../frontend/src/lib/roster-view-model.js');
 const {setLang,t}=await import('../frontend/src/lib/i18n.js');setLang('it');
 const c={cell:'A',tmuxSession:'cloud-A',tmux:true,active:true,ncControl:'attested',preserved:true};
 const {rawItems}=buildRemoteRoster({route:['peer'],status:'down',fleetState:'stale',sessionsAvailable:false,cells:[c],sessions:[]},{getItem:()=>null});
 assert.equal(rawItems[0].live,false,'controllo positivo preserved');
 assert.ok(!rawItems[0].subtitle.includes(t('nc-control-attested')),'non attestato corrente da nodo down');
 // rev.2: la garanzia segue l'innesto nuovo — neanche il campo dedicato puo'
 // prestare un'attestazione corrente a una riga conservata.
 assert.equal(rawItems[0].ncControl,'unverifiable','dato conservato degradato');
 assert.notEqual(rawItems[0].ncControlLabel,t('nc-control-attested'),'nessuna etichetta corrente da nodo down');
});
test('CP07 sola lettura fleet stale degrada anche la supervisione',async()=>{
 const {buildLocalRoster}=await import('../frontend/src/lib/roster-view-model.js');
 const {setLang,t}=await import('../frontend/src/lib/i18n.js');setLang('it');
 const c={cell:'A',tmuxSession:'cloud-A',tmux:true,active:true,ncControl:'attested'};
 const items=buildLocalRoster([c],[],new Map(),{getItem:()=>null},{autorevole:true,fleetStale:true});
 assert.ok(!items[0].subtitle.includes(t('nc-control-attested')),'fleet conservata non prova controllo corrente');
 // rev.2: il degrado si VEDE nell'etichetta dedicata — mai attested prestato
 // dall'ultimo elenco buono.
 assert.equal(items[0].ncControl,'unverifiable');
 assert.equal(items[0].ncControlLabel,t('nc-control-unverifiable'),'fleet conservata: non verificabile, dichiarato');
});
