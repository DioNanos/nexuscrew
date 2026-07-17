'use strict';
// nexuscrew init: orchestrazione setup portatile. [B2][M8][R4]
// detectPlatform -> prereq (Node>=18 abort, tmux abort-before-service) ->
// migration rule (porta da service esistente) -> config.json (preserva) ->
// token (preserva) -> NexusFiles -> generateService -> installService (skip dry-run) ->
// [B4.3] fleet companion (solo se provider builtin + gate ok; READONLY/dry-run skip;
//   mai fa fallire l'init principale) -> print URL #token. Termux:boot best-effort.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { detectPlatform, nodeBin, repoRoot, uid } = require('./platform.js');
const { loadOrCreateToken } = require('../auth/token.js');
const { generateService, installService, fileMode, installPath: svcInstallPath } = require('./service.js');
// B4.3 — companion di boot del fleet (design §4c/§9b/§9d). Seam iniettabili per test.
const {
  generateFleetService, installFleetService, migrationGate,
  selectProviderModeSync, fleetFileMode,
} = require('./fleet-service.js');
const { atomicWrite: writeFleet } = require('../fleet/definitions.js');
const { defaultDefinitions } = require('../fleet/managed.js');
const { commandExists } = require('./path.js');

function haveTmux(tmuxBin, env = process.env) {
  return commandExists(tmuxBin, env);
}

function nodeMajor() {
  return parseInt(String(process.versions.node).split('.')[0], 10);
}

