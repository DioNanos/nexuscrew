'use strict';
// Diagnostica del pin della claim vl: il codice CHIUSO del pin e la
// piattaforma arrivano nella risposta, invece di un LOCK_UNAVAILABLE generico.
// La piattaforma e' quella del runtime (`process.platform`+`process.arch`), non
// il nome di un target di build; il componente (flock/node/helper) dice QUALE
// oggetto non si e' qualificato. Nessun path nella risposta.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const radici = require('../lib/fleet/vl-roots.js');
const W = require('./helpers/launch-world.js');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function radice(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pin-diag-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  return home;
}

const REALE = radici.MANIFEST;

test('pin: una piattaforma non coperta e\' un motivo distinto dal file assente', (t) => {
  const home = radice(t);
  // linux-x64 e' autorizzata al ripiego locale: un manifest android-arm64 su
  // questo runtime apre il ramo locale e il rifiuto e' «assente», non «non
  // coperta».
  const r = radici.preparaPin(home, { ...REALE, platform: 'android-arm64' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_UNCOVERED');
  assert.equal(r.motivo, 'assente');
  assert.equal(r.platform, `${process.platform}-${process.arch}`);
  assert.equal(r.atteso, 'android-arm64');

  // La prova della piattaforma NON autorizzata resta, su una davvero esclusa
  // (darwin arrivera' con un altro schema): componente null e atteso noto.
  const esclusa = radici.preparaPin(home, REALE, 'darwin-arm64');
  assert.equal(esclusa.ok, false);
  assert.equal(esclusa.code, 'PIN_UNCOVERED');
  assert.equal(esclusa.component, null);
  assert.equal(esclusa.atteso, REALE.platform);
});

test('pin: il manifest di build copre questa piattaforma (linux invariato)', (t) => {
  const home = radice(t);
  const r = radici.preparaPin(home, REALE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(r.flock) && fs.existsSync(r.node) && fs.existsSync(r.helper));
});

test('pin: il componente che non si qualifica viaggia con il rifiuto', (t) => {
  const home = radice(t);

  const assente = radici.preparaPin(home, {
    ...REALE, flock: { ...REALE.flock, source: '/nonexistent/nc-flock' },
  });
  assert.equal(assente.code, 'PIN_ABSENT');
  assert.equal(assente.component, 'flock');

  // Il node non e' piu' un campo del manifest: un v1 legacy (o un v2 con
  // node extra) rifiuta sulla versione dello schema, componente null.
  const v1 = radici.preparaPin(home, {
    ...REALE, v: 1, node: { sha256: '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c' },
  });
  assert.equal(v1.code, 'PIN_REREAD');
  assert.equal(v1.motivo, 'manifest-version');
  assert.equal(v1.component, null);

  const versione = radici.preparaPin(home, {
    ...REALE, flock: { ...REALE.flock, version: '0.0.0' },
  });
  assert.equal(versione.code, 'PIN_VERSION');
  assert.equal(versione.component, 'flock');

  const helper = radici.preparaPin(home, {
    ...REALE, helper: { ...REALE.helper, sha256: '0'.repeat(64) },
  });
  assert.equal(helper.code, 'PIN_MISMATCH');
  assert.equal(helper.component, 'helper');

  for (const r of [assente, v1, versione, helper]) {
    assert.equal(r.platform, `${process.platform}-${process.arch}`);
  }
});

test('pin: l\'up rifiutato per piattaforma non coperta lo dice nella risposta', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  // La fixture passa dalla DI interna (nessun seam di config): il wrapper
  // chiama la funzione reale con il manifest iniettato via opts.manifest.
  const { runtime } = W.apriRuntime(d, {
    riservaRootClaim: (opts) => radici.riserva({ ...opts, manifest: { ...REALE, platform: 'android-arm64' } }),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const errore = await runtime.up(d.cella).then(() => null, (e) => e);
  assert.ok(errore, 'l\'up doveva rifiutare');
  assert.equal(errore.status, 500);
  assert.equal(errore.fleetCode, 'PIN_UNCOVERED');
  assert.equal(errore.fleetPhase, 'preflight');
  assert.equal(errore.data.pinCode, 'PIN_UNCOVERED');
  assert.equal(errore.data.platform, `${process.platform}-${process.arch}`);
  assert.equal(errore.data.component, null);
  const testo = String(errore.message);
  assert.match(testo, new RegExp(`${process.platform}-${process.arch}`));
  assert.match(testo, /PIN_UNCOVERED/);
  assert.equal(testo.includes('/usr/bin'), false, 'path nella risposta');
  // Nessun effetto: il record del lancio non c'e'.
  const lt = require('../lib/fleet/launch-target.js');
  assert.equal(lt.leggi(d.filesRoot, d.sessione).stato, 'assente');
});

test('pin: un componente non qualificato arriva come fleetCode e nel dato', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const { runtime } = W.apriRuntime(d, {
    riservaRootClaim: (opts) => radici.riserva({
      ...opts,
      manifest: { ...REALE, flock: { ...REALE.flock, source: '/nonexistent/nc-flock' } },
    }),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const errore = await runtime.up(d.cella).then(() => null, (e) => e);
  assert.ok(errore, 'l\'up doveva rifiutare');
  assert.equal(errore.status, 500);
  assert.equal(errore.fleetCode, 'PIN_ABSENT');
  assert.equal(errore.fleetPhase, 'preflight');
  assert.equal(errore.data.outcome, 'refused');
  assert.equal(errore.data.pinCode, 'PIN_ABSENT');
  assert.equal(errore.data.component, 'flock');
  assert.equal(String(errore.message).includes('flock'), true);
});

test('pin: hash del pin del file reale ancora quello del manifest (controllo)', () => {
  const p = path.join(__dirname, '..', 'lib', 'fleet', 'vl-claim-section.js');
  assert.equal(sha256File(p), REALE.helper.sha256);
});
