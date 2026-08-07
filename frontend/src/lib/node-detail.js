// frontend/src/lib/node-detail.js — cosa contiene il FOGLIO di un nodo.
//
// Compagno di `node-summary.js`: quello decide cosa sta in riga, questo cosa sta
// nel foglio che la riga apre. La divisione e' la decisione di design del
// 2026-08-04: identita' e riassunto derivato in riga, tutto il resto un livello
// sotto. Nessuna delle due meta' e' React: si possono provare senza montare
// nulla, ed e' li' che stanno gli errori silenziosi.
//
// Regola che vale per tutto il file: si derivano solo campi che ESISTONO. Dove
// il modello di autorita' per-nodo (NC-E) non c'e' ancora, questo modulo lo
// dichiara mancante invece di riempirlo con qualcosa che gli somiglia.

import { nodeReach, nodeExposure } from './node-summary.js';

// Identita' e trasporto: cosa e' questo nodo e da dove arriva. Nessun segreto —
// `token`/`acceptToken` non compaiono qui e non devono comparire nel foglio.
export function nodeIdentity(node) {
  if (!node || typeof node !== 'object' || typeof node.name !== 'string' || !node.name) return null;
  const routed = node.kind === 'transitive';
  return {
    name: node.name,
    title: (typeof node.label === 'string' && node.label.trim()) || node.name,
    routed,
    // Il percorso di un nodo in transito E' la sua identita' di rete: senza,
    // due nodi omonimi dietro hub diversi sono indistinguibili.
    route: routed && Array.isArray(node.route) ? [...node.route] : null,
    ssh: !routed && node.direction === 'outbound' && node.ssh ? String(node.ssh) : null,
    inbound: !routed && node.direction === 'inbound',
    transport: (node.tunnel && typeof node.tunnel.transport === 'string' && node.tunnel.transport) || null,
  };
}

// La sezione «cosa puo' fare questo nodo».
//
// Oggi la risposta vera e' una sola e sta gia' scritta in README e
// docs/SECURITY.md: un nodo accoppiato e' fidato quanto l'operatore. Non ci sono
// poteri per-nodo, quindi non c'e' un elenco da mostrare — e questo e'
// esattamente il punto in cui il foglio potrebbe mentire. `visibility` dice cosa
// il nodo VEDE, non cosa PUO': metterla qui da sola la farebbe leggere come un
// limite di potere che non e'.
//
// `grants: []` e' lo slot di NC-E. Quando i grant esisteranno, l'elenco si
// riempie qui e la classe derivata (`user`/`admin`/personalizzato) si calcola
// da questa lista, mai da un campo memorizzato.
export function nodeAuthority(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.kind === 'transitive') {
    // Un nodo raggiunto in transito non e' accoppiato con QUESTA macchina: non
    // ha autorita' qui, ce l'ha presso l'hub che lo instrada. Dirlo
    // «owner-equivalent» sarebbe falso in eccesso.
    return { key: 'authority-routed', ownerEquivalent: false, grants: [], model: 'none' };
  }
  return { key: 'authority-owner-equivalent', ownerEquivalent: true, grants: [], model: 'none' };
}

// I nodi verso cui questo nodo e' esplicitamente esposto, con la loro etichetta.
// Vale solo per `visibility: 'selected'`: e' la lista delle CONCESSIONI, non
// l'universo dei nodi con le spunte. Un id concesso che non corrisponde piu' a
// un nodo vivo resta nella lista — sparire in silenzio nasconderebbe una
// concessione ancora attiva lato server.
export function selectionGrants(node, nodes) {
  if (!node || node.visibility !== 'selected') return [];
  // Lo stesso id due volte e' una concessione sola: l'elenco memorizzato puo'
  // contenerlo duplicato, e mostrarlo due volte farebbe credere a due
  // concessioni distinte, una delle quali sembrerebbe non togliersi mai.
  const ids = [...new Set(Array.isArray(node.selected) ? node.selected : [])];
  const byId = new Map();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (n && n.nodeId && !byId.has(n.nodeId)) byId.set(n.nodeId, n);
  }
  return ids.map((id) => {
    const peer = byId.get(id);
    return {
      id,
      label: peer ? ((typeof peer.label === 'string' && peer.label.trim()) || peer.name) : id,
      known: !!peer,
    };
  });
}