function writeConfigAtomic(configPath, value) {
  try {
    if (fs.lstatSync(configPath).isSymbolicLink()) throw new Error('refusing symlink config target');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, configPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// Migration rule (B2): se non c'è config.json, parse la porta dal service file esistente.
function readExistingPort(platform, home, installPathOverride) {
  const p = installPathOverride || svcInstallPath(platform, home);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
  if (platform === 'linux') {
    const m = raw.match(/Environment=NEXUSCREW_PORT=(\d+)/);
    return m ? Number(m[1]) : null;
  }
  if (platform === 'mac') {
    const m = raw.match(/<key>NEXUSCREW_PORT<\/key>\s*<string>(\d+)/);
    return m ? Number(m[1]) : null;
  }
  if (platform === 'termux') {
    const m = raw.match(/export NEXUSCREW_PORT=(\d+)/);
    return m ? Number(m[1]) : null;
  }
  return null;
}

function runInit(opts = {}) {
  const platform = opts.platform || detectPlatform();
  const home = opts.home || os.homedir();
  const configDir = opts.configDir || path.join(home, '.nexuscrew');
  const configPath = opts.configPath || path.join(configDir, 'config.json');
  const tokenPath = opts.tokenPath || path.join(configDir, 'token');
  const filesRoot = opts.filesRoot || path.join(home, 'NexusFiles');
  const dryRun = !!opts.dryRun;
  const installBoot = opts.installBoot !== false;
  const log = opts.log || (() => {});
  const tmuxOk = opts.tmuxOk !== undefined ? opts.tmuxOk : haveTmux(opts.tmuxBin || 'tmux');

  // prereq Node (abort before any write) [M8]
  if (nodeMajor() < 18) {
    throw new Error(`Node >= 18 richiesto (attuale ${process.versions.node}). Aggiorna Node prima di init.`);
  }

  const actions = [];

  // porta: opts.port > migration rule > config esistente > default 41820
  let port = opts.port;
  if (!port) {
    const migrated = readExistingPort(platform, home, opts.installPath);
    if (migrated) { port = migrated; actions.push(`migration: porta ${port} letta dal service esistente`); }
  }

  // config.json (scrivi se non esiste; preserva se esiste) [B2]
  if (!dryRun) {
    fs.mkdirSync(configDir, { recursive: true });
    if (!fs.existsSync(configPath)) {
      if (!port) port = 41820;
      writeConfigAtomic(configPath, { port });
      actions.push(`created config ${configPath} (port ${port})`);
    } else {
      let current;
      try {
        current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (_) { current = {}; }
      if (opts.port) {
        current.port = opts.port;
        port = opts.port;
        writeConfigAtomic(configPath, current);
        actions.push(`updated config ${configPath} (port ${port})`);
      } else if (current && current.port) port = current.port;
      actions.push(`preserved config ${configPath} (port ${port})`);
    }
  }

  // Fleet app defaults: soltanto i quattro client nativi. Provider cloud/Z.AI sono
  // disponibili nel catalogo managed ma vanno aggiunti esplicitamente.
  const fleetDefsPath = opts.fleetDefsPath || path.join(configDir, 'fleet.json');
  if (!dryRun && !fs.existsSync(fleetDefsPath)) {
    try {
      writeFleet(fleetDefsPath, defaultDefinitions());
      actions.push(`created fleet defaults ${fleetDefsPath} (claude.native, codex.native, codex-vl.native, pi.native)`);
    } catch (e) {
      actions.push(`WARN: fleet defaults non creati: ${e.message}`);
    }
  } else if (!dryRun) {
    actions.push(`preserved fleet definitions ${fleetDefsPath}`);
  }
  if (!port) port = 41820;

  // token (preserva esistente) [M4]
  let token;
  if (!dryRun) {
    token = loadOrCreateToken(tokenPath);
    actions.push(`token ok (${tokenPath})`);
  } else {
    token = null;
  }

  // NexusFiles dir
  if (!dryRun) {
    fs.mkdirSync(filesRoot, { recursive: true });
    actions.push(`files root ${filesRoot}`);
  }

  // nodes.json (B0): nodeId STABILE per installazione (generato qui se manca) +
  // migrazione esplicita guarded dei nodes legacy da config.json. READONLY/dry-run
  // saltano; ogni errore -> WARN, MAI far fallire l'init.
  if (!dryRun && process.env.NEXUSCREW_READONLY !== '1' && !opts.readonly) {
    try {
      const nstore = require('../nodes/store.js');
      const nodesPath = opts.nodesPath || path.join(configDir, 'nodes.json');
      const st = nstore.initStore(nodesPath);
      actions.push(`nodes.json ok (${nodesPath}, nodeId ${st.nodeId.slice(0, 8)}…)`);
      const mig = nstore.migrateLegacyNodes(configPath, nodesPath);
      if (mig.migrated) actions.push(`nodes: migrati ${mig.count} nodi legacy da config.json`);
    } catch (e) {
      actions.push(`WARN: nodes.json init/migrazione fallita: ${e.message} (init prosegue)`);
    }
    try {
      const dstore = require('../decks/store.js');
      const decksPath = opts.decksPath || path.join(configDir, 'decks.json');
      dstore.initStore(decksPath);
      actions.push(`decks.json ok (${decksPath})`);
    } catch (e) {
      actions.push(`WARN: decks.json init fallita: ${e.message} (init prosegue)`);
    }
  }

  // service generation
  const svcCtx = {
    repoRoot: repoRoot(),
    nodeBin: nodeBin(),
    port, home, uid: uid(),
    installPath: opts.installPath,
  };
  const content = generateService(platform, svcCtx);

  if (!installBoot) {
    actions.push(`boot opt-in: service ${platform} non installato`);
  } else if (dryRun) {
    actions.push(`DRY-RUN service (${platform}) generato, NON installato`);
  } else if (!tmuxOk) {
    // tmux mancante: abort before service install (config/token gia' creati) [M8]
    actions.push(`WARN: tmux non trovato su PATH -> service NON installato (installa tmux, ri-runna init)`);
  } else {
    try {
      const r = installService(platform, content, svcCtx, { execImpl: opts.execImpl });
      if (r.failures && r.failures.length) {
        // file installato MA activation (systemctl/launchctl) fallita [M1]
        actions.push(`WARN: service file installato ${r.target} MA activation fallita: ${r.failures.map((f) => f.cmd).join('; ')} (file preservato, diagnosi)`);
      } else {
        actions.push(`service installed ${r.target} (mode 0${fileMode(platform).toString(8)})`);
      }
    } catch (e) {
      // failure: preserve file + diagnosi (no rollback) [M8]
      actions.push(`WARN: service install fallito: ${e.message} (file generati preservati)`);
    }
  }

  // --- B4.3 companion: service di boot del fleet (design §4c/§9b/§9d) ---
  // Il companion si installa SOLO se il provider e' builtin (§9b) e il migration
  // gate non rileva unit legacy cloud-cell@*.service abilitate (no doppio boot).
  // READONLY blocca ogni azione del companion (§9d). MAI far fallire l'init
  // principale: ogni errore del companion -> WARN action + return normale.
  try {
    const readonly = process.env.NEXUSCREW_READONLY === '1' || opts.readonly;
    if (!installBoot) {
      actions.push('fleet companion: boot opt-in, non installato');
    } else if (readonly) {
      actions.push('fleet companion: READONLY, non installato');
    } else {
      // provider mode: companion SOLO se builtin (§9b). selectProviderModeSync e'
      // il default SINCRONO (runInit e' sync: bin chiama process.exit dopo dispatch,
      // selectProvider async non sopravvive). Seam opts.selectProvider per i test.
      const selectProvider = opts.selectProvider || selectProviderModeSync;
      const fleetCfg = opts.fleetCfg || {
        home,
        fleetEnabled: opts.fleetEnabled !== undefined ? opts.fleetEnabled : true,
        builtinEnabled: opts.builtinEnabled,
        fleetDefsPath,
      };
      const sel = selectProvider(fleetCfg) || {};
      if (sel.mode !== 'builtin') {
        actions.push(`fleet companion: non installato (provider ${sel.mode})`);
      } else {
        // migration gate (§9b): seam opts.migrationGate iniettabile; default quello
        // di fleet-service.js (exec iniettabile via opts.execImpl). blocked -> NON
        // installare (mai doppio boot silenzioso).
        const gate = (opts.migrationGate || migrationGate)({ exec: opts.execImpl, platform });
        if (gate.blocked) {
          actions.push(`WARN: fleet companion NON installato — migration gate bloccato: ${(gate.units || []).join(', ')} (${gate.remediation || 'disabilita le unit legacy cloud-cell@*.service'})`);
        } else if (dryRun) {
          actions.push('DRY-RUN fleet companion generato, NON installato');
        } else {
          const fleetContent = generateFleetService({
            platform,
            nodeBin: svcCtx.nodeBin,
            entryPath: path.join(svcCtx.repoRoot, 'bin', 'nexuscrew.js'),
            repoRoot: svcCtx.repoRoot,
            home,
          });
          const fr = installFleetService(
            platform, fleetContent,
            { home, uid: uid(), installPath: opts.fleetInstallPath },
            { execImpl: opts.execImpl },
          );
          if (fr.failures && fr.failures.length) {
            // file installato MA activation (systemctl/launchctl) fallita [M1]
            actions.push(`WARN: fleet companion file installato ${fr.target} MA activation fallita: ${fr.failures.map((f) => f.cmd).join('; ')} (file preservato, diagnosi)`);
          } else {
            actions.push(`fleet companion installed ${fr.target} (mode 0${fleetFileMode(platform).toString(8)})`);
          }
        }
      }
    }
  } catch (e) {
    // qualunque errore del companion: WARN + init principale prosegue intatto.
    actions.push(`WARN: fleet companion fallito: ${e.message} (init principale prosegue)`);
  }

  // Termux:boot best-effort detection (R4)
  if (platform === 'termux' && installBoot) {
    const bootDir = path.join(home, '.termux', 'boot');
    const bootOk = fs.existsSync(bootDir);
    actions.push(bootOk
      ? `Termux:boot dir presente — verifica app Termux:Boot installata/abilitata per l'avvio al reboot`
      : `Termux:boot dir MANCANTE — installa/apri l'app Termux:Boot una volta per l'avvio automatico`);
  }

  const url = `http://127.0.0.1:${port}/`;
  const urlWithToken = token ? `${url}#token=${token}` : url;
  actions.push(`platform: ${platform}`);
  // printUrl:false -> non stampare l'URL col token (usato da smart-up, che presenta
  // URL base + QR da se': cosi' l'output di smart-up non contiene il token in chiaro).
  if (opts.printUrl !== false) actions.push(`URL: ${urlWithToken}`);

  for (const a of actions) log(a);

  return { platform, port, token, url: urlWithToken, actions, tmuxOk, dryRun };
}

module.exports = { runInit, readExistingPort, haveTmux, nodeMajor, writeConfigAtomic };
