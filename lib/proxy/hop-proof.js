'use strict';
// lib/proxy/hop-proof.js — prova che una richiesta arrivata su /api e' l'ULTIMO
// hop di una route federata generata da QUESTO processo, non un POST diretto di
// un client locale che ha semplicemente scritto gli header a mano.
//
// Perche' serve. `controlledVisited()` lega gia' `x-nexuscrew-visited` al peer
// autenticato dal suo acceptToken, ma l'ultimo hop entra in `/api/<resource>`
// con il Bearer LOCALE: a quel punto l'handler non distingue piu' un inbound
// federato da una richiesta diretta di chiunque possieda il token della UI.
// `cleanHeaders()` cancella gia' `x-nexuscrew-{route,visited,hop}` da ogni
// header in ingresso, quindi il canale e' riservato: basta renderlo non
// riproducibile. La firma usa un segreto casuale per-processo, mai su disco,
// mai esposto da un'API: un client locale non puo' calcolarla.
//
// Il payload firmato include metodo e path oltre alla catena visited, cosi' una
// prova non e' trasportabile su un'altra risorsa o su un altro verbo.
const crypto = require('node:crypto');

const HOP_HEADER = 'x-nexuscrew-hop';
const PREFIX = 'NEXUSCREW-HOP-V1';

function createHopSecret() {
  return crypto.randomBytes(32);
}

function canonicalHop({ method, path: reqPath, visited }) {
  const chain = Array.isArray(visited) ? visited.join(',') : String(visited || '');
  return `${PREFIX}\n${String(method || '').toUpperCase()}\n${String(reqPath || '')}\n${chain}`;
}

// signHop(): hex HMAC-SHA256. Ritorna null senza segreto, cosi' un server che
// non ha inizializzato la prova non emette un header vuoto interpretabile.
function signHop(secret, parts) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(canonicalHop(parts)).digest('hex');
}

// verifyHop(): confronto timing-safe. Fail-closed su qualunque anomalia
// (segreto assente, header assente, lunghezza diversa, hex non valido).
function verifyHop(secret, parts, proof) {
  if (!secret || typeof proof !== 'string' || !/^[a-f0-9]{64}$/i.test(proof)) return false;
  const expected = signHop(secret, parts);
  if (!expected) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(proof.toLowerCase(), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { createHopSecret, signHop, verifyHop, canonicalHop, HOP_HEADER };
