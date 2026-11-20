'use strict';
// Contratto v2 della claim vl: Node esce dal pin di release e dal
// provisioning locale; resta il runtime effettivo qualificato. Manifest build
// v2 chiuso (v, platform, flock, helper), pin locale v2 solo flock, lettura
// v1 legacy proiettata senza aprire il vecchio node. Il seam di config per il
// manifest non esiste piu': la diagnostica usa la DI interna.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const radici = require('../lib/fleet/vl-roots.js');
const pinLocale = require('../lib/fleet/vl-claim-pin-local.js');
const nodo = require('../lib/fleet/vl-node-runtime.js');
const W = require('./helpers/launch-world.js');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function radice(t, prefisso = 'nc-nodepin-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefisso));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} });
  return home;
}

const REALE = radici.MANIFEST;

function manifestoV1() {
  // Un v1 cosi' come distribuito dalle build precedenti.
  return {
    v: 1,
    platform: REALE.platform,
    flock: { ...REALE.flock },
    node: { sha256: '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c' },
    helper: { ...REALE.helper },
  };
}

test('manifest: il v1 legacy e\' rifiutato dalla build nuova con PIN_REREAD', (t) => {
  const home = radice(t);
  const r = radici.preparaPin(home, manifestoV1());
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'PIN_REREAD');
  assert.equal(r.motivo, 'manifest-version');
  assert.equal(r.component, null);
});

test('manifest: versione assente o sconosciuta rifiutano come manifest-version', (t) => {
  const home = radice(t);
  const senzaV = { ...REALE };
  delete senzaV.v;
  const r1 = radici.preparaPin(home, senzaV);
  assert.equal(r1.code, 'PIN_REREAD');
  assert.equal(r1.motivo, 'manifest-version');
  const r2 = radici.preparaPin(home, { ...REALE, v: 3 });
  assert.equal(r2.code, 'PIN_REREAD');
  assert.equal(r2.motivo, 'manifest-version');
});

test('manifest: v2 con node o chiavi extra rifiuta come manifest-schema', (t) => {
  const home = radice(t);
  const conNode = { ...REALE, node: { sha256: '0'.repeat(64) } };
  const r1 = radici.preparaPin(home, conNode);
  assert.equal(r1.code, 'PIN_REREAD');
  assert.equal(r1.motivo, 'manifest-schema');
  const r2 = radici.preparaPin(home, { ...REALE, extra: 1 });
  assert.equal(r2.code, 'PIN_REREAD');
  assert.equal(r2.motivo, 'manifest-schema');
});

test('manifest: il v2 reale prepara flock, helper e node runtime-qualified', (t) => {
  const home = radice(t);
  const r = radici.preparaPin(home, REALE);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(r.flock));
  assert.ok(fs.existsSync(r.helper));
  // Il node pubblicato e' la fotografia del runtime effettivo, dentro lo
  // staging della claim, non il binario dell'host e non un alias.
  const st = fs.lstatSync(r.node);
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(st.mode & 0o777, 0o500);
  // Il node pubblicato e' dentro il namespace d'istanza dello staging:
  // <staging>/inst-<32hex>/<hash>, path restituito dal preparatore.
  assert.equal(path.dirname(path.dirname(r.node)), path.join(home, '.nexuscrew', 'vl-claim-pin'));
  assert.match(path.basename(path.dirname(r.node)), /^inst-[0-9a-f]{32}$/);
  assert.notEqual(r.node, process.execPath);
  // I byte pubblicati sono quelli del runtime del processo.
  const q = nodo.qualifica();
  assert.equal(q.ok, true);
  assert.equal(st.size, fs.lstatSync(process.execPath).size);
  assert.equal(fs.readFileSync(r.node).length, fs.lstatSync(process.execPath).size);
});

test('manifest: il rifiuto v1 arriva prima del ramo piattaforma/locale', (t) => {
  const home = radice(t);
  const r = radici.preparaPin(home, manifestoV1(), 'android-arm64');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_REREAD');
  assert.equal(r.motivo, 'manifest-version');
  assert.equal(r.platform, 'android-arm64');
});

