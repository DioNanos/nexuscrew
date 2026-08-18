'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../lib/update/core.js');
const { createNpmUpdater, isGlobalInstall, lookupLatestNpm } = require('../lib/update/manager.js');
const { restartRuntime, runUpdate } = require('../lib/update/runner.js');

test('npm updater: confronto semver stabile/prerelease e parsing npm JSON', () => {
  assert.equal(core.compareVersions('0.8.9', '0.8.8'), 1);
  assert.equal(core.compareVersions('0.8.9', '0.8.9'), 0);
  assert.equal(core.compareVersions('0.8.9-beta.2', '0.8.9-beta.10'), -1);
  assert.equal(core.compareVersions('0.8.9', '0.8.9-rc.1'), 1);
  assert.equal(core.registryVersion('"1.2.3"\n'), '1.2.3');
  assert.equal(core.registryVersion('1.2.3\n'), '1.2.3');
  assert.equal(core.registryVersion('["1.2.3"]\n'), '1.2.3');
  assert.equal(core.registryVersion('{"version":"1.2.3"}\n'), '1.2.3');
  assert.equal(core.registryVersion('\u001b[32m1.2.3\u001b[0m\n'), '1.2.3');
  assert.throws(() => core.registryVersion('latest'), /versione non valida/);
});

test('npm updater: npm view usa cwd stabile anche se il cwd originario è stato eliminato', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-cwd-'));
  let seen = null;
  const latest = await lookupLatestNpm({ home, execFileImpl: (_bin, _args, opts, cb) => {
    seen = opts.cwd; cb(null, '"0.8.13"\n');
  } });
  assert.equal(latest, '0.8.13');
  assert.equal(seen, path.join(home, '.nexuscrew'));
  assert.equal(fs.statSync(seen).isDirectory(), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('npm updater: riconosce installazioni globali Linux/macOS/Termux, non il checkout', () => {
  assert.equal(isGlobalInstall('/usr/lib/node_modules/@mmmbuto/nexuscrew'), true);
  assert.equal(isGlobalInstall('/opt/homebrew/lib/node_modules/@mmmbuto/nexuscrew'), true);
  assert.equal(isGlobalInstall('/data/data/com.termux/files/usr/lib/node_modules/@mmmbuto/nexuscrew'), true);
  assert.equal(isGlobalInstall('/home/tester/projects/nexuscrew'), false);
});

test('npm updater: latest inferiore non provoca mai downgrade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-'));
  let spawned = false;
  const updater = createNpmUpdater({
    currentVersion: '0.8.9', home: dir, statusPath: path.join(dir, 'state.json'),
    supported: true, enabled: false, lookupLatest: async () => '0.8.8',
    spawnImpl: () => { spawned = true; },
  });
  const status = await updater.check();
  assert.equal(status.available, false);
  assert.equal(status.latest, '0.8.8');
  assert.equal(status.phase, 'idle');
  assert.equal(spawned, false);
  updater.close();
});

