'use strict';
// Ripiego ESPLICITO sul pin locale della claim vl su Linux. Il manifest di
// build resta l'autorita': se i suoi byte combaciano la claim si risolve da
// sola e il pin non si legge. Se un aggiornamento di sistema cambia la flock
// rispetto al catalogo (PIN_ABSENT / PIN_MISMATCH / PIN_VERSION sul componente
// flock) su linux-x64 si apre il ripiego, con un ordine obbligato: prima il
// Node runtime e l'helper DELLA RELEASE, poi il pin. Pin assente = codice del
// manifest e `provision-again`; pin invalido = suo codice con la causa del
// manifest conservata; staging guasto = suo codice e stop. Nessun auto-pin.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const locale = require('../lib/fleet/vl-claim-pin-local.js');
const radici = require('../lib/fleet/vl-roots.js');
const F = require('./helpers/vl-pin-fixture.js');

const MANIFEST_CAUSE = { code: 'PIN_MISMATCH', component: 'flock' };

// La terna del pacchetto aggiornato, ciascuna con il suo manifest per-test.
function terna() {
  return [
    { code: 'PIN_ABSENT', manifest: F.manifestAggiornato({ source: '/nonexistent/pin-fallback-flock' }) },
    { code: 'PIN_MISMATCH', manifest: F.manifestAggiornato() },
    { code: 'PIN_VERSION', manifest: F.manifestAggiornato({ sha256: F.sistema().sha256 }) },
  ];
}

test('piattaforma e sorgente misurabili: linux-x64 con flock di sistema', () => {
  assert.equal(`${process.platform}-${process.arch}`, 'linux-x64', 'il ripiego e\' linux-x64');
  const m = F.sistema();
  assert.equal(m.source, '/usr/bin/flock');
  assert.equal(m.uid, 0, 'la sorgente di sistema e\' di root');
  assert.equal((m.mode & 0o022), 0, 'non scrivibile da gruppo/altri');
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
});

test('(a) terna del manifest e nessun pin: codice del manifest e provision-again', (t) => {
  for (const voce of terna()) {
    const { home } = F.homeFinta(t);
    const r = radici.preparaPin(home, voce.manifest);
    assert.equal(r.ok, false, voce.code);
    assert.equal(r.code, voce.code, `pacchetto aggiornato: ${voce.code}`);
    assert.equal(r.component, 'flock');
    assert.equal(r.platform, 'linux-x64');
    assert.equal(r.pinRecovery, 'provision-again');
    assert.equal(r.manifestCause, undefined, 'la causa e\' il codice del manifest stesso');
    assert.equal(fs.existsSync(locale.percorso(home)), false, 'nessun pin creato');
  }
});

test('(l) anti-auto-pin: il rifiuto non crea e non riscrive il pin', (t) => {
  const { home } = F.homeFinta(t);
  const primo = radici.preparaPin(home, F.manifestAggiornato());
  assert.equal(primo.code, 'PIN_MISMATCH');
  assert.equal(fs.existsSync(locale.percorso(home)), false);
  const secondo = radici.preparaPin(home, F.manifestAggiornato());
  assert.equal(secondo.pinRecovery, 'provision-again');
  assert.equal(fs.existsSync(locale.percorso(home)), false, 'un secondo tentativo non pinna');
});

test('(b) terna del manifest con pin valido: la claim passa con gli oggetti del pin', (t) => {
  const { home } = F.homeFinta(t);
  const m = F.sistema();
  F.scriviPin(home, F.pinValido());
  const r = radici.preparaPin(home, F.manifestAggiornato());
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const p of [r.flock, r.node, r.helper]) assert.ok(fs.existsSync(p), p);
  assert.equal(F.sha256File(r.flock), m.sha256, 'la copia pubblicata e\' la flock registrata');
  assert.equal(F.sha256File(r.helper), radici.MANIFEST.helper.sha256, 'l\'helper resta della release');
  assert.equal(path.dirname(r.flock), path.join(home, '.nexuscrew', 'vl-claim-pin'));
});

test('(c) manifest combaciante e pin presente: vince il manifest, il pin non si legge', (t) => {
  const { home } = F.homeFinta(t);
  // Un pin corrotto: se venisse letto il rifiuto sarebbe PIN_REREAD.
  F.scriviPin(home, '{"v":1,');
  const r = radici.preparaPin(home, F.manifestCombaciante());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(F.sha256File(r.flock), F.sistema().sha256);
});

