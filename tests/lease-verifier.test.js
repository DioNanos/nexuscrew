'use strict';
// Fetta 2b — verifier per-installazione e proof HMAC (contratto rev1, sezioni
// B1/B4/B7/B8, C4/C5). Il modello: solo il server conosce il segreto; il
// supervisore/child presenta un proof firmato con claims ed expiry.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PROOF_TTL_MS, canonicalProofFields, loadOrCreateVerifier, fingerprintOf,
  signProof, verifyProof,
} = require('../lib/fleet/lease-verifier.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'leasever-')); }

// --- B4: codifica canonica length-prefixed, proofKind primo tag --------------

test('canonica: proofKind e il primo campo codificato (B4)', () => {
  const enc = canonicalProofFields(['lease', 'cellA', 'epoch1']);
  const kindLen = enc.readUInt32BE(0);
  assert.equal(kindLen, 'lease'.length);
  assert.equal(enc.subarray(4, 4 + kindLen).toString('utf8'), 'lease');
});

test('canonica: length-prefix disambigua i confini dei campi (nessun separatore ambiguo)', () => {
  // La proprieta' che la canonizzazione JSON non ha: due tuple con campi
  // «tagliati» diversamente producano byte DIVERSI. Con il length-prefix il
  // confine e' dichiarato, non dedotto da un separatore.
  const a = canonicalProofFields(['ab', 'c']);
  const b = canonicalProofFields(['a', 'bc']);
  assert.notEqual(a.toString('hex'), b.toString('hex'));
  // E la disambiguazione vale anche con il separatore newline DENTRO un campo.
  const c = canonicalProofFields(['a\nb', 'c']);
  const d = canonicalProofFields(['a', 'b\nc']);
  assert.notEqual(c.toString('hex'), d.toString('hex'));
});

test('canonica: u32 BE length prefix, ricostruibile campo per campo', () => {
  const enc = canonicalProofFields(['lease', 'cellA', 'epoch1', 'lid1', '7', 'jti', '1000']);
  let off = 0;
  const fields = [];
  while (off < enc.length) {
    const len = enc.readUInt32BE(off); off += 4;
    fields.push(enc.subarray(off, off + len).toString('utf8')); off += len;
  }
  assert.deepEqual(fields, ['lease', 'cellA', 'epoch1', 'lid1', '7', 'jti', '1000']);
});

// --- B7/C5: chiave dedicata 0o600, stato durevole senza segreto ---------------

test('loadOrCreateVerifier: chiave dedicata 0600, idempotente, derivabile', () => {
  const dir = tmpdir();
  const v1 = loadOrCreateVerifier({ dir });
  const v2 = loadOrCreateVerifier({ dir });
  assert.equal(v1.secret, v2.secret);
  assert.equal(v1.keyId, v2.keyId);
  const st = fs.lstatSync(path.join(dir, 'lease-verifier.key'));
  assert.equal(st.mode & 0o777, 0o600);
  // keyId derivato dall'impronta: stessa chiave, stesso id, senza stato extra.
  assert.equal(v1.keyId, fingerprintOf(v1.secret).slice(0, 16));
});

test('loadOrCreateVerifier: rigenera il meta se assente, senza toccare la chiave', () => {
  const dir = tmpdir();
  const v1 = loadOrCreateVerifier({ dir });
  fs.unlinkSync(path.join(dir, 'lease-verifier.json'));
  const v2 = loadOrCreateVerifier({ dir });
  assert.equal(v1.secret, v2.secret);
  assert.ok(fs.existsSync(path.join(dir, 'lease-verifier.json')));
});

test('C5: lo stato durevole contiene id e impronta, MAI il segreto', () => {
  const dir = tmpdir();
  const v = loadOrCreateVerifier({ dir });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'lease-verifier.json'), 'utf8'));
  assert.equal(meta.keyId, v.keyId);
  assert.equal(meta.fingerprint, fingerprintOf(v.secret));
  // Il segreto compare in UN solo file della dir: la chiave stessa.
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const offenders = files.filter((f) => {
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    return f !== 'lease-verifier.key' && body.includes(v.secret);
  });
  assert.deepEqual(offenders, []);
});

