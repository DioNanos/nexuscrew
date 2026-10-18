'use strict';

// Il gate dei pidfile non manda segnali a un processo che appartiene a un'altra
// run. Un pidfile valido sotto la root della suite descrive un processo: la sua
// appartenenza si dimostra sull'ENVIRON (HOME o TMPDIR sotto la root), non sul
// posto dove il file e' finito. La sentinella di questi test e' innocua: un
// vivo con la cmdline di un supervisor.
//
// LA PROVA SI RINNOVA PRIMA DI OGNI SEGNALE. Il riaudit del 2026-10-18 ha
// misurato che il fallback SIGKILL si fidava del solo PID e della cmdline: un
// processo che rende illeggibile il proprio environ DOPO il SIGTERM
// (prctl(PR_SET_DUMPABLE, 0)) riceveva comunque il secondo segnale. Il quarto
// test riproduce esattamente quel caso.
//
// DOVE L'ENVIRON NON E' LEGGIBILE IL CASO POSITIVO SALTA. La prova di
// appartenenza e' l'environ: se questa macchina non lascia leggerlo (un
// preload che nega EACCES, un kernel diverso) il caso positivo non puo'
// pretendere una chiusura, e lo dichiara invece di fallire. Il fail-closed
// quando la prova manca resta asserito esplicitamente — dal test negativo
// sull'estraneo e da quello sulla prova persa — quindi il gate non si
// indebolisce: cambia solo l'aspettativa del caso che quella prova la richiede.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');
const { chiudiLeakDaPidfile } = require('./pidfile-containment.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Un processo vivo la cui cmdline nomina tunnel-supervisor.js, nato con la HOME
// che gli si dice. `corpo` e' il suo programma: per default non installa handler,
// quindi un SIGTERM la termina; i test del fallback SIGKILL gli fanno ignorare
// SIGTERM.
function sentinella(home, corpo = 'setInterval(() => {}, 1000);\n') {
  const dir = fs.mkdtempSync(path.join(home, 'sentinella-'));
  const script = path.join(dir, 'tunnel-supervisor.js');
  fs.writeFileSync(script, corpo);
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, HOME: home, TMPDIR: home }, stdio: 'ignore',
  });
  return { child, script, cmd: `${path.basename(process.execPath)} ${script}` };
}

// La prova di appartenenza si legge da /proc/<pid>/environ. Dove non e'
// leggibile il caso positivo che la richiede salta invece di fallire.
function environLeggibile(pid) {
  try { fs.readFileSync(`/proc/${pid}/environ`); return true; } catch (_) { return false; }
}

// python3 serve SOLO al negativo che rende il proprio environ illeggibile dopo
// il SIGTERM: `prctl(PR_SET_DUMPABLE, 0)` non ha un equivalente in Node.
function pythonConPrctl() {
  try {
    execFileSync('python3', ['-c', 'import ctypes; ctypes.CDLL(None, use_errno=True)'], { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

// Sentinella in python: nome script da supervisor, SIGTERM che rende il
// processo non dumpable (da quel momento /proc/<pid>/environ e' EACCES anche
// per il nostro stesso UID) e resta viva. E' la riproduzione esatta del
// riaudit, senza mock del filesystem.
const CORPO_PRCTL = [
  'import ctypes, signal, time',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'def term(sig, frame):',
  '    libc.prctl(4, 0, 0, 0, 0)',
  'signal.signal(signal.SIGTERM, term)',
  'while True:',
  '    time.sleep(1)',
  '',
].join('\n');

function sentinellaPrctl(home) {
  const dir = fs.mkdtempSync(path.join(home, 'sentinella-'));
  const script = path.join(dir, 'tunnel-supervisor.js');
  fs.writeFileSync(script, CORPO_PRCTL);
  const child = spawn('python3', [script], {
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home }, stdio: 'ignore',
  });
  return { child, script, cmd: `python3 ${script}` };
}

function pidfileValido(root, nome, figlio) {
  const pidPath = path.join(root, 'tunnels', nome, 'sup.pid');
  pidf.writePidfile(pidPath, figlio.child.pid, figlio.cmd);
  return pidPath;
}

function vivo(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// Il reap del figlio e' asincrono: subito dopo il segnale il PID puo' risultare
// ancora vivo. Si aspetta l'uscita vera prima di asserire la morte.
function morto(child, ms = 2000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(t); resolve(true); });
  });
}

