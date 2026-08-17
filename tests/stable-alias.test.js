'use strict';
// R23 — alias stabili per i path del servizio di boot.
//
// Il punto centrale del briefing: il controllo negativo. «Fai risolvere
// l'alias a un file diverso e pretendi che NON venga scelto. Se il test resta
// verde, guarda l'oggetto sbagliato.» Qui il controllo negativo NON e' un
// braccio accanto: e' la COPPIA nello stesso tempdir — lo stesso identico
// meccanismo con un symlink che punta al file giusto (scelto) e uno che punta
// a un file diverso (non scelto). Se la guardia non discriminasse, la coppia
// sarebbe verde a meta'.
//
// Due livelli di realta', entrambi necessari:
//  - realpath INIETTATO: esiti deterministici sui tre casi del briefing, con
//    PIU' candidati (almeno tre: con uno solo «prova tutti» e «prova il
//    primo» coincidono);
//  - filesystem VERO (symlink reali, fs.realpathSync reale): perche' un
//    realpath finto puo' essere finto insieme alla guardia che dovrebbe
//    usarlo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  nodeAliasCandidates, entryAliasCandidates, resolveStableAlias, resolveBootPaths,
} = require('../lib/cli/stable-alias.js');
const { escapeSystemdExec } = require('../lib/cli/service.js');
const { runInit } = require('../lib/cli/init.js');

// —— candidati ————————————————————————————————————————————————————————————————

test('nodeAliasCandidates: almeno tre candidati noti, $PREFIX aggiunto e deduplicato', () => {
  const base = nodeAliasCandidates({});
  assert.ok(base.length >= 3, `almeno tre candidati, non uno: ${base.join(', ')}`);
  assert.ok(base.includes('/opt/homebrew/bin/node'));
  assert.ok(base.includes('/usr/local/bin/node'));
  assert.ok(base.includes('/usr/bin/node'));
  const termux = nodeAliasCandidates({ PREFIX: '/data/data/com.termux/files/usr' });
  assert.ok(termux.includes('/data/data/com.termux/files/usr/bin/node'));
  // Dedup: un PREFIX che coincide con un root noto non duplica.
  const dup = nodeAliasCandidates({ PREFIX: '/usr' });
  assert.equal(dup.filter((c) => c === '/usr/bin/node').length, 1);
});

test('entryAliasCandidates: il suffisso e DERIVATO dal path in esecuzione, non inventato', () => {
  const entry = '/qualcosa/versions/node/v24/lib/node_modules/@mmmbuto/nexuscrew/bin/nexuscrew.js';
  const c = entryAliasCandidates(entry, {});
  assert.ok(c.length >= 3, 'almeno tre radici stabili');
  for (const cand of c) {
    assert.ok(cand.endsWith(path.join('lib', 'node_modules', '@mmmbuto', 'nexuscrew', 'bin', 'nexuscrew.js')),
      `il suffisso del pacchetto va preservato intatto: ${cand}`);
  }
  assert.ok(c.includes(path.join('/opt/homebrew', 'lib', 'node_modules', '@mmmbuto', 'nexuscrew', 'bin', 'nexuscrew.js')));
  const termux = entryAliasCandidates(entry, { PREFIX: '/data/data/com.termux/files/usr' });
  assert.ok(termux.includes('/data/data/com.termux/files/usr/lib/node_modules/@mmmbuto/nexuscrew/bin/nexuscrew.js'));
});

test('entryAliasCandidates: un path senza node_modules (checkout di sviluppo) non ha candidati', () => {
  assert.deepEqual(entryAliasCandidates('/home/qualcuno/dev/nexuscrew/bin/nexuscrew.js', {}), []);
  assert.deepEqual(entryAliasCandidates('', {}), []);
  assert.deepEqual(entryAliasCandidates(null, {}), []);
});

// —— risolutore, realpath iniettato: i tre esiti del briefing ————————————————

test('resolveStableAlias: alias trovato — salta assenti e file diversi, sceglie il primo identico', () => {
  // ALMENO TRE candidati, e l'ordine conta: [assente, file diverso, file uguale].
  // Se il risolutore si fermasse al primo esistente sceglierebbe 'diverso';
  // se non provasse tutti non arriverebbe al terzo.
  const reale = '/vera/installazione/node';
  const fakeReal = (p) => {
    if (p === reale) return reale;
    if (p === '/usr/local/bin/node') return '/un/altro/node/diverso';
    if (p === '/usr/bin/node') return reale;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  };
  const r = resolveStableAlias(reale,
    ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
    { realpath: fakeReal });
  assert.equal(r.alias, '/usr/bin/node', 'sceglie il candidato che risolve allo stesso file, non il primo che esiste');
  assert.equal(r.path, '/usr/bin/node');
  assert.equal(r.warning, null, 'nessun avviso quando l\'alias c\'e\': sarebbe rumore');
});

