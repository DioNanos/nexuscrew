'use strict';
// tests/label-slug.test.js — separazione label umana (display) vs slug tecnico
// (routing). Copre: generazione slug, disambiguazione, validazione label nello
// store, backward-compat record esistenti, rename della label senza toccare il
// name (route preservata).
const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../lib/nodes/store.js');

const NODE_ID = 'a'.repeat(32);
const baseNode = (over = {}) => ({
  name: 'vps3', ssh: 'u@h', remotePort: 22, localPort: 43001, direction: 'outbound', ...over,
});
const mk = (over) => store.parseStore({ schemaVersion: 2, nodeId: NODE_ID, nodes: [baseNode(over)] });

// --- toSlug -----------------------------------------------------------------

test('toSlug: lowercase, diacritici ASCII, run non-alfanumerici -> single dash', () => {
  assert.equal(store.toSlug('VPS3'), 'vps3');
  assert.equal(store.toSlug('My Server!'), 'my-server');
  assert.equal(store.toSlug('café'), 'cafe');
  assert.equal(store.toSlug('  Multi   space  '), 'multi-space');
  assert.equal(store.toSlug('über-größe'), 'uber-große'.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
});

test('toSlug: input povero -> fallback "node", mai throw, mai vuoto', () => {
  assert.equal(store.toSlug(''), 'node');
  assert.equal(store.toSlug('---'), 'node');
  assert.equal(store.toSlug('   '), 'node');
  assert.equal(store.toSlug(null), 'node');
  assert.equal(store.toSlug(undefined), 'node');
  assert.equal(store.toSlug('!@#$%'), 'node');
});

test('toSlug: rispetta il limite 32 char (NODE_NAME_RE)', () => {
  const long = 'A'.repeat(50);
  const slug = store.toSlug(long);
  assert.ok(slug.length <= 32);
  assert.match(slug, /^[a-z0-9-]{1,32}$/);
});

test('toSlug: output sempre conforme a NODE_NAME_RE', () => {
  for (const input of ['VPS3', 'Pixel 9 Pro', 'localhost', 'A.B/C', 'café', '42', '---', '']) {
    const slug = store.toSlug(input);
    assert.ok(store.NODE_NAME_RE.test(slug), `"${input}" -> "${slug}" non conforme`);
  }
});

// --- suggestNodeName --------------------------------------------------------

test('suggestNodeName: slug univoco, disambigua -2/-3 su collisione', () => {
  assert.equal(store.suggestNodeName('VPS3', []), 'vps3');
  assert.equal(store.suggestNodeName('VPS3', ['vps3']), 'vps3-2');
  assert.equal(store.suggestNodeName('VPS3', ['vps3', 'vps3-2']), 'vps3-3');
  // input povero -> base 'node', disambiguato
  assert.equal(store.suggestNodeName('!!!', []), 'node');
  assert.equal(store.suggestNodeName('!!!', ['node']), 'node-2');
});

test('suggestNodeName: candidato sempre conforme a NODE_NAME_RE e <=32', () => {
  const existing = [];
  for (let i = 0; i < 40; i += 1) {
    const name = store.suggestNodeName('A'.repeat(40), existing);
    assert.ok(store.NODE_NAME_RE.test(name), `"${name}" non conforme`);
    assert.ok(name.length <= 32);
    existing.push(name);
  }
  assert.equal(new Set(existing).size, 40, 'tutti univoci');
});

// --- label nello store ------------------------------------------------------

test('parseNode: accetta label valida (display, maiuscole/spazi)', () => {
  const s = mk({ label: 'VPS3 Server' });
  assert.ok(s);
  assert.equal(s.nodes[0].label, 'VPS3 Server');
  assert.equal(s.nodes[0].name, 'vps3'); // name (slug) invariato
});

test('parseNode: label opzionale (backward-compat record esistenti)', () => {
  const s = mk();
  assert.ok(s);
  assert.equal(s.nodes[0].label, undefined);
});

test('parseNode: rifiuta label garbage (control char, >64, non-string, solo spazi)', () => {
  assert.equal(mk({ label: 'a\nb' }), null);          // newline
  assert.equal(mk({ label: 'a\tb' }), null);          // tab
  assert.equal(mk({ label: 'a'.repeat(65) }), null);  // >64
  assert.equal(mk({ label: 42 }), null);              // non-string
  assert.equal(mk({ label: '   ' }), null);           // solo spazi
});

test('parseNode: label trimmata (spazi ai bordi normalizzati)', () => {
  const s = mk({ label: '  VPS3  ' });
  assert.equal(s.nodes[0].label, 'VPS3');
});

// --- redaction / nodeLabel --------------------------------------------------

test('redactNode: espone label se presente, assente se mancante (no fallback nel JSON)', () => {
  assert.equal(store.redactNode(mk({ label: 'VPS3' }).nodes[0]).label, 'VPS3');
  const redNoLabel = store.redactNode(mk().nodes[0]);
  assert.equal(redNoLabel.label, undefined);
  assert.ok(!('label' in redNoLabel), 'non serializzare label mancante');
});

test('nodeLabel: ritorna label se presente, fallback a name altrimenti', () => {
  assert.equal(store.nodeLabel(mk({ label: 'VPS3' }).nodes[0]), 'VPS3');
  assert.equal(store.nodeLabel(mk().nodes[0]), 'vps3');
  assert.equal(store.nodeLabel(null), '');
});

// --- rename label preservando name (route non rotta) ------------------------

test('updateNode: rename della label NON cambia il name (route/URL preservati)', () => {
  let s = store.addNode(store.emptyStore(NODE_ID), baseNode({ label: 'Old' }));
  assert.equal(s.nodes[0].name, 'vps3');
  assert.equal(s.nodes[0].label, 'Old');
  s = store.updateNode(s, 'vps3', { label: 'Nuovo Nome' });
  assert.equal(s.nodes[0].name, 'vps3');     // name invariato -> route stabile
  assert.equal(s.nodes[0].label, 'Nuovo Nome');
});

test('updateNode: stripping della label (ritorno a fallback name) ammesso', () => {
  let s = store.addNode(store.emptyStore(NODE_ID), baseNode({ label: 'Tmp' }));
  // patch con label undefined NON rimuove (merge superficiale): si usa null/empty?
  // Contratto: updateNode mergia patch; per "rimuovere" la label non c'e' API qui,
  // ma la label vuota e' rifiutata -> il rename verso '' e' un errore esplicito.
  assert.throws(() => store.updateNode(s, 'vps3', { label: '   ' }), /non valido/);
  // la label resta leggibile come fallback name via nodeLabel
  assert.equal(store.nodeLabel(store.addNode(store.emptyStore(NODE_ID), baseNode()).nodes[0]), 'vps3');
});
