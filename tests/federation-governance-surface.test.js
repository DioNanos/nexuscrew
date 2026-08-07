'use strict';
// tests/federation-governance-surface.test.js — le vie di governo sotto
// `/settings/` non attraversano la federazione, e questo file le dice per NOME.
//
// LA PRETESA E' DELIBERATAMENTE STRETTA. La prima stesura diceva «la superficie
// di governo», che prometteva piu' di quanto copre: l'audit ha trovato una via
// di AMMISSIONE federata fuori da `/settings/` — `/vl-nodes/invite`, che conia
// un invito legato all'owner di QUESTO hub, lo stesso shape di
// `/settings/peering/invite` che fu tolto il 2026-08-04. E' preesistente e
// deliberata (i nodi VL sono federati per disegno, vedi la NOTE in
// federation.js), e la direzione del rischio e' diversa: un micro-device VL e'
// un bersaglio di comandi, non un peer che agisce come proprietario. Ma un test
// che si chiama «superficie di governo» ed e' verde farebbe credere coperto
// anche quello. Un verde non deve promettere piu' di cio' che guarda.
//
// PERCHE' ESISTE. Oggi le vie di governo sono irraggiungibili da remoto per una
// ragione implicita: non compaiono nell'allowlist. Va bene finche' nessuno
// aggiunge una riga. Il 2026-08-04 e' successo il contrario —
// `/settings/peering/invite` ERA federata, e un peer accoppiato poteva far
// coniare al proprio hub un invito che ammetteva un terzo: la fiducia diventava
// transitiva senza che l'operatore agisse o lo sapesse. Fu tolta, ma nulla
// impediva di rimetterla.
//
// Questo test enumera la superficie e la fissa. Non e' una guardia contro un
// attacco: e' una guardia contro una riga aggiunta con le migliori intenzioni.
//
// COSA NON C'E' QUI, DI PROPOSITO: l'interruttore `remoteGovernance` previsto
// dal passo 2 del modello di autorita'. Introdurlo adesso creerebbe una manopola
// che, se accesa, esporrebbe il governo SENZA il modello sotto — grant, prove e
// revoca non esistono ancora. Un flag dal nome rassicurante che non protegge
// nulla e invita ad accenderlo e' peggio della sua assenza. Arriva al passo 5b,
// insieme a cio' che lo rende sicuro.
const { test } = require('node:test');
const assert = require('node:assert');
const fed = require('../lib/proxy/federation.js');

// La superficie di governo, presa da `lib/settings/routes.js`. Ogni voce e' una
// via che cambia CHI puo' fare cosa su questo nodo, o che tocca la sua
// identita': accoppiare, spaiare, ruotare il token, aggiornare il binario,
// coniare un invito, cambiare i ruoli.
const GOVERNO = [
  ['/settings', 'GET'],
  ['/settings/config', 'POST'],
  ['/settings/nodes', 'POST'],
  ['/settings/nodes/pair', 'POST'],
  ['/settings/nodes/vps', 'PATCH'],
  ['/settings/nodes/vps', 'DELETE'],
  ['/settings/nodes/vps/share', 'PATCH'],
  ['/settings/nodes/vps/visibility', 'PATCH'],
  ['/settings/nodes/vps/up', 'POST'],
  ['/settings/nodes/vps/down', 'POST'],
  ['/settings/nodes/vps/restart', 'POST'],
  ['/settings/nodes/vps/test', 'POST'],
  ['/settings/node-role', 'POST'],
  ['/settings/node-aliases', 'GET'],
  ['/settings/peering/invite', 'POST'],
  ['/settings/token/rotate', 'POST'],
  ['/settings/service/regenerate', 'POST'],
  ['/settings/update/check', 'POST'],
  ['/settings/update/apply', 'POST'],
  ['/settings/audio/consent', 'PATCH'],
];

test('nessuna via di governo e\' raggiungibile dalla federazione', () => {
  for (const [resource, method] of GOVERNO) {
    assert.equal(fed.allowedResource(resource, method), false,
      `${method} ${resource} non deve essere federata`);
    // E non deve nemmeno essere INDIRIZZABILE: `parseRoute` la rifiuta prima,
    // cosi' il rifiuto non dipende dal solo controllo sul verbo.
    assert.equal(fed.parseRoute(`/vps/_${resource}`), null,
      `/vps/_${resource} non deve nemmeno essere indirizzabile`);
  }
});

test('il consenso audio resta LOCALE anche se il resto dell\'audio e\' federato', () => {
  // Distinzione che si perde facilmente: parlare e zittire attraversano la
  // federazione di proposito, dare il CONSENSO no. Chi puo' concedere a un nodo
  // di usare l'altoparlante di una stanza fisica deve stare in quella stanza.
  assert.equal(fed.allowedResource('/audio/speak', 'POST'), true);
  assert.equal(fed.allowedResource('/audio/stop', 'POST'), true);
  assert.equal(fed.allowedResource('/settings/audio/consent', 'PATCH'), false);
});

test('il rifiuto vale per OGNI verbo, non solo per quello previsto', () => {
  // Una risorsa di governo non deve diventare raggiungibile perche' qualcuno
  // prova un metodo diverso da quello che il router locale espone.
  for (const resource of ['/settings/token/rotate', '/settings/update/apply', '/settings/peering/invite']) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(fed.allowedResource(resource, method), false, `${method} ${resource}`);
    }
  }
});

test('il confine e\' dichiarato: l\'ammissione VL E\' federata, e questo test non la copre', () => {
  // Non e' un difetto trovato qui, e non lo chiudo io: e' una scelta di disegno
  // preesistente. Ma se un giorno cambiasse — in un verso o nell'altro — deve
  // cambiare con qualcuno che se ne accorge, non in silenzio.
  assert.equal(fed.allowedResource('/vl-nodes/invite', 'POST'), true,
    'oggi e\' federata di proposito; se diventasse locale, aggiornare qui e nel modello di autorita\'');
  assert.equal(fed.allowedResource('/settings/peering/invite', 'POST'), false,
    'l\'invito PEER resta locale: e\' la capacita\' che ammette un proprietario');
});

test('la lista qui sopra non e\' un elenco morto: le vie NON di governo passano', () => {
  // Se questo test fallisse insieme agli altri, vorrebbe dire che ho rotto la
  // federazione invece di averla verificata — e i tre test sopra sarebbero verdi
  // per la ragione sbagliata.
  assert.equal(fed.allowedResource('/sessions', 'GET'), true);
  assert.equal(fed.allowedResource('/fleet/status', 'GET'), true);
  assert.equal(fed.allowedResource('/notify', 'POST'), true);
  assert.deepEqual(fed.parseRoute('/vps/_/fleet/status'), { route: ['vps'], resource: '/fleet/status' });
});