test('npm updater: latest 0.8.24 non sostituisce current 0.8.25-alibaba.0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-alibaba-'));
  let spawned = false;
  const updater = createNpmUpdater({
    currentVersion: '0.8.25-alibaba.0', home: dir, statusPath: path.join(dir, 'state.json'),
    supported: true, enabled: true, lookupLatest: async () => '0.8.24',
    spawnImpl: () => { spawned = true; },
  });
  const status = await updater.check({ autoApply: true });
  assert.equal(core.compareVersions('0.8.24', '0.8.25-alibaba.0'), -1);
  assert.equal(status.available, false);
  assert.equal(status.latest, '0.8.24');
  assert.equal(status.phase, 'idle');
  assert.equal(spawned, false);
  updater.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm updater: latest 0.8.24 non sostituisce current stable 0.8.25', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-stable-'));
  let spawned = false;
  const updater = createNpmUpdater({
    currentVersion: '0.8.25', home: dir, statusPath: path.join(dir, 'state.json'),
    supported: true, enabled: true, lookupLatest: async () => '0.8.24',
    spawnImpl: () => { spawned = true; },
  });
  const status = await updater.check({ autoApply: true });
  assert.equal(core.compareVersions('0.8.24', '0.8.25'), -1);
  assert.equal(status.available, false);
  assert.equal(status.latest, '0.8.24');
  assert.equal(status.phase, 'idle');
  assert.equal(spawned, false);
  updater.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm updater: applica esclusivamente la versione esatta verificata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-'));
  let call = null; let unref = false;
  const updater = createNpmUpdater({
    currentVersion: '0.8.8', home: dir, statusPath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'update.log'), runnerPath: '/safe/runner.js',
    supported: true, enabled: false, lookupLatest: async () => '0.8.9', useSystemdRun: false,
    spawnImpl: (bin, argv, opts) => { call = { bin, argv, opts }; return { pid: 43210, unref: () => { unref = true; } }; },
  });
  assert.equal((await updater.check()).available, true);
  const status = await updater.apply();
  assert.equal(status.phase, 'installing');
  assert.deepEqual(call.argv.slice(0, 3), ['/safe/runner.js', '--version', '0.8.9']);
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.cwd, path.join(dir, '.nexuscrew'));
  assert.equal(unref, true);
  updater.close();
});

test('npm update runner: install globale pin esatto, cwd stabile, verifica e restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-runner-'));
  const statusPath = path.join(dir, 'state.json');
  let install = null; let installOpts = null; let restarted = false;
  const out = await runUpdate({
    version: '0.8.9', home: dir, statusPath,
    execImpl: (bin, argv, opts) => { install = { bin, argv }; installOpts = opts; },
    readInstalledVersion: () => '0.8.9',
    preflightImpl: async () => true,
    restartImpl: async () => { restarted = true; return 'portable'; },
  });
  assert.equal(install.bin, 'npm');
  assert.ok(install.argv.includes('@mmmbuto/nexuscrew@0.8.9'));
  assert.equal(install.argv.includes('latest'), false);
  assert.equal(installOpts.cwd, path.join(dir, '.nexuscrew'));
  assert.equal(restarted, true);
  // R28: il risultato ora riporta anche l'esito della rigenerazione delle
  // definizioni di boot. In questa home sintetica non ci sono unit/plist
  // installate: tutto skipped, nessuna rigenerazione, nessun errore. (Le
  // warnings dipendono dall'ambiente reale degli alias, quindi non fanno
  // parte dell'uguaglianza: il contratto verificato qui è il resto.)
  assert.equal(out.updated, true);
  assert.equal(out.version, '0.8.9');
  assert.equal(out.restartMode, 'portable');
  assert.deepEqual(out.bootDefinitions.regenerated, []);
  assert.deepEqual(out.bootDefinitions.errors, []);
  assert.equal(out.bootDefinitions.skipped.length, 2);
  const saved = core.readState(statusPath);
  assert.equal(saved.phase, 'installed');
  assert.equal(saved.current, '0.8.9');
});

test('npm update runner: failure redatta e nessun restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-runner-'));
  const statusPath = path.join(dir, 'state.json');
  let restarted = false;
  await assert.rejects(() => runUpdate({
    version: '0.8.9', home: dir, statusPath,
    execImpl: () => { throw new Error(`registry failed ${'A'.repeat(48)}`); },
    readInstalledVersion: () => '0.8.8', preflightImpl: async () => true,
    restartImpl: async () => { restarted = true; },
  }), /registry failed/);
  assert.equal(restarted, false);
  assert.equal(core.readState(statusPath).lastError.includes('A'.repeat(48)), false);
});

test('npm update runner: un restart service non verificato blocca update e health', async () => {
  let health = false;
  await assert.rejects(() => restartRuntime({
    home: '/tmp/nc-update-restart-guard', platform: 'linux', port: 41820, token: 'test-token',
    commands: {
      isServiceRunning: () => true,
      restart: () => ({ restarted: false, reason: 'tmux survival guard failed' }),
    },
    waitForRuntimeImpl: async () => { health = true; return true; },
  }), /tmux survival guard failed/);
  assert.equal(health, false);
});

