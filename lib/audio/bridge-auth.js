'use strict';
// lib/audio/bridge-auth.js — confine di identita' del bridge MCP, separato dal
// token della UI.
//
// Il problema che risolve. Il bridge (`nexuscrew mcp`) parla con l'API locale
// usando lo STESSO Bearer della UI: quel token prova "qualcuno in loopback ha il
// token", non "questa e' la cella X". Finche' l'origine viene dichiarata nel
// body (`{session}`) chiunque possieda il token — inclusa la pagina web aperta
// nel browser — puo' attribuire un enunciato a una cella qualsiasi. Per Audio
// Share l'origine e' un dato di sicurezza (rate limit, ACL, attribuzione del
// receipt), quindi serve una prova che il Bearer non puo' dare.
//
// Il confine. Un segreto dedicato, distinto dal token UI, in un file 0600 creato
// in modo esclusivo e anti-symlink (stessa disciplina di lib/auth/token.js), e
// una firma HMAC-SHA256 timing-safe su un payload canonico che lega metodo,
// path, sessione dichiarata, timestamp, nonce e hash del body grezzo. Il body e'
// coperto per BYTE, non per forma: si firma il buffer effettivamente trasmesso,
// non un JSON ri-serializzato con un ordine di chiavi diverso.
//
// Anti-replay. Finestra temporale bounded piu' cache dei nonce bounded: un nonce
// vale una volta sola dentro la finestra, la cache non cresce senza limite e non
// ha bisogno di persistenza. Il segreto non compare mai in risposte, log o
// errori: la verifica ritorna un codice di motivo, e la route risponde comunque
// un 401 generico, per non trasformare la diagnostica in un oracolo.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PREFIX = 'NEXUSCREW-AUDIO-BRIDGE-V1';
const SESSION_HEADER = 'x-nexuscrew-audio-session';
const TS_HEADER = 'x-nexuscrew-audio-ts';
const NONCE_HEADER = 'x-nexuscrew-audio-nonce';
const PROOF_HEADER = 'x-nexuscrew-audio-proof';

// Finestra di validita': +-60s copre lo skew fra processi sulla stessa macchina
// senza tenere un nonce vivo abbastanza a lungo da far crescere la cache.
const SKEW_MS = 60 * 1000;
const NONCE_CAP = 4096;
const NONCE_RE = /^[a-f0-9]{32}$/i;
const PROOF_RE = /^[a-f0-9]{64}$/i;

function bridgeSecretPath(cfg = {}, home = (cfg && cfg.home) || os.homedir()) {
  return (cfg && cfg.audioBridgeSecretPath) || path.join(home, '.nexuscrew', 'audio-bridge.key');
}

// Lettura no-follow: un symlink al posto del file e' un rifiuto, non un
// redirect silenzioso verso un segreto scelto da altri.
function readBridgeSecretSafe(secretPath) {
  const st = fs.lstatSync(secretPath);
  if (st.isSymbolicLink()) throw new Error(`refusing symlink bridge secret path: ${secretPath}`);
  if (!st.isFile()) return null;
  const s = fs.readFileSync(secretPath, 'utf8').trim();
  return s || null;
}

// Create esclusivo (flag 'wx') + 0600. Preserva un segreto esistente valido, e
// sulla race EEXIST rilegge quello dell'altro processo invece di sovrascriverlo:
// due bridge avviati insieme devono convergere sullo stesso segreto.
function loadOrCreateBridgeSecret(secretPath) {
  try {
    const existing = readBridgeSecretSafe(secretPath);
    if (existing) return existing;
    fs.unlinkSync(secretPath); // file vuoto: ricrea esclusivo
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(secretPath, `${secret}\n`, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') {
      const other = readBridgeSecretSafe(secretPath);
      if (other) return other;
    }
    throw e;
  }
  fs.chmodSync(secretPath, 0o600);
  return secret;
}

