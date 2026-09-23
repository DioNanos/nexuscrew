'use strict';
// Il marcatore del pane del supervisore, provato su un tmux VERO.
//
// PERCHE' SERVE UN TEST CON TMUX VERO. Il caso che questo meccanismo chiude e'
// stato MISURATO, non immaginato: `#{pane_dead}` di `list-sessions` riguarda il
// pane ATTIVO, e con una seconda finestra viva selezionata dice «vivo» anche
// quando il pane del supervisore e' morto. Un fake che modella meno di tmux non
// puo' provarlo: qui la sessione ha DUE finestre, una morta (il supervisore) e
// una viva, esattamente come sul campo.
//
// SICUREZZA: si usa una socket TEMPORANEA (`tmux -L <nome casuale>`), mai la
// socket delle celle. Alla fine si uccide SOLO quel server di prova. Se `tmux`
// non c'e', il test si dichiara saltato invece di fallire.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { PANES_FMT, NC_SUPERVISOR_OPT, statiSupervisore } = require('../lib/tmux/supervisor-pane.js');

function tmuxDisponibile() {
  const r = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function nuovoServer(t) {
  // Una socket per test, con un nome che non puo' collidere con quelle vere.
  const socket = `nc-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const tmux = (args, opts = {}) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', ...opts });
  t.after(() => {
    // SOLO questo server di prova, mai quello delle celle: `-L <socket>` e' una
    // socket separata. E si cancella anche il FILE della socket: `kill-server`
    // uccide il server ma lascia il file, e un test che gira spesso riempirebbe
    // /tmp di socket morte (`tmux` la mette in `<tmpdir>/tmux-<uid>/`).
    spawnSync('tmux', ['-L', socket, 'kill-server'], { encoding: 'utf8' });
    for (const base of new Set([os.tmpdir(), '/tmp'])) {
      let voci = [];
      try { voci = fs.readdirSync(base); } catch (_) { continue; }
      for (const voce of voci.filter((v) => v.startsWith('tmux-'))) {
        try { fs.unlinkSync(path.join(base, voce, socket)); } catch (_) { /* non c'era */ }
      }
    }
  });
  return { socket, tmux };
}

test('tmux vero: supervisore morto + seconda finestra viva → sessione senza supervisore', { skip: !tmuxDisponibile() && 'tmux non installato' }, (t) => {
  const server = nuovoServer(t);
  const { tmux } = server;

  // La sessione della cella: la prima finestra e' il supervisore, la seconda una
  // finestra che l'operatore puo' aprire e selezionare (il caso misurato).
  tmux(['new-session', '-d', '-s', 'cloud-Prova', '-x', '80', '-y', '24', 'sh', '-c', 'sleep 300']);

  // Il pane del supervisore e' quello della finestra appena creata. Si prende
  // per ID, non per indice: gli indici di finestra dipendono dalla config di
  // tmux (`base-index`), e fidarsi dell'ordine di un elenco rendeva questo test
  // verde una volta e rosso la successiva.
  const paneSupervisore = tmux(['list-panes', '-t', 'cloud-Prova', '-F', '#{pane_id}']).trim().split('\n')[0];

  // `remain-on-exit` sulla SUA finestra (come la runtime fa sulla cella: e'
  // quello che fa sopravvivere il pane al processo), poi la seconda finestra —
  // quella che l'operatore puo' aprire e selezionare — e il suo pane.
  tmux(['set-option', '-w', '-t', paneSupervisore, 'remain-on-exit', 'on']);
  tmux(['new-window', '-t', 'cloud-Prova']);
  const paneAltraFinestra = tmux(['list-panes', '-t', 'cloud-Prova', '-F', '#{pane_id}']).trim().split('\n')[0];

  // Lo si marca come fa la runtime al lancio, e poi si uccide il PROCESSO che
  // ci gira dentro con SIGKILL — che e' cosa fa OOM. NON `kill-pane`: quello
  // distrugge il pane, e non modella niente (provato: col pane distrutto la
  // sessione restava con la sola seconda finestra). Con remain-on-exit il pane
  // resta, morto.
  tmux(['set-option', '-p', '-t', paneSupervisore, NC_SUPERVISOR_OPT, '1']);
  const pid = Number(tmux(['display-message', '-p', '-t', paneSupervisore, '#{pane_pid}']).trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `pane_pid non letto: ${pid}`);
  process.kill(pid, 'SIGKILL');
  // tmux se ne accorge in un istante: si aspetta il pane morto, non un tempo.
  for (let i = 0; i < 100; i += 1) {
    if (tmux(['list-panes', '-a', '-F', '#{pane_id} #{pane_dead}']).includes(`${paneSupervisore} 1`)) break;
    spawnSync('sleep', ['0.05']);
  }

  // E si seleziona l'ALTRA finestra: e' lì che il campo della sessione direbbe
  // «vivo».
  tmux(['select-pane', '-t', paneAltraFinestra]);

  const elenco = tmux(['list-panes', '-a', '-F', PANES_FMT]);
  const stati = statiSupervisore(elenco);
  assert.equal(stati.get('cloud-Prova'), 'morto',
    `il supervisore e' morto ma la sessione non risulta tale:\n${elenco}`);
  // La prova che il campo della SESSIONE avrebbe mentito: il pane attivo e' vivo.
  const paneAttivoMorto = tmux(['display-message', '-p', '-t', 'cloud-Prova', '#{pane_dead}']).trim();
  assert.equal(paneAttivoMorto, '0', 'il pane attivo della sessione e vivo: e proprio per questo il suo pane_dead non basta');
});

test('tmux vero: supervisore vivo → la sessione NON e senza supervisore', { skip: !tmuxDisponibile() && 'tmux non installato' }, (t) => {
  const { tmux } = nuovoServer(t);
  tmux(['new-session', '-d', '-s', 'cloud-Viva', '-x', '80', '-y', '24', 'sh', '-c', 'sleep 300']);
  const pane = tmux(['list-panes', '-t', 'cloud-Viva', '-F', '#{pane_id}']).trim();
  tmux(['set-option', '-p', '-t', pane, NC_SUPERVISOR_OPT, '1']);
  const stati = statiSupervisore(tmux(['list-panes', '-a', '-F', PANES_FMT]));
  assert.equal(stati.get('cloud-Viva'), 'vivo');
});