test('resolveStableAlias: alias assente — path attuale intatto + dichiarazione', () => {
  const fakeReal = (p) => { throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); };
  const r = resolveStableAlias('/home/x/.nvm/versions/node/v24.10.0/bin/node',
    ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'],
    { realpath: fakeReal });
  assert.equal(r.path, '/home/x/.nvm/versions/node/v24.10.0/bin/node', 'il path attuale non si tocca');
  assert.equal(r.alias, null);
  assert.ok(typeof r.warning === 'string' && r.warning.includes('/home/x/.nvm/versions/node/v24.10.0/bin/node'),
    'la dichiarazione nomina il path che puo\' scadere: un avviso alla scrittura, non il silenzio');
});

test('resolveStableAlias: candidato presente ma file DIVERSO — non lo usa', () => {
  const reale = '/vera/installazione/node';
  const fakeReal = (p) => (p === reale ? reale : '/un/altro/node/diverso');
  const r = resolveStableAlias(reale, ['/usr/bin/node', '/usr/local/bin/node', '/opt/homebrew/bin/node'],
    { realpath: fakeReal });
  assert.equal(r.alias, null, 'un candidato che risolve a un file diverso NON e\' un alias');
  assert.equal(r.path, reale);
  assert.ok(r.warning, 'e la scadenza potenziale va dichiarata');
});

// —— filesystem VERO: symlink reali, realpath reale ——————————————————————————

