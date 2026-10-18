'use strict';

// Il gate dei pidfile non manda segnali a un processo che appartiene a un'altra
// run. Un pidfile valido sotto la root della suite descrive un processo: la sua
// appartenenza si dimostra sull'ENVIRON (HOME o TMPDIR sotto la root), non sul
// posto dove il file e' finito. La sentinella di questi due test e' innocua: un
// node vivo con la cmdline di un supervisor.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');
const { chiudiLeakDaPidfile } = require('./pidfile-containment.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Un processo vivo la cui cmdline nomina tunnel-supervisor.js, nato con la HOME
// che gli si dice.
function sentinella(home) {
  const dir = fs.mkdtempSync(path.join(home, 'sentinella-'));
  const script = path.join(dir, 'tunnel-supervisor.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, HOME: home, TMPDIR: home }, stdio: 'ignore',
  });
  return { child, script };
}

function pidfileValido(root, nome, child, script) {
  const pidPath = path.join(root, 'tunnels', nome, 'sup.pid');
  pidf.writePidfile(pidPath, child.pid, `${path.basename(process.execPath)} ${script}`);
  return pidPath;
}

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

test('un pidfile sotto la root non autorizza un segnale a un processo di un\'altra run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pidfile-root-'));
  const altrove = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pidfile-estranea-'));
  const { child, script } = sentinella(altrove);
  const pidPath = pidfileValido(root, 'estranea', child, script);
  t.after(async () => {
    if (vivo(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(altrove, { recursive: true, force: true });
  });
  await delay(200);                                  // la sentinella e' viva e leggibile

  const esito = await chiudiLeakDaPidfile(pidPath, pidf.readPidfile(pidPath), root);

  assert.equal(esito && esito.esito, 'anomalia', `atteso anomalia, ottenuto ${JSON.stringify(esito)}`);
  assert.match(String(esito.motivo || ''), /appartenenza|environ/i, esito.motivo);
  assert.ok(vivo(process.pid) && await delay(150) === undefined && vivo(child.pid),
    'la sentinella estranea non deve ricevere segnali');
});

test('il supervisor che appartiene alla run viene chiuso', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pidfile-root-'));
  const casa = path.join(root, 'home');
  fs.mkdirSync(casa, { recursive: true });
  const { child, script } = sentinella(casa);
  const pidPath = pidfileValido(root, 'nostra', child, script);
  t.after(async () => {
    if (vivo(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await delay(200);

  const esito = await chiudiLeakDaPidfile(pidPath, pidf.readPidfile(pidPath), root);

  assert.equal(esito && esito.esito, 'chiuso', JSON.stringify(esito));
  assert.equal(vivo(child.pid), false, 'il supervisor della run deve essere terminato');
});
