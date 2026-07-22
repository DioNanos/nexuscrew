'use strict';
// Regressione tmux REALE su socket isolato per identita e avvio Shell 0.8.31.
// Causa reale: tmux normalizza '.' in '_' nei nomi sessione, per cui i target
// nominali =cloud-<id-con-punto> falliscono deterministicamente anche con un
// child longevo. Il fix usa un nome v2 dot-free; l'avvio staged (placeholder ->
// set-option su @N -> respawn-pane su %N) arma inoltre la diagnostica prima di
// avviare il vero child e conserva il suo exit reale.
//
// NESSUN contatto col server tmux dell'utente: ogni comando usa -S <socket
// isolato>, kill-server in finally.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { parseDefinitions, tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const { migrateLegacyTmuxSessions } = require('../lib/fleet/launch.js');

const TMUX = '/usr/bin/tmux';
const CELL_HOLD = path.join(__dirname, '..', 'lib', 'fleet', 'cell-hold.js');

function sockName() { return `ncrace-${process.pid}`; }

function socketPath(socket) {
  return path.join(os.tmpdir(), `${socket}.sock`);
}

function tmuxClientArgs(socket, args) {
  // Non caricare ~/.tmux.conf: i server di prova devono essere isolati anche
  // dalle command-alias e dalle policy del server operativo. -S rende inoltre
  // il socket esplicito e ripulibile senza dipendere dal TMPDIR interno di tmux.
  return ['-f', '/dev/null', '-S', socketPath(socket), ...args];
}

// Esegue tmux sul socket isolato. Ritorna {code, stdout, stderr}.
function tmux(socket, args, { timeout = 5000 } = {}) {
  try {
    const out = execFileSync(TMUX, tmuxClientArgs(socket, args), {
      encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMUX: '' },
    });
    return { code: 0, stdout: String(out || ''), stderr: '' };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || ''),
    };
  }
}

function cleanup(socket) {
  try {
    execFileSync(TMUX, tmuxClientArgs(socket, ['kill-server']), {
      stdio: 'ignore', timeout: 3000, env: { ...process.env, TMUX: '' },
    });
  } catch (_) { /* already gone */ }
  // tmux puo lasciare il socket dopo un arresto anomalo; il nome e confinato al
  // namespace ncrace-<pid>-* creato da questo file.
  try { fs.unlinkSync(socketPath(socket)); } catch (_) { /* absent */ }
}

function migrationWrapper(socket) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nctmuxwrap-'));
  const bin = path.join(dir, 'tmux');
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${TMUX} -f /dev/null -S ${JSON.stringify(socketPath(socket))} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function dottedDefs(id) {
  return parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'agy.native', managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id, cwd: '/tmp', engine: 'agy.native' }],
  });
}

function parsePaneDeadState(stdout) {
  // Rimuove solo il newline aggiunto da `display-message -p`: il tab finale e'
  // informazione significativa (pane morto, exit status ancora pending).
  const raw = String(stdout || '').replace(/\r?\n$/, '');
  const fields = raw.split('\t');
  const dead = fields[0];
  const status = fields[1];
  const signal = fields[2];
  const wellFormed = fields.length === 3
    && (dead === '0' || dead === '1')
    && (status === '' || /^\d+$/.test(status))
    && (signal === '' || /^\d+$/.test(signal));
  return { raw, dead, status, signal, wellFormed };
}

// Attende che il pane %N risulti morto con un exit status valorizzato.
//  - budget INIETTABILE, default generoso (8000 ms): sotto contesa di CPU la
//    finestra fra il kill del placeholder e la comparsa dell'exit status del
//    nuovo child si allunga, e un budget fisso troppo stretto flapppa.
//  - NON applica trim() alla riga intera: separa dead/status/signal
//    con split('\t') PRESERVANDO il campo vuoto, così lo stato transitorio
//    "morto, status non ancora disponibile" (tmux emette "1\t") e' riconosciuto e
//    tenuto distinto nel messaggio di timeout, non confuso con "pane non morto".
//  - successo solo con dead === '1' e status valorizzato (numero).
//  - al timeout diagnostica bounded distinto: pane non morto / morto con status
//    ancora pending / comando tmux fallito o risposta malformata.
async function waitForDeadPane(socket, paneId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  const poll = 25;
  let last = { code: -1, dead: null, status: undefined, raw: '', stderr: '' };
  do {
    const state = tmux(socket, ['display-message', '-p', '-t', paneId,
      '#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}']);
    const parsed = parsePaneDeadState(state.stdout);
    last = {
      code: state.code,
      ...parsed,
      stderr: state.stderr.trim(),
    };
    if (state.code === 0 && last.wellFormed && last.dead === '1'
        && (last.status !== '' || last.signal !== '')) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  } while (Date.now() < deadline);
  let reason;
  if (last.code !== 0) {
    reason = `comando tmux fallito (code ${last.code})`;
  } else if (!last.wellFormed) {
    reason = 'risposta tmux malformata';
  } else if (last.dead !== '1') {
    reason = `pane non morto (pane_dead=${JSON.stringify(last.dead)})`;
  } else {
    reason = 'pane morto ma exit status/segnale ancora non disponibili (pending)';
  }
  assert.fail(`pane ${paneId} non pronto entro ${timeoutMs}ms: ${reason} — raw=${JSON.stringify(last.raw)} stderr=${JSON.stringify(last.stderr)}`);
}