test('(d) pin stantio: PIN_MISMATCH con la causa del manifest conservata', (t) => {
  const { home } = F.homeFinta(t);
  F.scriviPin(home, F.pinValido({ sha256: 'a'.repeat(64) }));
  const r = radici.preparaPin(home, F.manifestAggiornato());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_MISMATCH');
  assert.equal(r.component, 'flock');
  assert.deepEqual(r.manifestCause, MANIFEST_CAUSE);
  assert.equal(r.pinRecovery, undefined, 'un pin invalido non invita al provision');
});

test('(e) il provision --again sostituisce il record', (t) => {
  const { home } = F.homeFinta(t);
  assert.equal(F.provisionaLinux(home).ok, true);
  const prima = locale.leggi(home).pin;
  const seconda = F.provisionaLinux(home);
  assert.equal(seconda.code, 'PIN_EXISTS');
  assert.equal(locale.leggi(home).pin.by, 'operatore');
  const terza = F.provisionaLinux(home, { again: true, by: 'secondo' });
  assert.equal(terza.ok, true, JSON.stringify(terza));
  assert.equal(locale.leggi(home).pin.by, 'secondo');
  assert.equal(locale.leggi(home).pin.components.flock.source, '/usr/bin/flock');
});

test('(f) linux-arm64 non coperta: ramo locale puro (il pin si legge per primo)', (t) => {
  const { home } = F.homeFinta(t);
  assert.equal(F.provisionaLinux(home, { deps: { arch: 'arm64' } }).ok, true);
  const r = radici.preparaPin(home, F.manifestCombaciante(), 'linux-arm64');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(r.flock) && fs.existsSync(r.node) && fs.existsSync(r.helper));
  assert.equal(F.sha256File(r.helper), radici.MANIFEST.helper.sha256);
});

test('(g) schema del manifest errato: PIN_REREAD, nessun ramo e pin non letto', (t) => {
  const { home } = F.homeFinta(t);
  F.scriviPin(home, '{"v":1,');
  for (const rotto of [{ ...radici.MANIFEST, v: 1 }, { ...radici.MANIFEST, extra: 1 }]) {
    const r = radici.preparaPin(home, rotto);
    assert.equal(r.code, 'PIN_REREAD');
    assert.match(r.motivo, /^manifest-/);
    assert.equal(r.component, null);
    assert.equal(r.pinRecovery, undefined);
    assert.equal(r.manifestCause, undefined);
  }
});

test('(h) rifiuti del Node e dell\'helper della release: il loro codice, pin mai letto', (t) => {
  const { home } = F.homeFinta(t);
  // Pin corrotto: se il ripiego lo leggesse, il codice sarebbe PIN_REREAD.
  F.scriviPin(home, '{"v":1,');
  const node = radici.preparaPin(home, F.manifestAggiornato(), null, { execPath: '/nonexistent/nc-node' });
  assert.equal(node.ok, false);
  assert.equal(node.code, 'PIN_ABSENT');
  assert.equal(node.component, 'node');
  assert.deepEqual(node.manifestCause, MANIFEST_CAUSE);

  const { home: home2 } = F.homeFinta(t);
  F.scriviPin(home2, '{"v":1,');
  const helper = radici.preparaPin(home2, {
    ...F.manifestAggiornato(), helper: { sha256: '0'.repeat(64) },
  });
  assert.equal(helper.ok, false);
  assert.equal(helper.code, 'PIN_MISMATCH');
  assert.equal(helper.component, 'helper');
  assert.deepEqual(helper.manifestCause, MANIFEST_CAUSE);

  // Helper non qualificato con la flock del manifest INTATTA: il rifiuto e' del
  // componente helper e NON apre il ripiego (nessuna causa del manifest, nessun
  // invito al provision). Il gate del ripiego e' la flock, non un guasto
  // qualsiasi.
  const { home: home3 } = F.homeFinta(t);
  const h3 = radici.preparaPin(home3, {
    ...F.manifestCombaciante(), helper: { sha256: '0'.repeat(64) },
  });
  assert.equal(h3.ok, false);
  assert.equal(h3.code, 'PIN_MISMATCH');
  assert.equal(h3.component, 'helper');
  assert.equal(h3.manifestCause, undefined, 'il rifiuto dell\'helper non apre il ripiego');
  assert.equal(h3.pinRecovery, undefined);
});

