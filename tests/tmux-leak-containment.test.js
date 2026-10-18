'use strict';
// L'invariante del gate di contenimento tmux (tests/run-isolated.js +
// tests/tmux-containment.js), provata da ENTRAMBI i lati.
//
// Il gate chiuso su un verde a vuoto non e' un gate: senza il caso positivo,
// un rilevatore rotto (che non trova mai nulla) passerebbe la suite per
// sempre. L'ordine dei test e' parte della prova: PRIMA si mostra che il
// rilevatore VEDE un server lasciato vivo, POI che la chiusura dell'helper
// lascia il mondo pulito.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { avviaTmuxTest } = require('./tmux-test-server.js');
const { elencaServerTmuxLeak, chiudiServerTmux } = require('./tmux-containment.js');

const tmuxDisponibile = () => {
  const r = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
};

test('positivo: un server tmux lasciato vivo sotto la root viene TROVATO dal rilevatore', { skip: !tmuxDisponibile() && 'tmux non installato' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-leak-probe-'));
  try {
    // Un server «orfano» come lo lascerebbe un test senza teardown: TMUX_TMPDIR
    // sotto la root della suite, vivo, NON chiuso.
    const orfano = await avviaTmuxTest({ tmpDir: root });
    // Un secondo server, con la sua tmpdir ALTROVE: il rilevatore non deve
    // vederlo nella root sbagliata (il match e' per environ, non «tutti i tmux»).
    const estraneo = await avviaTmuxTest();
    try {
      const leak = elencaServerTmuxLeak(root);
      const trovato = leak.find((l) => l.pid === orfano.pid);
      assert.ok(trovato, `il rilevatore deve trovare il server lasciato vivo ${orfano.pid}: ${JSON.stringify(leak)}`);
      assert.match(trovato.prova, new RegExp(`^TMUX_TMPDIR=${root.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`),
        'la prova e la voce environ che ha collocato il processo');
      assert.ok(!leak.some((l) => l.pid === estraneo.pid),
        'un server con environ fuori dalla root non va nel conteggio della root');
      // Il gate chiuderebbe per PID: lo facciamo col modulo stesso.
      const chiusi = await chiudiServerTmux(leak);
      assert.deepEqual(chiusi, [orfano.pid], 'chiusura per segnale del solo leak');
      assert.throws(() => process.kill(orfano.pid, 0), (e) => e.code === 'ESRCH', 'il PID non esiste piu\'');
    } finally {
      await estraneo.chiudi();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('negativo: dopo chiudi() non resta ne processo ne socket, e il rilevatore trova nulla', { skip: !tmuxDisponibile() && 'tmux non installato' }, async () => {
  const server = await avviaTmuxTest();
  const pid = server.pid;
  const socketPath = server.socketPath;
  const dir = server.socketDir;
  await server.chiudi();
  assert.throws(() => process.kill(pid, 0), (e) => e.code === 'ESRCH', 'il PID del server non esiste piu\'');
  assert.equal(fs.existsSync(socketPath), false, 'il file del socket non esiste piu\' (sopravvive al processo: va rimosso)');
  assert.equal(fs.existsSync(dir), false, 'la dir dedicata del server e stata rimossa');
  assert.deepEqual(elencaServerTmuxLeak(dir), [], 'nessun processo con environ sotto la dir del server chiuso');
});