test('parser pane_dead preserva i campi pending e rifiuta risposte malformate', () => {
  assert.deepEqual(parsePaneDeadState('1\t\t\n'), {
    raw: '1\t\t', dead: '1', status: '', signal: '', wellFormed: true,
  });
  assert.deepEqual(parsePaneDeadState('1\t1\t\n'), {
    raw: '1\t1\t', dead: '1', status: '1', signal: '', wellFormed: true,
  });
  assert.deepEqual(parsePaneDeadState('1\t\t9\n'), {
    raw: '1\t\t9', dead: '1', status: '', signal: '9', wellFormed: true,
  });
  assert.equal(parsePaneDeadState('0\t\t\n').wellFormed, true, 'pane vivo con stato terminale vuoto e valido');
  assert.equal(parsePaneDeadState('1\n').wellFormed, false, 'tab/status assente e malformato');
  assert.equal(parsePaneDeadState('1\t1\t\textra\n').wellFormed, false, 'campi extra sono malformati');
});

test('controllo negativo: il nome con punto viene normalizzato da tmux (.->_)', () => {
  const socket = `${sockName()}-neg`;
  try {
    tmux(socket, ['new-session', '-d', '-s', 'cloud-agy.native']);
    const ls = tmux(socket, ['list-sessions', '-F', '#{session_name}']).stdout.trim();
    assert.equal(ls, 'cloud-agy_native', 'tmux ha normalizzato il punto in underscore');
    // targettare il nome col punto fallisce: tmux cerca cloud-agy.native (inesistente)
    const has = tmux(socket, ['has-session', '-t', '=cloud-agy.native']);
    assert.notEqual(has.code, 0, 'has-session sul nome col punto fallisce');
  } finally { cleanup(socket); }
});

test('anti-falso-verde: tornando al vecchio target nominale puntato il setup fallisce deterministicamente', () => {
  const socket = `${sockName()}-old`;
  try {
    // Usa un child longevo per isolare il mangling del nome da qualunque timing:
    // tmux crea cloud-agy_native, poi il target =cloud-agy.native: non puo matchare.
    const r = tmux(socket, [
      'new-session', '-d', '-s', 'cloud-agy.native', '-c', '/tmp', '/usr/bin/sleep', '30',
      ';', 'set-option', '-w', '-t', '=cloud-agy.native:', 'remain-on-exit', 'on',
    ]);
    assert.notEqual(r.code, 0, 'il vecchio target puntato deve fallire');
    assert.match(r.stderr, /no such window|can.?t find pane/i, 'firma del target normalizzato non risolto');
    const ls = tmux(socket, ['list-sessions', '-F', '#{session_name}']).stdout.trim();
    assert.equal(ls, 'cloud-agy_native', 'la sessione reale prova il mangling . -> _');
  } finally { cleanup(socket); }
});

test('nuovo ordine staged con nome v2 safe + child rapido: exit reale preservato', async () => {
  const socket = `${sockName()}-new`;
  const safe = tmuxSessionForCell('agy.native');
  try {
    // 1) new-session con placeholder inerte (cell-hold), -P -F 3 ID
    const create = tmux(socket, [
      'new-session', '-d', '-s', safe, '-c', '/tmp',
      '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}',
      process.execPath, CELL_HOLD,
    ]);
    assert.equal(create.code, 0, `new-session ok: ${create.stderr}`);
    const [sid, wid, pid] = create.stdout.trim().split('\t');
    assert.ok(sid.startsWith('$') && wid.startsWith('@') && pid.startsWith('%'), '3 ID restituiti');
    // 2) remain-on-exit window-local sul @N mentre il placeholder tiene viva la window
    const arm = tmux(socket, ['set-option', '-w', '-t', wid, 'remain-on-exit', 'on']);
    assert.equal(arm.code, 0, `set-option ok: ${arm.stderr}`);
    // 3) respawn-pane -k verso un child rapido non-zero (false) sul %N
    const respawn = tmux(socket, ['respawn-pane', '-k', '-c', '/tmp', '-t', pid, '/usr/bin/false']);
    assert.equal(respawn.code, 0, `respawn ok: ${respawn.stderr}`);
    // remain-on-exit e' ARMATO: il %N resta (dead) con il suo exit reale (1),
    // la sessione NON sparisce, nessun NEW_SESSION_FAILED.
    const dead = await waitForDeadPane(socket, pid);
    assert.equal(dead.dead, '1', 'pane morto (false exit)');
    assert.equal(dead.status, '1', 'exit reale 1 preservato (non mascherato)');
    // cleanup con $N
    const kill = tmux(socket, ['kill-session', '-t', sid]);
    assert.equal(kill.code, 0);
    assert.equal(tmux(socket, ['list-sessions', '-F', '#{session_name}']).stdout.trim(), '', 'nessuna sessione orfana');
  } finally { cleanup(socket); }
});

