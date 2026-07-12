'use strict';
// Logica PURA del ricevitore single-link (frontend/src/lib/pairing-flow.js):
// normalizzazione risultato QR, classificazione completo/parziale/invalido,
// merge nel form, corpo della richiesta, guard anti doppio submit e resa
// strutturata degli errori a stadi (e.data di jsonFetch).
const { test } = require('node:test');
const assert = require('node:assert');
const peering = require('../lib/nodes/peering.js');

const pf = () => import('../frontend/src/lib/pairing-flow.js');

const urlFor = (payload) => `http://127.0.0.1:41830/#pair=${peering.encodePairing(payload)}`;
const BASE = { instanceId: 'a'.repeat(32), port: 41830, label: 'Relay', invite: 'i'.repeat(43) };

test('normalizeScanResult: string, {data} e garbage', async () => {
  const { normalizeScanResult } = await pf();
  assert.equal(normalizeScanResult('  http://x/#pair=abc  '), 'http://x/#pair=abc');
  assert.equal(normalizeScanResult({ data: 'http://x/#pair=abc' }), 'http://x/#pair=abc');
  assert.equal(normalizeScanResult({ result: 'x' }), '');
  assert.equal(normalizeScanResult(null), '');
  assert.equal(normalizeScanResult(42), '');
});

test('classifyPairingInput: v2 completo -> complete; v2 senza ssh e v1 -> partial con missing precisi; garbage -> invalid', async () => {
  const { classifyPairingInput } = await pf();
  const complete = classifyPairingInput(urlFor({ v: 2, ...BASE, name: 'home-relay', ssh: 'user@relay' }));
  assert.equal(complete.kind, 'complete');
  assert.equal(complete.decoded.ssh, 'user@relay');
  const noSsh = classifyPairingInput(urlFor({ v: 2, ...BASE, name: 'home-relay' }));
  assert.equal(noSsh.kind, 'partial');
  assert.deepEqual(noSsh.missing, ['ssh']);
  const v1 = classifyPairingInput(urlFor({ v: 1, ...BASE }));
  assert.equal(v1.kind, 'partial');
  assert.deepEqual(v1.missing, ['ssh', 'name']);
  assert.equal(classifyPairingInput('not a url').kind, 'invalid');
  assert.equal(classifyPairingInput('').kind, 'empty');
  // il routing SSH non si inventa: partial NON produce mai un campo ssh
  assert.equal(noSsh.decoded.ssh, undefined);
});

test('applyDecodedToForm: prefill dei campi non toccati, edit manuali conservati', async () => {
  const { classifyPairingInput, applyDecodedToForm } = await pf();
  const { decoded } = classifyPairingInput(urlFor({ v: 2, ...BASE, name: 'home-relay', ssh: 'user@relay', sshPort: 2222 }));
  const blank = { name: '', label: '', ssh: '', sshPort: '', pairingUrl: '' };
  const fresh = applyDecodedToForm(blank, decoded, new Set(), false);
  assert.equal(fresh.name, 'home-relay');
  assert.equal(fresh.ssh, 'user@relay');
  assert.equal(fresh.sshPort, '2222');
  assert.equal(fresh.label, 'Relay');
  const edited = applyDecodedToForm({ ...blank, ssh: 'manual@host' }, decoded, new Set(['ssh']), false);
  assert.equal(edited.ssh, 'manual@host', 'ssh editato a mano non viene sovrascritto');
});

test('resolvePairingInput: un link v2 digitato e confermato con Enter applica routing e nome prima del submit', async () => {
  const { resolvePairingInput } = await pf();
  const raw = urlFor({ v: 2, ...BASE, name: 'home-relay', ssh: 'user@relay', sshPort: 2222 });
  const blank = { name: '', label: '', ssh: '', sshPort: '', pairingUrl: '', localLabel: '' };
  const out = resolvePairingInput(blank, raw, new Set(), false);
  assert.equal(out.classification.kind, 'complete');
  assert.equal(out.form.pairingUrl, raw);
  assert.equal(out.form.name, 'home-relay');
  assert.equal(out.form.ssh, 'user@relay');
  assert.equal(out.form.sshPort, '2222');
});

test('buildPairBody: numeri e default coerenti, niente campi vuoti fabbricati', async () => {
  const { buildPairBody } = await pf();
  const full = buildPairBody({ name: 'peer', ssh: 'relay', sshPort: '2222', pairingUrl: 'u', label: 'Peer', localLabel: '' }, { deviceDefault: 'Pixel' });
  assert.deepEqual(full, { name: 'peer', ssh: 'relay', pairingUrl: 'u', label: 'Peer', sshPort: 2222, localLabel: 'Pixel' });
  const lean = buildPairBody({ name: 'peer', ssh: 'relay', sshPort: '', pairingUrl: 'u', label: '', localLabel: '' }, {});
  assert.deepEqual(lean, { name: 'peer', ssh: 'relay', pairingUrl: 'u' });
});

test('createSubmitGuard: un solo auto-submit per link, retry manuale via reset', async () => {
  const { createSubmitGuard } = await pf();
  const g = createSubmitGuard();
  assert.equal(g.canAuto('link-a'), true);
  assert.equal(g.start('link-a'), true);
  assert.equal(g.canAuto('link-a'), false, 'busy: niente secondo submit');
  assert.equal(g.start('link-a'), false, 'start concorrente rifiutato');
  g.finish();
  assert.equal(g.canAuto('link-a'), false, 'stesso link mai due volte in automatico');
  assert.equal(g.canAuto('link-b'), true, 'link diverso riparte');
  g.reset('link-a');
  assert.equal(g.canAuto('link-a'), true, 'retry manuale riabilita il link');
});

test('describePairError: usa e.data (stage/code/detail/hint/retryable), fallback a message', async () => {
  const { describePairError } = await pf();
  const e = new Error('ssh-ready: peer non risponde');
  e.data = { error: 'x', stage: 'ssh-ready', code: 'transport-not-ready', detail: 'peer non risponde (6 tentativi)', hint: 'controlla chiavi', retryable: true };
  const d = describePairError(e);
  assert.equal(d.stage, 'ssh-ready');
  assert.equal(d.code, 'transport-not-ready');
  assert.equal(d.hint, 'controlla chiavi');
  assert.equal(d.retryable, true);
  assert.equal(d.message, 'peer non risponde (6 tentativi)', 'detail del server vince sul message generico');
  const legacy = describePairError(new Error('HTTP 502'));
  assert.equal(legacy.stage, '');
  assert.equal(legacy.message, 'HTTP 502', 'niente e.data -> message non viene inghiottito');
  assert.equal(legacy.retryable, true, 'un errore di rete/legacy senza stage resta riprovabile');
});