function chiudiSentinella(child) {
  if (vivo(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch (_) {} }
}

test('un pidfile sotto la root non autorizza un segnale a un processo di un\'altra run', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pidfile-root-'));
  const altrove = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pidfile-estranea-'));
  const figlio = sentinella(altrove);
  const { child } = figlio;
  const pidPath = pidfileValido(root, 'estranea', figlio);
  t.after(async () => {
    chiudiSentinella(child);
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
  const figlio = sentinella(casa);
  const { child } = figlio;
  const pidPath = pidfileValido(root, 'nostra', figlio);
  t.after(async () => {
    chiudiSentinella(child);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await delay(200);
  if (!environLeggibile(child.pid)) {
    t.skip('environ non leggibile qui: la prova di appartenenza non e disponibile, quindi questo caso positivo non puo asserire una chiusura (il fail-closed e asserito dai test negativi)');
    return;
  }

  const esito = await chiudiLeakDaPidfile(pidPath, pidf.readPidfile(pidPath), root);

  assert.equal(esito && esito.esito, 'chiuso', JSON.stringify(esito));
  await morto(child);
  assert.equal(vivo(child.pid), false, 'il supervisor della run deve essere terminato');
});

test('il supervisor della run che ignora SIGTERM riceve SIGKILL', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pidfile-root-'));
  const casa = path.join(root, 'home');
  fs.mkdirSync(casa, { recursive: true });
  const figlio = sentinella(casa, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n");
  const { child } = figlio;
  const pidPath = pidfileValido(root, 'ignora', figlio);
  t.after(async () => {
    chiudiSentinella(child);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await delay(200);
  if (!environLeggibile(child.pid)) {
    t.skip('environ non leggibile qui: senza la prova di appartenenza il gate non manda segnali (il fail-closed e asserito dai test negativi)');
    return;
  }

  const esito = await chiudiLeakDaPidfile(pidPath, pidf.readPidfile(pidPath), root);

  assert.equal(esito && esito.esito, 'chiuso', JSON.stringify(esito));
  await morto(child);
  assert.equal(vivo(child.pid), false, 'ignorare SIGTERM non deve salvare la sentinella della run');
});

test('persa la prova di appartenenza dopo SIGTERM, il secondo segnale non parte', async (t) => {
  if (!pythonConPrctl()) {
    t.skip('python3 con ctypes e richiesto per rendere illeggibile /proc/<pid>/environ dopo il SIGTERM');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pidfile-root-'));
  const casa = path.join(root, 'home');
  fs.mkdirSync(casa, { recursive: true });
  const figlio = sentinellaPrctl(casa);
  const { child } = figlio;
  const pidPath = pidfileValido(root, 'perdeprova', figlio);
  t.after(async () => {
    chiudiSentinella(child);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await delay(300);
  if (!environLeggibile(child.pid)) {
    t.skip('environ non leggibile GIA prima del primo segnale: il caso da misurare e la sua perdita DOPO il SIGTERM');
    return;
  }

  const esito = await chiudiLeakDaPidfile(pidPath, pidf.readPidfile(pidPath), root);

  assert.equal(esito && esito.esito, 'anomalia', `atteso anomalia, ottenuto ${JSON.stringify(esito)}`);
  assert.match(String(esito.motivo || ''), /prova persa|SIGTERM|environ/i, esito.motivo);
  assert.equal(vivo(child.pid), true, 'nessun secondo segnale: la sentinella deve essere ancora viva');
  assert.equal(fs.existsSync(pidPath), true, 'il pidfile resta come evidenza: la suite deve fallire, non passare');
});
