'use strict';
// tests/nodes-identity.test.js — passo 1 del modello di autorita': la chiave del
// nodo e la directory delle pubbliche.
//
// COSA QUESTO FILE PROVA, E COSA NO. Il passo 1 non cambia nessun permesso, per
// disegno, quindi non c'e' un comportamento di autorizzazione da esercitare.
// Cio' che si puo' provare — e che e' tutto il valore del passo — e' che
// l'identita' regga: che la privata non finisca dove non deve, e che una chiave
// legata non cambi in silenzio. Se una di queste due cade, i grant dei passi
// 3-5 poggeranno su un nome che chiunque puo' prendersi.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const identity = require('../lib/nodes/identity.js');
const store = require('../lib/nodes/store.js');

function casa(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-identity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('la chiave si genera una volta sola e non cambia fra due avvii', (t) => {
  const home = casa(t);
  const primo = identity.ensureNodeKey({ home });
  assert.equal(primo.created, true);
  assert.ok(identity.isPublicKey(primo.publicKey), `pubblica malformata: ${primo.publicKey}`);

  const secondo = identity.ensureNodeKey({ home });
  assert.equal(secondo.created, false, 'la seconda chiamata non deve rigenerare');
  assert.equal(secondo.publicKey, primo.publicKey,
    'una chiave che cambia a ogni avvio non e\' un\'identita\'');
});

test('due creazioni in corsa convergono sulla chiave che sta sul disco', (t) => {
  // LA CORSA, ricostruita invece che simulata a parole: due processi che
  // partono insieme vedono entrambi il file assente e generano due chiavi
  // diverse; i due rename si sovrascrivono. Chi PERDE non deve restituire in
  // memoria una chiave che sul disco non c'e' piu': se la mandasse a un peer
  // dentro un pairing, quel peer legherebbe un'identita' che non potremo mai
  // dimostrare, e da li' in poi ogni nostra chiave gli risulterebbe un
  // conflitto. Per sempre.
  // LA PRIMA STESURA DI QUESTO TEST ERA VERDE E NON PROVAVA NULLA: creava la
  // chiave, poi ne sovrascriveva il file, poi richiamava ensureNodeKey — che a
  // quel punto trovava il file ESISTENTE e prendeva il ramo di lettura. Il
  // percorso di CREAZIONE, l'unico in cui la corsa esiste, non veniva mai
  // eseguito. L'ho scoperto perche' il controllo negativo non falliva.
  // Serve un seam: la corsa va fatta accadere DENTRO la creazione.
  const home = casa(t);
  const altroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-corsa-'));
  t.after(() => fs.rmSync(altroDir, { recursive: true, force: true }));
  const vincitore = identity.ensureNodeKey({ keyPath: path.join(altroDir, 'k.json') });

  // L'altro processo vince il rename fra la nostra scrittura e il nostro
  // ritorno: e' esattamente la finestra della corsa.
  const perdente = identity.ensureNodeKey({
    home,
    afterWriteSeam: (p) => fs.copyFileSync(vincitore.path, p),
  });

  assert.equal(perdente.publicKey, vincitore.publicKey,
    'chi perde la corsa deve restituire la chiave che sta sul disco, non la propria: '
    + 'una pubblica mandata a un peer e poi persa lo lega a un\'identita\' che non potremo dimostrare');

  // E la pubblica restituita deve corrispondere alla privata restituita:
  // altrimenti si firmerebbe con una e si farebbe verificare con l'altra.
  assert.equal(identity.publicKeyFromPrivate(perdente.privateKey), perdente.publicKey);

  // Il giro successivo vede il vincitore, come ogni avvio da qui in poi.
  assert.equal(identity.ensureNodeKey({ home }).publicKey, vincitore.publicKey);
});

test('la privata sta in un file suo, a 0600, e non dentro nodes.json', (t) => {
  const home = casa(t);
  const { path: p } = identity.ensureNodeKey({ home });

  assert.notEqual(path.basename(p), 'nodes.json',
    'nodes.json e\' letto da redazione, backup e viste condivise: la privata non ci va');
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);

  // E il contenuto e' davvero una privata: se il file fosse vuoto o pubblico il
  // test sopra sarebbe verde per la ragione sbagliata.
  assert.match(fs.readFileSync(p, 'utf8'), /PRIVATE KEY/);
});

