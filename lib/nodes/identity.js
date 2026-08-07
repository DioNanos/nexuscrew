'use strict';
// lib/nodes/identity.js — la chiave di questo nodo, e cosa sappiamo delle altrui.
//
// Passo 1 del modello di autorita' (DocsHub 2026-08-04_NODE_AUTHORITY_MODEL_v3,
// §8.1). Il documento lo descrive in una riga — «chiavi per nodo e directory
// delle pubbliche. Nessun effetto sui permessi» — e quella riga e' un vincolo,
// non una nota: qui si OSSERVA e si REGISTRA, non si concede e non si nega.
// Nessuna via cambia comportamento perche' una chiave c'e' o non c'e'.
//
// PERCHE' UN PASSO CHE NON CAMBIA NULLA VALE COMUNQUE. Tutto il modello poggia
// su una proprieta' sola: che `holderKey` identifichi davvero un titolare. Se
// l'identita' di un peer potesse cambiare in silenzio, i grant dei passi 3-5
// sarebbero legati a un nome che chiunque puo' prendersi, e nessuna firma
// varrebbe niente. Quella proprieta' si guadagna adesso, osservando presto e a
// lungo, o non si guadagna piu': una chiave legata oggi ha una storia domani.
//
// LA REGOLA CHE DA' VALORE AL PASSO: una chiave gia' legata NON viene mai
// sovrascritta. La prima osservazione lega (TOFU), una successiva diversa e' un
// CONFLITTO che si registra e si mostra. Sovrascrivere sarebbe comodo — il peer
// ha reinstallato, ha rigenerato, e' tutto normale — ed e' esattamente il
// comportamento che rende l'identita' inutile: chi sa rispondere a un probe
// diventerebbe il peer. Un conflitto lo risolve l'operatore, mai il codice.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Ed25519 grezza: 32 byte, in base64url. Lunghezza fissa, niente PEM sul filo,
// niente ambiguita' di codifica fra due implementazioni.
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const KEY_BASENAME = 'node-key.json';
const KEY_SCHEMA_VERSION = 1;

function keyPathFor(home) {
  return path.join(home, '.nexuscrew', KEY_BASENAME);
}

// La privata sta in un file SUO, non dentro nodes.json. Non e' pignoleria:
// nodes.json viene letto dalla redazione, dal backup, da `nodes inspect` e
// dalle viste condivise. Tenerla fuori per COSTRUZIONE vale piu' di ricordarsi
// di redigerla in cinque punti — dimenticarne uno la pubblicherebbe, e una
// privata pubblicata una volta e' bruciata per sempre.
function readKeyFile(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  // Un symlink qui e' un modo per farci scrivere altrove o per farci leggere
  // una chiave che non e' la nostra. Stessa disciplina di atomicWriteStore.
  if (st.isSymbolicLink()) throw new Error('node-key.json e\' un symlink: rifiuto di usarlo');
  if (!st.isFile()) throw new Error('node-key.json non e\' un file regolare');
  // Se il file e' leggibile da gruppo o altri, la chiave e' gia' potenzialmente
  // fuori. Non la si usa fingendo che vada bene, e non la si "ripara" in
  // silenzio: un chmod nostro nasconderebbe che qualcuno l'ha letta.
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`node-key.json ha permessi ${(st.mode & 0o777).toString(8)}: `
      + 'la chiave privata e\' leggibile oltre il proprietario, va rigenerata a mano');
  }
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.schemaVersion !== KEY_SCHEMA_VERSION) return null;
  if (typeof parsed.privateKeyPem !== 'string' || !parsed.privateKeyPem.includes('PRIVATE KEY')) return null;
  return parsed;
}

// La pubblica si DERIVA dalla privata a ogni caricamento, e non si conserva
// accanto. Due copie della stessa cosa possono divergere, e una pubblica che
// non corrisponde alla privata e' un'identita' che firma e non verifica —
// il genere di guasto che si scopre solo quando serve.
function publicKeyFromPrivate(privateKey) {
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('chiave del nodo non Ed25519');
  }
  return jwk.x;
}

