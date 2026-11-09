'use strict';
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
 // rev.3 (disegno S5): l'etichetta NC NON vive piu' nella riga — in card
 // resta solo «expired», ogni altro esito vive nel FOGLIO della cella
 // (PowerSheet), che nomina il controllo per esteso sulla riga
 // «Controllo NC». Un server vecchio (nessun campo ncControl) non puo'
 // prestare un attestato nemmeno per sbaglio: niente etichetta corrente in
 // riga, niente testo NC nel subtitle, e il foglio che DICHIARA non
 // verificabile. Il rendering REALE di quella riga del foglio e' provato,
 // col nome di questa CP, in
 // frontend/src/components/PowerSheet.nc-supervision.test.jsx.
 // rev.2 conservata verbatim in tests/frozen/control-supervision-probe.r2.frozen.js.
 const {cellRuntime,buildLocalRoster,ncControlCode}=await import('../frontend/src/lib/roster-view-model.js');
 const {setLang,t}=await import('../frontend/src/lib/i18n.js');
 // i18n seleziona la lingua da localStorage: in node non c'e', quindi il test
 // ne presta uno in memoria SOLO per scegliere la lingua (nessuno stato del
 // prodotto viene toccato) e lo restituisce alla fine.
 globalThis.localStorage={lang:null,getItem(){return this.lang},setItem(_k,v){this.lang=v}};
 const vecchia={cell:'A',tmux:true,active:true}; // il server vecchio non manda ncControl
 for(const lang of ['it','en','es']){
  setLang(lang);const r=cellRuntime(vecchia,{});
  assert.equal(r.ncControl,'unverifiable',lang+': codice onesto senza campo');
  assert.equal(r.ncControlLabel,undefined,lang+': S5 — nessuna etichetta NC in riga per unverifiable');
  assert.ok(!r.subtitle.includes(t('nc-control-unverifiable')),lang+': il testo di stato resta quello che era');
  assert.ok(!r.subtitle.includes(t('nc-control-attested')),lang+': mai attestato nel testo della riga');
  // Il FOGLIO riceve lo stesso codice e nomina il controllo per esteso:
  // la riga «Controllo NC» dice non verificabile — visibile, non muta.
  const codice=ncControlCode(vecchia);
  assert.equal(codice,'unverifiable',lang+': il foglio riceve il codice degradato');
  const rigaFoglio=t('prompt-initial-control')+': '+t('nc-control-'+codice);
  assert.ok(rigaFoglio.includes(t('nc-control-unverifiable')),lang+': il foglio dichiara non verificabile');
  assert.ok(!rigaFoglio.includes(t('nc-control-attested')),lang+': il foglio non presta un attestato');
 }
 // Controllo positivo: una lettura VIVA con controllo armato mostra
 // l'attestato NEL FOGLIO — cosi' il non-verificabile sopra non puo' essere
 // un default fisso che passerebbe comunque.
 setLang('it');
 const viva={cell:'A',tmux:true,active:true,ncControl:'attested'};
 assert.equal(ncControlCode(viva),'attested','lettura viva: attestazione presente');
 assert.ok(t('prompt-initial-control')+': '+t('nc-control-'+ncControlCode(viva)).includes(t('nc-control-attested')),'attestato visibile nel foglio');
 // Le righe che i roster consegnano alla vista portano il CODICE, non
 // l'etichetta: il rendering S5 non ha etichette NC da riga (salvo expired),
 // e il subtitle resta testo di stato.
 const riga=buildLocalRoster([{cell:'A',tmuxSession:'cloud-A',tmux:true,active:true}],[],new Map(),{getItem:()=>null})[0];
 assert.equal(riga.ncControl,'unverifiable','il codice degradato viaggia con la riga');
 assert.equal(riga.ncControlLabel,undefined,'S5: l\'etichetta non sta in riga');
 assert.ok(!riga.subtitle.includes('NC'),'il subtitle resta testo di stato');
 delete globalThis.localStorage;
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
 // rev.3 (disegno S5): con la fleet conservata il codice degrada a non
 // verificabile e NEANCHE il foglio puo' chiamare attested il dato fermo:
 // la riga «Controllo NC» dichiara il dato NON CORRENTE, mai un attestato
 // prestato dall'ultimo elenco buono, e mai un none ricostruito. In riga
 // non resta alcuna etichetta NC (solo expired vive in card). Il rendering
 // REALE della riga del foglio, fleet fresca contro fleet conservata, e'
 // provato col nome di questa CP in
 // frontend/src/components/PowerSheet.nc-supervision.test.jsx.
 // rev.2 conservata verbatim in tests/frozen/control-supervision-probe.r2.frozen.js.
 const {buildLocalRoster,ncControlCode}=await import('../frontend/src/lib/roster-view-model.js');
 const {setLang,t}=await import('../frontend/src/lib/i18n.js');
 globalThis.localStorage={lang:null,getItem(){return this.lang},setItem(_k,v){this.lang=v}};
 setLang('it');
 const c={cell:'A',tmuxSession:'cloud-A',tmux:true,active:true,ncControl:'attested'};
 const items=buildLocalRoster([c],[],new Map(),{getItem:()=>null},{autorevole:true,fleetStale:true});
 assert.ok(!items[0].subtitle.includes(t('nc-control-attested')),'fleet conservata non prova controllo corrente');
 assert.equal(items[0].ncControl,'unverifiable','dato conservato degradato');
 assert.equal(items[0].ncControlLabel,undefined,'S5: nessuna etichetta NC in riga dal dato conservato');
 // Il FOGLIO riceve lo stesso degrado e lo DICHIARA invece di nasconderlo.
 const codiceStale=ncControlCode(c,{fleetStale:true});
 assert.equal(codiceStale,'unverifiable','il foglio riceve il dato degradato');
 assert.notEqual(codiceStale,'none','mai none ricostruito dall\'assenza');
 const rigaFoglio=t('prompt-initial-control')+': '+t('nc-control-'+codiceStale);
 assert.ok(rigaFoglio.includes(t('nc-control-unverifiable')),'il foglio dichiara il dato non corrente');
 assert.ok(!rigaFoglio.includes(t('nc-control-attested')),'mai attestato dal dato fermo');
 // Controllo positivo e sensibilita' del degrado: la STESSA cella letta da
 // una fleet FRESCA mostra l'attestato nel foglio. Se il degrado venisse
 // rimosso (attestato anche da fermo) o reso permanente (unverifiable
 // sempre), uno dei due lati cade.
 const codiceVivo=ncControlCode(c,{fleetStale:false});
 assert.equal(codiceVivo,'attested','lettura viva: attestazione presente');
 assert.ok(t('prompt-initial-control')+': '+t('nc-control-'+codiceVivo).includes(t('nc-control-attested')),'attestato visibile nel foglio con lettura viva');
 delete globalThis.localStorage;
});
