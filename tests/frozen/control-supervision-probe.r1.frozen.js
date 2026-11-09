'use strict';
// ---------------------------------------------------------------------------
// STORICO — CP05 rev.1, congelata VERBATIM dal file
// tests/control-supervision-probe.test.js alla revisione f0972ffa (base b32ceca5).
//
// Questo file NON fa parte della suite: il runner raccoglie solo
// tests/*.test.js. È conservato perché la CP05 rev.1 imponeva
// `r.subtitle.includes(nc-control-unverifiable)`: quando l'etichetta NC è
// migrata dal subtitle al campo DEDICATO ncControlLabel (elemento proprio
// accanto allo stato, mai concatenato), quel punto è stato migrato
// esplicitamente in CP05 rev.2 nel file attivo — niente etichetta duplicata,
// niente subtitle fittizio tenuto vivo solo per far passare la prova.
// Le condizioni della migrazione (testo originale esatto, etichetta NC
// separata e visibile in it/en/es anche con server vecchio, mai none
// ricostruito, dato stale/preserved mai attestazione corrente) sono provate
// sul rendering REALE in frontend/src/components/NcControlRow.test.jsx.
// ---------------------------------------------------------------------------

// CP05 rev.1 — dal file rev.1 (f0972ffa), righe 42-50, immutata:
//
// test('CP05 server vecchio ha una presentazione visibile non verificabile in tre lingue',async()=>{
//  const {cellRuntime}=await import('../frontend/src/lib/roster-view-model.js');
//  const {setLang,t}=await import('../frontend/src/lib/i18n.js');
//  for(const lang of ['it','en','es']){
//   setLang(lang);const r=cellRuntime({cell:'A',tmux:true,active:true},{});
//   assert.equal(r.ncControl,'unverifiable');
//   assert.ok(r.subtitle.includes(t('nc-control-unverifiable')),lang+': non basta un campo non renderizzato');
//  }
// });