function bodyDigest(rawBody) {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody === undefined || rawBody === null ? '' : String(rawBody));
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Payload canonico: campi separati da newline in ordine fisso. Nessun campo puo'
// contenere un newline (session/nonce/ts sono validati a monte), quindi la
// concatenazione non e' ambigua.
function canonicalRequest({ method, path: reqPath, session, timestamp, nonce, rawBody }) {
  return [
    PREFIX,
    String(method || '').toUpperCase(),
    String(reqPath || ''),
    String(session || ''),
    String(timestamp || ''),
    String(nonce || ''),
    bodyDigest(rawBody),
  ].join('\n');
}

function signRequest(secret, parts) {
  return crypto.createHmac('sha256', String(secret)).update(canonicalRequest(parts)).digest('hex');
}

// Header pronti per il client del bridge: un solo posto genera nonce/timestamp e
// firma, cosi' bridge e server non possono divergere sul formato.
function signedHeaders(secret, { method, path: reqPath, session, rawBody, now = Date.now, nonce = null }) {
  const timestamp = String(now());
  const n = nonce || crypto.randomBytes(16).toString('hex');
  return {
    [SESSION_HEADER]: String(session),
    [TS_HEADER]: timestamp,
    [NONCE_HEADER]: n,
    [PROOF_HEADER]: signRequest(secret, { method, path: reqPath, session, timestamp, nonce: n, rawBody }),
  };
}

// Cache nonce bounded. TTL = 2x la finestra di skew: oltre quella soglia il
// timestamp e' gia' rifiutato, quindi ricordare il nonce non serve piu'. Il cap
// e' un tetto duro: si eliminano prima gli scaduti, poi i piu' vecchi.
function createNonceCache({ now = Date.now, cap = NONCE_CAP, ttlMs = SKEW_MS * 2 } = {}) {
  const seen = new Map(); // nonce -> firstSeenMs
  function prune(t) {
    for (const [n, at] of seen) if (t - at > ttlMs) seen.delete(n);
    while (seen.size > cap) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }
  return {
    // true = nonce accettato (primo uso); false = replay.
    use(nonce) {
      const t = now();
      prune(t);
      if (seen.has(nonce)) return false;
      seen.set(nonce, t);
      prune(t);
      return true;
    },
    size: () => seen.size,
  };
}

// verifyRequest(): ordine deliberato. Prima la forma degli header (rifiuto
// gratuito, nessun HMAC calcolato), poi la finestra temporale, poi l'HMAC, e
// SOLO alla fine il consumo del nonce: un nonce non deve essere bruciato da una
// firma sbagliata, altrimenti un terzo potrebbe invalidare richieste legittime
// indovinando i nonce.
function verifyRequest({ secret, method, path: reqPath, headers = {}, rawBody, nonceCache, now = Date.now, skewMs = SKEW_MS }) {
  if (!secret) return { ok: false, reason: 'no-secret' };
  const session = headers[SESSION_HEADER];
  const ts = headers[TS_HEADER];
  const nonce = headers[NONCE_HEADER];
  const proof = headers[PROOF_HEADER];
  if (typeof session !== 'string' || !session || session.includes('\n')) return { ok: false, reason: 'malformed' };
  if (typeof ts !== 'string' || !/^\d{1,15}$/.test(ts)) return { ok: false, reason: 'malformed' };
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return { ok: false, reason: 'malformed' };
  if (typeof proof !== 'string' || !PROOF_RE.test(proof)) return { ok: false, reason: 'malformed' };
  const delta = now() - Number(ts);
  if (!Number.isFinite(delta) || Math.abs(delta) > skewMs) return { ok: false, reason: 'expired' };
  const expected = signRequest(secret, { method, path: reqPath, session, timestamp: ts, nonce, rawBody });
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(proof.toLowerCase(), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-proof' };
  if (nonceCache && !nonceCache.use(nonce)) return { ok: false, reason: 'replay' };
  return { ok: true, session };
}

module.exports = {
  bridgeSecretPath, readBridgeSecretSafe, loadOrCreateBridgeSecret,
  canonicalRequest, signRequest, signedHeaders, verifyRequest, createNonceCache, bodyDigest,
  SESSION_HEADER, TS_HEADER, NONCE_HEADER, PROOF_HEADER, SKEW_MS, NONCE_CAP,
};
