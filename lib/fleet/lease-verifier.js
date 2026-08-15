'use strict';

// Verifier per-installazione e proof HMAC del lease Live (fetta 2b, contratto
// rev1: PREMESSA + B1/B4/B6/B7/B8 + C4/C5).
//
// Modello (PREMESSA): la 2a usava un segreto condiviso simmetrico — il
// supervisore presentava la capability cosi' com'e' e il server la confrontava.
// La 2b usa HMAC con verifier per-installazione: SOLO il server conosce il
// segreto, il supervisore/child presenta un proof firmato con claims ed expiry.
// Non e' la 2a con un giro in piu': e' un modello di autorizzazione diverso.
//
//  - B7: la chiave verifier vive in un file DEDICATO separato 0o600, distinto
//    dai token di liveness per-cella e dal segreto del bridge audio. «Un solo
//    segreto» significa una sola chiave verifier, non un solo file segreto nel
//    sistema.
//  - C5: lo stato durevole contiene l'identificativo e l'impronta, MAI il
//    segreto — forma gia' usata da vl-node (PendingEnrollment). Il keyId e'
//    DERIVATO dall'impronta (sha256 della chiave): non esiste uno stato da
//    tenere sincronizzato con la chiave, e il meta su disco e' diagnostica.
//  - B4: la codifica canonica e' length-prefixed con proofKind come primo tag.
//    La canonizzazione JSON e' fragile: due serializzatori onesti producono
//    byte diversi. Il length-prefixing dichiara il confine di ogni campo, non
//    lo deduce da un separatore.
//  - B8: expiry = issuedAt + 60s, calcolabile all'emissione. «Ultimo-live+60»
//    e' la proprieta' che si vuole, non la formula che si scrive: non e'
//    calcolabile nel momento in cui il proof va firmato.
//  - C4: fail-closed sulla verifica. La verifica prova TUTTE le chiavi vive
//    (oggi una sola: la rotazione e' sospesa per scelta dichiarata, contratto
//    C3; la forma e' gia' quella a due chiavi di C2).
//  - C6: la verifica rende osservabile QUALE chiave ha firmato (keyId), cosi'
//    il momento in cui una chiave subentra resta leggibile dopo il fatto.
//
// Disciplina del file segreto: stessa di lib/audio/bridge-auth.js e
// lib/auth/token.js — create esclusivo 'wx' + 0600, lettura no-follow (un
// symlink al posto della chiave e' un rifiuto, non un redirect).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// B8: vita di un proof emesso. Il refresh gira ogni 20s (REFRESH_MS): un proof
// da 60s lascia sempre al detentore >=2 presentazioni legittime di margine.
const PROOF_TTL_MS = 60_000;

// Tolleranza di clock sull'emissione: il proof e' emesso e presentato sulla
// stessa macchina dal server stesso, quindi serve solo un margine minimo.
const ISSUED_AT_SKEW_MS = 1_000;

const KEY_FILE = 'lease-verifier.key';
const META_FILE = 'lease-verifier.json';
const KEY_ID_LEN = 16;
const JTI_RE = /^[a-f0-9]{16,64}$/;
const SIG_RE = /^[a-f0-9]{64}$/;

// Campi firmati per proofKind, IN ORDINE, proofKind primo (B4). Per kind la
// lista e' fissa e tutti i campi sono obbligatori e non vuoti: campo mancante e
// campo vuoto non sono distinguibili nella canonica, quindi non esistono campi
// opzionali. B6: nel kind 'lease' l'identita' del lease e' 'leaseId' — non
// identityKey, che legherebbe il lease all'identita' della cella.
const KIND_FIELDS = Object.freeze({
  // tupla del supervisore: autorizza il reconnect all'endpoint stabile.
  lease: ['kind', 'cellId', 'launchEpoch', 'leaseId', 'generation', 'jti', 'issuedAt'],
  // tupla del child: autorizza register/refresh/recovery (B5). incarnationId e'
  // per-registration (B2), mai globale.
  child: ['kind', 'cellId', 'incarnationId', 'jti', 'issuedAt'],
});