// --- B8/C4: firma e verifica ---------------------------------------------------

test('signProof/verifyProof: roundtrip con claims attesi e keyId osservabile', () => {
  const dir = tmpdir();
  const v = loadOrCreateVerifier({ dir });
  const claims = { kind: 'lease', cellId: 'Research', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16), generation: '3', jti: 'c'.repeat(16), issuedAt: 10_000 };
  const proof = signProof(v, claims, { now: () => 10_000 });
  assert.equal(proof.expiresAt, 10_000 + PROOF_TTL_MS);
  const out = verifyProof([v], proof, { now: () => 10_500, expect: { kind: 'lease', cellId: 'Research', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16) } });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.keyId, v.keyId);
  assert.equal(out.claims.generation, '3');
});

test('B8: expiry = issuedAt + 60s, calcolabile all emissione', () => {
  assert.equal(PROOF_TTL_MS, 60_000);
  const dir = tmpdir();
  const v = loadOrCreateVerifier({ dir });
  const claims = { kind: 'child', cellId: 'Dev', incarnationId: 'd'.repeat(16), jti: 'e'.repeat(16), issuedAt: 5_000 };
  const proof = signProof(v, claims, { now: () => 5_000 });
  // Vivo un attimo prima della scadenza, morto alla scadenza (fail-closed, >=).
  assert.equal(verifyProof([v], proof, { now: () => 5_000 + PROOF_TTL_MS - 1, expect: { kind: 'child', cellId: 'Dev' } }).ok, true);
  const dead = verifyProof([v], proof, { now: () => 5_000 + PROOF_TTL_MS, expect: { kind: 'child', cellId: 'Dev' } });
  assert.equal(dead.ok, false);
  assert.equal(dead.reason, 'expired');
});

test('verifyProof fail-closed: kind, claims attesi, firma, coerenza expiry', () => {
  const dir = tmpdir();
  const v = loadOrCreateVerifier({ dir });
  const claims = { kind: 'lease', cellId: 'Research', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16), generation: '0', jti: 'c'.repeat(16), issuedAt: 1_000 };
  const proof = signProof(v, claims, { now: () => 1_000 });
  const base = { now: () => 1_100 };
  // proofKind e' parte dei claims firmati: un proof lease non vale come child.
  assert.equal(verifyProof([v], proof, { ...base, expect: { kind: 'child', cellId: 'Research' } }).reason, 'kind');
  // claims attesi: cellId / launchEpoch / leaseId.
  assert.equal(verifyProof([v], proof, { ...base, expect: { kind: 'lease', cellId: 'Altro' } }).reason, 'cellId');
  assert.equal(verifyProof([v], proof, { ...base, expect: { kind: 'lease', cellId: 'Research', launchEpoch: 'f'.repeat(16) } }).reason, 'launchEpoch');
  assert.equal(verifyProof([v], proof, { ...base, expect: { kind: 'lease', cellId: 'Research', launchEpoch: 'a'.repeat(16), leaseId: 'z'.repeat(16) } }).reason, 'leaseId');
  // Firma manomessa.
  const bad = { ...proof, proof: '0'.repeat(64) };
  assert.equal(verifyProof([v], bad, { ...base, expect: { kind: 'lease', cellId: 'Research', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16) } }).reason, 'bad-proof');
  // claims manomessi dopo la firma.
  const tampered = { ...proof, generation: '99' };
  assert.equal(verifyProof([v], tampered, { ...base, expect: { kind: 'lease', cellId: 'Research', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16) } }).reason, 'bad-proof');
  // expiresAt contraffatto (non coerente con issuedAt+TTL).
  const tamperedExp = { ...proof, expiresAt: proof.expiresAt + 60_000 };
  assert.equal(verifyProof([v], tamperedExp, { ...base, expect: { kind: 'lease', cellId: 'Research', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16) } }).reason, 'malformed');
  // issuedAt nel futuro oltre la tolleranza di clock.
  const future = signProof(v, { ...claims, issuedAt: 999_999 }, { now: () => 999_999 });
  assert.equal(verifyProof([v], future, { now: () => 1_100, expect: { kind: 'lease', cellId: 'Research', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16) } }).reason, 'expired');
});