test('(i) staging guasto: codice di staging e stop', (t) => {
  // Staging non privato: il primo oggetto pubblicato e' il Node della release.
  const { home } = F.homeFinta(t);
  F.scriviPin(home, '{"v":1,');
  const staging = path.join(home, '.nexuscrew', 'vl-claim-pin');
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.chmodSync(staging, 0o777);
  const rotto = radici.preparaPin(home, F.manifestAggiornato());
  assert.equal(rotto.ok, false);
  assert.ok(['PIN_DIR', 'PIN_STAGE', 'PIN_REREAD'].includes(rotto.code), `codice di staging: ${rotto.code}`);
  assert.equal(rotto.component, 'node');
  assert.deepEqual(rotto.manifestCause, MANIFEST_CAUSE);
  assert.notEqual(rotto.motivo, 'json', 'il pin non e\' stato letto');

  // Staging privato ma oggetto ostile sotto il nome della flock del pin:
  // il pin si legge, e' valido, e il suo staging rifiuta con PIN_REREAD.
  const { home: home2 } = F.homeFinta(t);
  F.scriviPin(home2, F.pinValido());
  const staging2 = path.join(home2, '.nexuscrew', 'vl-claim-pin');
  fs.mkdirSync(path.join(staging2, F.sistema().sha256), { recursive: true, mode: 0o700 });
  fs.chmodSync(staging2, 0o700);
  fs.chmodSync(path.join(staging2, F.sistema().sha256), 0o700);
  const r = radici.preparaPin(home2, F.manifestAggiornato());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_REREAD');
  assert.equal(r.component, 'flock');
  assert.deepEqual(r.manifestCause, MANIFEST_CAUSE);

  // Un guasto di staging del RAMO MANIFEST non apre il ripiego: la terna dei
  // codici di misura e' l'unica porta, i codici di staging si fermano dove
  // nascono.
  const { home: home3 } = F.homeFinta(t);
  const staging3 = path.join(home3, '.nexuscrew', 'vl-claim-pin');
  fs.mkdirSync(staging3, { recursive: true, mode: 0o700 });
  fs.chmodSync(staging3, 0o777);
  const m3 = radici.preparaPin(home3, F.manifestCombaciante());
  assert.equal(m3.ok, false);
  assert.equal(m3.code, 'PIN_DIR');
  assert.equal(m3.component, 'flock');
  assert.equal(m3.manifestCause, undefined, 'lo staging del manifest non apre il ripiego');
  assert.equal(m3.pinRecovery, undefined);
});

test('(j) pin illeggibile, altra piattaforma, helper vecchio: suo codice e causa conservata', (t) => {
  const casi = [
    { nome: 'illeggibile', pin: F.pinValido(), modo: 0o666, code: 'PIN_REREAD', component: undefined },
    { nome: 'altra piattaforma', pin: F.pinValido({ platform: 'android', arch: 'arm64' }), code: 'PIN_UNCOVERED' },
    { nome: 'helper vecchio', pin: F.pinValido({ helper: 'b'.repeat(64) }), code: 'PIN_MISMATCH', component: 'helper' },
  ];
  for (const caso of casi) {
    const { home } = F.homeFinta(t);
    F.scriviPin(home, caso.pin, caso.modo ? { modo: caso.modo } : {});
    const r = radici.preparaPin(home, F.manifestAggiornato());
    assert.equal(r.ok, false, caso.nome);
    assert.equal(r.code, caso.code, caso.nome);
    if (caso.component) assert.equal(r.component, caso.component, caso.nome);
    assert.deepEqual(r.manifestCause, MANIFEST_CAUSE, `${caso.nome}: causa del manifest`);
    assert.equal(r.pinRecovery, undefined, `${caso.nome}: nessun invito al provision`);
  }
  const altra = F.homeFinta(t);
  F.scriviPin(altra.home, F.pinValido({ platform: 'android', arch: 'arm64' }));
  assert.equal(radici.preparaPin(altra.home, F.manifestAggiornato()).motivo, 'altra-piattaforma');
});