test('un file di chiave leggibile da altri viene RIFIUTATO, non riparato', (t) => {
  const home = casa(t);
  const { path: p } = identity.ensureNodeKey({ home });
  fs.chmodSync(p, 0o644);

  assert.throws(() => identity.ensureNodeKey({ home }), /permessi 644/,
    'una privata gia\' leggibile da altri va rigenerata a mano, non usata');

  // Perche' non ripararla da soli: un chmod nostro cancellerebbe l'unica
  // traccia che qualcuno ha potuto leggerla. Il file resta come sta.
  assert.equal(fs.statSync(p).mode & 0o777, 0o644, 'non deve toccare i permessi');
});

test('un symlink al posto del file di chiave viene rifiutato', (t) => {
  const home = casa(t);
  const altrove = path.join(home, 'altrove.json');
  fs.writeFileSync(altrove, '{}', { mode: 0o600 });
  const p = identity.keyPathFor(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.symlinkSync(altrove, p);

  assert.throws(() => identity.ensureNodeKey({ home }), /symlink/);
});

test('la prima osservazione LEGA, e registra come e quando', () => {
  const chiave = identity.ensureNodeKey({ keyPath: path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-')), 'k.json') }).publicKey;

  const { node, outcome } = identity.observePeerKey(
    { name: 'pixel' }, { publicKey: chiave, source: 'pairing', now: Date.parse('2026-08-07T10:00:00Z') });

  assert.equal(outcome, 'bound');
  assert.equal(node.publicKey, chiave);
  assert.equal(node.keySource, 'pairing');
  assert.equal(node.keyBoundAt, '2026-08-07T10:00:00.000Z');
});

test('rivedere la STESSA chiave non cambia la provenienza del legame', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-'));
  const chiave = identity.ensureNodeKey({ keyPath: path.join(dir, 'k.json') }).publicKey;
  const legato = { name: 'pixel', publicKey: chiave, keySource: 'pairing', keyBoundAt: '2026-08-07T10:00:00.000Z' };

  const { node, outcome } = identity.observePeerKey(legato, { publicKey: chiave, source: 'peer-assertion' });

  assert.equal(outcome, 'unchanged');
  assert.equal(node.keySource, 'pairing',
    'la provenienza e\' del LEGAME, non dell\'ultima volta che abbiamo rivisto la chiave');
});

test('UNA CHIAVE DIVERSA NON SOSTITUISCE QUELLA LEGATA — e\' l\'invariante del passo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-'));
  const vera = identity.ensureNodeKey({ keyPath: path.join(dir, 'a.json') }).publicKey;
  const altra = identity.ensureNodeKey({ keyPath: path.join(dir, 'b.json') }).publicKey;
  assert.notEqual(vera, altra);

  const legato = { name: 'pixel', publicKey: vera, keySource: 'pairing' };
  const { node, outcome } = identity.observePeerKey(legato,
    { publicKey: altra, source: 'peer-assertion', now: Date.parse('2026-08-07T11:00:00Z') });

  assert.equal(outcome, 'conflict');
  assert.equal(node.publicKey, vera,
    'sovrascrivere renderebbe il peer chiunque sappia rispondere a un probe');
  assert.deepEqual(node.keyConflict,
    { seen: altra, at: '2026-08-07T11:00:00.000Z', source: 'peer-assertion' });
});

