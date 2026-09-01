'use strict';
// lib/nodes/identity.js — la chiave di questo nodo, e cosa sappiamo delle altrui.
//
// Primo passo del modello di autorita' per-nodo, e il piu' modesto: «chiavi per
// nodo e directory delle pubbliche, nessun effetto sui permessi». Quella
// clausola e' un vincolo, non una nota: qui si OSSERVA e si REGISTRA, non si
// concede e non si nega. Nessuna via cambia comportamento perche' una chiave
// c'e' o non c'e'.
//
// PERCHE' UN PASSO CHE NON CAMBIA NULLA VALE COMUNQUE. Tutto il modello poggia
// su una proprieta' sola: che `holderKey` identifichi davvero un titolare. Se
// l'identita' di un peer potesse cambiare in silenzio, i grant dei passi 3-5
// sarebbero legati a un nome che chiunque puo' prendersi, e nessuna firma
// varrebbe niente. Quella proprieta' si guadagna adesso, osservando presto e a
// lungo, o non si guadagna piu': una chiave legata oggi ha una storia domani.
//
// LA REGOLA: una chiave gia' legata NON viene mai sovrascritta. La prima
// osservazione lega (TOFU), una successiva diversa e' un CONFLITTO che si
// registra e si mostra. Sovrascrivere sarebbe comodo — il peer ha reinstallato,
// ha rigenerato, e' tutto normale — ed e' esattamente il comportamento che
// rende l'identita' inutile: chi sa rispondere a un probe diventerebbe il peer.
//
// STATO REALE, perche' non si creda piu' di cio' che c'e': OGGI IL PAIRING E'
// L'UNICO SCRITTORE di chiavi, e scrive inline in `/pair/confirm` e nel
// coordinatore. `observePeerKey` NON HA CHIAMANTI: e' la primitiva del primo
// percorso che imparera' una chiave FUORI dal pairing, e arriva con lui. Fino
// ad allora nessuna chiave puo' essere sovrascritta perche' non esiste un
// secondo scrittore — la proprieta' regge per assenza, non per controllo, e la
// differenza va detta invece che lasciata credere.
//
// Rilievo della revisione indipendente: una funzione provata e senza chiamanti e' il
// segnale piu' forte che una garanzia esista, ed e' il piu' facile da dare per
// sbaglio.
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

// La chiave vive accanto a nodes.json, non accanto alla home: chi ha gia' un
// `nodesPath` — le route, il coordinatore di pairing, ogni test con una home
// finta — non deve ricostruire una home da cui e' gia' derivato. Derivare due
// volte lo stesso percorso da due basi diverse e' il modo in cui un test passa
// su un file e la produzione ne usa un altro.
function keyPathNextTo(nodesPath) {
  return path.join(path.dirname(nodesPath), KEY_BASENAME);
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
  // UN FILE CHE ESISTE MA NON E' USABILE FA RUMORE, NON SI SOSTITUISCE.
  // Uno schema errato e un JSON corrotto sono due forme dello stesso stato non
  // usabile: entrambi devono fare rumore e nessuno deve autorizzare una nuova
  // chiave. Rigenerare cambia l'identita' del nodo e lascia ogni peer gia'
  // associato con una chiave che non corrisponde. Il ramo sicuro si ferma e
  // rende esplicita la causa senza sostituire il file.
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`node-key.json illeggibile (${e.message}): `
      + 'non lo sostituisco da solo, perche\' rigenerare cambierebbe l\'identita\' di questo nodo');
  }
  const rotto = !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.schemaVersion !== KEY_SCHEMA_VERSION
    || typeof parsed.privateKeyPem !== 'string' || !parsed.privateKeyPem.includes('PRIVATE KEY');
  if (rotto) {
    throw new Error('node-key.json non ha la forma attesa: '
      + 'non lo sostituisco da solo, perche\' rigenerare cambierebbe l\'identita\' di questo nodo');
  }
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
// `afterWriteSeam` e' un seam di prova, come `sessionExistsSeam` e `fleetSeam`
// altrove: viene chiamato subito dopo la scrittura e rende deterministico il
// punto della corsa. Senza il seam, il test puo' osservare un file gia'
// esistente e non esercitare mai il percorso di CREAZIONE; il controllo
// negativo deve quindi fissare esplicitamente quel punto.
function ensureNodeKey({ home, keyPath, afterWriteSeam } = {}) {
  const p = keyPath || keyPathFor(home);
  const existing = readKeyFile(p);
  if (existing) {
    const privateKey = crypto.createPrivateKey(existing.privateKeyPem);
    return { publicKey: publicKeyFromPrivate(privateKey), privateKey, path: p, created: false };
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  writeKeyFile(p, pem);
  if (typeof afterWriteSeam === 'function') afterWriteSeam(p);

  // SI RILEGGE DAL DISCO invece di restituire la chiave appena generata, e non
  // e' pignoleria: due processi che partono insieme sulla PRIMA creazione
  // vedono entrambi il file assente, generano due chiavi diverse e i due rename
  // si sovrascrivono. Chi perde la corsa restituirebbe in memoria una chiave
  // che sul disco non esiste piu' — e se nel frattempo l'ha mandata a un peer
  // dentro un pairing, quel peer lega un'identita' che non potremo mai
  // dimostrare: da li' in poi ogni nostra chiave gli risulta un conflitto, per
  // sempre, ed e' esattamente il guasto che questo modulo esiste per impedire.
  // Rileggendo, i due processi convergono su chi ha vinto il rename.
  const suDisco = readKeyFile(p);
  const effettiva = suDisco ? crypto.createPrivateKey(suDisco.privateKeyPem) : privateKey;
  return { publicKey: publicKeyFromPrivate(effettiva), privateKey: effettiva, path: p, created: true };
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
  keyPathNextTo,
  PUBLIC_KEY_RE,
};
