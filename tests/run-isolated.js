'use strict';

// Official test entrypoint.  Besides per-worker HOME isolation, this enforces
// the most important containment invariants: a passing suite may not leave a
// detached NexusCrew tunnel supervisor alive, NOR a tmux server alive.  Any
// owned leak is terminated by its exact pid/cmd or environ metadata and still
// makes the suite fail.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');
const { sorvegliaStallo } = require('./stall-watchdog.js');
const { elencaServerTmuxLeak, chiudiServerTmux } = require('./tmux-containment.js');
const { elencaSupervisorTunnelLeak, chiudiSupervisorTunnel } = require('./tunnel-supervisor-containment.js');
const { allPidfiles, chiudiLeakDaPidfile } = require('./pidfile-containment.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-tests-'));
const tmuxRoot = path.join(root, 'tmux');
fs.mkdirSync(tmuxRoot, { recursive: true, mode: 0o700 });
const bootstrap = path.join(__dirname, 'isolated-home.cjs');
const testFiles = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(__dirname, name));

async function main() {
  const childEnv = {
    ...process.env,
    NEXUSCREW_TEST_HOME_ROOT: root,
    NEXUSCREW_TEST_TMUX_ROOT: tmuxRoot,
    NEXUSCREW_AUTO_UPDATE: '0',
    TMUX_TMPDIR: tmuxRoot,
  };
  // Never let a test client inherit the operator's live tmux socket.
  delete childEnv.TMUX;
  delete childEnv.TMUX_PANE;
  // CONCORRENZA LIMITATA, e la ragione e' misurata. `node --test` senza questo
  // flag parallelizza sul numero di core: sei file per volta, ognuno dei quali
  // puo' avviare processi figli, socket e finti supervisori. Su questa macchina
  // (sei core, load di base gia' sopra sei) i test che misurano TEMPI cadevano a
  // caso — quattro volte in una notte, su file diversi, sempre verdi in tre giri
  // isolati. Un gate che produce un rosso casuale a ogni giro non e' un gate:
  // insegna a ignorare i rossi, e rende ogni «zero fail» una questione di
  // fortuna.
  //
  // Il prezzo e' un gate piu' lento; il prezzo dell'alternativa e' non sapere se
  // un rosso e' tuo. Chi ha una macchina piu' larga puo' alzarlo con
  // NEXUSCREW_TEST_CONCURRENCY.
  const concurrency = process.env.NEXUSCREW_TEST_CONCURRENCY || '2';
  // Un SECONDO reporter, su un file che nessuno legge: e' il battito che dice se
  // il gate sta avanzando. Costa niente e lascia stdout ereditato — prenderlo in
  // pipe per osservarlo obbligherebbe a rilanciare ogni riga, con contropressione
  // proprio sui test che misurano tempi. Il file sta nella dir temporanea della
  // suite e sparisce con lei.
  const battito = path.join(root, 'progress.tap');
  const child = spawn(process.execPath, [
    '--require', bootstrap, '--test', `--test-concurrency=${concurrency}`,
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${battito}`,
    ...process.argv.slice(2), ...testFiles,
  ], {
    cwd: path.join(__dirname, '..'),
    env: childEnv,
    stdio: 'inherit',
  });
  // Il gate non deve MAI restare appeso in silenzio: un file che lascia handle
  // aperti non esce, il runner lo aspetta per sempre, e appeso somiglia a lento
  // invece che a rotto. Motivazione, misure e casi cattivi in
  // tests/stall-watchdog.js e nel suo test.
  const code = await sorvegliaStallo({
    child,
    segnale: () => { try { return fs.statSync(battito).size; } catch (_) { return -1; } },
    stallMs: Number(process.env.NEXUSCREW_TEST_STALL_MS || 5 * 60_000),
  });

  const leaked = [];
  const anomali = [];
  for (const pidPath of allPidfiles(root)) {
    const esito = await chiudiLeakDaPidfile(pidPath, pidf.readPidfile(pidPath), root);
    if (!esito) continue;
    if (esito.esito === 'chiuso') leaked.push({ pid: esito.pid, pidPath: esito.pidPath });
    else anomali.push(esito);
  }

  // Secondo invariante: nessun server tmux con environ sotto la root della
  // suite puo' restare vivo. Il match e' sull'ENVIRON (TMUX_TMPDIR/HOME sotto
  // root), non sulla cmdline: un server tmux conserva la cmdline del client
  // che l'ha partorito. Per PID e per segnale: `kill-server` sugli orfani puo'
  // essere negato dall'alias della guardia. Il filtro per prefisso sotto la
  // mkdtemp fresca di QUESTA run rende impossibile toccare il server
  // dell'operatore (HOME reale, fuori da qui).
  const tmuxLeaks = elencaServerTmuxLeak(root);
  const tmuxChiusi = tmuxLeaks.length ? await chiudiServerTmux(tmuxLeaks) : [];

  // Terzo invariante, la rete che chiude il punto cieco della prima: nessun
  // supervisor dei tunnel con environ (HOME o TMPDIR) sotto la root della
  // suite puo' restare vivo, QUALUNQUE sia il posto dove e' finito il suo
  // pidfile. La prima rete legge i pidfile sotto root; un test che piazza la
  // fixture home fuori dalla root (mkdtemp dritta in TMPDIR) le sfugge, ma il
  // supervisor eredita comunque la HOME del worker che l'ha partorito, e
  // quella sta sotto root. Chiusura per PID e per segnale, come i tmux; il
  // supervisor di produzione (HOME reale) e' fuori dal filtro per costruzione.
  const tunnelLeaks = elencaSupervisorTunnelLeak(root);
  const tunnelChiusi = tunnelLeaks.length ? await chiudiSupervisorTunnel(tunnelLeaks) : [];

  // L'EVIDENZA DEVE SOPRAVVIVERE ALLA RUN. Il modulo conserva il pidfile quando
  // trova un'anomalia (tests/pidfile-containment.js), ma quel pidfile sta SOTTO
  // la root: cancellare la root qui lo porta via con lei, e di un'anomalia resta
  // solo una riga di stderr su una run gia' finita — cioe' niente da guardare.
  // Con un'anomalia la root si CONSERVA e il suo path si stampa, dicendo che va
  // rimossa a mano; in tutti gli altri casi la pulizia resta com'e', leak chiusi
  // compresi: un leak chiuso e' risolto, e lasciare la root a ogni rosso
  // riempirebbe TMPDIR di rifiuti.
  const rootConservata = anomali.length > 0;
  if (!rootConservata) fs.rmSync(root, { recursive: true, force: true });
  if (leaked.length) {
    process.stderr.write(`\nNexusCrew test containment failure: ${leaked.length} detached tunnel supervisor(s) were cleaned up.\n`);
  }
  if (tmuxLeaks.length) {
    process.stderr.write(`\nNexusCrew test containment failure: ${tmuxChiusi.length} tmux server(s) were cleaned up (${tmuxLeaks.map((l) => `${l.pid} ${l.prova}`).join('; ')}).\n`);
  }
  if (tunnelLeaks.length) {
    process.stderr.write(`\nNexusCrew test containment failure: ${tunnelChiusi.length} tunnel supervisor(s) were cleaned up by environ (${tunnelLeaks.map((l) => `${l.pid} ${l.prova}`).join('; ')}).\n`);
  }
  // Un pidfile che descrive un processo NON appartenente alla run e' un'anomalia:
  // non si tocca il processo (potrebbe essere il supervisor di produzione) e la
  // suite fallisce lo stesso, cosi' la fixture non passa in silenzio.
  if (anomali.length) {
    process.stderr.write(`\nNexusCrew test containment anomaly: ${anomali.length} pidfile(s) under the run root describe a process that does not belong to it; no signal was sent (${anomali.map((a) => `${a.pid} ${a.pidPath}: ${a.motivo}`).join('; ')}).\n`);
    if (rootConservata) {
      process.stderr.write(`The run root was KEPT as evidence: ${root}\nRemove it by hand after the analysis: the preserved pidfiles and the processes they describe are the evidence.\n`);
    }
  }
  if (leaked.length || tmuxLeaks.length || tunnelLeaks.length || anomali.length) process.exit(1);
  process.exit(code);
}

main().catch((error) => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exit(1);
});
