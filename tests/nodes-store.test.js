'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nodes-'));
const NODE_ID = 'a'.repeat(32); // hex valido

function validStore() {
  return {
    schemaVersion: 1,
    nodeId: NODE_ID,
    nodes: [{
      name: 'vps', ssh: 'user@example.com',
      remotePort: 41820, localPort: 43001,
      keyPath: '/home/user/.nexuscrew/keys/host_ed25519',
      roles: { client: true, node: false },
      token: 'REMOTE-SECRET-123',
    }],
  };
}

// --- schema strict ----------------------------------------------------------

test('parseStore: schema valido accettato (oggetto e stringa), normalizzato', () => {
  const s = store.parseStore(validStore());
  assert.ok(s);
  assert.equal(s.nodeId, NODE_ID);
  assert.equal(s.nodes[0].name, 'vps');
  assert.equal(s.nodes[0].token, 'REMOTE-SECRET-123');
  assert.ok(store.parseStore(JSON.stringify(validStore())));
  // node minimale: roles default {client:true, node:false}, token assente
  const min = store.parseStore({
    schemaVersion: 1, nodeId: NODE_ID,
    nodes: [{ name: 'n1', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k' }],
  });
  assert.ok(min);
  assert.deepEqual(min.nodes[0].roles, { client: true, node: false });
  assert.equal(min.nodes[0].token, undefined);
});

test('parseStore: schemaVersion/nodeId invalidi -> null', () => {
  const b = validStore();
  assert.equal(store.parseStore({ ...b, schemaVersion: 2 }), null);
  assert.equal(store.parseStore({ ...b, schemaVersion: '1' }), null);
  assert.equal(store.parseStore({ ...b, nodeId: undefined }), null);
  assert.equal(store.parseStore({ ...b, nodeId: 'NOT-HEX!!' }), null);
  assert.equal(store.parseStore({ ...b, nodes: 'x' }), null);
  assert.equal(store.parseStore('not json {'), null);
  assert.equal(store.parseStore(null), null);
  assert.equal(store.parseStore([]), null);
});

test('parseStore: nome nodo invalido -> null (mai guess)', () => {
  const bad = (name) => store.parseStore({ schemaVersion: 1, nodeId: NODE_ID, nodes: [{ name, ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k' }] });
  assert.equal(bad('UPPER'), null);       // maiuscole
  assert.equal(bad('has space'), null);
  assert.equal(bad('dot.name'), null);    // '.' vietato (name = segmento path in B1)
  assert.equal(bad('a'.repeat(33)), null); // >32
  assert.equal(bad(''), null);
  assert.equal(bad('trav/../ersal'), null);
  assert.ok(bad('ok-node-1'));            // valido
});

test('parseStore: ssh user@host strict', () => {
  const mk = (ssh) => store.parseStore({ schemaVersion: 1, nodeId: NODE_ID, nodes: [{ name: 'n', ssh, remotePort: 22, localPort: 43001, keyPath: '/k' }] });
  assert.ok(mk('user@example.com'));
  assert.ok(mk('user@10.0.0.1'));
  assert.equal(mk('nohost'), null);
  assert.equal(mk('@host'), null);
  assert.equal(mk('user@'), null);
  assert.equal(mk('user@-flag'), null);       // host inizia con '-' -> argv-unsafe
  assert.equal(mk('user@ho st'), null);       // spazio
  assert.equal(mk('a@b@c'), null);            // due '@'
});

test('parseStore: porte e keyPath strict', () => {
  const mk = (over) => store.parseStore({ schemaVersion: 1, nodeId: NODE_ID, nodes: [{ name: 'n', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k', ...over }] });
  assert.equal(mk({ remotePort: 0 }), null);
  assert.equal(mk({ remotePort: 70000 }), null);
  assert.equal(mk({ remotePort: 22.5 }), null);
  assert.equal(mk({ localPort: '43001' }), null); // stringa -> null
  assert.equal(mk({ keyPath: 'relative/key' }), null); // non assoluto
  assert.equal(mk({ keyPath: '/k\nx' }), null);        // newline
});

test('parseStore: campo extra o roles garbage -> null (schema chiuso)', () => {
  assert.equal(store.parseStore({ schemaVersion: 1, nodeId: NODE_ID, nodes: [{ name: 'n', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k', bogus: 1 }] }), null);
  assert.equal(store.parseStore({ schemaVersion: 1, nodeId: NODE_ID, nodes: [{ name: 'n', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k', roles: { client: 'yes' } }] }), null);
  assert.equal(store.parseStore({ schemaVersion: 1, nodeId: NODE_ID, nodes: [{ name: 'n', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k', roles: { extra: true } }] }), null);
});

test('parseStore: name duplicato / self-reference / nodeId remoto duplicato -> null', () => {
  const dupName = { schemaVersion: 1, nodeId: NODE_ID, nodes: [
    { name: 'n', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k' },
    { name: 'n', ssh: 'u@h2', remotePort: 22, localPort: 43002, keyPath: '/k2' },
  ] };
  assert.equal(store.parseStore(dupName), null);
  const selfRef = { schemaVersion: 1, nodeId: NODE_ID, nodes: [
    { name: 'n', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k', nodeId: NODE_ID },
  ] };
  assert.equal(store.parseStore(selfRef), null);
  const dupId = { schemaVersion: 1, nodeId: NODE_ID, nodes: [
    { name: 'a', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k', nodeId: 'b'.repeat(32) },
    { name: 'b', ssh: 'u@h2', remotePort: 22, localPort: 43002, keyPath: '/k2', nodeId: 'b'.repeat(32) },
  ] };
  assert.equal(store.parseStore(dupId), null);
});

test('parseStore: rendezvous opzionale, strict', () => {
  const ok = store.parseStore({ ...validStore(), rendezvous: { ssh: 'user@host', publishedPort: 41821, localPort: 41820, keyPath: '/k' } });
  assert.ok(ok.rendezvous);
  assert.equal(ok.rendezvous.publishedPort, 41821);
  const bad = store.parseStore({ ...validStore(), rendezvous: { ssh: 'nohost', publishedPort: 41821, localPort: 41820, keyPath: '/k' } });
  assert.equal(bad, null);
});

// --- I/O: permessi 0600, atomicita, no symlink ------------------------------

test('atomicWriteStore + loadStore: 0600, round-trip, rifiuta symlink target', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'nodes.json');
  const written = store.atomicWriteStore(p, validStore());
  assert.equal(written.nodes[0].name, 'vps');
  assert.equal(fs.lstatSync(p).mode & 0o777, 0o600);
  const loaded = store.loadStore(p);
  assert.deepEqual(loaded, written);
  // nessun file tmp residuo
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  // symlink target -> refuse
  const linkDir = tmpDir();
  const real = path.join(linkDir, 'real.json');
  const link = path.join(linkDir, 'link.json');
  fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, link);
  assert.throws(() => store.atomicWriteStore(link, validStore()), /symlink/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(linkDir, { recursive: true, force: true });
});

test('atomicWriteStore: dati invalidi -> throw, nessuna scrittura', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'nodes.json');
  assert.throws(() => store.atomicWriteStore(p, { schemaVersion: 1, nodeId: 'BAD', nodes: [] }), /valid/);
  assert.ok(!fs.existsSync(p));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadStore: symlink -> null; file invalido -> null', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'nodes.json');
  fs.writeFileSync(p, 'garbage{');
  assert.equal(store.loadStore(p), null);
  const link = path.join(dir, 'link.json');
  fs.symlinkSync(p, link);
  assert.equal(store.loadStore(link), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadOrInitStore: crea vuoto con nodeId stabile; invalido -> throw', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'nodes.json');
  const s1 = store.loadOrInitStore(p);
  assert.match(s1.nodeId, /^[a-f0-9]{32}$/);
  assert.deepEqual(s1.nodes, []);
  assert.equal(fs.lstatSync(p).mode & 0o777, 0o600);
  // stabile: seconda load stesso nodeId
  const s2 = store.loadOrInitStore(p);
  assert.equal(s2.nodeId, s1.nodeId);
  // file presente ma corrotto -> throw (no overwrite silenzioso)
  fs.writeFileSync(p, 'nope{');
  assert.throws(() => store.loadOrInitStore(p), /invalido/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- mutazioni --------------------------------------------------------------

test('addNode: rifiuta duplicati e self-reference', () => {
  const s0 = store.emptyStore(NODE_ID);
  const s1 = store.addNode(s0, { name: 'a', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k' });
  assert.equal(s1.nodes.length, 1);
  assert.throws(() => store.addNode(s1, { name: 'a', ssh: 'u@h2', remotePort: 22, localPort: 43002, keyPath: '/k2' }), /duplicato/);
  assert.throws(() => store.addNode(s1, { name: 'b', ssh: 'u@h', remotePort: 22, localPort: 43002, keyPath: '/k', nodeId: NODE_ID }), /self-reference/);
  assert.throws(() => store.addNode(s1, { name: 'BAD NAME', ssh: 'u@h', remotePort: 22, localPort: 43002, keyPath: '/k' }), /non valido/);
});

test('removeNode / setNodeToken', () => {
  let s = store.addNode(store.emptyStore(NODE_ID), { name: 'a', ssh: 'u@h', remotePort: 22, localPort: 43001, keyPath: '/k' });
  s = store.setNodeToken(s, 'a', 'TOK-1');
  assert.equal(store.getNode(s, 'a').token, 'TOK-1');
  assert.throws(() => store.setNodeToken(s, 'a', 'multi\nline'), /token non valido/);
  assert.throws(() => store.setNodeToken(s, 'nope', 'x'), /sconosciuto/);
  s = store.removeNode(s, 'a');
  assert.equal(s.nodes.length, 0);
  assert.throws(() => store.removeNode(s, 'a'), /sconosciuto/);
});

// --- redazione --------------------------------------------------------------

test('redactStore/redactNode: MAI il token, solo hasToken', () => {
  const s = store.parseStore(validStore());
  const red = store.redactStore(s);
  const json = JSON.stringify(red);
  assert.ok(!json.includes('REMOTE-SECRET-123'));
  assert.equal(red.nodes[0].hasToken, true);
  assert.equal(red.nodes[0].token, undefined);
  // nodo senza token
  const s2 = store.removeNode(s, 'vps');
  assert.deepEqual(store.redactStore(s2).nodes, []);
});

// --- migrazione legacy ------------------------------------------------------

test('migrateLegacyNodes: guarded (no-op senza campo nodes)', () => {
  const dir = tmpDir();
  const cfg = path.join(dir, 'config.json');
  const nodesPath = path.join(dir, 'nodes.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: 41820 }));
  const r = store.migrateLegacyNodes(cfg, nodesPath);
  assert.equal(r.migrated, false);
  assert.match(r.reason, /nessun campo nodes/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrateLegacyNodes: importa nodes legacy da config.json', () => {
  const dir = tmpDir();
  const cfg = path.join(dir, 'config.json');
  const nodesPath = path.join(dir, 'nodes.json');
  fs.writeFileSync(cfg, JSON.stringify({
    port: 41820,
    nodes: [{ name: 'old', ssh: 'user@old-host', remotePort: 41820, localPort: 43050, keyPath: '/home/user/k' }],
  }));
  const r = store.migrateLegacyNodes(cfg, nodesPath);
  assert.equal(r.migrated, true);
  assert.equal(r.count, 1);
  assert.equal(store.loadStore(nodesPath).nodes[0].name, 'old');
  // idempotente: seconda volta no-op (nodes.json gia' popolato)
  const r2 = store.migrateLegacyNodes(cfg, nodesPath);
  assert.equal(r2.migrated, false);
  assert.match(r2.reason, /gia' popolato/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrateLegacyNodes: nodo legacy malformato -> throw esplicito (no silent)', () => {
  const dir = tmpDir();
  const cfg = path.join(dir, 'config.json');
  const nodesPath = path.join(dir, 'nodes.json');
  fs.writeFileSync(cfg, JSON.stringify({ nodes: [{ name: 'BAD NAME', ssh: 'x' }] }));
  assert.throws(() => store.migrateLegacyNodes(cfg, nodesPath), /non valido/);
  fs.rmSync(dir, { recursive: true, force: true });
});