// Un build che porta un candidato node nel manifest e' rifiuto di schema
// PRIMA di ogni preparazione: il candidato alternativo, qui un binario reale
// che lascerebbe traccia se venisse toccato, non si apre e non si esegue.
test('manifest: un build con node.source alternativo osservabile non tocca il candidato', async (t) => {
  const home = radice(t, 'nc-nodepin-m2-');
  const finto = path.join(home, 'finto-node');
  const segnapunto = path.join(home, 'segnapunto');
  fs.writeFileSync(finto, `#!/bin/sh\nprintf x > ${JSON.stringify(segnapunto)}\ncase "$1" in --version) echo "v${process.versions.node}";; esac\n`);
  fs.chmodSync(finto, 0o755);
  const m = { ...REALE, node: { source: finto, sha256: sha256(fs.readFileSync(finto)) } };
  const r = radici.preparaPin(home, m);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.motivo, 'manifest-schema');
  assert.ok(!fs.existsSync(segnapunto), 'il candidato del build e\' stato eseguito');
});

// --- pin locale ---

function mondoLocale(t) {
  const home = radice(t, 'nc-nodepin-l-');
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodepin-t-'));
  t.after(() => { try { fs.rmSync(tools, { recursive: true, force: true }); } catch (_) {} });
  fs.writeFileSync(path.join(tools, 'flock'), '#!/bin/sh\necho "flock from util-linux 2.39.3"\n');
  fs.chmodSync(path.join(tools, 'flock'), 0o755);
  // Il finto runtime risponde `--version` con la versione DEL RUNNER: la
  // probe reale della fotografia deve tornare proprio quella.
  fs.writeFileSync(path.join(tools, 'node'), `#!/bin/sh\ncase "$1" in --version) echo "v${process.versions.node}";; esac\n`);
  fs.chmodSync(path.join(tools, 'node'), 0o755);
  const shaFlock = sha256(fs.readFileSync(path.join(tools, 'flock')));
  return { home, tools, execPath: path.join(tools, 'node'), shaFlock };
}

