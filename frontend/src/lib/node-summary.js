// frontend/src/lib/node-summary.js — cosa viaggia nella RIGA di un nodo.
//
// Decisione di design (DevAuditor, 2026-08-04): riga + foglio di dettaglio, e
// in riga solo identita' e un **riassunto derivato**. Il dettaglio sta nel
// foglio, che su mobile e' un bottom sheet e su desktop un pannello laterale:
// una sola gerarchia di navigazione invece di schede che si espandono e fanno
// saltare il layout.
//
// Il riassunto e' DERIVATO, mai memorizzato. Oggi si deriva dai campi che
// esistono davvero — `shared`, `visibility`, `selected`. Quando arriveranno i
// grant (NC-E) si derivera' da quelli, e la classe `user`/`admin`/personalizzato
// sara' calcolata qui: e' lo slot, ed e' il motivo per cui questa funzione esiste
// gia' adesso invece di essere due righe dentro il componente.
//
// Nessuna etichetta di classe viene prodotta finche' il codice non la mantiene:
// scriverla oggi sopra `visibility` significherebbe promettere poteri
// inesistenti, e quando i grant arrivassero quell'etichetta diventerebbe vera
// senza che nessuno l'abbia concessa.

// Chiavi i18n, non testo: chi rende decide la lingua.
export const REACH = {
  routed: 'peer-routed',
  routedStale: 'peer-routed-stale',
  up: 'tunnel-up',
  down: 'tunnel-down',
  passive: 'node-connected-client',
};

// Un nodo raggiunto in transito non ha un tunnel proprio: la sua
// raggiungibilita' e' quella della catena, e va detta come tale.
export function nodeReach(node) {
  if (!node || typeof node !== 'object') return { key: REACH.down, up: false };
  if (node.kind === 'transitive') {
    const stale = node.stale === true;
    return { key: stale ? REACH.routedStale : REACH.routed, up: !stale, routed: true };
  }
  const status = node.tunnel && node.tunnel.status;
  if (status === 'up') return { key: REACH.up, up: true };
  if (status === 'passive') return { key: REACH.passive, up: false, passive: true };
  return { key: REACH.down, up: false };
}

// Cosa questo nodo puo' raggiungere della rete, secondo i campi che esistono
// OGGI. Deliberatamente non si chiama "classe" e non produce «admin»/«user».
//
// Due chiavi, non una: `key` e' la frase intera del foglio, `shortKey` sta in
// riga. Sono la stessa cosa tranne per «privato», che nel foglio spiega cosa
// significa e in riga verrebbe troncato a meta' parola.
export function nodeExposure(node) {
  if (!node || typeof node !== 'object') return { key: 'peer-private', shortKey: 'row-private', shared: false };
  if (node.shared !== true) return { key: 'peer-private', shortKey: 'row-private', shared: false };
  const visibility = node.visibility || 'network';
  if (visibility === 'relay-only') return { key: 'visibility-relay', shortKey: 'visibility-relay', shared: true, visibility };
  if (visibility === 'selected') {
    const count = Array.isArray(node.selected) ? node.selected.length : 0;
    // Zero selezionati e' condiviso ma verso nessuno: e' uno stato reale e
    // silenzioso, e chi legge la riga deve poterlo distinguere da "vede tutti".
    return { key: 'visibility-selected', shortKey: 'visibility-selected', shared: true, visibility, count };
  }
  return { key: 'visibility-network', shortKey: 'visibility-network', shared: true, visibility };
}

// La riga completa: identita' piu' i due riassunti. Nient'altro — ogni campo in
// piu' qui e' un campo che su un telefono spinge fuori il nome del nodo.
export function nodeRowSummary(node) {
  if (!node || typeof node !== 'object') return null;
  const name = typeof node.name === 'string' ? node.name : '';
  if (!name) return null;
  const routed = node.kind === 'transitive';
  return {
    name,
    title: (typeof node.label === 'string' && node.label.trim()) || name,
    subtitle: name,
    reach: nodeReach(node),
    exposure: nodeExposure(node),
    routed,
    // Di un nodo raggiunto in transito NON possiamo dire l'esposizione: quella
    // la decide l'hub che lo instrada, non questa macchina. Cio' che sappiamo, e
    // che serve per distinguerlo da un omonimo dietro un altro hub, e' da dove
    // passa. La riga mostra quello.
    routeLabel: routed && Array.isArray(node.route) ? node.route.join(' › ') : null,
  };
}
