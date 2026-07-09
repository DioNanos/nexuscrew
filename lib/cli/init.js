'use strict';
// nexuscrew init: orchestrazione setup portatile. [B2][M8][R4]
// detectPlatform -> prereq (Node>=18 abort, tmux abort-before-service) ->
// migration rule (porta da service esistente) -> config.json (preserva) ->
// token (preserva) -> NexusFiles -> generateService -> installService (skip dry-run) ->
// print URL #token. Termux:boot detection best-effort.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { detectPlatform, nodeBin, repoRoot, uid } = require('./platform.js');
const { loadOrCreateToken } = require('../auth/token.js');
const { generateService, installService, fileMode, installPath: svcInstallPath } = require('./service.js');

function haveTmux(tmuxBin) {
  try { execFileSync('command', ['-v', tmuxBin], { stdio: 'ignore', shell: true }); return true; }
  catch (_) { return false; }
}

function nodeMajor() {
  return parseInt(String(process.versions.node).split('.')[0], 10);
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
      fs.writeFileSync(configPath, JSON.stringify({ port }, null, 2) + '\n', { mode: 0o600 });
      actions.push(`created config ${configPath} (port ${port})`);
    } else {
      try {
        const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (c && c.port) port = c.port;
      } catch (_) {}
      actions.push(`preserved config ${configPath} (port ${port})`);
    }
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

  // service generation
  const svcCtx = {
    repoRoot: repoRoot(),
    nodeBin: nodeBin(),
    port, home, uid: uid(),
    installPath: opts.installPath,
  };
  const content = generateService(platform, svcCtx);

  if (dryRun) {
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

  // Termux:boot best-effort detection (R4)
  if (platform === 'termux') {
    const bootDir = path.join(home, '.termux', 'boot');
    const bootOk = fs.existsSync(bootDir);
    actions.push(bootOk
      ? `Termux:boot dir presente — verifica app Termux:Boot installata/abilitata per l'avvio al reboot`
      : `Termux:boot dir MANCANTE — installa/apri l'app Termux:Boot una volta per l'avvio automatico`);
  }

  const url = `http://127.0.0.1:${port}/`;
  const urlWithToken = token ? `${url}#token=${token}` : url;
  actions.push(`platform: ${platform}`);
  actions.push(`URL: ${urlWithToken}`);

  for (const a of actions) log(a);

  return { platform, port, token, url: urlWithToken, actions, tmuxOk, dryRun };
}

module.exports = { runInit, readExistingPort, haveTmux, nodeMajor };
