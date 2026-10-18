'use strict';
// L'invariante del gate di contenimento dei supervisor dei tunnel
// (tests/run-isolated.js + tests/tunnel-supervisor-containment.js), provata
// dal lato che conta.
//
// Il gate chiuso su un verde a vuoto non e' un gate: senza il caso positivo,
// un rilevatore rotto (che non trova mai nulla) passerebbe la suite per
// sempre. Qui un supervisor VERO viene lasciato vivo come lo lascerebbe un
// test senza teardown — cmdline che nomina tunnel-supervisor.js, environ HOME
// sotto la root della suite, pidfile finito FUORI dalla root (il punto cieco
// che ha motivato la rete environ: la scansione dei pidfile non lo vede, il
// rilevatore deve vederlo lo stesso) — e si prova che il rilevatore lo trova,
// che ignora un estraneo con environ altrove e che la chiusura per segnale
// lascia il mondo pulito.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');
const { elencaSupervisorTunnelLeak, chiudiSupervisorTunnel } = require('./tunnel-supervisor-containment.js');

// L'attribuzione per environ richiede /proc leggibile: senza di lui il
// rilevatore torna vuoto per costruzione e il caso positivo non puo' che
// fallire. Su quelle piattaforme il gate resta attivo sulle altre reti.
const procLeggibile = () => {
  try { fs.accessSync('/proc/self/environ', fs.constants.R_OK); return true; } catch (_) { return false; }
};

const pidVivo = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Un supervisor VERO (lo stesso lib/nodes/tunnel-supervisor.js della suite),
// partito detached con sshBin `true`: il figlio esce subito e il supervisor
// resta vivo a ritentare — il comportamento che rende il leak persistente.
// Il pidfile viene scritto sotto la home dell'orfano, che vive DENTRO la root
// indicata; il caller decide se e' la root della prova o quella dell'estraneo.
async function avviaSupervisorOrfano(t, { root, nome }) {
  const home = fs.mkdtempSync(path.join(root, `orph-${nome}-`));
  const tunnelsDir = path.join(home, '.nexuscrew', 'tunnels');
  fs.mkdirSync(tunnelsDir, { recursive: true, mode: 0o700 });
  const pidPath = path.join(tunnelsDir, `${nome}.pid`);
  const statePath = path.join(tunnelsDir, `${nome}.state.json`);
  const runId = 'd'.repeat(32);
  const supervisorPath = path.join(__dirname, '..', 'lib', 'nodes', 'tunnel-supervisor.js');
  const argv = [supervisorPath, 'true', '-N'];
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      HOME: home,
      NEXUSCREW_TUNNEL_STATE: statePath,
      NEXUSCREW_TUNNEL_PIDFILE: pidPath,
      NEXUSCREW_TUNNEL_RUN_ID: runId,
      NEXUSCREW_TUNNEL_STABLE_MS: '30000',
    },
  });
  child.unref();
  pidf.writePidfile(pidPath, child.pid, `${process.execPath} ${argv.join(' ')}`, { runId });
  // Aspetta che sia VIVO per davvero (boot completato: il primo writeState
  // dimostra che il processo gira e possiede la generazione).
  const scadenza = Date.now() + 4000;
  while (Date.now() < scadenza && pidVivo(child.pid) && !fs.existsSync(statePath)) await sleep(50);
  assert.ok(pidVivo(child.pid), `l'orfano ${nome} non e' partito`);
  assert.ok(fs.existsSync(statePath), `l'orfano ${nome} non ha scritto stato (boot incompleto)`);
  const ferma = async () => {
    const esito = pidf.killPidfile(pidPath);
    const fine = Date.now() + 3000;
    while (Date.now() < fine && pidVivo(child.pid)) await sleep(50);
    return esito;
  };
  t.after(ferma);
  return { pid: child.pid, home, ferma };
}

test('positivo: un tunnel supervisor lasciato vivo con environ sotto la root viene TROVATO dal rilevatore, un estraneo no, e la chiusura lo toglie di mezzo', { skip: !procLeggibile() && '/proc non leggibile: attribuzione per environ impossibile' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-leak-probe-'));
  const rootEstraneo = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-leak-estraneo-'));
  try {
    const orfano = await avviaSupervisorOrfano(t, { root, nome: 'reader1' });
    // Un secondo supervisor, con HOME ALTROVE: il rilevatore non deve vederlo
    // nella root sbagliata (il match e' per environ, non «tutti i supervisor»).
    const estraneo = await avviaSupervisorOrfano(t, { root: rootEstraneo, nome: 'other' });
    const leak = elencaSupervisorTunnelLeak(root);
    const trovato = leak.find((l) => l.pid === orfano.pid);
    assert.ok(trovato, `il rilevatore deve trovare il supervisor lasciato vivo ${orfano.pid}: ${JSON.stringify(leak)}`);
    assert.match(trovato.prova, new RegExp(`^HOME=${root.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}`),
      'la prova e la voce environ che ha collocato il processo');
    assert.ok(!leak.some((l) => l.pid === estraneo.pid),
      'un supervisor con environ fuori dalla root non va nel conteggio della root');
    // Il gate chiuderebbe per PID: lo facciamo col modulo stesso.
    const chiusi = await chiudiSupervisorTunnel(leak);
    assert.deepEqual(chiusi, [orfano.pid], 'chiusura per segnale del solo leak');
    assert.throws(() => process.kill(orfano.pid, 0), (e) => e.code === 'ESRCH', 'il PID non esiste piu\'');
    assert.deepEqual(elencaSupervisorTunnelLeak(root), [], 'dopo la chiusura la root e pulita');
    // L'estraneo va chiuso per la sua via (pidfile verificato), e nemmeno la
    // sua root conserva nulla.
    await estraneo.ferma();
    assert.deepEqual(elencaSupervisorTunnelLeak(rootEstraneo), [], 'nemmeno la root dell\'estraneo conserva leak dopo la sua chiusura');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(rootEstraneo, { recursive: true, force: true });
  }
});