// I candidati del picker: chi puo' ancora essere aggiunto. Esclude se' stesso,
// chi e' gia' concesso e chi non ha un'identita' stabile (`nodeId`) da
// concedere. `query` filtra su etichetta e nome, senza distinzione di maiuscole.
//
// «Se stesso» si riconosce dall'IDENTITA', non dal nome: il nome e' locale e
// puo' differire fra due viste dello stesso nodo, mentre due nodi distinti
// possono chiamarsi uguale dietro hub diversi. Confrontare i nomi sbagliava in
// entrambi i versi — offriva il nodo a se' stesso sotto un altro nome, e
// nascondeva un omonimo che era un nodo diverso.
export function selectionCandidates(node, nodes, query = '') {
  if (!node) return [];
  const granted = new Set(Array.isArray(node.selected) ? node.selected : []);
  const needle = String(query || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  const isSelf = (n) => (node.nodeId ? n.nodeId === node.nodeId : n.name === node.name);
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || !n.nodeId || isSelf(n)) continue;
    if (granted.has(n.nodeId) || seen.has(n.nodeId)) continue;
    const label = (typeof n.label === 'string' && n.label.trim()) || n.name;
    if (needle && !`${label} ${n.name}`.toLowerCase().includes(needle)) continue;
    seen.add(n.nodeId);
    out.push({ id: n.nodeId, label, name: n.name });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// Le azioni del foglio, in ordine, gia' decise: quali esistono per questo nodo
// (`node.actions`, che il server calcola) e quali sono utilizzabili adesso.
// `connect` e `disconnect` sono la stessa riga in due stati e non compaiono mai
// insieme: mostrarle entrambe fa premere quella sbagliata.
export function nodeActions(node, { readonly = false, busy = false } = {}) {
  if (!node || typeof node !== 'object') return [];
  const available = node.actions && typeof node.actions === 'object' ? node.actions : {};
  const up = nodeReach(node).up;
  const out = [];
  const push = (key, action, { mutating = true, danger = false } = {}) => {
    out.push({ key, action, danger, disabled: busy || (mutating && readonly) });
  };
  if (available.edit) push('edit', 'edit');
  // Una prova di raggiungibilita' non muta nulla: resta viva anche in sola
  // lettura, ed e' proprio li' che serve per capire perche' un nodo non risponde.
  if (available.test) push('node-test', 'test', { mutating: false });
  if (available.disconnect && up) push('tunnel-stop', 'down');
  if (available.connect && !up) push('tunnel-start', 'up');
  if (available.restart) push('tunnel-restart', 'restart');
  if (available.remove) push('delete', 'remove', { danger: true });
  return out;
}

// --- scope celle (NC-E) ---------------------------------------------------
// Gemello di selectionGrants/selectionCandidates, e deliberatamente con le
// stesse regole: chi ha imparato una lista ha imparato l'altra. Cambia il
// dominio — li' i NODI verso cui questo nodo e' esposto, qui le CELLE di questa
// installazione che quel nodo puo' vedere — e cambia l'identita': una cella e'
// identificata dal suo nome, che qui e' la chiave del permesso.
//
// `all` non elenca nulla di proposito, come nel resolver lato server: una lista
// che significa "tutte" invecchierebbe a ogni cella nuova.
export function cellScopeMode(node) {
  const mode = node && typeof node.cellVisibility === 'string' ? node.cellVisibility : 'all';
  return ['all', 'none', 'selected'].includes(mode) ? mode : 'all';
}

// Le celle concesse. Un nome concesso che non corrisponde piu' a una cella viva
// RESTA nell'elenco: sparire in silenzio nasconderebbe un permesso ancora
// attivo lato server — stessa scelta di selectionGrants.
export function cellScopeGrants(node, cells) {
  if (cellScopeMode(node) !== 'selected') return [];
  const names = [...new Set(Array.isArray(node.cells) ? node.cells : [])];
  // Finche' l'elenco delle celle non e' stato caricato NON si sa nulla, e
  // «non lo so» non deve leggersi come «non esiste piu'»: marcare tutte le
  // concessioni come sconosciute mentre la lista arriva sarebbe un falso
  // allarme su ogni apertura del foglio. Solo un elenco vero (anche vuoto)
  // autorizza il giudizio.
  if (!Array.isArray(cells)) return names.map((name) => ({ id: name, label: name, known: true }));
  const known = new Set(cells
    .map((c) => (typeof c === 'string' ? c : c && (c.cell || c.id)))
    .filter(Boolean));
  return names.map((name) => ({ id: name, label: name, known: known.has(name) }));
}

// I candidati: le celle di questa installazione non ancora concesse.
export function cellScopeCandidates(node, cells, query = '') {
  const granted = new Set(Array.isArray(node && node.cells) ? node.cells : []);
  const needle = String(query || '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(cells) ? cells : []) {
    const name = typeof entry === 'string' ? entry : entry && (entry.cell || entry.id);
    if (!name || granted.has(name) || seen.has(name)) continue;
    if (needle && !name.toLowerCase().includes(needle)) continue;
    seen.add(name);
    out.push({ id: name, label: name });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// Il foglio intero, in un colpo solo. Il componente non ricalcola nulla: rende.
export function nodeDetailModel(node, nodes, { readonly = false, busy = false } = {}) {
  const identity = nodeIdentity(node);
  if (!identity) return null;
  return {
    identity,
    reach: nodeReach(node),
    authority: nodeAuthority(node),
    exposure: nodeExposure(node),
    grants: selectionGrants(node, nodes),
    cellScope: cellScopeMode(node),
    actions: nodeActions(node, { readonly, busy }),
    // La visibilita' si modifica solo dove il server la espone, solo se il nodo
    // e' condiviso, e mai su un nodo raggiunto in transito: quella scelta
    // appartiene all'hub che lo instrada, non a noi. Il server la rifiuterebbe
    // comunque; offrirla e' un comando che non ha effetto o che agisce su una
    // decisione altrui.
    canEditVisibility: !!(node.actions && node.actions.visibility)
      && node.shared === true && node.kind !== 'transitive',
    // Lo scope celle si imposta su un peer DIRETTO, anche quando non e'
    // condiviso: e' un permesso di lettura sulle NOSTRE celle, indipendente dal
    // fatto che quel nodo sia pubblicato in rete. Legarlo a `shared` come la
    // visibilita' avrebbe reso impossibile restringere un nodo privato — che e'
    // esattamente il caso in cui lo si vuole fare per primo.
    canEditCellScope: !!(node.actions && node.actions.edit) && node.kind !== 'transitive',
  };
}