test('npm updater: lock interprocesso rifiuta un secondo apply e check non clobbera installing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-lock-'));
  const common = {
    currentVersion: '0.8.8', home: dir, statusPath: path.join(dir, 'state.json'),
    lockPath: path.join(dir, 'update.lock'), logPath: path.join(dir, 'update.log'),
    supported: true, enabled: false, lookupLatest: async () => '0.8.9', useSystemdRun: false,
  };
  const first = createNpmUpdater({ ...common, spawnImpl: () => ({ pid: 43211, unref() {} }) });
  await first.check();
  assert.equal((await first.apply()).phase, 'installing');
  assert.equal((await first.check()).phase, 'installing', 'check non sovrascrive installing');
  const second = createNpmUpdater({ ...common, spawnImpl: () => { throw new Error('must not spawn'); } });
  await assert.rejects(() => second.apply(), (error) => error.status === 409 && error.code === 'update-busy');
  first.close(); second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm updater: latest prerelease viene rifiutata anche se dist-tag errato', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-prerelease-'));
  const updater = createNpmUpdater({ currentVersion: '0.8.8', home: dir,
    statusPath: path.join(dir, 'state.json'), supported: true, enabled: false,
    lookupLatest: async () => '0.8.9-rc.1' });
  const status = await updater.check();
  assert.equal(status.phase, 'error');
  assert.match(status.lastError, /prerelease/);
  updater.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('npm update runner: boot failure rolls back exact previous version once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-runner-rollback-'));
  const statusPath = path.join(dir, 'state.json');
  let installed = '0.8.8'; const installs = []; let restarts = 0;
  await assert.rejects(() => runUpdate({
    version: '0.8.9', home: dir, statusPath,
    execImpl: (_bin, argv) => { const spec = argv.find((arg) => arg.startsWith('@mmmbuto/nexuscrew@')); installed = spec.split('@').at(-1); installs.push(installed); },
    readInstalledVersion: () => installed,
    preflightImpl: async ({ version }) => { assert.equal(version, installed); },
    restartImpl: async () => { restarts += 1; if (restarts === 1) throw new Error('new runtime unhealthy'); return 'service'; },
  }), /unhealthy/);
  assert.deepEqual(installs, ['0.8.9', '0.8.8']);
  assert.equal(restarts, 2);
  const state = core.readState(statusPath);
  assert.equal(state.phase, 'error');
  assert.equal(state.rolledBackTo, '0.8.8');
  assert.equal(state.blockedVersion, '0.8.9');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('update errors redact registry credentials and local home paths', () => {
  const message = core.scrubError(new Error('https://user:password@registry.example /home/tester/.npm/_logs/x Bearer ' + 'Z'.repeat(44)));
  assert.equal(message.includes('password'), false);
  assert.equal(message.includes('/home/tester'), false);
  assert.equal(message.includes('Z'.repeat(44)), false);
});