test('C2-ready: la verifica prova TUTTE le chiavi vive (due insieme)', () => {
  const dir = tmpdir();
  const cur = loadOrCreateVerifier({ dir });
  const prev = loadOrCreateVerifier({ dir: path.join(dir, 'altra') });
  assert.notEqual(cur.keyId, prev.keyId);
  const proofCur = signProof(cur, { kind: 'child', cellId: 'Dev', incarnationId: 'd'.repeat(16), jti: 'e'.repeat(16), issuedAt: 1_000 }, { now: () => 1_000 });
  const proofPrev = signProof(prev, { kind: 'child', cellId: 'Dev', incarnationId: 'd'.repeat(16), jti: 'f'.repeat(16), issuedAt: 1_000 }, { now: () => 1_000 });
  const both = [cur, prev];
  const o1 = verifyProof(both, proofCur, { now: () => 1_100, expect: { kind: 'child', cellId: 'Dev' } });
  const o2 = verifyProof(both, proofPrev, { now: () => 1_100, expect: { kind: 'child', cellId: 'Dev' } });
  assert.equal(o1.ok, true);
  assert.equal(o1.keyId, cur.keyId);
  assert.equal(o2.ok, true);
  assert.equal(o2.keyId, prev.keyId); // osservabile QUALE chiave ha verificato (C6)
});

test('forma: campi della tupla obbligatori per kind (B6: leaseId nel kind lease)', () => {
  const dir = tmpdir();
  const v = loadOrCreateVerifier({ dir });
  // lease senza leaseId non e' una tupla firmabile.
  assert.throws(() => signProof(v, { kind: 'lease', cellId: 'C', launchEpoch: 'a'.repeat(16), generation: '0', jti: 'c'.repeat(16), issuedAt: 1 }, { now: () => 1 }));
  // kind sconosciuto rifiutato alla firma.
  assert.throws(() => signProof(v, { kind: 'misto', cellId: 'C', jti: 'c'.repeat(16), issuedAt: 1 }, { now: () => 1 }));
  // oggetto proof senza campi -> malformed, non crash.
  assert.equal(verifyProof([v], {}, { now: () => 1 }).reason, 'malformed');
  assert.equal(verifyProof([v], null, { now: () => 1 }).reason, 'malformed');
});

test('graceMs (recovery): proof scaduto accettato SOLO entro la finestra dichiarata', () => {
  const dir = tmpdir();
  const v = loadOrCreateVerifier({ dir });
  const claims = { kind: 'child', cellId: 'Dev', incarnationId: 'd'.repeat(16), jti: 'e'.repeat(16), issuedAt: 1_000 };
  const proof = signProof(v, claims, { now: () => 1_000 });
  const expect = { kind: 'child', cellId: 'Dev', incarnationId: 'd'.repeat(16) };
  // Scaduto senza finestra: expired (invariato).
  assert.equal(verifyProof([v], proof, { now: () => 1_000 + PROOF_TTL_MS, expect }).reason, 'expired');
  // Con finestra 60s: accettato fino a expiresAt+60s-1, negato oltre.
  const inGrace = verifyProof([v], proof, { now: () => 1_000 + PROOF_TTL_MS + 59_999, expect, graceMs: 60_000 });
  assert.equal(inGrace.ok, true);
  const beyond = verifyProof([v], proof, { now: () => 1_000 + PROOF_TTL_MS + 60_000, expect, graceMs: 60_000 });
  assert.equal(beyond.ok, false);
  assert.equal(beyond.reason, 'expired');
  // La finestra NON degrada gli altri check: firma cattiva resta cattiva.
  assert.equal(verifyProof([v], { ...proof, proof: '0'.repeat(64) }, { now: () => 1_000 + 100, expect, graceMs: 60_000 }).reason, 'bad-proof');
});
