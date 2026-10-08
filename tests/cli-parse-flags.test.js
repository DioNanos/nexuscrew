'use strict';
// Il parser delle opzioni CLI accettava la forma «--opt valore» solo
// per le opzioni elencate in CLI_VALUE_FLAGS: `nexuscrew nodes edit <nodo>
// --access-role user` rispondeva «access-role non valido» perché il flag
// diventava `true` e `user` finiva nei posizionali, mentre `--access-role=user`
// funzionava. Questi test sono nati ROSSI su quel comportamento e fissano il
// contratto del parser: ogni opzione con valore accetta ENTRAMBE le forme, i
// flag booleani non consumano il posizionale che segue, e un valore mancante
// produce un errore chiaro invece del silenzioso `true`.
//
// La tabella ESEMPI copre esattamente le chiavi di CLI_VALUE_FLAGS: chi domani
// aggiunge un'opzione con valore al set senza aggiungerne l'esempio vede
// rosso qui sotto, non sul campo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');
const cmds = require('../lib/nodes/commands.js');
const { dispatch, parseFlags, CLI_VALUE_FLAGS } = require('../lib/cli/commands.js');

// Un valore di esempio per OGNI opzione con valore della CLI, tale che
// `--opt esempio` e `--opt=esempio` debbano produrre lo stesso risultato.
const ESEMPI = Object.freeze({
  label: 'Nuova etichetta',
  ssh: 'utente@esempio.it',
  'ssh-port': '2222',
  autostart: 'off',
  visibility: 'relay-only',
  selected: 'Dev,Research',
  name: 'node-example',
  'local-name': 'node-local',
  'local-label': 'Etichetta locale',
  'identity-file': '/chiavi/ed25519',
  port: '41822',
  dir: '/tmp/nc-dir',
  'events-receive': 'on',
  'access-role': 'user',
  'access-revision': '7',
  'events-access': 'off',
  'node-events-access': 'on',
  'ask-reply-access': 'off',
  'files-read-access': 'on',
  'peer-operator-access': 'off',
});

function nodeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cli-flags-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
  store.initStore(path.join(home, '.nexuscrew', 'nodes.json'));
  return home;
}
const nodesPathFor = (home) => path.join(home, '.nexuscrew', 'nodes.json');
const FAKE_PUB = 'ssh-ed25519 AAAAFAKEKEY nexuscrew-tunnel';
const keygenSeam = () => FAKE_PUB;

// --- parser: le due forme per ogni opzione con valore ----------------------

test('parseFlags: la tabella esempi copre esattamente CLI_VALUE_FLAGS', () => {
  assert.ok(CLI_VALUE_FLAGS, 'CLI_VALUE_FLAGS deve essere esportato da lib/cli/commands.js');
  const nelSet = [...CLI_VALUE_FLAGS].sort();
  const nellaTabella = Object.keys(ESEMPI).sort();
  assert.deepEqual(nellaTabella, nelSet,
    'ogni opzione con valore del set deve avere un esempio qui (e viceversa)');
});

test('parseFlags: ogni opzione con valore accetta la forma "--opt valore"', () => {
  for (const [opt, valore] of Object.entries(ESEMPI)) {
    const { flags, rest, error } = parseFlags([`--${opt}`, valore], CLI_VALUE_FLAGS);
    assert.equal(error, null, `--${opt}: nessun errore atteso`);
    assert.equal(flags[opt], valore, `--${opt} ${valore}: il valore deve essere consumato`);
    assert.deepEqual(rest, [], `--${opt}: il valore non deve finire nei posizionali`);
  }
});

test('parseFlags: ogni opzione con valore accetta la forma "--opt=valore"', () => {
  for (const [opt, valore] of Object.entries(ESEMPI)) {
    const { flags, rest, error } = parseFlags([`--${opt}=${valore}`], CLI_VALUE_FLAGS);
    assert.equal(error, null, `--${opt}=…: nessun errore atteso`);
    assert.equal(flags[opt], valore, `--${opt}=${valore}: valore inline`);
    assert.deepEqual(rest, [], `--${opt}=…: nessun posizionale atteso`);
  }
});

// --- parser: booleani e posizionali ----------------------------------------

test('parseFlags: un flag booleano non consuma il posizionale che segue', () => {
  const { flags, rest, error } = parseFlags(['--json', 'filtro'], CLI_VALUE_FLAGS);
  assert.equal(error, null);
  assert.equal(flags.json, true, '--json resta un booleano');
  assert.deepEqual(rest, ['filtro'], 'il posizionale non deve essere mangiato');
});

test('parseFlags: booleano, posizionale e opzione con valore insieme', () => {
  const { flags, rest, error } = parseFlags(['--yes', 'vps', '--label', 'Etichetta'], CLI_VALUE_FLAGS);
  assert.equal(error, null);
  assert.equal(flags.yes, true);
  assert.deepEqual(rest, ['vps'], 'il posizionale resta al suo posto');
  assert.equal(flags.label, 'Etichetta');
});