// NC-S — l'aggiornamento automatico lasciava vivi i supervisori dei tunnel.
//
// Il riavvio MANUALE li ferma da sempre (`commands.restart` chiama
// `stopManagedTunnels`), quindi il ramo gestito era coperto. Il ramo
// PORTATILE — un dispositivo senza gestore di servizi — uccideva il servizio e
// basta: al riavvio il servizio nuovo trovava un supervisore ancora vivo che
// non riusciva ad attribuirsi, e allora NON lo fermava e NON ne avviava uno
// suo. Il canale inverso restava appeso a un orfano e il peer risultava giu'.
//
// La correlazione che lo ha isolato, misurata su un dispositivo reale il
// 2026-08-07: riavvii via `nexuscrew restart` -> peer su, 2 su 2; riavvii per
// aggiornamento automatico -> peer giu', 2 su 2.
test('npm update runner: il riavvio PORTATILE ferma i tunnel, come quello manuale', async () => {
  const fermati = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-update-tunnels-'));
  await restartRuntime({
    home: dir, platform: 'termux', port: 41820, token: 't',
    commands: {
      isServiceRunning: () => false, // ramo portatile
      // Il passo tunnel dal punto unico REALE: lo stopTunnelsImpl del test
      // passa attraverso di esso, come nel prodotto.
      fermaTunnelPrimaDiRiavviare: require('../lib/cli/commands.js').fermaTunnelPrimaDiRiavviare,
      startPortable: () => ({ started: true }),
      portAvailable: async () => true,
    },
    stopTunnelsImpl: (o) => { fermati.push(o); },
    pidfile: { defaultPidfilePath: () => path.join(dir, 'x.pid'), readPidfile: () => null },
    waitForRuntimeImpl: async () => true,
  });

  assert.equal(fermati.length, 1, 'i tunnel vanno fermati prima di riavviare');
  assert.equal(fermati[0].home, dir, 'e sulla home giusta');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm update runner: se fermare i tunnel fallisce, l\'aggiornamento prosegue — e lo dice SUL PATH PRODUTTIVO, senza log iniettato', async () => {
  // Il compito principale e' aggiornare. Un errore qui non deve bloccarlo —
  // ma non deve nemmeno sparire: viene detto. NESSUN log iniettato: un test
  // che passa un logger di comodo prova solo se stesso. Qui si cattura lo
  // stdout REALE del processo — lo stesso canale che manager.js redirige sul
  // file di log dell'update quando lancia questo runner come figlio staccato
  // — cosi' la prova e' che l'utente lo vede davvero, non che il seam esiste.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-update-tunnels-ko-'));
  const originalWrite = process.stdout.write;
  const scritto = [];
  process.stdout.write = (chunk, ...rest) => { scritto.push(String(chunk)); return true; };
  let mode;
  try {
    mode = await restartRuntime({
      home: dir, platform: 'termux', port: 41820, token: 't',
      commands: {
        isServiceRunning: () => false,
        fermaTunnelPrimaDiRiavviare: require('../lib/cli/commands.js').fermaTunnelPrimaDiRiavviare,
        startPortable: () => ({ started: true }),
        portAvailable: async () => true,
      },
      stopTunnelsImpl: () => { throw new Error('ssh non raggiungibile'); },
      pidfile: { defaultPidfilePath: () => path.join(dir, 'x.pid'), readPidfile: () => null },
      waitForRuntimeImpl: async () => true,
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.ok(mode, 'l\'aggiornamento non si ferma per questo');
  assert.match(scritto.join('\n'), /stop tunnel non riuscito/,
    'ma non tace — deve comparire sullo stdout reale, non solo se qualcuno inietta un log nel test');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('il riavvio portatile dell\'update attraversa lo STESSO nucleo del manuale: tunnel e abbattimento veri', async (t) => {
  // Questo test esiste per il controllo negativo: il nucleo condiviso
  // (fermaTunnelPrimaDiRiavviare, stopPortableRuntime) è REALE qui — non
  // stubbato. Se qualcuno rompe il passo nel punto unico, diventano rossi
  // ENTRAMBI i percorsi: questo (update) e quelli di commands.test (mano).
  // Se invece una copia tornasse a vivere, solo uno dei due se ne accorgerebbe.
  const { spawn } = require('node:child_process');
  const pidf = require('../lib/cli/pidfile.js');
  const realCommands = require('../lib/cli/commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-update-nucleo-'));
  // Il cmd nel pidfile deve corrispondere al cmdline VERO del processo
  // (isAlive verifica la coppia pid+cmdline): stesso trucco di portableFixture
  // in commands.test. Il child muore di SIGTERM di default, come un serve.
  const code = 'setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  // Il cleanup si registra SUBITO: se un assert fallisce a metà, il child
  // vivo terrebbe appeso l'intero runner — un test fallito che sembra un
  // hang è la forma peggiore di guasto (vista oggi, e non per caso).
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); });
  const uscito = new Promise((resolve) => { child.on('exit', resolve); });
  const pidPath = pidf.defaultPidfilePath(dir);
  await new Promise((resolve) => { if (child.pid) resolve(); else child.on('spawn', resolve); });
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} -e ${code}`);
  const fermati = [];

  const mode = await restartRuntime({
    home: dir, platform: 'linux', port: 41820, token: 't',
    commands: {
      isServiceRunning: () => false, // ramo portatile
      fermaTunnelPrimaDiRiavviare: realCommands.fermaTunnelPrimaDiRiavviare, // REALE
      stopPortableRuntime: realCommands.stopPortableRuntime,                 // REALE
      startPortable: () => ({ started: true }),
      portAvailable: async () => true,
    },
    stopTunnelsImpl: () => { fermati.push('tunnel'); },
    waitForRuntimeImpl: async () => true,
  });

  assert.equal(mode, 'portable');
  assert.equal(fermati.length, 1, 'i tunnel passano dal punto unico');
  // Se il nucleo reale non abbattesse il child, il test resta appeso: il
  // timeout del runner lo dichiara, e il kill nel t.after lo ripulisce.
  await uscito;
  assert.equal(fs.existsSync(pidPath), false, 'il pidfile del vecchio runtime è stato pulito');
});

// R-pidfile-2/3 (2026-08-17): il difetto MISURATO, non solo temuto — qui,
// non in pidfile.test.js, perché è dove si vede davvero. Un nodo il cui
// runtime è ancora precedente a quando processStart è nato (8fe514f, v0.9.0
// — non a7c8a56/0.9.4 come creduto in un primo momento) ha un pidfile senza
// nessun campo di attestazione: non perché l'attestazione sia fallita, ma
// perché quel codice non la conosceva affatto. Quando aggiorna, npm install
// sovrascrive lib/cli/pidfile.js PRIMA che questo runner lo richieda:
// stopPortableRuntime (nucleo REALE, come il test sopra) legge il pidfile
// VECCHIO col codice NUOVO. Se killPidfile trattasse "nessun campo" come
// indeterminate sempre (fail-closed), stopped.killed sarebbe false,
// restartRuntime lancerebbe "restart portatile fallito", e l'update
// morirebbe per OGNI nodo in questo stato — non un rischio, un guasto certo.
//
// Il fix (lib/cli/pidfile.js) tratta questo caso come COMPATIBILITÀ
// AMBIGUA, concessa SOLO finché questa installazione non ha mai completato
// una scrittura v2 (nessun marker di schema — non "legacy" permanente, che
// l'auditor ha contestato: lasciava aperti per sempre restore/downgrade).
// Questo test copre ENTRAMBI i requisiti del gate 2 e 3: il ciclo di vita
// reale non fallisce QUI (pre-migrazione), e lo dice sul log VERO — non solo
// nel valore di ritorno che runner.js:73 ignora quando killed è true
// (lib/cli/runtime-lifecycle.js stopPortableRuntime lo scrive quando
// unverifiedBirth è presente).
test('npm update runner: un pidfile senza attestazione PRE-migrazione non fa fallire l\'update, e lo dice sul log vero', async (t) => {
  const { spawn } = require('node:child_process');
  const pidf = require('../lib/cli/pidfile.js');
  const realCommands = require('../lib/cli/commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-update-ambig-'));
  const code = 'setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); });
  const uscito = new Promise((resolve) => { child.on('exit', resolve); });
  const pidPath = pidf.defaultPidfilePath(dir);
  await new Promise((resolve) => { if (child.pid) resolve(); else child.on('spawn', resolve); });
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  // Scritto A MANO, non con pidf.writePidfile: è esattamente quello che il
  // codice pre-v0.9.0 avrebbe scritto — nessun processStart, nessun
  // attestation, perché quel campo non esisteva ancora. Nessun marker in
  // questa directory nuova: precondizione pre-migrazione.
  fs.writeFileSync(pidPath, `${JSON.stringify({
    pid: child.pid, cmd: `${process.execPath} -e ${code}`, startTs: Date.now(),
  })}\n`, { mode: 0o600 });
  assert.equal(pidf.hasSchemaMarker(pidPath), false, 'precondizione: nessuna scrittura v2 in questa directory ancora');

  const originalWrite = process.stdout.write;
  const scritto = [];
  process.stdout.write = (chunk, ...rest) => { scritto.push(String(chunk)); return true; };
  let mode;
  try {
    mode = await restartRuntime({
      home: dir, platform: 'linux', port: 41820, token: 't',
      commands: {
        isServiceRunning: () => false, // ramo portatile
        fermaTunnelPrimaDiRiavviare: realCommands.fermaTunnelPrimaDiRiavviare, // REALE
        stopPortableRuntime: realCommands.stopPortableRuntime,                 // REALE — killPidfile nudo
        startPortable: () => ({ started: true }),
        portAvailable: async () => true,
      },
      stopTunnelsImpl: () => {},
      waitForRuntimeImpl: async () => true,
      // NIENTE log iniettato: il path produttivo reale, come nel test sopra
      // sul tunnel — un log che prova solo se stesso non prova che
      // l'operatore lo vedrà mai.
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(mode, 'portable', 'l\'update NON fallisce su compatibilità ambigua pre-migrazione: nessun throw da stopPortableRuntime');
  assert.match(scritto.join('\n'), /identita' NON completamente verificata \(ambiguous-compat\)/,
    'gate 2: il ramo permissivo arriva al log VERO, non solo al valore di ritorno che runner.js ignora quando killed è true');
  await uscito;
  assert.equal(fs.existsSync(pidPath), false, 'il pidfile del vecchio runtime è stato pulito, come sempre');
});

// Gate 3 (Dev, R-pidfile-3): il negativo dopo migrazione. STESSO scenario di
// sopra, ma questa installazione ha GIÀ completato una scrittura v2 (marker
// presente): "nessun campo attestazione" non è più spiegabile come
// pre-migrazione, ed è ESATTAMENTE il guasto che Dev ha misurato — l'update
// deve fallire, di nuovo, ma solo qui: dopo la migrazione, non per sempre.
test('npm update runner: un pidfile senza attestazione DOPO la migrazione fa fallire l\'update, di nuovo', async (t) => {
  const { spawn } = require('node:child_process');
  const pidf = require('../lib/cli/pidfile.js');
  const realCommands = require('../lib/cli/commands.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-update-postmig-'));
  const code = 'setInterval(() => {}, 1000)';
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} fs.rmSync(dir, { recursive: true, force: true }); });
  const pidPath = pidf.defaultPidfilePath(dir);
  await new Promise((resolve) => { if (child.pid) resolve(); else child.on('spawn', resolve); });
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  // La prima scrittura v2 in questa directory: crea il marker per davvero.
  const scritturaV2 = path.join(path.dirname(pidPath), 'altro.pid');
  pidf.writePidfile(scritturaV2, process.pid, 'node altro', {});
  fs.rmSync(scritturaV2, { force: true });
  assert.equal(pidf.hasSchemaMarker(pidPath), true, 'precondizione: la migrazione è già avvenuta in questa directory');
  // Ora il pidfile SENZA attestazione, come sopra — ma dopo la migrazione.
  fs.writeFileSync(pidPath, `${JSON.stringify({
    pid: child.pid, cmd: `${process.execPath} -e ${code}`, startTs: Date.now(),
  })}\n`, { mode: 0o600 });

  await assert.rejects(() => restartRuntime({
    home: dir, platform: 'linux', port: 41820, token: 't',
    commands: {
      isServiceRunning: () => false,
      fermaTunnelPrimaDiRiavviare: realCommands.fermaTunnelPrimaDiRiavviare,
      stopPortableRuntime: realCommands.stopPortableRuntime,
      startPortable: () => ({ started: true }),
      portAvailable: async () => true,
    },
    stopTunnelsImpl: () => {},
    waitForRuntimeImpl: async () => true,
  }), /restart portatile fallito/, 'dopo la migrazione, un pidfile senza attestazione torna a bloccare l\'update — sospetto, non più pre-migrazione');
  assert.equal(pidf.pidOwnership(child.pid), 'owned', 'il processo legittimo non è stato toccato: il rifiuto non tocca il pidfile né il pid');
});

// R28 — i due test dedicati che mancano alla consegna parziale 79fe968.
//
// Il guasto misurato (2026-08-18, upgrade 0.9.6→0.9.7 su mac): l'upgrade
// reinstalla il pacchetto nel prefix del node NUOVO, ma le definizioni di
// boot installate restano quelle di prima — la companion puntata al Cellar
// del node vecchio, ormai unlinkato. `npm install` NON riscrive un'unit già
// installata (lo dichiara anche service.js sopra ensureLinuxTmuxSurvival):
// senza un passo esplicito di rigenerazione, exit 78 EX_CONFIG e celle
// boot:true mute finché qualcuno non lancia `nexuscrew init` a mano.
//
// Qui il percorso È quello del runner, end-to-end: runUpdate vero, con soli
// i seam previsti per il determinismo. `platformMod.nodeBin()` restituisce
// il path MORTO perché è lo scenario reale: il runner dell'update gira con
// il node che lo ha lanciato, che l'upgrade di Homebrew ha già unlinkato
// (il processo resta in memoria, il file no). Il node vivo del test entra
// tra i candidati stabili via PREFIX (seam aliasMod, vedi sotto) e `exists`
// lo rende l'unico eleggibile: senza questo, il primo candidato presente
// sulla macchina che gira i test (/usr/local/bin/node su una, /usr/bin/node
// su un'altra) renderebbe l'esito dipendente dall'host.
// service.js, fleet-service.js e stable-alias.js sono i MODULI REALI: le
// definizioni che finiscono su disco passano da generateLinux/
// generateFleetLinux/resolveLiveBootPaths veri.
test('npm update runner: l\'upgrade rigenera ENTRAMBE le definizioni di boot quando il node puntato è morto', async (t) => {
  const serviceMod = require('../lib/cli/service.js');
  const fleetMod = require('../lib/cli/fleet-service.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-r28-regen-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const statusPath = path.join(dir, 'state.json');

  // Il node morto: il Cellar della versione precedente, già rimpiazzata.
  const deadNode = path.join(dir, 'dead', 'Cellar', 'node', '26.4.0', 'bin', 'node');
  // Il node vivo: un percorso stabile installato (esiste su disco).
  const aliveNode = path.join(dir, 'alive', 'bin', 'node');
  fs.mkdirSync(path.dirname(aliveNode), { recursive: true });
  fs.writeFileSync(aliveNode, '#!/bin/sh\n', { mode: 0o755 });

  // Le definizioni installate PRIMA dell'upgrade: entrambe puntano al node
  // morto. Devono esistere già — il contratto R28 sana solo ciò che c'è.
  const serviceTarget = serviceMod.installPath('linux', dir);
  const fleetTarget = fleetMod.fleetInstallPath('linux', dir);
  fs.mkdirSync(path.dirname(serviceTarget), { recursive: true });
  fs.mkdirSync(path.dirname(fleetTarget), { recursive: true });
  fs.writeFileSync(serviceTarget, `[Service]\nExecStart=${deadNode} serve\n`);
  fs.writeFileSync(fleetTarget, `[Service]\nExecStart=${deadNode} fleet-boot\n`);

  const platformMod = {
    detectPlatform: () => 'linux',
    nodeBin: () => deadNode,
    repoRoot: () => path.resolve(__dirname, '..'),
    uid: () => 1000,
  };
  // regenBootDefinitions non inoltra `env` a resolveLiveBootPaths, quindi il
  // node vivo del test entra nell'elenco dei candidati stabili tramite il
  // seam aliasMod previsto: un wrapper che delega al modulo REALE aggiungendo
  // solo il PREFIX del test (regola documentata di stable-alias:PREFIX aggiunge
  // <PREFIX>/bin/node ai candidati). `exists` restringe poi i candidati al
  // solo node vivo, altrimenti il primo candidato presente sull'host che
  // gira i test vincerebbe sull'ordine.
  const realAlias = require('../lib/cli/stable-alias.js');
  const aliasMod = {
    resolveLiveBootPaths: (o) => realAlias.resolveLiveBootPaths({
      ...o, env: { PREFIX: path.join(dir, 'alive') },
    }),
  };
  const onlyAlive = (p) => p === aliveNode;

  const out = await runUpdate({
    version: '0.9.8', home: dir, statusPath,
    execImpl: () => {},
    readInstalledVersion: () => '0.9.8',
    preflightImpl: async () => true,
    restartImpl: async () => 'portable',
    regenSeams: { platformMod, aliasMod, exists: onlyAlive },
  });

  assert.equal(out.updated, true, 'la rigenerazione best-effort non blocca l\'aggiornamento');
  assert.deepEqual(out.bootDefinitions.regenerated, ['service', 'fleet-companion'],
    'ENTRAMBE le definizioni, non solo la principale — è il difetto di R28');
  assert.deepEqual(out.bootDefinitions.errors, []);
  const serviceTxt = fs.readFileSync(serviceTarget, 'utf8');
  const fleetTxt = fs.readFileSync(fleetTarget, 'utf8');
  assert.ok(serviceTxt.includes(aliveNode) && !serviceTxt.includes(deadNode),
    `il servizio principale riparte su un node vivo (${aliveNode})`);
  assert.ok(fleetTxt.includes(aliveNode) && !fleetTxt.includes(deadNode),
    `la companion riparte su un node vivo (${aliveNode}) — il path che nessun altro sanava`);
  assert.match(out.bootDefinitions.warnings.join('\n'), new RegExp(`il node del servizio.*${deadNode}.*non esiste piu' su disco`),
    'la sostituzione è DICHIARATA, non silenziosa');
  // Le skippedActivation sono per COMANDO (3 systemctl per il service, 2 per
  // la companion): ciò che il contratto richiede è che LE DICHIARI ENTRAMBE
  // le componenti — activate:false, il companion oneshot non parte a metà update.
  assert.ok(out.bootDefinitions.warnings.some((w) => w.startsWith('service: attivazione differita')),
    'il service principale dichiara l\'attivazione differita');
  assert.ok(out.bootDefinitions.warnings.some((w) => w.startsWith('fleet-companion: attivazione differita')),
    'la companion dichiara l\'attivazione differita');
});

