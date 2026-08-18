#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  PACKAGE_NAME, parseVersion, scrubError, adoptUpdateLock, releaseUpdateLock, readState, writeState,
  stableRuntimeDir,
} = require('./core.js');

// R28 — rigenerazione delle definizioni di boot dopo l'installazione.
//
// L'aggiornamento del pacchetto sposta i path versionati che le unit/plist
// scrivono LETTERALMENTE (node del Cellar su Homebrew, pacchetto in
// lib/node_modules): senza questo passo il servizio riparte sulle definizioni
// vecchie e la companion di boot — che nessun altro percorso sana, se non
// `nexuscrew init` — resta puntata a un binario che non esiste più, con exit
// 78 EX_CONFIG e le celle boot:true mute (misurato sul campo 2026-08-18).
//
// Il criterio R23 resta intatto («alias stabile che realpath allo stesso
// file», verificato alla SCRITTURA, mai a ogni avvio) con una estensione
// dichiarata per il caso del runner: il processo dell'update può girare con
// un node già unlinkato su disco, e in quel caso si sceglie il primo percorso
// stabile VIVO (resolveLiveBootPaths).
//
// Contratto: sana SOLO le definizioni che ESISTONO già (il boot è opt-in:
// l'update non installa un companion mai chiesto); attivazione differita
// (activate:false) perché il companion RunAtLoad/oneshot non va eseguito a
// metà update — R28-rimedio: l'attivazione la APPLICA healBootDefinitions
// nel percorso di update (daemon-reload / bootout+bootstrap), non un restart
// che non carica le definizioni; un fallimento NON blocca l'aggiornamento
// (il comportamento senza questo passo era proprio quello) ma viene LOGGATO
// e riportato: il silenzio era il difetto, non il fallimento.
function regenBootDefinitions(opts = {}) {
  const readFileImpl = opts.readFileImpl || fs.readFileSync;
  const serviceMod = opts.serviceMod || require('../cli/service.js');
  const fleetMod = opts.fleetMod || require('../cli/fleet-service.js');
  const aliasMod = opts.aliasMod || require('../cli/stable-alias.js');
  const platformMod = opts.platformMod || require('../cli/platform.js');
  const home = opts.home || os.homedir();
  const platform = opts.platform || platformMod.detectPlatform();
  const log = opts.log || console.log;
  const out = { regenerated: [], skipped: [], warnings: [], errors: [] };

  const revive = aliasMod.resolveLiveBootPaths({
    nodeBin: platformMod.nodeBin(),
    entryPath: path.resolve(__dirname, '..', '..', 'bin', 'nexuscrew.js'),
    ...(opts.realpath ? { realpath: opts.realpath } : {}),
    ...(opts.exists ? { exists: opts.exists } : {}),
  });
  out.warnings.push(...revive.warnings);

  const targets = [
    {
      component: 'service',
      path: () => serviceMod.installPath(platform, home),
      isOurs: (content) => serviceMod.isOurService(platform, content),
      exists: () => {
        try { return fs.lstatSync(serviceMod.installPath(platform, home)).isFile(); } catch (_) { return false; }
      },
      install: () => {
        const content = serviceMod.generateService(platform, {
          repoRoot: platformMod.repoRoot(),
          nodeBin: revive.nodeBin,
          entryPath: revive.entryPath,
          port: opts.port,
          home,
          uid: platformMod.uid(),
        });
        return serviceMod.installService(platform, content, {
          repoRoot: platformMod.repoRoot(),
          nodeBin: revive.nodeBin,
          entryPath: revive.entryPath,
          port: opts.port,
          home,
          uid: platformMod.uid(),
        }, { activate: false });
      },
    },
    {
      component: 'fleet-companion',
      path: () => fleetMod.fleetInstallPath(platform, home),
      isOurs: (content) => fleetMod.isOurFleetService(platform, content),
      exists: () => {
        try { return fs.lstatSync(fleetMod.fleetInstallPath(platform, home)).isFile(); } catch (_) { return false; }
      },
      install: () => fleetMod.installFleetService(platform, fleetMod.generateFleetService({
        platform,
        nodeBin: revive.nodeBin,
        entryPath: revive.entryPath,
        repoRoot: platformMod.repoRoot(),
        home,
      }), { home, uid: platformMod.uid() }, { activate: false }),
    },
  ];

  for (const target of targets) {
    let present;
    try { present = target.exists(); } catch (e) { present = false; }
    if (!present) {
      out.skipped.push(`${target.component}: nessuna definizione installata, nulla da sanare`);
      continue;
    }
    // R28-rimedio, difetto 3 (audit): symlink e directory al posto del target
    // erano già saltati, ma un FILE REGOLARE DI TERZI veniva sovrascritto. Le
    // definizioni che generiamo portano tutte il nome del progetto nell'header
    // (systemd: «# NexusCrew service», plist: Label com.mmmbuto.nexuscrew):
    // se il contenuto non lo contiene, il file non è nostro e non lo tocchiamo
    // — lo skip è dichiarato, non silenzioso. Un file illeggibile non blocca
    // la sanazione (si presume nostro: il caso terzi è il contenuto leggibile
    // che dichiara altro).
    // R28 (audit rev2): la proprieta' si riconosce da un'ancora STRUTTURALE del
    // nostro generatore (isOurService/isOurFleetService), non dalla parola
    // «nexuscrew» presente nel file: un unit di terzi che ci nomina in un
    // commento veniva sovrascritto. E cio' che NON si riesce a leggere non si
    // presume nostro: si salta e si dichiara — l'unica direzione sicura, perche'
    // l'errore costa una sanazione mancata invece del file di qualcun altro.
    let content = null;
    let why = null;
    try { content = readFileImpl(target.path(), 'utf8'); }
    catch (e) {
      why = `${target.component}: definizione esistente non leggibile (${target.path()}, ${(e && e.code) || 'errore'}) — non identificabile, non la tocco; rilancia nexuscrew init`;
    }
    if (!why && !target.isOurs(content)) {
      why = `${target.component}: file esistente non nostro al target (${target.path()}) — nessuna ancora delle nostre definizioni, possibile file di terzi, non lo tocco`;
    }
    if (why) {
      out.skipped.push(why);
      log(`WARN boot definitions: ${why}`);
      continue;
    }
    try {
      const result = target.install();
      out.regenerated.push(target.component);
      out.warnings.push(...(Array.isArray(result.skippedActivation)
        ? result.skippedActivation.map((cmd) => `${target.component}: attivazione differita (${cmd}) — il passo di attivazione dell'update la applica`)
        : []));
      log(`boot definitions: ${target.component} rigenerata su ${result.target}`);
    } catch (e) {
      out.errors.push(`${target.component}: ${String((e && e.message) || e)}`);
      log(`WARN boot definitions: rigenerazione di ${target.component} fallita: ${(e && e.message) || e} (aggiornamento proseguito; rilancia nexuscrew init)`);
    }
  }
  for (const w of out.warnings) log(`WARN boot definitions: ${w}`);
  return out;
}

