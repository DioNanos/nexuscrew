'use strict';
// tests/fleet-boot-finestra.test.js — rilievo 3 dell'audit pre-release 093:
// il draft della migrazione può essere più VECCHIO del confronto che lo
// autorizza. `boot` nasce da una lettura (1); `migrateLegacyTmuxSessions`
// gira in mezzo (una catena di chiamate tmux: finestra LARGA); il vecchio
// `primaDelloScrivere` era una RILETTURA (2) successiva. Una scrittura
// arrivata fra (1) e (2) era già DENTRO la rilettura: il confronto
// dentro===primaDelloScrivere passava, e `boot` — costruito sullo stato
// pre-migrazione — sovrascriveva il lavoro altrui. Il lock proteggeva la
// finestra sbagliata: la coda, non la finestra intera.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

function engines() {
  return [
    { id: 'shell.local', label: 'Shell', rc: false, managed: { client: 'shell', provider: 'local', model: '', permissionPolicy: 'standard' } },
    { id: 'agy.native', label: 'Agy', rc: false, managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' } },
  ];
}

// NEGATIVO: lo straniero scrive DENTRO la finestra della migrazione — il
// momento esatto in cui (1) è già stato letto e (2) deve ancora avvenire. Il
// veicolo è il fake tmux: la scrittura avviene durante `list-sessions`, la
// chiamata che apre migrateLegacyTmuxSessions, prima che risponda «nessun
// server» (needsPersistence, senza dover simulare rename riusciti).
test('NEGATIVO finestra migrazione: la scrittura altrui DURANTE migrateLegacyTmuxSessions non va persa', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-boot-finestra-'));
  const file = path.join(root, 'fleet.json');
  try {
    // (1) Lo stato che il bootstrap leggerà: una cella col nome legacy (punto).
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      engines: engines(),
      cells: [{ id: 'agy.native', cwd: root, engine: 'agy.native', boot: false, tmuxSession: 'cloud-agy.native' }],
    }, null, 2)}\n`, { mode: 0o600 });

    // Lo stato DELLO STRANIERO: la stessa base, più il lavoro suo (una cella).
    const stranger = {
      schemaVersion: 1,
      engines: engines(),
      cells: [
        { id: 'agy.native', cwd: root, engine: 'agy.native', boot: false, tmuxSession: 'cloud-agy.native' },
        { id: 'DellaStraniera', cwd: root, engine: 'shell.local', boot: false, tmuxSession: 'cloud-DellaStraniera' },
      ],
    };

    // Fake tmux: durante list-sessions (DENTRO la finestra) lo straniero
    // scrive fleet.json; poi il server risulta assente — la migrazione
    // risponde needsPersistence senza bisogno di rename simulati.
    const bin = path.join(root, 'fake-tmux.js');
    fs.writeFileSync(bin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'list-sessions') {
  fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(`${JSON.stringify(stranger, null, 2)}\n`)});
  process.stderr.write('error connecting to /tmp/tmux-1000/default (No such file or directory)\\n');
  process.exit(1);
}
process.exit(0);
`, { mode: 0o755 });
    fs.chmodSync(bin, 0o755);

    const fleet = await createBuiltinFleet({
      home: root, fleetDefsPath: file, tmuxBin: bin,
      ensureTmuxProtection: async () => {}, platform: 'linux', env: {},
    });
    try {
      const suDisco = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ids = suDisco.cells.map((c) => c.id).sort();
      // Contro il codice attuale: dentro===primaDelloScrivere (entrambi letti
      // DOPO lo straniero) → il confronto passa → boot(1) viene scritto → la
      // cella dello straniero SPARISCE (visto rosso: «su disco: agy.native»).
      // Il contratto: chi scrive nella finestra non perde il proprio lavoro.
      assert.ok(ids.includes('DellaStraniera'),
        `la cella scritta durante la migrazione sopravvive (su disco: ${ids.join(', ')})`);
      // Il lavoro arriva INTEGRO, non solo l'id: engine e sessione come li ha
      // scritti lo straniero. (La normalizzazione del nome legacy PUÒ essere
      // persistita dopo da un backfill legittimo — che decide dentro il lock
      // su `dentro` e lo preserva — quindi la forma del nome di agy.native su
      // disco NON è un indicatore della rinuncia: non la si asserisce.)
      const straniera = suDisco.cells.find((c) => c.id === 'DellaStraniera');
      assert.equal(straniera.engine, 'shell.local', 'il contenuto della cella straniera è integro');
      assert.equal(straniera.tmuxSession, 'cloud-DellaStraniera', 'la sessione della straniera è la sua');
    } finally {
      await fleet.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
