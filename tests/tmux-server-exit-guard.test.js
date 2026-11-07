'use strict';

// La verifica di terminazione esercitata su processi VERI: un negativo
// vivo (il processo resta visibile e la verifica deve fallire) e un
// positivo con cleanup reale (processo terminato, uscita attestata da ps).
// In piu': un ps che non produce verdetto non puo' valere come assenza.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { verificaUscitaServer } = require('./tmux-server-exit-guard.js');

// L'attesa dell'uscita deve lasciare girare l'event loop: e' il loop che
// miete il figlio terminato, finche' resta zombie il pid resta visibile.
function attendiUscita(figlio, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (figlio.exitCode !== null || figlio.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    figlio.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

function attendiAvvio(figlio, timeoutMs = 2000) {
  const termine = Date.now() + timeoutMs;
  while (Date.now() < termine) {
    try {
      process.kill(figlio.pid, 0);
      return true;
    } catch (_) { /* non ancora partito */ }
    spawnSync('sleep', ['0.01']);
  }
  return false;
}

function avviaProcessoVivo() {
  const figlio = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  if (!attendiAvvio(figlio)) {
    try { figlio.kill('SIGKILL'); } catch (_) {}
    throw new Error("il processo di prova non e' partito");
  }
  return figlio;
}

async function fermaProcesso(figlio) {
  try { figlio.kill('SIGKILL'); } catch (_) {}
  await attendiUscita(figlio);
}

test('negativo vivo: un processo reale ancora visibile fallisce la verifica', async () => {
  const figlio = avviaProcessoVivo();
  try {
    assert.throws(
      () => verificaUscitaServer(spawnSync, figlio.pid),
      (e) => e.message.includes('ancora visibile') && e.message.includes(String(figlio.pid)),
    );
  } finally {
    await fermaProcesso(figlio);
  }
});

test('positivo: cleanup reale di un processo terminato passa la verifica', async () => {
  const figlio = avviaProcessoVivo();
  try {
    figlio.kill('SIGKILL');
    assert.equal(await attendiUscita(figlio), true, 'il processo di prova deve uscire');
    assert.equal(verificaUscitaServer(spawnSync, figlio.pid), true);
  } finally {
    await fermaProcesso(figlio);
  }
});

test('ps senza verdetto (errore o timeout) non vale come assenza', () => {
  const pidFittizio = 424242;
  const casi = [
    () => ({ error: Object.assign(new Error('synthetic ps ENOENT'), { code: 'ENOENT' }), status: null, stdout: '' }),
    () => { throw new Error('synthetic spawn throw'); },
    () => ({ status: null, signal: 'SIGTERM', stdout: '' }),
    () => ({ status: 2, stdout: '' }),
  ];
  for (const spawnSenzaVerdetto of casi) {
    assert.throws(
      () => verificaUscitaServer(spawnSenzaVerdetto, pidFittizio),
      (e) => e.message.includes('non ha prodotto un verdetto'),
    );
  }
});
