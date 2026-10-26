'use strict';
// tests/fleet-cleanup-no-name.test.js — il cleanup di un lancio FALLITO non
// usa MAI il nome della sessione per cercare qualcosa da fermare.
//
// PERCHE' QUESTO TEST ESISTE. Il nome di una sessione tmux e' un indirizzo
// RIUTILIZZABILE: quando il lancio A esce (o non nasce affatto), chiunque puo'
// creare una sessione B con lo stesso nome. Un cleanup che, non avendo id
// propri, enumera le sessioni e ferma quella che «porta il nome della cella»
// sta fermando B — una sessione che questo NC non ha lanciato e di cui non
// possiede nulla. Essere nel percorso di errore non autorizza a toccarla: un
// lancio fallito lascia al massimo una traccia non pulita, dichiarata, MAI
// un kill su un indirizzo che nel frattempo e' diventato di qualcun altro.
//
// Qui il lancio e' fallito PRIMA di restituire qualunque id ($N/@N/%N tutti
// assenti): l'unica cosa che il vecchio percorso sapeva fare era cercare il
// NOME. La barriera: B nasce con quel nome nel frattempo (il fake la rende
// deterministica scrivendola nello stato DENTRO la new-session anomala) e
// deve restare VIVA, senza nemmeno un tentativo di kill-session.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');

const SESSIONE = 'cloud-CellaNome';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cleanup-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'CellaNome'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const client = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.chmodSync(client, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  const filesRoot = path.join(home, 'NexusFiles'); fs.mkdirSync(filesRoot);

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const killLog = path.join(root, 'kill.log');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const STATO = ${JSON.stringify(statoPath)};
const KILLLOG = ${JSON.stringify(killLog)};
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
const fmt = args[args.indexOf('-F') + 1] || '';
if (cmd === 'list-sessions') {
  if (fmt.includes('session_id')) { for (const n of vive()) process.stdout.write('$7\\t' + n + '\\n'); }
  else { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); }
  process.exit(0);
}
if (cmd === 'has-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  process.exit(vive().includes(bersaglio) ? 0 : 1);
}
if (cmd === 'new-session') {
  // L'anomalia: tmux risponde senza NESSUN id (output -P vuoto). Il lancio
  // non potra' mai dimostrare cosa ha creato. Nel frattempo una sessione B
  // di un ALTRO client occupa il nome della cella: nel mondo vero e' una
  // concorrenza, qui la si rende deterministica facendola nascere adesso.
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  process.exit(0);
}
if (cmd === 'display-message') { process.stderr.write('no such pane\\n'); process.exit(1); }
if (cmd === 'kill-session') {
  fs.appendFileSync(KILLLOG, args.join(' ') + '\\n');
  process.exit(0);
}
if (cmd === 'set-option' || cmd === 'respawn-pane' || cmd === 'capture-pane') process.exit(0);
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 }); fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'ec', label: 'Claude', managed: {
        client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe',
      },
    }],
    cells: [{ id: 'CellaNome', tmuxSession: SESSIONE, cwd, engine: 'ec', boot: false }],
  });

  const runtime = createBuiltinRuntime({
    cfg: { launchReadyMs: 0, filesRoot, activityHooks: true },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: {
      issue: async () => ({ socketPath: path.join(root, 'broker.sock'), nonce: 'n'.repeat(64) }),
      revoke: async () => {},
      close: async () => {},
    },
    boot: require('../lib/fleet/definitions.js').loadDefinitions(defsPath),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { runtime, statoPath, killLog };
}

test('cleanup di un lancio fallito senza id propri: NESSUN kill per nome, B resta viva', async (t) => {
  const w = mondo(t);

  await assert.rejects(() => w.runtime.up('CellaNome'), (e) => {
    assert.equal(e.status, 500);
    assert.equal(e.fleetCode, 'NEW_SESSION_FAILED');
    return true;
  });

  // La barriera: nessun tentativo di fermare chicchessia. Non «nessun kill
  // riuscito»: NESSUNA chiamata kill-session, nemmeno destinata a un id,
  // perche' il vecchio percorso risaliva dal nome a un id altrui.
  assert.equal(fs.existsSync(w.killLog), false,
    'nessun kill-session: il cleanup senza id non cerca il bersaglio per nome');

  // E la sessione omonima — di un altro — e' ancora li', viva.
  const vive = fs.readFileSync(w.statoPath, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(vive, [SESSIONE], 'la sessione omonima B resta VIVA');
});
