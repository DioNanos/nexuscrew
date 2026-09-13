'use strict';
// Provisioning dell'authority mode. Genera le DUE credenziali distinte
// (daemon + launcher) nella directory dell'authority, con permessi 0700/0600,
// e attiva `fleet.identity.mode = "authority"` nella config. Idempotente:
// credenziali esistenti non vengono MAI sovrascritte senza --force.
//
// Nessun valore di credenziale torna nel ritorno e nessun valore finisce nei
// log: il ritorno descrive solo percorsi e azioni.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CREDENTIAL_FILES = Object.freeze({
  identityDaemonCredential: 'daemon.credential',
  identityLauncherCredential: 'launcher.credential',
});

function defaultAuthorityDir(home) {
  return path.join(home || require('node:os').homedir(), '.nexuscrew', 'identity-authority');
}

function assertSafeMode(filePath, expectedMode) {
  const st = fs.lstatSync(filePath);
  if (!st.isFile()) throw new Error(`identity provision: ${filePath} non e' un file regolare`);
  if ((st.mode & 0o777) !== expectedMode) {
    throw new Error(`identity provision: ${filePath} ha permessi ${(st.mode & 0o777).toString(8)} (attesi ${expectedMode.toString(8)})`);
  }
}

function existingCredentials(dir) {
  const found = [];
  for (const name of Object.values(CREDENTIAL_FILES)) {
    const filePath = path.join(dir, name);
    try {
      const st = fs.lstatSync(filePath);
      if (st.isFile() && st.size > 0) found.push(filePath);
    } catch (_) { /* assente: ok */ }
  }
  return found;
}

function provisionIdentityAuthority({
  home,
  dir,
  force = false,
  writeConfig = true,
  configPath,
  randomBytes = crypto.randomBytes,
  fsImpl = fs,
  now = new Date,
} = {}) {
  const targetDir = dir || defaultAuthorityDir(home);
  fsImpl.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  const preExisting = existingCredentials(targetDir);
  if (preExisting.length && !force) {
    return {
      ok: false, code: 'ALREADY_PROVISIONED', dir: targetDir,
      existing: preExisting,
      message: 'identity authority already provisioned; pass --force to regenerate',
    };
  }

  const written = [];
  for (const name of Object.values(CREDENTIAL_FILES)) {
    const filePath = path.join(targetDir, name);
    const value = randomBytes(32).toString('hex');
    fsImpl.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
    written.push(filePath);
  }
  // I permessi espliciti valgono anche su filesystem che ignorano mode in
  // writeFileSync (umask larghe): rinforza dopo la scrittura.
  fsImpl.chmodSync(targetDir, 0o700);
  for (const filePath of written) fsImpl.chmodSync(filePath, 0o600);
  for (const filePath of written) assertSafeMode(filePath, 0o600);

  const resolvedConfigPath = configPath
    || (process.env.NEXUSCREW_CONFIG_FILE
      || path.join(home || require('node:os').homedir(), '.nexuscrew', 'config.json'));

  let configUpdated = false;
  let configInstructions = null;
  if (writeConfig) {
    let config = {};
    try {
      config = JSON.parse(fsImpl.readFileSync(resolvedConfigPath, 'utf8'));
      if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
    } catch (_) { config = {}; }
    config.fleet = { ...(config.fleet || {}), identity: { ...(config.fleet?.identity || {}), mode: 'authority' } };
    fsImpl.mkdirSync(path.dirname(resolvedConfigPath), { recursive: true });
    fsImpl.writeFileSync(resolvedConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    configUpdated = true;
  } else {
    configInstructions = [
      'Set the following keys in the NexusCrew config (fleet.identity.mode = "authority")',
      `and keep the two credential files in place under ${targetDir}:`,
      ...Object.values(CREDENTIAL_FILES).map((name) => `  ${path.join(targetDir, name)}`),
    ].join('\n');
  }

  return {
    ok: true, dir: targetDir, written, configUpdated, configInstructions,
    mode: 'authority',
  };
}

module.exports = {
  provisionIdentityAuthority,
  defaultAuthorityDir,
  CREDENTIAL_FILES,
};