// R28-rimedio, difetto 2 (audit): l'attivazione differita dichiarata dalla
// regen era una promessa FALSA in silenzio. `restart` fa `systemctl --user
// restart` SENZA daemon-reload (systemd riavvia con la definizione VECCHIA
// in memoria) e `launchctl kickstart` riusa la definizione già caricata; col
// runtime spento non c'è restart affatto. L'attivazione va APPLICATA qui,
// nel percorso di update, subito dopo la regen. È UN SOLO CERVELLO per
// «reinstalla ⇒ sana le definizioni ⇒ rendile note al service manager»:
// la usa il runner dell'auto-update e la usa `update()` manuale (difetto 1:
// la via manuale bypassava la sanazione).
//
// Cosa applica, per piattaforma, dopo la regen:
// - linux: `systemctl --user daemon-reload` — rende note le unit riscritte
//   SENZA avviare nulla (il companion oneshot resta fermo; il restart
//   dell'update carica davvero la definizione nuova).
// - mac, runtime attivo: bootout+bootstrap del principale (RunAtLoad lo
//   riparte subito sul nuovo codice: coincide col restart che l'update farebbe
//   comunque) e POI della companion (le celle boot:true partono col servizio
//   già nuovo). Il kickstart del restart successivo è ridondante e innocuo.
// - mac, runtime SPENTO: NESSUN bootstrap — non si accende ciò che l'utente
//   ha spento, e start/restart non caricano definizioni (kickstart). Limite
//   DICHIARATO in activation.skipped: launchd prende le definizioni scritte
//   al prossimo boot della macchina o con `nexuscrew init`.
// - termux: nessun service manager — skipped dichiarato.
//
// Best-effort come la regen: un fallimento non blocca l'aggiornamento, viene
// loggato e riportato in activation.errors.
function healBootDefinitions(opts = {}) {
  const platformMod = opts.platformMod || require('../cli/platform.js');
  const platform = opts.platform || platformMod.detectPlatform();
  const home = opts.home || os.homedir();
  const execImpl = opts.execImpl || execFileSync;
  const log = opts.log || console.log;
  const regen = (opts.regenImpl || regenBootDefinitions)({ ...opts });
  const out = { ...regen, activation: { applied: [], skipped: [], errors: [] } };
  if (!Array.isArray(regen.regenerated) || regen.regenerated.length === 0) {
    out.activation.skipped.push('nessuna definizione rigenerata: nulla da attivare');
    return out;
  }
  const run = (bin, args) => {
    const cmd = `${bin} ${args.join(' ')}`;
    try { execImpl(bin, args, { stdio: 'ignore' }); out.activation.applied.push(cmd); }
    catch (e) { out.activation.errors.push(`${cmd}: ${(e && e.message) || e}`); }
  };
  if (platform === 'linux') {
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (platform === 'mac') {
    if (opts.running !== true) {
      const limit = 'runtime spento: definizioni scritte e NON attivate — launchd le carica al prossimo boot della macchina o con nexuscrew init (start/restart usano kickstart sulla definizione già in memoria)';
      out.activation.skipped.push(limit);
      out.warnings.push(`attivazione non applicata: ${limit}`);
    } else {
      const uid = opts.uid !== undefined ? opts.uid : platformMod.uid();
      const domain = `gui/${uid}`;
      const serviceMod = opts.serviceMod || require('../cli/service.js');
      const fleetMod = opts.fleetMod || require('../cli/fleet-service.js');
      const boot = (label, target) => {
        // bootout best-effort: non caricato è l'esito atteso del primo giro
        try { execImpl('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch (_) {}
        run('launchctl', ['bootstrap', domain, target]);
      };
      if (regen.regenerated.includes('service')) {
        boot('com.mmmbuto.nexuscrew', serviceMod.installPath(platform, home));
      }
      if (regen.regenerated.includes('fleet-companion')) {
        boot('com.mmmbuto.nexuscrew-fleet', fleetMod.fleetInstallPath(platform, home));
      }
    }
  } else {
    out.activation.skipped.push(`platform ${platform}: nessun service manager, attivazione non applicabile`);
  }
  for (const a of out.activation.applied) log(`boot definitions: attivazione applicata (${a})`);
  for (const s of out.activation.skipped) log(`WARN boot definitions: ${s}`);
  for (const e of out.activation.errors) log(`WARN boot definitions: attivazione fallita: ${e}`);
  return out;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith('--') || argv[i + 1] === undefined) return null;
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

async function restartRuntime(opts = {}) {
  const home = opts.home || os.homedir();
  const commands = opts.commands || require('../cli/commands.js');
  const pidf = opts.pidfile || require('../cli/pidfile.js');
  const platform = opts.platform || require('../cli/platform.js').detectPlatform();
  const url = opts.url || require('../cli/url.js');
  const port = opts.port || url.loadPort({ home });
  const token = opts.token || url.readToken(url.resolvePaths({ home }).tokenPath);
  // Il runner gira come figlio staccato con stdout/stderr già redirette sul
  // log file dell'update (manager.js apre il fd e lo passa allo spawn):
  // console.log qui e' quindi il canale produttivo reale, non un default di
  // comodo per i test. Senza questo, un log iniettato solo nei test prova
  // solo se stesso — il fallimento dello stop tunnel in produzione restava
  // silenzioso anche col passo verificato a monte.
  const log = opts.log || console.log;
  let mode = 'inactive';
  if (commands.isServiceRunning({ platform, home })) {
    const restarted = commands.restart({ platform, home, log });
    if (!restarted || restarted.restarted !== true) {
      throw new Error(`restart service fallito: ${(restarted && restarted.reason) || 'esito non verificato'}`);
    }
    mode = 'service';
  } else {
    // IL PUNTO UNICO DEL RIAVVIO, attraversato anche qui. Fino a qui questo
    // ramo aveva una sua copia di ogni passo: tunnel fermati con un
    // try/copy proprio, abbattimento con killPidfile diretto (senza l'attesa
    // dell'uscita che il riavvio manuale fa), attesa porta inline. Due
    // copie divergono: la stessa divergenza è stata trovata TRE volte, una
    // per guasto — l'ultima misurata sul campo (2026-08-07): riavvii a mano
    // → peer su 2/2, riavvii per aggiornamento → peer giù 2/2, la differenza
    // era UNA riga. Ora i tunnel si fermano PRIMA dallo STESSO ingresso
    // (`fermaTunnelPrimaDiRiavviare`, con la policy best-effort di questo
    // chiamante: il compito principale è aggiornare) e il vecchio processo
    // si abbatte con la STESSA `stopPortableRuntime` del manuale — kill e
    // attesa dell'uscita incluse.
    //
    // COSA PRODUCEVA non fermarli, osservato sul campo: il servizio nuovo
    // trovava un supervisore ancora vivo che non riusciva ad attribuirsi e
    // non lo fermava né ne avviava uno suo (`lib/nodes/tunnel.js`:
    // «unattributable existing supervisor»): il canale inverso restava
    // appeso a un orfano e il peer risultava giù finché qualcuno non
    // interveniva a mano.
    commands.fermaTunnelPrimaDiRiavviare({
      home, platform,
      ...(opts.stopTunnelsImpl ? { stopTunnelsImpl: opts.stopTunnelsImpl } : {}),
      log,
    });
    const pidPath = pidf.defaultPidfilePath(home);
    const meta = pidf.readPidfile(pidPath);
    if (meta && pidf.isAlive(meta)) {
      const stopped = (opts.stopPortableImpl || commands.stopPortableRuntime)({ home, platform, log });
      if (!stopped.killed) throw new Error(`restart portatile fallito: ${stopped.reason || 'processo non arrestato'}`);
      // Il pid è già stato atteso DENTRO stopPortableRuntime (waitForPidExit);
      // resta la PORTA, che il kernel può trattenere oltre la morte del
      // processo: un bind nuovo su porta occupata fa cadere il runtime sul
      // fallback (server.js EADDRINUSE) — una porta DIVERSA da quella
      // configurata, con i peer accoppiati rifiutati. Si aspetta la vera
      // liberazione, non la morte del pid.
      const wait = opts.waitImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
      let released = false;
      for (let i = 0; i < 60; i += 1) {
        if (await (opts.portAvailableImpl || commands.portAvailable)(port)) { released = true; break; }
        await wait(100);
      }
      if (!released) throw new Error(`restart portatile fallito: porta ${port} non liberata`);
      commands.startPortable({ platform, home });
      mode = 'portable';
    }
  }
  if (mode !== 'inactive') {
    const waitFor = opts.waitForRuntimeImpl || commands.waitForNexusCrew;
    const healthy = await waitFor(port, token, {
      waitAttempts: opts.healthAttempts || 60, waitDelayMs: opts.healthDelayMs || 250,
      ...(opts.healthProbeImpl ? { probeImpl: opts.healthProbeImpl } : {}),
    });
    if (!healthy) throw new Error(`NexusCrew ${mode} non healthy su 127.0.0.1:${port} dopo il restart`);
  }
  return mode;
}

async function runUpdate(opts = {}) {
  const version = String(opts.version || '');
  if (!parseVersion(version)) throw new Error('versione update non valida');
  const home = opts.home || os.homedir();
  const statusPath = opts.statusPath || path.join(home, '.nexuscrew', 'npm-update.json');
  const workDir = opts.cwd || stableRuntimeDir(home);
  const execImpl = opts.execImpl || execFileSync;
  const readInstalledVersion = opts.readInstalledVersion || (() => {
    const p = path.resolve(__dirname, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version;
  });
  const preflightImpl = opts.preflightImpl || (({ version: expectedVersion = version } = {}) => {
    const bin = path.resolve(__dirname, '..', '..', 'bin', 'nexuscrew.js');
    const output = execFileSync(process.execPath, [bin, 'version'], {
      encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], cwd: workDir,
    });
    if (String(output || '').trim() !== expectedVersion) throw new Error(`preflight CLI fallito: attesa ${expectedVersion}`);
    return true;
  });
  const restartImpl = opts.restartImpl || restartRuntime;
  const lockPath = opts.lockPath || '';
  const lockToken = opts.lockToken || '';
  let ownsLock = false;
  if (lockPath || lockToken) {
    if (!lockPath || !lockToken || !adoptUpdateLock(lockPath, lockToken, process.pid)) {
      const error = new Error('lock aggiornamento non posseduto'); error.status = 409; throw error;
    }
    ownsLock = true;
  }
  const previous = readState(statusPath);
  const previousVersion = String(readInstalledVersion() || '');
  let installedNew = false;
  // wasRunning serve solo a mac (decide se bootout+bootstrap è lecito: col
  // runtime spento non si accende nulla): su linux daemon-reload non esegue
  // servizi e non serve saperlo. Calcolato PRIMA del try perché vale per il
  // percorso di aggiornamento e per quello di rollback.
  const regenPlatform = opts.regenSeams && opts.regenSeams.platformMod
    ? opts.regenSeams.platformMod.detectPlatform()
    : require('../cli/platform.js').detectPlatform();
  const wasRunning = regenPlatform === 'mac'
    ? ((opts.isRunningImpl || ((o) => require('../cli/commands.js').isServiceRunning(o)))({ home }))
    : undefined;
  try {
    writeState(statusPath, { ...previous, phase: 'installing', targetVersion: version, updaterPid: process.pid, lastError: '' });
    execImpl('npm', ['install', '--global', `${PACKAGE_NAME}@${version}`, '--no-audit', '--no-fund'], {
      stdio: 'inherit', timeout: 5 * 60 * 1000, cwd: workDir,
    });
    const installed = String(readInstalledVersion() || '');
    if (installed !== version) throw new Error(`verifica installazione fallita: attesa ${version}, trovata ${installed || 'sconosciuta'}`);
    installedNew = true;
    await preflightImpl({ version, home });
    writeState(statusPath, { ...readState(statusPath), phase: 'restarting', updaterPid: process.pid, lastError: '' });
    // R28: sana le definizioni di boot PRIMA del riavvio — è il passo che
    // manca al percorso di upgrade e che lasciava la companion puntata a un
    // binario morto (exit 78, silenzio). R28-rimedio: la sanazione ora
    // APPLICA anche l'attivazione differita (healBootDefinitions) — il
    // restart da solo non caricava le definizioni riscritte. Best-effort
    // DICHIARATO: un errore qui non blocca l'aggiornamento, viene loggato e
    // riportato nel risultato.
    const bootDefinitions = (opts.healBootImpl || healBootDefinitions)({
      home, running: wasRunning, execImpl, ...(opts.regenSeams || {}),
      ...(opts.regenBootImpl ? { regenImpl: opts.regenBootImpl } : {}),
    });
    const restartMode = await restartImpl({ home, ...(opts.runtimeSeams || {}) });
    writeState(statusPath, {
      ...readState(statusPath), phase: 'installed', current: version, latest: version,
      available: false, blockedVersion: '', lastUpdatedAt: new Date().toISOString(), lastError: '',
    });
    return { updated: true, version, restartMode, bootDefinitions };
  } catch (e) {
    let rollbackError = null; let rolledBack = false;
    if (installedNew && parseVersion(previousVersion) && previousVersion !== version) {
      try {
        execImpl('npm', ['install', '--global', `${PACKAGE_NAME}@${previousVersion}`, '--no-audit', '--no-fund'], {
          stdio: 'inherit', timeout: 5 * 60 * 1000, cwd: workDir,
        });
        if (String(readInstalledVersion() || '') !== previousVersion) throw new Error(`rollback verify: attesa ${previousVersion}`);
        await preflightImpl({ version: previousVersion, home, rollback: true });
        // R28: il rollback riparte dalle stesse definizioni sane — il
        // downgrade reinstalla il pacchetto nel prefix attuale e i path
        // vivi valgono anche per la versione precedente. R28-rimedio:
        // anche qui sanazione+attivazione (heal), non la sola regen.
        (opts.healBootImpl || healBootDefinitions)({
          home, running: wasRunning, execImpl, ...(opts.regenSeams || {}),
          ...(opts.regenBootImpl ? { regenImpl: opts.regenBootImpl } : {}),
        });
        await restartImpl({ home, ...(opts.runtimeSeams || {}) });
        rolledBack = true;
      } catch (rollbackFailure) { rollbackError = rollbackFailure; }
    }
    const detail = rollbackError
      ? `${scrubError(e)}; rollback ${previousVersion || '?'} fallito: ${scrubError(rollbackError)}`
      : rolledBack ? `${scrubError(e)}; rollback a ${previousVersion} completato` : scrubError(e);
    writeState(statusPath, {
      ...readState(statusPath), phase: 'error', current: rolledBack ? previousVersion : readState(statusPath).current,
      available: true, blockedVersion: installedNew ? version : '', rolledBackTo: rolledBack ? previousVersion : '',
      lastError: detail,
    });
    throw e;
  } finally {
    if (ownsLock) releaseUpdateLock(lockPath, lockToken);
  }
}

if (require.main === module) {
  const parsed = args(process.argv.slice(2));
  if (!parsed || !parsed.version || !parsed.status) process.exitCode = 2;
  else runUpdate({ version: parsed.version, statusPath: parsed.status, home: parsed.home,
    lockPath: parsed.lock, lockToken: parsed['lock-token'] })
    .catch(() => { process.exitCode = 1; });
}

module.exports = { args, restartRuntime, runUpdate, regenBootDefinitions, healBootDefinitions };
