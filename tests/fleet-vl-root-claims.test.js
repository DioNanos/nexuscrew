'use strict';
// S3d — claim con fs.link e lock flock -F. Nessun segnale a processi della
// flotta: i SIGKILL sono sul figlio creato dal test.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const radici = require('../lib/fleet/vl-roots.js');
const sezione = require('../lib/fleet/vl-claim-section.js');

function id() { return crypto.randomBytes(8).toString('hex'); }

function casa(nome) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), nome));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  return home;
}

function foto(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).sort().map((n) => {
    const p = path.join(dir, n);
    const st = fs.lstatSync(p);
    return `${n}:${st.ino}:${st.mode & 0o777}:${st.size}`;
  }).join('\n');
}

function attendi(check, ms = 3000) {
  const fine = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = null;
      try { v = check(); } catch (e) { reject(e); return; }
      if (v) { resolve(v); return; }
      if (Date.now() > fine) { reject(new Error('attesa scaduta')); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function entrati(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith('entered-'));
}

function sblocca(dir, nome) {
  fs.writeFileSync(path.join(dir, `go-${nome.slice('entered-'.length)}`), '1');
}

test('argv di flock: -F, opzioni prima del path, -w in secondi, niente shell', () => {
  const args = radici.argvFlock({
    timeoutSec: 0.25, conflictCode: 73, lockPath: '/tmp/spazio dir/r.lock',
    nodePath: '/usr/bin/node', helperPath: '/opt/helper.js',
  });
  assert.deepEqual(args.slice(0, 6), ['-F', '-x', '-w', '0.25', '-E', '73']);
  assert.equal(args[6], '--');
  assert.equal(args[7], '/tmp/spazio dir/r.lock');
  assert.ok(args.indexOf('-x') < args.indexOf('--'));
  assert.ok(!String(args[3]).endsWith('000'));
});

test('pin assente o hash diverso: rifiuto senza effetti', async () => {
  const home = casa('nc-pin-');
  const claims = radici.dirClaim(home);
  fs.mkdirSync(claims, { mode: 0o700 });
  fs.writeFileSync(path.join(claims, 'sentinella'), 'x');
  const prima = foto(claims);
  const manifest = JSON.parse(JSON.stringify(radici.MANIFEST));
  manifest.flock = { ...manifest.flock, source: path.join(home, 'manca'), sha256: 'ab'.repeat(32) };
  const root = path.join(home, 'srv');
  const esito = await radici.riserva({
    home, manifest, root, launchId: id(), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 1000,
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.outcome, 'refused');
  assert.equal(foto(claims), prima);
});

test('due NC sulla stessa root: un solo vincitore, niente directory vl', async () => {
  const home = casa('nc-due-');
  const root = path.join(home, 'srv');
  const a = radici.riserva({ home, root, launchId: id(), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 4000 });
  const b = radici.riserva({ home, root, launchId: id(), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 4000 });
  const [ea, eb] = await Promise.all([a, b]);
  const esiti = [ea, eb].map((e) => e.outcome).sort();
  assert.deepEqual(esiti, ['claimed', 'collision']);
  assert.equal(fs.readdirSync(radici.dirClaim(home)).filter((n) => n.endsWith('.lease')).length, 1);
  assert.equal(fs.existsSync(path.join(home, '.nexuscrew', 'vl-cells')), false);
});

test('due root distinte restano entrambe nel registro derivato', async () => {
  const home = casa('nc-radici-');
  const a = await radici.riserva({
    home, root: path.join(home, 'a'), launchId: id(), ownerInstanceId: 'own', cellId: 'A', budgetMs: 4000,
  });
  const b = await radici.riserva({
    home, root: path.join(home, 'b'), launchId: id(), ownerInstanceId: 'own', cellId: 'B', budgetMs: 4000,
  });
  assert.equal(a.outcome, 'claimed');
  assert.equal(b.outcome, 'claimed');
  assert.equal(a.lockHeld, true);
  assert.equal(fs.readdirSync(radici.dirClaim(home)).filter((n) => n.endsWith('.own')).length, 2);
});

test('release tardiva di A, dopo B, rilegge e non toglie B', async () => {
  const home = casa('nc-tardi-');
  const root = path.join(home, 'srv');
  const lancioA = id();
  const lancioB = id();
  const base = { home, root, ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 4000 };
  assert.equal((await radici.riserva({ ...base, launchId: lancioA })).outcome, 'claimed');
  assert.equal((await radici.rilascia({ ...base, launchId: lancioA })).outcome, 'released');
  assert.equal((await radici.riserva({ ...base, launchId: lancioB })).outcome, 'claimed');
  const tardi = await radici.rilascia({ ...base, launchId: lancioA });
  assert.equal(tardi.outcome, 'not-held');
  const visto = await radici.ispeziona({ ...base, launchId: lancioB });
  assert.equal(visto.lease.launchId, lancioB);
  assert.equal(visto.own.cellId, 'Cella');
});

test('senza flock due release vecchie cancellano la lease nuova', async () => {
  const home = casa('nc-neg-');
  const root = sezione.canonicaRadice(path.join(home, 'srv'));
  const hold = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hold-'));
  const claims = radici.dirClaim(home);
  const lancioA = id();
  const base = { home, root, ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 4000 };
  assert.equal((await radici.riserva({ ...base, launchId: lancioA })).outcome, 'claimed');
  const runner = path.join(home, 'mutante.cjs');
  fs.writeFileSync(runner, `'use strict';
const { eseguiSezione } = require(${JSON.stringify(path.join(__dirname, '../lib/fleet/vl-claim-section.js'))});
process.stdout.write(JSON.stringify(eseguiSezione(JSON.parse(process.argv[2]))));
`);
  const req = JSON.stringify({
    v: 1, op: 'release', requestId: id(), root, launchId: lancioA,
    ownerInstanceId: 'own', cellId: 'Cella', claimsDir: claims, sectionBudgetMs: 4000,
  });
  const lancia = () => spawn(process.execPath, [runner, req], {
    env: { ...process.env, VL_CLAIM_HOLD_DIR: hold, VL_CLAIM_HOLD_AT: 'dopo-lettura' },
  });
  const r1 = lancia();
  const r2 = lancia();
  await attendi(() => entrati(hold).length >= 2);
  assert.ok(entrati(hold).length >= 2, 'il mutante senza lock si sovrappone');
  const primo = entrati(hold)[0];
  const pid = Number(primo.slice('entered-'.length).split('-')[0]);
  sblocca(hold, primo);
  const uscito = [r1, r2].find((p) => p.pid === pid);
  await new Promise((resolve) => {
    if (uscito.exitCode != null) resolve();
    else uscito.on('exit', resolve);
  });
  const lancioB = id();
  const claimB = sezione.eseguiSezione({
    v: 1, op: 'claim', requestId: id(), root, launchId: lancioB,
    ownerInstanceId: 'own', cellId: 'Cella', claimsDir: claims, sectionBudgetMs: 4000,
  });
  assert.equal(claimB.outcome, 'claimed');
  for (const nome of entrati(hold)) sblocca(hold, nome);
  await Promise.all([r1, r2].map((p) => new Promise((resolve) => {
    if (p.exitCode != null || p.signalCode != null) resolve();
    else p.on('exit', resolve);
  })));
  const lease = fs.readdirSync(claims).filter((n) => n.endsWith('.lease'));
  assert.equal(lease.length, 0, 'la release stantia ha tolto la lease di B');
  fs.rmSync(hold, { recursive: true, force: true });
});

test('con il lock il secondo non entra finche il primo non esce', async () => {
  const home = casa('nc-ser-');
  const root = path.join(home, 'srv');
  const hold = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hold2-'));
  const lanciati = [];
  const primo = radici.riserva({
    home, root, launchId: id(), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 8000,
    holdDir: hold, holdAt: 'dopo-lettura',
    onChild: (c) => lanciati.push(c),
  });
  await attendi(() => entrati(hold).length === 1);
  const secondo = await radici.riserva({
    home, root, launchId: id(), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 500,
  });
  assert.equal(secondo.outcome, 'refused');
  assert.equal(secondo.code, 'LOCK_TIMEOUT');
  assert.equal(entrati(hold).length, 1);
  sblocca(hold, entrati(hold)[0]);
  const esito = await primo;
  assert.equal(esito.outcome, 'claimed');
  assert.equal(fs.readdirSync(radici.dirClaim(home)).filter((n) => n.endsWith('.lease')).length, 1);
  fs.rmSync(hold, { recursive: true, force: true });
});

test('SIGKILL del possessore: prima del link non lascia record, dopo il link il record e completo', async () => {
  const home = casa('nc-kill-');
  const root = path.join(home, 'srv');
  const hold = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hold3-'));
  const lockDir = radici.dirClaim(home);
  let proc = null;
  const p = radici.riserva({
    home, root, launchId: id(), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 8000,
    holdDir: hold, holdAt: 'dopo-lettura', onChild: (c) => { proc = c; },
  });
  await attendi(() => proc && entrati(hold).length === 1);
  const prima = fs.existsSync(path.join(lockDir, fs.readdirSync(lockDir).find((n) => n.endsWith('.lock')) || 'x'))
    ? fs.lstatSync(path.join(lockDir, fs.readdirSync(lockDir).find((n) => n.endsWith('.lock')))).ino : 0;
  proc.kill('SIGKILL');
  const morto = await p;
  assert.notEqual(morto.outcome, 'claimed');
  assert.equal(fs.readdirSync(lockDir).some((n) => n.endsWith('.own') || n.endsWith('.lease')), false);
  const dopo = await radici.riserva({
    home, root, launchId: id(), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 4000,
  });
  assert.equal(dopo.outcome, 'claimed');
  const lock = fs.readdirSync(lockDir).find((n) => n.endsWith('.lock'));
  const ino = fs.lstatSync(path.join(lockDir, lock)).ino;
  assert.equal(ino, prima);

  const hold2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hold4-'));
  const home2 = casa('nc-kill2-');
  const root2 = path.join(home2, 'srv');
  let proc2 = null;
  const p2 = radici.riserva({
    home: home2, root: root2, launchId: id(), ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 8000,
    holdDir: hold2, holdAt: 'dopo-link', onChild: (c) => { proc2 = c; },
  });
  await attendi(() => entrati(hold2).length === 1);
  const dir2 = radici.dirClaim(home2);
  const own = fs.readdirSync(dir2).find((n) => n.endsWith('.own'));
  assert.ok(own);
  const testo = fs.readFileSync(path.join(dir2, own), 'utf8');
  assert.equal(JSON.parse(testo).kind, 'own');
  const ino2 = fs.lstatSync(path.join(dir2, fs.readdirSync(dir2).find((n) => n.endsWith('.lock')))).ino;
  proc2.kill('SIGKILL');
  await p2;
  assert.equal(fs.lstatSync(path.join(dir2, fs.readdirSync(dir2).find((n) => n.endsWith('.lock')))).ino, ino2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir2, own), 'utf8')).kind, 'own');
  fs.rmSync(hold, { recursive: true, force: true });
  fs.rmSync(hold2, { recursive: true, force: true });
});

