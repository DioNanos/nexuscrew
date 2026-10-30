'use strict';
// D-558 FIX2c — contratto di `vl host status --json` contro il BINARIO VERO.
//
// Perche' esiste: la qualifica d'isolamento legge dal JSON due campi
// (`declared_pid`, `pid_number_in_use`). Il test di FIX2b usava un `vl` finto con
// uno schema inventato (`pid`), quindi era verde mentre il percorso reale
// falliva con `pid-assente` (vedi E2E2 del 2026-10-30). Questo test parla con
// `vl-0.4-bin` vero, su una root temporanea e con HOME/XDG isolati, e verifica
// che i campi che NC legge esistano davvero.
//
// Si salta se il binario non c'e' (macchine senza VL installato): non deve
// rendere rossa una suite che non c'entra.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const VL = process.env.NC_VL_STATUS_BIN || path.join(os.homedir(), '.local', 'bin', 'vl-0.4-bin');
const presente = (() => { try { return fs.statSync(VL).isFile(); } catch (_) { return false; } })();
const skip = presente ? false : `binario VL assente: ${VL}`;

function ambiente(root) {
  const home = path.join(root, 'home');
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.state'),
    XDG_DATA_HOME: path.join(home, '.data'),
    XDG_RUNTIME_DIR: path.join(home, '.run'),
    PATH: '/usr/bin:/bin',
  };
}

function prepara(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vlstatus-'));
  fs.chmodSync(root, 0o700);
  const serverRoot = path.join(root, 'host-v1');
  const home = path.join(root, 'home');
  for (const d of [serverRoot, home, path.join(home, '.config'), path.join(home, '.state'),
    path.join(home, '.data'), path.join(home, '.run')]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, serverRoot, env: ambiente(root) };
}

const status = (w) => JSON.parse(execFileSync(VL,
  ['host', 'status', '--json', '--server-root', w.serverRoot],
  { encoding: 'utf8', timeout: 15000, env: { ...process.env, ...w.env } }));

test('contratto: lo status reale espone i campi che la qualifica legge (host assente)', { skip }, (t) => {
  const w = prepara(t);
  const s = status(w);
  assert.equal(s.schema_version, 1);
  assert.equal(typeof s.state, 'string');
  assert.equal(s.state, 'none');
  // I due campi che il runtime legge. Devono ESISTERE anche quando sono null:
  // un campo assente e un campo null si distinguono, e la qualifica non deve
  // dedurre l'uno dall'altro.
  assert.ok(Object.prototype.hasOwnProperty.call(s, 'declared_pid'), 'declared_pid deve esistere');
  assert.ok(Object.prototype.hasOwnProperty.call(s, 'pid_number_in_use'), 'pid_number_in_use deve esistere');
  assert.equal(s.declared_pid, null);
  assert.equal(s.pid_number_in_use, null);
  // Il nome `pid` NON fa parte del contratto: chi lo legge legge uno schema
  // inventato (il difetto F1-bis corretto in FIX2c).
  assert.equal(Object.prototype.hasOwnProperty.call(s, 'pid'), false, 'il contratto non espone `pid`');
  assert.equal(s.server_root, w.serverRoot);
});