function writeKeyFile(p, privateKeyPem) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${KEY_BASENAME}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({
      schemaVersion: KEY_SCHEMA_VERSION,
      privateKeyPem,
    }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // 0600 a prescindere da umask
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
    throw e;
  }
}

// ensureNodeKey: idempotente. La prima chiamata genera, le successive leggono.
// `created` distingue i due casi per chi vuole registrarlo una volta sola.
function ensureNodeKey({ home, keyPath } = {}) {
  const p = keyPath || keyPathFor(home);
  const existing = readKeyFile(p);
  if (existing) {
    const privateKey = crypto.createPrivateKey(existing.privateKeyPem);
    return { publicKey: publicKeyFromPrivate(privateKey), privateKey, path: p, created: false };
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  writeKeyFile(p, pem);
  return { publicKey: publicKeyFromPrivate(privateKey), privateKey, path: p, created: true };
}

function isPublicKey(value) {
  return typeof value === 'string' && PUBLIC_KEY_RE.test(value);
}

// observePeerKey — il cuore del passo, ed e' quattro righe di logica e un
// invariante. Torna un nodo NUOVO (non muta l'ingresso) e l'esito osservato.
//
//   'bound'     la prima volta: si lega e si registra COME e QUANDO
//   'unchanged' la chiave e' quella di prima
//   'conflict'  e' arrivata una chiave DIVERSA. Non si sovrascrive nulla.
//
// `source` ('pairing' | 'peer-assertion') non e' decorazione: al passo 3 un
// grant potra' pretendere una chiave legata AL PAIRING, cioe' nello stesso atto
// in cui l'operatore ha deciso di fidarsi, e non una arrivata dopo su un canale
// che il peer stesso controlla. Se non lo registriamo adesso, quella
// distinzione non e' piu' ricostruibile.
function observePeerKey(node, { publicKey, source = 'peer-assertion', now = Date.now() } = {}) {
  if (!isPublicKey(publicKey)) return { node, outcome: 'invalid' };
  if (!node.publicKey) {
    return {
      node: { ...node, publicKey, keySource: source, keyBoundAt: new Date(now).toISOString() },
      outcome: 'bound',
    };
  }
  if (node.publicKey === publicKey) {
    // Una chiave gia' legata al pairing non viene "promossa" ne' declassata da
    // un'osservazione successiva: la provenienza e' quella del legame, non
    // dell'ultima volta che l'abbiamo rivista.
    return { node, outcome: 'unchanged' };
  }
  // Conflitto. Si conserva il primo legame e si registra cosa e' arrivato,
  // perche' l'operatore possa decidere: un peer reinstallato e una sostituzione
  // di identita' hanno la stessa forma sul filo, e a distinguerli non e' il
  // codice ma chi sa cosa e' successo a quel dispositivo.
  return {
    node: { ...node, keyConflict: { seen: publicKey, at: new Date(now).toISOString(), source } },
    outcome: 'conflict',
  };
}

// La directory: cosa questo nodo sa delle identita' altrui. Sola lettura,
// nessun segreto — le pubbliche sono pubbliche, ed e' il punto.
function publicKeyDirectory(store) {
  const nodes = store && Array.isArray(store.nodes) ? store.nodes : [];
  return nodes.map((node) => ({
    name: node.name,
    instanceId: node.nodeId || null,
    publicKey: node.publicKey || null,
    source: node.publicKey ? (node.keySource || 'peer-assertion') : null,
    boundAt: node.keyBoundAt || null,
    conflict: node.keyConflict || null,
  }));
}

module.exports = {
  ensureNodeKey,
  observePeerKey,
  publicKeyDirectory,
  publicKeyFromPrivate,
  isPublicKey,
  keyPathFor,
  PUBLIC_KEY_RE,
};