test('resolveStableAlias su FS vero: la coppia discriminante (stesso file scelto, file diverso NO)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-'));
  try {
    const veroNode = path.join(dir, 'node-vero');
    const altroNode = path.join(dir, 'node-altro');
    fs.writeFileSync(veroNode, '#!/bin/sh\n');
    fs.writeFileSync(altroNode, '#!/bin/sh\n');
    const aliasUguale = path.join(dir, 'alias-uguale');   // -> veroNode
    const aliasDiverso = path.join(dir, 'alias-diverso'); // -> altroNode
    fs.symlinkSync(veroNode, aliasUguale);
    fs.symlinkSync(altroNode, aliasDiverso);
    const corrente = path.join(dir, 'copies', 'node-versionato');
    fs.mkdirSync(path.dirname(corrente));
    fs.writeFileSync(corrente, '#!/bin/sh\n');
    fs.unlinkSync(aliasUguale);
    fs.symlinkSync(corrente, aliasUguale); // ora aliasUguale -> lo STESSO file di corrente

    // POSITIVO: symlink allo stesso file -> scelto.
    const pos = resolveStableAlias(corrente, [aliasDiverso, aliasUguale], {});
    assert.equal(pos.alias, aliasUguale, 'il symlink che risolve allo stesso file viene scelto');
    assert.equal(pos.path, aliasUguale);

    // NEGATIVO (il controllo del briefing): lo STESSO meccanismo, ma l'unico
    // candidato risolve a un file DIVERSO -> NON scelto. Se questo braccio
    // restasse verde da solo senza il rosso del positivo, la guardia
    // guarderebbe l'oggetto sbagliato.
    const neg = resolveStableAlias(corrente, [aliasDiverso], {});
    assert.equal(neg.alias, null, 'il symlink a un file diverso NON deve essere scelto');
    assert.equal(neg.path, corrente, 'il path attuale resta intatto');
    assert.ok(neg.warning, 'e la mancanza di alias va dichiarata');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// —— composizione al punto di scrittura ——————————————————————————————————————

test('resolveBootPaths: caso nvm — nessun alias per NESSUNO dei due path, due dichiarazioni', () => {
  const nodeBin = '/home/x/.nvm/versions/node/v24.10.0/bin/node';
  const entry = '/home/x/.nvm/versions/node/v24.10.0/lib/node_modules/@mmmbuto/nexuscrew/bin/nexuscrew.js';
  const tuttoEnoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const r = resolveBootPaths({ nodeBin, entryPath: entry, env: {}, realpath: () => tuttoEnoent() });
  assert.equal(r.nodeBin, nodeBin, 'node: path attuale');
  assert.equal(r.entryPath, entry, 'entry: path attuale');
  assert.equal(r.warnings.length, 2, 'ENTRAMBI i path dichiarati: correggere solo il node e\' il difetto che il briefing vieta');
});

test('resolveBootPaths: caso Homebrew — alias stabili per entrambi, nessuna dichiarazione', () => {
  const nodeBin = '/opt/homebrew/Cellar/node/24.0.0/bin/node';
  const entry = '/opt/homebrew/lib/node_modules/@mmmbuto/nexuscrew/bin/nexuscrew.js';
  const fakeReal = (p) => {
    if (p === nodeBin || p === '/opt/homebrew/bin/node') return nodeBin;
    if (p === entry) return entry;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const r = resolveBootPaths({ nodeBin, entryPath: entry, env: {}, realpath: fakeReal });
  assert.equal(r.nodeBin, '/opt/homebrew/bin/node', 'il node scritto e\' l\'alias stabile, non il Cellar versionato');
  assert.equal(r.entryPath, entry, 'l\'entry era gia\' sotto la radice stabile: resta se\'');
  assert.deepEqual(r.warnings, [], 'nessun avviso quando entrambi i path hanno un riferimento stabile');
});

// —— il punto di scrittura VERO: runInit installa l'unit con i path risolti ——
//
// Questo test ricomputa l'atteso con lo STESSO risolutore sugli STESSI input
// di runInit (process.execPath + entry dal repo root) e lo confronta col file
// installato e con gli WARN. Sulla macchina di sviluppo nvm (nessun alias)
// discrimina sui WARN; su una macchina Homebrew discriminerebbe sul path del
// node (alias != Cellar). Dove i due rami coincidono (node gia' stabile) il
// test non puo' vedere la differenza — dichiarato, e' il prezzo dell'onestà:
// la prova deterministica sta nei test sopra.
test('runInit scrive il companion di boot con i path RISOLTI e dichiara cio\' che non ha alias', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r23-init-'));
  const installTarget = path.join(home, 'svc.service');
  const fleetTarget = path.join(home, 'nexuscrew-fleet.service');
  try {
    const logs = [];
    const r = runInit({
      platform: 'linux', home, tmuxOk: true,
      installPath: installTarget,
      fleetInstallPath: fleetTarget,
      execImpl: () => {},
      log: (m) => logs.push(m),
    });
    assert.ok(fs.existsSync(fleetTarget), 'il companion di boot deve essere installato');
    const unit = fs.readFileSync(fleetTarget, 'utf8');

    const repoRoot = path.join(__dirname, '..');
    const atteso = resolveBootPaths({
      nodeBin: process.execPath,
      entryPath: path.join(repoRoot, 'bin', 'nexuscrew.js'),
    });
    const execStart = unit.split('\n').find((l) => l.startsWith('ExecStart='));
    assert.ok(execStart, 'ExecStart presente nell\'unit');
    assert.ok(execStart.includes(escapeSystemdExec(atteso.nodeBin)),
      `ExecStart deve contenere il node RISOLTO (${atteso.nodeBin}): ${execStart}`);
    assert.ok(execStart.includes(escapeSystemdExec(atteso.entryPath)),
      `ExecStart deve contenere l'entry RISOLTO (${atteso.entryPath}): ${execStart}`);

    const warns = r.actions.filter((a) => a.startsWith('WARN fleet companion:'));
    assert.equal(warns.length, atteso.warnings.length,
      `le dichiarazioni nel report devono essere esattamente quelle del risolutore (attese ${atteso.warnings.length})`);
    for (const w of atteso.warnings) {
      assert.ok(warns.some((a) => a.includes(w)), `la dichiarazione va riportata: ${w}`);
    }

    // 1-bis: il servizio PER-NODO e' il secondo punto di scrittura degli
    // stessi path — i due siti NON devono divergere (correggerne uno solo
    // lascerebbe il difetto vivo). Stesse attese, stesso risolutore.
    const svcUnit = fs.readFileSync(installTarget, 'utf8');
    const svcExec = svcUnit.split('\n').find((l) => l.startsWith('ExecStart='));
    assert.ok(svcExec, 'ExecStart presente nell\'unit del servizio per-nodo');
    assert.ok(svcExec.includes(escapeSystemdExec(atteso.nodeBin)),
      `il servizio per-nodo deve contenere il node RISOLTO (${atteso.nodeBin})`);
    assert.ok(svcExec.includes(escapeSystemdExec(atteso.entryPath)),
      `il servizio per-nodo deve contenere l'entry RISOLTO (${atteso.entryPath})`);
    const svcWarns = r.actions.filter((a) => a.startsWith('WARN service:'));
    assert.equal(svcWarns.length, atteso.warnings.length,
      'anche il servizio per-nodo dichiara cio\' che non ha alias');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