// Il controllo negativo dello stesso guasto: senza il passo di rigenerazione
// (regenBootImpl che non fa nulla, come il runner pre-R28), la companion
// resta puntata al node morto. Prova che è QUEL passo a sanare — non
// l'npm install, non il restart, non qualcos'altro lungo la strada.
test('npm update runner: senza il passo di rigenerazione la companion resta puntata al node morto', async (t) => {
  const serviceMod = require('../lib/cli/service.js');
  const fleetMod = require('../lib/cli/fleet-service.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-r28-noregen-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const statusPath = path.join(dir, 'state.json');

  const deadNode = path.join(dir, 'dead', 'Cellar', 'node', '26.4.0', 'bin', 'node');
  const serviceTarget = serviceMod.installPath('linux', dir);
  const fleetTarget = fleetMod.fleetInstallPath('linux', dir);
  fs.mkdirSync(path.dirname(serviceTarget), { recursive: true });
  fs.mkdirSync(path.dirname(fleetTarget), { recursive: true });
  const vecchiaService = `[Service]\nExecStart=${deadNode} serve\n`;
  const vecchiaFleet = `[Service]\nExecStart=${deadNode} fleet-boot\n`;
  fs.writeFileSync(serviceTarget, vecchiaService);
  fs.writeFileSync(fleetTarget, vecchiaFleet);

  const out = await runUpdate({
    version: '0.9.8', home: dir, statusPath,
    execImpl: () => {},
    readInstalledVersion: () => '0.9.8',
    preflightImpl: async () => true,
    restartImpl: async () => 'portable',
    // Il runner pre-R28: nessun passo di rigenerazione delle definizioni.
    regenBootImpl: () => ({ regenerated: [], skipped: [], warnings: [], errors: [] }),
  });

  assert.equal(out.updated, true, 'l\'aggiornamento riusciva anche allora — questo è il punto: il guasto era silenzioso');
  assert.equal(fs.readFileSync(serviceTarget, 'utf8'), vecchiaService,
    'il servizio principale resta sulla definizione vecchia');
  assert.equal(fs.readFileSync(fleetTarget, 'utf8'), vecchiaFleet,
    'la companion resta puntata al node morto: exit 78 al prossimo boot, nessun altro passo la sana');
});
