'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {
  readPidfile, writePidfile, pidOwnership, pidExists, isAlive, cleanStale, killPidfile, removePidfile,
} = require('../lib/cli/pidfile.js');

function tmpPid() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pid-'));
  return path.join(dir, 'nexuscrew.pid');
}

test('writePidfile + readPidfile round-trip', () => {
  const p = tmpPid();
  writePidfile(p, 12345, 'node nexuscrew serve');
  const meta = readPidfile(p);
  assert.equal(meta.pid, 12345);
  assert.equal(meta.cmd, 'node nexuscrew serve');
  assert.ok(meta.startTs > 0);
  // mode 0600
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('writePidfile exclusive (wx): no silent overwrite', () => {
  const p = tmpPid();
  writePidfile(p, 111, 'cmd-a');
  assert.throws(() => writePidfile(p, 222, 'cmd-b'), /EEXIST|file already exists/i);
  // contenuto invariato (primo writer)
  assert.equal(readPidfile(p).pid, 111);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readPidfile: assente/malformato -> null', () => {
  const p = tmpPid();
  assert.equal(readPidfile(p), null); // non esiste
  fs.writeFileSync(p, 'not json');
  assert.equal(readPidfile(p), null); // malformato
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('pidExists: processo vivo (self) true, pid morto false', () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(999999), false);
});

test('EPERM: PID esistente ma estraneo non e un processo NexusCrew vivo', () => {
  const foreign = (_pid, signal) => {
    assert.equal(signal, 0);
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  assert.equal(pidOwnership(424242, foreign), 'foreign');
  assert.equal(pidExists(424242, foreign), true, 'il PID esiste genericamente');
  assert.equal(isAlive({ pid: 424242, cmd: 'node tunnel-supervisor.js' }, { killImpl: foreign }), false);
});

test('isAlive: self vivo (cmd match conservativo); meta null false', () => {
  // process.pid e' vivo; 'node' e' sicuramente nel cmdline del processo test
  assert.equal(isAlive({ pid: process.pid, cmd: 'node' }), true);
  assert.equal(isAlive(null), false);
  assert.equal(isAlive({ pid: 999999, cmd: 'x' }), false); // pid morto
});

test('cleanStale: pid morto -> rimuove pidfile', () => {
  const p = tmpPid();
  writePidfile(p, 999999, 'dead-process'); // pid morto
  assert.equal(cleanStale(p), true);
  assert.equal(readPidfile(p), null); // rimosso
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('cleanStale: pid vivo -> non rimuove', () => {
  const p = tmpPid();
  writePidfile(p, process.pid, 'node');
  assert.equal(cleanStale(p), false);
  assert.ok(readPidfile(p)); // ancora presente
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('cleanStale: PID riutilizzato da altro UID viene rimosso automaticamente', () => {
  const p = tmpPid();
  writePidfile(p, 424242, 'node tunnel-supervisor.js');
  const foreign = () => {
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  assert.equal(cleanStale(p, { killImpl: foreign }), true);
  assert.equal(readPidfile(p), null);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: no pidfile -> no kill', () => {
  const p = tmpPid();
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /no pidfile/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: stale (pid morto) -> remove, no kill', () => {
  const p = tmpPid();
  writePidfile(p, 999999, 'dead');
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /stale/);
  assert.equal(readPidfile(p), null); // rimosso
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: PID reuse (cmd mismatch) -> NO kill, remove stale', () => {
  // pid esiste (self) ma cmd salvato non matcha -> PID reuse, non killare
  const p = tmpPid();
  writePidfile(p, process.pid, 'COMPLETELY-DIFFERENT-CMD-XYZ-NOT-MATCHING');
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /pid reuse|cmd mismatch/);
  assert.equal(readPidfile(p), null); // pidfile stale rimosso (no broad kill)
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: EPERM rimuove solo il pidfile e non segnala il processo estraneo', () => {
  const p = tmpPid();
  writePidfile(p, 424242, 'node tunnel-supervisor.js');
  const signals = [];
  const foreign = (_pid, signal) => {
    signals.push(signal);
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  const r = killPidfile(p, 'SIGTERM', { killImpl: foreign });
  assert.deepEqual(signals, [0], 'solo ownership probe, nessun SIGTERM');
  assert.equal(r.killed, false);
  assert.match(r.reason, /not owned/);
  assert.equal(readPidfile(p), null);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

// --- removePidfile: la rimozione verifica il SOGGETTO (rilievo di audit) ----
// Un pidfile non è un file qualunque: è la prova che un processo è vivo.
// Toglierlo quando appartiene a un vivo che non siamo noi cancella quella
// prova — chi lo governa lo crederebbe morto. I casi legittimi (self, stale,
// garbage, e la garanzia del chiamante che ha appena killato) devono continuare
// a funzionare: chiudere il difetto non deve creare un blocco.
const aspettaExit = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once('exit', resolve);
  setTimeout(resolve, 3000); // il test non resta appeso per un figlio ostinato
});

test('removePidfile: il pidfile di un ALTRO processo vivo SOPRAVVIVE al tentativo', async () => {
  // Il caso cattivo: il pidfile è di un processo vivo che non è chi chiama.
  // Qui il "altro processo" è un figlio vero del test (vivo, cmd reale).
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => setTimeout(r, 150)); // il figlio parte
  const p = tmpPid();
  try {
    writePidfile(p, child.pid, `${process.execPath} -e`);
    assert.ok(isAlive(readPidfile(p)), 'precondizione: il pid del file è vivo');
    assert.notEqual(child.pid, process.pid, 'precondizione: non è il nostro pid');
    // Il tentativo di rimozione naked: rifiutato, e il file resta.
    assert.equal(removePidfile(p), false, 'rifiutato: vivo che non siamo noi');
    assert.ok(fs.existsSync(p), 'il pidfile sopravvive: la prova di vita non si cancella');
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
  }
  // Il caso legittimo accanto: MORTO il processo, la pulizia torna a funzionare
  // (non abbiamo chiuso il difetto creando un blocco).
  assert.equal(removePidfile(p), true, 'stale dopo la morte: si rimuove');
  assert.ok(!fs.existsSync(p));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('removePidfile: il NOSTRO pidfile si rimuove (self-cleanup del serve)', () => {
  const p = tmpPid();
  writePidfile(p, process.pid, 'node nexuscrew serve');
  assert.equal(removePidfile(p), true, 'meta.pid === process.pid: è nostro');
  assert.ok(!fs.existsSync(p));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('removePidfile: file garbage (non un pidfile) si rimuove — non è il pidfile di nessuno', () => {
  const p = tmpPid();
  fs.writeFileSync(p, 'not json at all\n');
  assert.equal(removePidfile(p), true);
  assert.ok(!fs.existsSync(p));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('removePidfile: allowLive è la garanzia del chiamante — il vivo si rimuove SOLO con essa', async () => {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => setTimeout(r, 150));
  const p = tmpPid();
  try {
    writePidfile(p, child.pid, `${process.execPath} -e`);
    assert.equal(removePidfile(p, { allowLive: true }), true, 'con la garanzia: rimozione');
    assert.ok(!fs.existsSync(p));
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
  }
  fs.rmSync(path.dirname(p), { recursive: true, force:true });
});

test('killPidfile: lo stop da CLI NON si rompe — post-kill il pidfile si toglie anche se /proc ritarda', () => {
  // Simulazione fedele: il pidfile è di un "server" vivo (mock killImpl non
  // uccide davvero), il cmd matcha, il segnale parte. La rimozione post-kill
  // usa la garanzia allowLive: senza, un /proc lento bloccherebbe lo stop.
  const p = tmpPid();
  writePidfile(p, 424243, 'node nexuscrew serve');
  const segnali = [];
  const killImpl = (pid, signal) => {
    segnali.push(signal);
    if (signal !== 0) return; // segnale partito, il "processo" resta visibile
    return; // ownership probe: ok (owned)
  };
  const r = killPidfile(p, 'SIGTERM', {
    killImpl,
    readCmdlineImpl: () => 'node nexuscrew serve', // cmd matcha: nessun pid-reuse
  });
  assert.deepEqual(segnali, [0, 'SIGTERM'], 'probe + segnale, in ordine');
  assert.equal(r.killed, true);
  assert.equal(readPidfile(p), null, 'post-kill: il pidfile è rimosso');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});