// La coppia di test qui sotto e' la ragione per cui esistono DUE funzioni
// invece di una con un flag. Se un domani venissero unificate, cade una delle
// due — ed e' il punto: un'asserzione costa zero a un attaccante, un pairing
// richiede un invito monouso consumato su entrambe le macchine.
test('il PAIRING puo\' rilegare: e\' un atto dell\'operatore, non un\'asserzione', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vecchia = identity.ensureNodeKey({ keyPath: path.join(dir, 'a.json') }).publicKey;
  const nuova = identity.ensureNodeKey({ keyPath: path.join(dir, 'b.json') }).publicKey;

  const legato = { name: 'pixel', publicKey: vecchia, keySource: 'pairing' };
  const { node, outcome } = identity.bindPeerKeyAtPairing(legato,
    { publicKey: nuova, now: Date.parse('2026-08-07T12:00:00Z') });

  assert.equal(outcome, 'rebound');
  assert.equal(node.publicKey, nuova, 'chi riaccoppia ha deciso di rifidarsi');
  assert.equal(node.keyBoundAt, '2026-08-07T12:00:00.000Z');

  // E la stessa chiamata su un peer nuovo dice 'bound', non 'rebound': i due
  // casi vanno distinti da chi legge un registro, non confusi.
  assert.equal(identity.bindPeerKeyAtPairing({ name: 'nuovo' }, { publicKey: nuova }).outcome, 'bound');
});

test('riaccoppiare RISOLVE un conflitto pendente, ed e\' l\'unico modo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vecchia = identity.ensureNodeKey({ keyPath: path.join(dir, 'a.json') }).publicKey;
  const contesa = identity.ensureNodeKey({ keyPath: path.join(dir, 'b.json') }).publicKey;

  // Un'asserzione ha sollevato il conflitto...
  const conConflitto = identity.observePeerKey(
    { name: 'pixel', publicKey: vecchia, keySource: 'pairing' },
    { publicKey: contesa }).node;
  assert.ok(conConflitto.keyConflict, 'precondizione: il conflitto c\'e\'');

  // ...e solo il riaccoppiamento lo spegne. Un allarme che nessuna azione puo'
  // spegnere smette di essere letto.
  const { node } = identity.bindPeerKeyAtPairing(conConflitto, { publicKey: contesa });
  assert.equal(node.publicKey, contesa);
  assert.equal(node.keyConflict, undefined, 'il conflitto va risolto, non accumulato');
});

test('al pairing una chiave assente o rotta non rompe il pairing ne\' tocca il nodo', () => {
  const legato = { name: 'pixel', publicKey: 'A'.repeat(43), keySource: 'pairing' };
  for (const cattiva of [undefined, null, '', 'corta', 42]) {
    const { node, outcome } = identity.bindPeerKeyAtPairing(legato, { publicKey: cattiva });
    assert.equal(outcome, 'invalid', `deve ignorare ${JSON.stringify(cattiva)}`);
    assert.equal(node, legato,
      'un peer di una versione precedente deve poter accoppiarsi come sempre');
  }
});

test('una chiave malformata non lega niente e non sporca il nodo', () => {
  const legato = { name: 'pixel' };
  for (const cattiva of ['', 'troppo-corta', 'A'.repeat(44), 'con spazio', null, 42, undefined]) {
    const { node, outcome } = identity.observePeerKey(legato, { publicKey: cattiva });
    assert.equal(outcome, 'invalid', `deve rifiutare ${JSON.stringify(cattiva)}`);
    assert.equal(node, legato, 'il nodo non va toccato');
  }
});

test('lo schema del nodo e\' chiuso anche sui campi di identita\'', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chiave = identity.ensureNodeKey({ keyPath: path.join(dir, 'k.json') }).publicKey;
  const base = { name: 'pixel', ssh: 'utente@esempio', remotePort: 41777, localPort: 44001 };

  assert.ok(store.parseNode({ ...base, publicKey: chiave, keySource: 'pairing' }));

  const cattivi = [
    { publicKey: 'non-una-chiave' },
    // provenienza o data senza la chiave: un record incoerente che piu' tardi
    // qualcuno leggerebbe come «legata al pairing» senza che nulla sia legato.
    { keySource: 'pairing' },
    { keyBoundAt: '2026-08-07T10:00:00.000Z' },
    // una terza provenienza inventata passerebbe i confronti senza significare
    // niente al passo 3.
    { publicKey: chiave, keySource: 'fidati' },
    { publicKey: chiave, keyBoundAt: 'domani' },
    { publicKey: chiave, keyConflict: { seen: 'corta', at: '2026-08-07T10:00:00.000Z', source: 'pairing' } },
    { publicKey: chiave, keyConflict: { seen: chiave, at: '2026-08-07T10:00:00.000Z', source: 'boh' } },
    { publicKey: chiave, keyConflict: { seen: chiave, at: '2026-08-07T10:00:00.000Z', source: 'pairing', extra: 1 } },
    { keyConflict: { seen: chiave, at: '2026-08-07T10:00:00.000Z', source: 'pairing' } },
  ];
  for (const patch of cattivi) {
    assert.equal(store.parseNode({ ...base, ...patch }), null,
      `deve rifiutare ${JSON.stringify(patch)}`);
  }
});

