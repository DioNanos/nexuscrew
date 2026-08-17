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
  let mode = 'inactive';
  if (commands.isServiceRunning({ platform, home })) {
    const restarted = commands.restart({ platform, home, log: () => {} });
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
      ...(opts.log ? { log: opts.log } : {}),
    });
    const pidPath = pidf.defaultPidfilePath(home);
    const meta = pidf.readPidfile(pidPath);
    if (meta && pidf.isAlive(meta)) {
      const stopped = (opts.stopPortableImpl || commands.stopPortableRuntime)({ home, platform });
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
    const restartMode = await restartImpl({ home, ...(opts.runtimeSeams || {}) });
    writeState(statusPath, {
      ...readState(statusPath), phase: 'installed', current: version, latest: version,
      available: false, blockedVersion: '', lastUpdatedAt: new Date().toISOString(), lastError: '',
    });
    return { updated: true, version, restartMode };
  } catch (e) {
    let rollbackError = null; let rolledBack = false;
    if (installedNew && parseVersion(previousVersion) && previousVersion !== version) {
      try {
        execImpl('npm', ['install', '--global', `${PACKAGE_NAME}@${previousVersion}`, '--no-audit', '--no-fund'], {
          stdio: 'inherit', timeout: 5 * 60 * 1000, cwd: workDir,
        });
        if (String(readInstalledVersion() || '') !== previousVersion) throw new Error(`rollback verify: attesa ${previousVersion}`);
        await preflightImpl({ version: previousVersion, home, rollback: true });
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

module.exports = { args, restartRuntime, runUpdate };