test('errore di acquisizione: albero invariato', async () => {
  const home = casa('nc-acq-');
  const claims = radici.dirClaim(home);
  fs.mkdirSync(claims, { mode: 0o700 });
  const lock = path.join(claims, `${'ab'.repeat(32)}.lock`);
  fs.writeFileSync(lock, '');
  fs.chmodSync(lock, 0o600);
  const prima = foto(claims);
  const manifest = JSON.parse(JSON.stringify(radici.MANIFEST));
  manifest.flock = { ...manifest.flock, source: path.join(home, 'non-esiste') };
  const esito = await radici.riserva({
    home, manifest, root: path.join(home, 'srv'), launchId: id(),
    ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 1000,
  });
  assert.equal(esito.ok, false);
  assert.equal(esito.outcome, 'refused');
  assert.equal(foto(claims), prima);
});

test('percorso con spazi e richiesta frammentata: un solo esito, fd tenuto', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nc spazio '));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  const root = path.join(home, 'citt\u00e0');
  const launchId = id();
  let argv = null;
  const esito = await radici.riserva({
    home, root, launchId, ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 4000,
    chunk: 1,
    spawnImpl: (exe, args, opts) => {
      argv = { exe, args, shell: opts.shell };
      return spawn(exe, args, opts);
    },
  });
  assert.equal(esito.outcome, 'claimed', `${esito.code || ''} ${esito.stderr || ''}`);
  assert.equal(esito.lockHeld, true);
  assert.equal(argv.shell, false);
  assert.equal(argv.args[0], '-F');
  assert.ok(argv.args[7].includes(' '));
  const tolto = await radici.rilascia({
    home, root, launchId, ownerInstanceId: 'own', cellId: 'Cella', budgetMs: 4000,
  });
  assert.equal(tolto.outcome, 'released');
  assert.equal(fs.readdirSync(radici.dirClaim(home)).some((n) => n.endsWith('.own')), true);
  assert.equal(fs.readdirSync(radici.dirClaim(home)).some((n) => n.endsWith('.lease')), false);
});