test('(k) sorgente non ammessa o non qualificata: rifiuto di policy, mai ammessa', (t) => {
  const m = F.sistema();
  const casi = [
    { nome: 'owner diverso da root', fs: F.fsSistema({ file: { uid: 1000 } }) },
    { nome: 'scrivibile da gruppo', fs: F.fsSistema({ file: { mode: 0o100775 } }) },
    { nome: 'scrivibile da altri', fs: F.fsSistema({ file: { mode: 0o100757 } }) },
    { nome: 'symlink al posto del file', fs: F.fsSistema({ file: { symlink: true } }) },
    { nome: 'non eseguibile', fs: F.fsSistema({ file: { mode: 0o100644 } }) },
    { nome: 'catena non di root', fs: F.fsSistema({ dirs: { '/usr/bin': { uid: 1000 } } }) },
    { nome: 'catena scrivibile da gruppo', fs: F.fsSistema({ dirs: { '/usr': { mode: 0o040775 } } }) },
  ];
  for (const caso of casi) {
    const { home } = F.homeFinta(t);
    F.scriviPin(home, F.pinValido());
    const r = radici.preparaPin(home, F.manifestAggiornato(), null, { sourceFs: caso.fs });
    assert.equal(r.ok, false, caso.nome);
    assert.equal(r.code, 'PIN_UNCOVERED', caso.nome);
    assert.equal(r.component, 'flock', caso.nome);
    assert.equal(r.motivo, 'source-policy', caso.nome);
    assert.deepEqual(r.manifestCause, MANIFEST_CAUSE, caso.nome);

    // Provision: la stessa qualifica rifiuta con PIN_PREFIX (codice CLI).
    const { home: homeProv } = F.homeFinta(t);
    const p = F.provisionaLinux(homeProv, { deps: { sourceFs: caso.fs } });
    assert.equal(p.ok, false, `${caso.nome}: provision`);
    assert.equal(p.code, 'PIN_PREFIX', caso.nome);
    assert.equal(fs.existsSync(locale.percorso(homeProv)), false, caso.nome);
  }

  // Un percorso della home non entra MAI, nemmeno se risolve allo stesso file:
  // l'appartenenza all'insieme chiuso si guarda sulla spelling, prima di ogni
  // lettura.
  const { home } = F.homeFinta(t);
  F.scriviPin(home, F.pinValido({ source: path.join(home, 'flock-uguale') }));
  const r = radici.preparaPin(home, F.manifestAggiornato());
  assert.equal(r.code, 'PIN_UNCOVERED');
  assert.equal(r.motivo, 'source-policy');
});

test('(m) /bin/flock: ammesso solo se e\' lo stesso oggetto del canonico', (t) => {
  const m = F.sistema();
  let bin = null;
  try { bin = fs.statSync('/bin/flock'); } catch (_) { bin = null; }
  t.diagnostic(`misura nel container: /bin/flock ${bin ? `presente dev=${bin.dev} ino=${bin.ino}` : 'assente'}; /usr/bin/flock dev=${m.dev} ino=${m.ino}`);
  const stesso = !!bin && bin.dev === m.dev && bin.ino === m.ino;

  // Misura reale del container (dichiarata sopra).
  const { home } = F.homeFinta(t);
  const reale = locale.provisiona({
    home, flock: '/bin/flock', helperHash: radici.MANIFEST.helper.sha256, by: 'x',
    deps: { platform: 'linux', arch: 'x64', versioneQualificata: () => m.version },
  });
  if (stesso) {
    assert.equal(reale.ok, true, JSON.stringify(reale));
    assert.equal(locale.leggi(home).pin.components.flock.source, '/bin/flock');
    F.scriviPin(home, F.pinValido({ source: '/bin/flock' }));
    assert.equal(locale.verifica({
      home, helperHash: radici.MANIFEST.helper.sha256, deps: { platform: 'linux', arch: 'x64' },
    }).ok, true, '/bin/flock allo stesso oggetto');
  } else {
    assert.equal(reale.ok, false);
    assert.ok(['PIN_ABSENT', 'PIN_PREFIX'].includes(reale.code), reale.code);
  }

  // Metadati sintetici: oggetto diverso e oggetto assente non si ammettono,
  // lo stesso dev/ino si ammette. Sempre via DI, mai il sistema.
  const diversi = F.fsSistema({ bin: F.statFile({ dev: m.dev, ino: m.ino + 1 }) });
  const { home: h1 } = F.homeFinta(t);
  F.scriviPin(h1, F.pinValido({ source: '/bin/flock' }));
  const rDiverso = radici.preparaPin(h1, F.manifestAggiornato(), null, { sourceFs: diversi });
  assert.equal(rDiverso.code, 'PIN_UNCOVERED');
  assert.equal(rDiverso.motivo, 'source-policy');

  const assente = F.fsSistema();
  const { home: h2 } = F.homeFinta(t);
  F.scriviPin(h2, F.pinValido({ source: '/bin/flock' }));
  const rAssente = radici.preparaPin(h2, F.manifestAggiornato(), null, { sourceFs: assente });
  assert.equal(rAssente.code, 'PIN_ABSENT');
  assert.equal(rAssente.component, 'flock');

  const identico = F.fsSistema({ bin: F.statFile({ dev: m.dev, ino: m.ino }) });
  const { home: h3 } = F.homeFinta(t);
  F.scriviPin(h3, F.pinValido({ source: '/bin/flock' }));
  const rUguale = locale.verifica({
    home: h3, helperHash: radici.MANIFEST.helper.sha256,
    deps: { platform: 'linux', arch: 'x64', sourceFs: identico },
  });
  assert.equal(rUguale.ok, true, JSON.stringify(rUguale));
});