test('i campi di identita\' sopravvivono al giro completo su disco', (t) => {
  const home = casa(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chiave = identity.ensureNodeKey({ keyPath: path.join(dir, 'k.json') }).publicKey;
  const nodesPath = path.join(home, '.nexuscrew', 'nodes.json');

  const iniziale = store.initStore(nodesPath);
  const conNodo = {
    ...iniziale,
    nodes: [{
      name: 'pixel', ssh: 'utente@esempio', remotePort: 41777, localPort: 44001,
      publicKey: chiave, keySource: 'pairing', keyBoundAt: '2026-08-07T10:00:00.000Z',
    }],
  };
  store.atomicWriteStore(nodesPath, conNodo);

  const riletto = store.loadStore(nodesPath);
  assert.equal(riletto.nodes[0].publicKey, chiave, 'una chiave che non sopravvive al riavvio non lega niente');
  assert.equal(riletto.nodes[0].keySource, 'pairing');

  // E il file dei nodi non contiene la privata, ne' per errore ne' per comodita'.
  assert.doesNotMatch(fs.readFileSync(nodesPath, 'utf8'), /PRIVATE KEY/);
});

test('la directory mostra le pubbliche e i conflitti, e nessun segreto', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = identity.ensureNodeKey({ keyPath: path.join(dir, 'a.json') }).publicKey;
  const b = identity.ensureNodeKey({ keyPath: path.join(dir, 'b.json') }).publicKey;

  const elenco = identity.publicKeyDirectory({ nodes: [
    { name: 'pixel', nodeId: 'a'.repeat(32), publicKey: a, keySource: 'pairing', keyBoundAt: '2026-08-07T10:00:00.000Z',
      token: 'segreto-non-deve-uscire', acceptToken: 'nemmeno-questo' },
    { name: 'asus', nodeId: 'b'.repeat(32), publicKey: b, keySource: 'peer-assertion',
      keyConflict: { seen: a, at: '2026-08-07T11:00:00.000Z', source: 'peer-assertion' } },
    { name: 'muto', nodeId: 'c'.repeat(32) },
  ] });

  assert.equal(elenco[0].publicKey, a);
  assert.equal(elenco[0].source, 'pairing');
  assert.equal(elenco[1].conflict.seen, a, 'un conflitto invisibile e\' un conflitto che nessuno risolve');
  assert.equal(elenco[2].publicKey, null, 'un peer senza chiave si dichiara tale, non si omette');

  const serializzato = JSON.stringify(elenco);
  assert.ok(!serializzato.includes('segreto-non-deve-uscire'), 'nessun token nella directory');
  assert.ok(!serializzato.includes('nemmeno-questo'));
});

test('la vista redatta porta la chiave del peer e il conflitto, mai i token', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-peer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = identity.ensureNodeKey({ keyPath: path.join(dir, 'a.json') }).publicKey;
  const b = identity.ensureNodeKey({ keyPath: path.join(dir, 'b.json') }).publicKey;

  const redatto = store.redactNode(store.parseNode({
    name: 'pixel', ssh: 'utente@esempio', remotePort: 41777, localPort: 44001,
    token: 'x'.repeat(64), publicKey: a, keySource: 'pairing',
    keyConflict: { seen: b, at: '2026-08-07T11:00:00.000Z', source: 'peer-assertion' },
  }));

  assert.equal(redatto.publicKey, a);
  assert.equal(redatto.keyConflict.seen, b);
  assert.equal(redatto.hasToken, true);
  assert.equal(redatto.token, undefined, 'la redazione resta quella di prima sui segreti');
});