// --- parser: valore mancante → errore chiaro --------------------------------

test('parseFlags: opzione con valore in coda ad argv → errore chiaro', () => {
  const { flags, error } = parseFlags(['nodes', 'edit', 'vps', '--label'], CLI_VALUE_FLAGS);
  assert.ok(error, 'serve un errore, non un flag `true` silenzioso');
  assert.ok(error.includes('--label'), `l'errore nomina l'opzione: ${error}`);
  assert.ok(/richiede un valore/.test(error), `l'errore dice cosa manca: ${error}`);
  assert.equal(flags.label, undefined, 'il flag non viene impostato a true');
});

test('parseFlags: valore mancante prima di un\'altra opzione → errore chiaro', () => {
  const { error } = parseFlags(['--access-role', '--json'], CLI_VALUE_FLAGS);
  assert.ok(error, '--access-role seguito da --json è un valore mancante');
  assert.ok(error.includes('--access-role'), `l'errore nomina l'opzione: ${error}`);
  assert.ok(/richiede un valore/.test(error), `l'errore dice cosa manca: ${error}`);
});

// --- dispatch: il sintomo originale, end-to-end -----------------------------

test('dispatch nodes edit: --access-role user (spazio) applica il preset user', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@example.com', keygen: keygenSeam });
  const righe = [];
  const r = await dispatch(['nodes', 'edit', 'vps', '--access-role', 'user'], { home, log: (m) => righe.push(m) });
  assert.equal(r.code, 0, `deve riuscire, non dire «access-role non valido»: ${righe.join(' | ')}`);
  const nodo = store.loadStore(nodesPathFor(home)).nodes[0];
  assert.equal(nodo.accessConfigured, true);
  assert.equal(nodo.askReplyAccess, false, 'marcatore del preset user');
  assert.equal(nodo.filesReadAccess, true, 'marcatore del preset user');
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch nodes edit: --access-role=user (=) applica lo stesso preset', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@example.com', keygen: keygenSeam });
  const r = await dispatch(['nodes', 'edit', 'vps', '--access-role=user'], { home, log: () => {} });
  assert.equal(r.code, 0);
  const nodo = store.loadStore(nodesPathFor(home)).nodes[0];
  assert.equal(nodo.accessConfigured, true);
  assert.equal(nodo.askReplyAccess, false);
  assert.equal(nodo.filesReadAccess, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch nodes edit: --events-access off (spazio) revoca davvero', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@example.com', keygen: keygenSeam });
  await dispatch(['nodes', 'edit', 'vps', '--access-role=user'], { home, log: () => {} });
  // Con il bug la forma con spazio valeva `true`: la revoca concessa per
  // sbaglio è peggiore dell'errore esplicito.
  const righe = [];
  const r = await dispatch(['nodes', 'edit', 'vps', '--events-access', 'off'], { home, log: (m) => righe.push(m) });
  assert.equal(r.code, 0, righe.join(' | '));
  const nodo = store.loadStore(nodesPathFor(home)).nodes[0];
  assert.equal(nodo.eventsAccess, false, '«off» con la forma col spazio deve revocare');
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch nodes edit: --events-access=off (=) revoca allo stesso modo', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@example.com', keygen: keygenSeam });
  await dispatch(['nodes', 'edit', 'vps', '--access-role=user'], { home, log: () => {} });
  const r = await dispatch(['nodes', 'edit', 'vps', '--events-access=off'], { home, log: () => {} });
  assert.equal(r.code, 0);
  assert.equal(store.loadStore(nodesPathFor(home)).nodes[0].eventsAccess, false);
  fs.rmSync(home, { recursive: true, force: true });
});

// --- dispatch: booleano seguito da posizionale, e valore mancante -----------

test('dispatch nodes remove: --yes prima del nome non mangia il nome', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@example.com', keygen: keygenSeam });
  const r = await dispatch(['nodes', 'remove', '--yes', 'vps'], { home, log: () => {} });
  assert.equal(r.code, 0, 'il nome dopo il booleano deve restare un posizionale');
  assert.equal(store.loadStore(nodesPathFor(home)).nodes.length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('dispatch nodes edit: --label senza valore → code 1 e messaggio chiaro', async () => {
  const home = nodeHome();
  cmds.nodesAdd({ home, log: () => {}, name: 'vps', ssh: 'user@example.com', keygen: keygenSeam });
  const righe = [];
  const r = await dispatch(['nodes', 'edit', 'vps', '--label'], { home, log: (m) => righe.push(m) });
  assert.equal(r.code, 1);
  const out = righe.join('\n');
  assert.ok(out.includes('--label'), `l'errore nomina l'opzione: ${out}`);
  assert.ok(/richiede un valore/.test(out), `l'errore dice come correggere: ${out}`);
  fs.rmSync(home, { recursive: true, force: true });
});