function fingerprintOf(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

// --- B4: codifica canonica ----------------------------------------------------

// Ogni campo: u32 big-endian della lunghezza in byte UTF-8, poi i byte. Il
// proofKind e' il primo tag: chiave di dominio della firma (un proof lease non
// e' riutilizzabile come proof child perche' il kind e' FIRMATO).
function canonicalProofFields(fields) {
  const parts = [];
  for (const f of fields) {
    const b = Buffer.from(String(f), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    parts.push(len, b);
  }
  return Buffer.concat(parts);
}

function claimsForKind(kind) {
  const fields = KIND_FIELDS[kind];
  if (!fields) throw new Error(`proof kind sconosciuto: ${kind}`);
  return fields;
}

// --- B7/C5: chiave per-installazione ------------------------------------------

// Lettura no-follow (anti-symlink), stessa disciplina del bridge secret.
function readKeySafe(fsImpl, keyPath) {
  const st = fsImpl.lstatSync(keyPath);
  if (st.isSymbolicLink()) throw new Error(`rifiuto symlink per la chiave verifier: ${keyPath}`);
  if (!st.isFile()) return null;
  const s = fsImpl.readFileSync(keyPath, 'utf8').trim();
  return s || null;
}

function loadOrCreateVerifier({ dir, fsImpl = fs, log = () => {}, now = Date.now } = {}) {
  const keyPath = path.join(dir, KEY_FILE);
  const metaPath = path.join(dir, META_FILE);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let secret = null;
  try {
    secret = readKeySafe(fsImpl, keyPath);
    if (secret === null) fsImpl.unlinkSync(keyPath); // file vuoto: ricrea esclusivo
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!secret) {
    const fresh = crypto.randomBytes(32).toString('base64url');
    try {
      fsImpl.writeFileSync(keyPath, `${fresh}\n`, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code === 'EEXIST') {
        const other = readKeySafe(fsImpl, keyPath); // race con un altro processo
        if (other) secret = other;
      }
      if (!secret) throw e;
    }
    if (!secret) secret = fresh;
  }
  try { fsImpl.chmodSync(keyPath, 0o600); } catch (_) {}
  // keyId derivato dall'impronta: la chiave porta con se' la propria identita'.
  const keyId = fingerprintOf(secret).slice(0, KEY_ID_LEN);
  // C5: il meta persiste id + impronta (MAI il segreto) per diagnostica e
  // osservabilita' (C6). Best-effort: se e' assente o divergente si riscrive;
  // un fallimento di scrittura non invalida la chiave.
  try {
    const meta = { version: 1, keyId, fingerprint: fingerprintOf(secret), createdAt: now() };
    const existing = (() => { try { return JSON.parse(fsImpl.readFileSync(metaPath, 'utf8')); } catch (_) { return null; } })();
    if (!existing || existing.keyId !== meta.keyId || existing.fingerprint !== meta.fingerprint) {
      fsImpl.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
      try { fsImpl.chmodSync(metaPath, 0o600); } catch (_) {}
    }
  } catch (e) {
    log(`lease-verifier: meta non persistito: ${e && e.message}`);
  }
  return { keyId, secret, fingerprint: fingerprintOf(secret) };
}

// --- firma / verifica ----------------------------------------------------------

function signProof(verifier, claims, { now = Date.now, jti = null } = {}) {
  if (!verifier || typeof verifier.secret !== 'string' || !verifier.secret) {
    throw new Error('verifier mancante');
  }
  const kind = claims && claims.kind;
  const fields = claimsForKind(kind);
  const issuedAt = claims.issuedAt;
  if (!Number.isSafeInteger(issuedAt)) throw new Error('issuedAt intero obbligatorio');
  const values = {};
  for (const f of fields) {
    const v = f === 'issuedAt' ? String(issuedAt) : claims[f];
    if (typeof v !== 'string' || !v.length) throw new Error(`campo firmato "${f}" mancante o vuoto per kind "${kind}"`);
    values[f] = v;
  }
  const finalJti = jti || crypto.randomBytes(8).toString('hex');
  if (!JTI_RE.test(finalJti)) throw new Error('jti malformato');
  values.jti = finalJti;
  const canonical = canonicalProofFields(fields.map((f) => values[f]));
  const sig = crypto.createHmac('sha256', verifier.secret).update(canonical).digest('hex');
  const proof = { ...values, expiresAt: issuedAt + PROOF_TTL_MS, proof: sig };
  return proof;
}

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

// Fail-closed (C4): ogni difetto e' un motivo, non un'eccezione. `verifiers` e'
// la lista delle chiavi vive (oggi una; C2-ready per due). `expect` porta i
// claims che il chiamante gia' conosce: la firma prova il resto.
// `graceMs` (default 0) allarga la finestra di accettazione DOPO la scadenza:
// e' la finestra di recovery del child (B5) — un proof la cui firma e' valida e
// la cui scadenza e' recente NON e' una credenziale rubata riportata in vita, e'
// un detentore che ha saltato i refresh. Ogni altro check resta invariato.
function verifyProof(verifiers, candidate, { now = Date.now, expect = {}, graceMs = 0 } = {}) {
  if (!Array.isArray(verifiers) || verifiers.length === 0) return { ok: false, reason: 'no-keys' };
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reason: 'malformed' };
  const kind = candidate.kind;
  let fields;
  try { fields = claimsForKind(kind); } catch (_) { return { ok: false, reason: 'malformed' }; }
  for (const f of fields) {
    if (!isNonEmptyString(candidate[f])) return { ok: false, reason: 'malformed' };
  }
  if (!JTI_RE.test(candidate.jti)) return { ok: false, reason: 'malformed' };
  if (typeof candidate.proof !== 'string' || !SIG_RE.test(candidate.proof)) return { ok: false, reason: 'malformed' };
  const issuedAt = Number(candidate.issuedAt);
  if (!Number.isSafeInteger(issuedAt)) return { ok: false, reason: 'malformed' };
  const expiresAt = Number(candidate.expiresAt);
  // B8: expiresAt non e' un campo qualunque: deve essere ESATTAMENTE
  // issuedAt + PROOF_TTL_MS. Manometterlo non estende la vita del proof.
  if (!Number.isSafeInteger(expiresAt) || expiresAt !== issuedAt + PROOF_TTL_MS) {
    return { ok: false, reason: 'malformed' };
  }
  const t = now();
  const graceMsNum = Number.isSafeInteger(graceMs) && graceMs >= 0 ? graceMs : 0;
  if (t >= expiresAt + graceMsNum) return { ok: false, reason: 'expired' };
  // Emissione nel futuro oltre la tolleranza: non e' un proof che questo
  // processo ha potuto emettere onestamente.
  if (issuedAt > t + ISSUED_AT_SKEW_MS) return { ok: false, reason: 'expired' };
  // Claims attesi dal chiamante (scope della presentazione).
  if (expect.kind !== undefined && kind !== expect.kind) return { ok: false, reason: 'kind' };
  if (expect.cellId !== undefined && candidate.cellId !== expect.cellId) return { ok: false, reason: 'cellId' };
  if (expect.launchEpoch !== undefined && candidate.launchEpoch !== expect.launchEpoch) return { ok: false, reason: 'launchEpoch' };
  if (expect.leaseId !== undefined && candidate.leaseId !== expect.leaseId) return { ok: false, reason: 'leaseId' };
  if (expect.incarnationId !== undefined && candidate.incarnationId !== expect.incarnationId) return { ok: false, reason: 'incarnationId' };
  // Firma contro OGNI chiave viva: la prima che passa vince (C2/C6).
  const canonical = canonicalProofFields(fields.map((f) => candidate[f]));
  for (const v of verifiers) {
    if (!v || typeof v.secret !== 'string') continue;
    const expected = crypto.createHmac('sha256', v.secret).update(canonical).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(candidate.proof, 'hex');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return { ok: true, claims: { ...candidate }, keyId: v.keyId };
    }
  }
  return { ok: false, reason: 'bad-proof' };
}

module.exports = {
  PROOF_TTL_MS, KIND_FIELDS,
  canonicalProofFields, loadOrCreateVerifier, fingerprintOf, signProof, verifyProof,
};