test('nuovo ordine: child longevo (sleep) resta vivo; pane ID preservato da respawn-pane', () => {
  const socket = `${sockName()}-live`;
  const safe = tmuxSessionForCell('agy.long');
  try {
    const create = tmux(socket, ['new-session', '-d', '-s', safe, '-c', '/tmp',
      '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}', process.execPath, CELL_HOLD]);
    const [, wid, pid] = create.stdout.trim().split('\t');
    tmux(socket, ['set-option', '-w', '-t', wid, 'remain-on-exit', 'on']);
    tmux(socket, ['respawn-pane', '-k', '-c', '/tmp', '-t', pid, '/usr/bin/sleep', '10']);
    const dead = tmux(socket, ['display-message', '-p', '-t', pid, '#{pane_dead}']).stdout.trim();
    assert.equal(dead, '0', 'child longevo vivo');
    assert.equal(tmux(socket, ['list-sessions', '-F', '#{session_name}']).stdout.trim(), safe);
  } finally { cleanup(socket); }
});

test('migrazione attiva: helper reale rinomina via $N e preserva il session ID', async () => {
  const socket = `${sockName()}-mig`;
  const safe = tmuxSessionForCell('agy.native');
  const legacy = 'cloud-agy_native'; // forma con cui tmux aveva creato la legacy
  const wrapper = migrationWrapper(socket);
  try {
    tmux(socket, ['new-session', '-d', '-s', legacy]);
    const beforeId = tmux(socket, ['display-message', '-p', '-t', `=${legacy}`, '#{session_id}']).stdout.trim();
    const result = await migrateLegacyTmuxSessions(wrapper.bin, dottedDefs('agy.native'));
    assert.deepEqual(result.migrated, [{ id: 'agy.native', from: legacy, to: safe }]);
    const afterId = tmux(socket, ['display-message', '-p', '-t', `=${safe}`, '#{session_id}']).stdout.trim();
    assert.equal(afterId, beforeId, 'session ID preservato (stessa sessione, stesso attach)');
    const ls = tmux(socket, ['list-sessions', '-F', '#{session_name}']).stdout.trim();
    assert.equal(ls, safe, 'sessione ora al nome v2 safe');
  } finally { cleanup(socket); wrapper.cleanup(); }
});

test('collisione reale: helper fallisce chiuso se legacy e v2 coesistono', async () => {
  const socket = `${sockName()}-coll`;
  const safe = tmuxSessionForCell('agy.native');
  const wrapper = migrationWrapper(socket);
  try {
    tmux(socket, ['new-session', '-d', '-s', safe]);             // target v2 gia' esistente
    tmux(socket, ['new-session', '-d', '-s', 'cloud-agy_native']); // legacy da migrare
    await assert.rejects(
      () => migrateLegacyTmuxSessions(wrapper.bin, dottedDefs('agy.native')),
      (error) => error.code === 'TMUX_MIGRATION_TARGET_EXISTS',
    );
    // esito osservabile: due sessioni distinte, nessun merge/overwrite
    const names = tmux(socket, ['list-sessions', '-F', '#{session_name}']).stdout.trim().split('\n').sort();
    assert.deepEqual(names, [safe, 'cloud-agy_native'].sort(), 'nessuna seconda sessione sovrascritta');
  } finally { cleanup(socket); wrapper.cleanup(); }
});

test('start e stop di una cella con id puntato non lasciano sessioni orfane', () => {
  const socket = `${sockName()}-ss`;
  const safe = tmuxSessionForCell('cell.dotted');
  try {
    // start (crea safe + child longevo)
    const create = tmux(socket, ['new-session', '-d', '-s', safe, '-c', '/tmp',
      '-P', '-F', '#{session_id}\t#{window_id}\t#{pane_id}', process.execPath, CELL_HOLD]);
    const [sid, wid, pid] = create.stdout.trim().split('\t');
    tmux(socket, ['set-option', '-w', '-t', wid, 'remain-on-exit', 'on']);
    tmux(socket, ['respawn-pane', '-k', '-c', '/tmp', '-t', pid, '/usr/bin/sleep', '30']);
    assert.equal(tmux(socket, ['list-sessions', '-F', '#{session_name}']).stdout.trim(), safe, 'avviata');
    // stop (kill-session -t $N)
    tmux(socket, ['kill-session', '-t', sid]);
    assert.equal(tmux(socket, ['list-sessions', '-F', '#{session_name}']).stdout.trim(), '', 'stop pulito, nessuna orfana');
  } finally { cleanup(socket); }
});