function scriviPin(home, pin) {
  const dir = path.join(home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'vl-claim-pin.local.json'), `${JSON.stringify(pin)}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(dir, 'vl-claim-pin.local.json'), 0o600);
}

function pinV1(mondo) {
  return {
    v: 1, schema: pinLocale.SCHEMA, provenance: pinLocale.PROVENIENZA,
    platform: { platform: 'android', arch: 'arm64' },
    components: {
      flock: { source: path.join(mondo.tools, 'flock'), sha256: mondo.shaFlock, version: '2.39.3' },
      node: { source: '/nonexistent/legacy-node', sha256: '1'.repeat(64) },
    },
    helper: { sha256: REALE.helper.sha256 },
    ts: 1700000000,
    by: 'operator',
  };
}

function pinV2(mondo) {
  const p = pinV1(mondo);
  return { ...p, v: 2, components: { flock: p.components.flock } };
}

test('locale: un v1 valido proietta flock/helper senza aprire il vecchio node', (t) => {
  const m = mondoLocale(t);
  scriviPin(m.home, pinV1(m));
  const l = pinLocale.leggi(m.home);
  assert.equal(l.stato, 'presente', JSON.stringify(l));
  const v = pinLocale.verifica({
    home: m.home, helperHash: REALE.helper.sha256,
    deps: { platform: 'android', arch: 'arm64', execPath: m.execPath },
  });
  assert.equal(v.ok, true, JSON.stringify(v));
  // Il nodo del pin locale v1 non e' mai un candidato: il node del pin e'
  // legacy, la preparazione usa il runtime qualificato.
  const r = radici.preparaPin(m.home, REALE, 'android-arm64', { execPath: m.execPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  // Il node pubblicato segue il path restituito: hash della fotografia
  // dentro il namespace d'istanza dello staging, mai un path globale.
  const qn = nodo.qualifica({ execPath: m.execPath });
  assert.equal(path.basename(r.node), qn.hash);
  assert.match(path.basename(path.dirname(r.node)), /^inst-[0-9a-f]{32}$/);
  assert.equal(path.dirname(path.dirname(r.node)), path.join(m.home, '.nexuscrew', 'vl-claim-pin'));
  assert.notEqual(r.node, '/nonexistent/legacy-node');
});

test('locale: v2 positivo, chiavi extra e corruzione negativi', (t) => {
  const m = mondoLocale(t);
  scriviPin(m.home, pinV2(m));
  const v = pinLocale.verifica({
    home: m.home, helperHash: REALE.helper.sha256,
    deps: { platform: 'android', arch: 'arm64', execPath: m.execPath },
  });
  assert.equal(v.ok, true, JSON.stringify(v));

  const conNode = { ...pinV2(m), components: { ...pinV2(m).components, node: pinV1(m).components.node } };
  scriviPin(m.home, conNode);
  assert.equal(pinLocale.leggi(m.home).stato, 'illeggibile');

  const corrotto = { ...pinV2(m), helper: { sha256: '0'.repeat(64) } };
  scriviPin(m.home, corrotto);
  const vCorrotto = pinLocale.verifica({
    home: m.home, helperHash: REALE.helper.sha256,
    deps: { platform: 'android', arch: 'arm64', execPath: m.execPath },
  });
  assert.equal(vCorrotto.ok, false);
  assert.equal(vCorrotto.code, 'PIN_MISMATCH');
  assert.equal(vCorrotto.component, 'helper');
});

test('locale: versione del record mancante o sconosciuta e\' illeggibile/versione', (t) => {
  const m = mondoLocale(t);
  const senzaV = { ...pinV1(m) };
  delete senzaV.v;
  scriviPin(m.home, senzaV);
  const l = pinLocale.leggi(m.home);
  assert.equal(l.stato, 'illeggibile');
  assert.equal(l.motivo, 'versione');
  const v = pinLocale.verifica({
    home: m.home, helperHash: REALE.helper.sha256,
    deps: { platform: 'android', arch: 'arm64', execPath: m.execPath },
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PIN_REREAD');

  scriviPin(m.home, { ...pinV1(m), v: '1' });
  assert.equal(pinLocale.leggi(m.home).motivo, 'versione');
  scriviPin(m.home, { ...pinV1(m), v: 3 });
  assert.equal(pinLocale.leggi(m.home).motivo, 'versione');
});

test('locale: il v1 non si riscrive e resta byte-invariato dopo l\'uso', (t) => {
  const m = mondoLocale(t);
  scriviPin(m.home, pinV1(m));
  const prima = fs.readFileSync(path.join(m.home, '.nexuscrew', 'vl-claim-pin.local.json'));
  pinLocale.verifica({
    home: m.home, helperHash: REALE.helper.sha256,
    deps: { platform: 'android', arch: 'arm64', execPath: m.execPath },
  });
  radici.preparaPin(m.home, REALE, 'android-arm64', { execPath: m.execPath });
  const dopo = fs.readFileSync(path.join(m.home, '.nexuscrew', 'vl-claim-pin.local.json'));
  assert.ok(prima.equals(dopo), 'il v1 e\' stato riscritto');
});

// --- seam di config e DI ---

test('seam: cfg.vlClaimPinManifest non altera il manifest effettivo', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const { runtime } = W.apriRuntime(d, {
    cfg: { vlClaimPinManifest: { v: 1, platform: 'android-arm64', flock: {}, node: {}, helper: {} } },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const errore = await runtime.up(d.cella).then(() => null, (e) => e);
  // Il garbage in cfg viene ignorato: l'up non rifiuta per un PIN_*.
  const pin = errore && typeof errore.fleetCode === 'string' && errore.fleetCode.startsWith('PIN_');
  assert.equal(pin, false, `il seam di cfg non deve produrre un rifiuto pin: ${errore && errore.fleetCode}`);
});

test('seam: la DI interna riservaRootClaim passa la fixture con opts.manifest', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  const viste = [];
  const { runtime } = W.apriRuntime(d, {
    riservaRootClaim: (opts) => {
      viste.push(Object.keys(opts));
      return radici.riserva({ ...opts, manifest: manifestoV1() });
    },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const errore = await runtime.up(d.cella).then(() => null, (e) => e);
  assert.ok(errore, 'l\'up doveva rifiutare con il manifest v1 iniettato');
  assert.equal(errore.status, 500);
  assert.equal(errore.fleetCode, 'PIN_REREAD');
  assert.equal(errore.fleetPhase, 'preflight');
  assert.equal(errore.data.pinCode, 'PIN_REREAD');
  assert.ok(viste.length >= 1, 'la DI non e\' stata usata');
});

// --- claim reale sul runtime del runner ---

test('claim: riserva e rilascio reali sotto flock con il runtime effettivo', async (t) => {
  const home = radice(t, 'nc-nodepin-c-');
  const root = radici.radiceServer(home, 'istanza-test', 'cella-test');
  assert.ok(root);
  const r1 = await radici.riserva({ home, root, launchId: 'a'.repeat(16), ownerInstanceId: 'istanza-test', cellId: 'cella-test', budgetMs: 8000 });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.outcome, 'claimed');
  const r2 = await radici.ispeziona({ home, root, launchId: '0'.repeat(16), ownerInstanceId: 'istanza-test', cellId: 'cella-test', budgetMs: 8000 });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const r3 = await radici.rilascia({ home, root, launchId: 'a'.repeat(16), ownerInstanceId: 'istanza-test', cellId: 'cella-test', budgetMs: 8000 });
  assert.equal(r3.ok, true, JSON.stringify(r3));
});

test('claim: il rilascio senza identita\' esatta non tocca la claim', async (t) => {
  const home = radice(t, 'nc-nodepin-id-');
  const root = radici.radiceServer(home, 'istanza-id', 'cella-id');
  const comuni = { home, root, ownerInstanceId: 'istanza-id', cellId: 'cella-id', budgetMs: 8000 };
  const r1 = await radici.riserva({ ...comuni, launchId: 'c'.repeat(16) });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const sbagliata = await radici.rilascia({ ...comuni, launchId: 'd'.repeat(16) });
  assert.equal(sbagliata.ok, false, JSON.stringify(sbagliata));
  assert.equal(sbagliata.outcome, 'mismatch');
  assert.equal(radici.osservaClaim({ home, root, ownerInstanceId: 'istanza-id', cellId: 'cella-id' }), 'held');
  const giusta = await radici.rilascia({ ...comuni, launchId: 'c'.repeat(16) });
  assert.equal(giusta.ok, true, JSON.stringify(giusta));
});

test('claim: la claim di un\'istanza si rilascia da un processo con altro runtime', async (t) => {
  const home = radice(t, 'nc-nodepin-x-');
  const root = radici.radiceServer(home, 'istanza-cross', 'cella-cross');
  assert.ok(root);
  // Il figlio e' un processo Node reale distinto: la claim eredita il lock
  // via flock -F e il rilascio arriva da QUESTA istanza con lo stesso
  // owner/root/launchId. Nessun hash Node nel formato della claim.
  const figlio = await new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const script = `
      const radici = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'fleet', 'vl-roots.js'))});
      radici.riserva({ home: ${JSON.stringify(home)}, root: ${JSON.stringify(root)},
        launchId: ${JSON.stringify('b'.repeat(16))}, ownerInstanceId: 'istanza-cross',
        cellId: 'cella-cross', budgetMs: 8000 }).then((r) => {
        process.stdout.write(JSON.stringify({ ok: r.ok, outcome: r.outcome }));
      }, (e) => { process.stdout.write(JSON.stringify({ ok: false, e: String(e) })); });
    `;
    const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.on('close', () => resolve(JSON.parse(out)));
  });
  assert.equal(figlio.ok, true, JSON.stringify(figlio));
  assert.equal(figlio.outcome, 'claimed');
  const r = await radici.rilascia({ home, root, launchId: 'b'.repeat(16), ownerInstanceId: 'istanza-cross', cellId: 'cella-cross', budgetMs: 8000 });
  assert.equal(r.ok, true, JSON.stringify(r));
});

// Un secondo runtime Node reale, distinto da quello del runner: serve alla
// prova di passaggio fra versioni. Nessun candidato alternativo del prodotto
// passa da qui: e' solo il binario che esegue il figlio dei test.
function altroRuntime() {
  const dir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  const mia = Number(process.versions.node.split('.')[0]);
  let scelto = null;
  try {
    for (const nome of fs.readdirSync(dir)) {
      const m = nome.match(/^v(\d+)\.\d+\.\d+$/);
      if (!m || Number(m[1]) < 18) continue;
      const exe = path.join(dir, nome, 'bin', 'node');
      try { fs.accessSync(exe, fs.constants.X_OK); } catch (_) { continue; }
      const major = Number(m[1]);
      if (major === mia) continue;
      if (!scelto || major > scelto.major) scelto = { major, exe };
    }
  } catch (_) { return null; }
  return scelto ? scelto.exe : null;
}

function figlioClaim(exe, fn, args) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    const script = `
      const radici = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'fleet', 'vl-roots.js'))});
      radici.${fn}(${JSON.stringify(args)}).then((r) => {
        process.stdout.write(JSON.stringify({ ok: r.ok, outcome: r.outcome }));
      }, (e) => { process.stdout.write(JSON.stringify({ ok: false, e: String(e) })); });
    `;
    const p = spawn(exe, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => { out += b; });
    p.on('error', reject);
    p.on('close', () => {
      try { resolve(JSON.parse(out)); } catch (_) { reject(new Error(`figlio senza risposta: ${out}`)); }
    });
  });
}

test('claim: la claim attraversa due runtime distinti con identita\' e barriere intatte', async (t) => {
  const altro = altroRuntime();
  if (!altro) { t.skip('nessun secondo runtime disponibile su questo runner'); return; }
  assert.notEqual(altro, process.execPath);
  const home = radice(t, 'nc-nodepin-2rt-');
  // Direzione A: riserva dal runtime DIVERSO, il runner ispeziona, la
  // barriera di identita' rifiuta il rilascio sbagliato, poi rilascia giusto.
  const comuniA = {
    home, root: radici.radiceServer(home, 'istanza-2rt-a', 'cella-2rt-a'),
    ownerInstanceId: 'istanza-2rt-a', cellId: 'cella-2rt-a', budgetMs: 8000,
  };
  const riservaAltro = await figlioClaim(altro, 'riserva', { ...comuniA, launchId: 'e'.repeat(16) });
  assert.equal(riservaAltro.ok, true, JSON.stringify(riservaAltro));
  assert.equal(riservaAltro.outcome, 'claimed');
  const ispezione = await radici.ispeziona({ ...comuniA, launchId: '0'.repeat(16) });
  assert.equal(ispezione.ok, true, JSON.stringify(ispezione));
  const sbagliato = await radici.rilascia({ ...comuniA, launchId: 'f'.repeat(16) });
  assert.equal(sbagliato.ok, false, JSON.stringify(sbagliato));
  assert.equal(sbagliato.outcome, 'mismatch');
  assert.equal(radici.osservaClaim({ home, root: comuniA.root, ownerInstanceId: 'istanza-2rt-a', cellId: 'cella-2rt-a' }), 'held');
  const giusto = await radici.rilascia({ ...comuniA, launchId: 'e'.repeat(16) });
  assert.equal(giusto.ok, true, JSON.stringify(giusto));
  // Direzione B: il runner riserva, il runtime diverso ispeziona e rilascia.
  const comuniB = {
    home, root: radici.radiceServer(home, 'istanza-2rt-b', 'cella-2rt-b'),
    ownerInstanceId: 'istanza-2rt-b', cellId: 'cella-2rt-b', budgetMs: 8000,
  };
  const riservaQui = await radici.riserva({ ...comuniB, launchId: 'a'.repeat(16) });
  assert.equal(riservaQui.ok, true, JSON.stringify(riservaQui));
  const ispezioneAltro = await figlioClaim(altro, 'ispeziona', { ...comuniB, launchId: '0'.repeat(16) });
  assert.equal(ispezioneAltro.ok, true, JSON.stringify(ispezioneAltro));
  const rilascioAltro = await figlioClaim(altro, 'rilascia', { ...comuniB, launchId: 'a'.repeat(16) });
  assert.equal(rilascioAltro.ok, true, JSON.stringify(rilascioAltro));
});

test('locale: il node legacy del v1 resta non eseguito, con prova osservabile', async (t) => {
  const m = mondoLocale(t);
  // Il node del record v1 e' un binario REALE che lascerebbe traccia se
  // venisse eseguito: la proiezione non lo apre e non lo lancia mai.
  const finto = path.join(m.tools, 'legacy-node');
  const segnapunto = path.join(m.tools, 'segnapunto');
  fs.writeFileSync(finto, `#!/bin/sh\nprintf x > ${JSON.stringify(segnapunto)}\ncase "$1" in --version) echo "v99.0.0";; esac\n`);
  fs.chmodSync(finto, 0o755);
  const pin = pinV1(m);
  pin.components.node = { source: finto, sha256: sha256(fs.readFileSync(finto)) };
  scriviPin(m.home, pin);
  const v = pinLocale.verifica({
    home: m.home, helperHash: REALE.helper.sha256,
    deps: { platform: 'android', arch: 'arm64', execPath: m.execPath },
  });
  assert.equal(v.ok, true, JSON.stringify(v));
  const r = radici.preparaPin(m.home, REALE, 'android-arm64', { execPath: m.execPath });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.node, finto);
  assert.ok(!fs.existsSync(segnapunto), 'il node del record v1 e\' stato eseguito');
  assert.equal(fs.readFileSync(r.node).length, fs.readFileSync(m.execPath).length);
});