test('(n) due riserve concorrenti sotto ripiego: una sola vince, con il tool qualificato', async (t) => {
  const { home } = F.homeFinta(t);
  assert.equal(F.provisionaLinux(home).ok, true);
  const manifest = F.manifestAggiornato();
  const root = path.join(home, 'srv');
  const base = { home, manifest, root, ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 4000 };
  const [a, b] = await Promise.all([
    radici.riserva({ ...base, launchId: '11'.repeat(8) }),
    radici.riserva({ ...base, launchId: '22'.repeat(8) }),
  ]);
  const esiti = [a.outcome, b.outcome].sort();
  assert.deepEqual(esiti, ['claimed', 'collision'], JSON.stringify([a, b]));
  const claims = radici.dirClaim(home);
  assert.equal(fs.readdirSync(claims).filter((n) => n.endsWith('.lease')).length, 1);
  assert.equal(fs.readdirSync(claims).filter((n) => n.endsWith('.own')).length, 1);
  assert.equal((await radici.rilascia({ ...base, launchId: a.outcome === 'claimed' ? '11'.repeat(8) : '22'.repeat(8) })).outcome, 'released');
});

test('propagazione dello stop: pinRecovery e manifestCause attraversano eseguiSottoLock', async (t) => {
  const { home } = F.homeFinta(t);
  const r = await radici.riserva({
    home, manifest: F.manifestAggiornato(), root: path.join(home, 'srv'),
    launchId: '33'.repeat(8), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.code, 'PIN_MISMATCH');
  assert.equal(r.component, 'flock');
  assert.equal(r.pinRecovery, 'provision-again');
  assert.equal(r.manifestCause, undefined);

  const { home: home2 } = F.homeFinta(t);
  F.scriviPin(home2, F.pinValido({ sha256: 'a'.repeat(64) }));
  const r2 = await radici.riserva({
    home: home2, manifest: F.manifestAggiornato(), root: path.join(home2, 'srv'),
    launchId: '44'.repeat(8), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 1000,
  });
  assert.equal(r2.code, 'PIN_MISMATCH');
  assert.deepEqual(r2.manifestCause, MANIFEST_CAUSE);
  assert.equal(r2.pinRecovery, undefined);
});

test('sha del manifest di produzione intatto: nessun test lo ha scritto', () => {
  const p = path.join(__dirname, '..', 'lib', 'fleet', 'vl-claim-pin-manifest.json');
  const manifesto = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(manifesto.platform, 'linux-x64');
  assert.equal(manifesto.flock.source, '/usr/bin/flock');
  assert.equal(manifesto.flock.sha256, F.sistema().sha256, 'il manifest descrive la flock del container');
  assert.equal(manifesto.flock.version, F.sistema().version);
});
