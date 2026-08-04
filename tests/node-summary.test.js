'use strict';
// tests/node-summary.test.js — il riassunto che viaggia nella RIGA di un nodo.
//
// Decisione di design: riga + foglio di dettaglio, e in riga solo identita' e
// riassunto derivato. Questo file vincola il derivato, che e' la parte che si
// puo' sbagliare in silenzio: una riga che dice "condiviso" mentre il nodo non
// raggiunge nessuno e' peggio di una riga vuota.

const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/node-summary.js');

test('node-summary: un nodo privato lo dice, qualunque sia la visibilita\'', async () => {
  const { nodeExposure } = await mod();
  assert.equal(nodeExposure({ shared: false, visibility: 'network' }).key, 'peer-private');
  assert.equal(nodeExposure({ shared: false, visibility: 'selected', selected: ['a'] }).shared, false);
});

test('node-summary: condiviso verso nessuno non e\' condiviso verso tutti', async () => {
  const { nodeExposure } = await mod();
  // E' uno stato reale e silenzioso: shared true, ma la lista e' vuota. Chi
  // legge la riga deve poterlo distinguere, altrimenti crede di essere esposto
  // quando non lo e', o il contrario.
  const nessuno = nodeExposure({ shared: true, visibility: 'selected', selected: [] });
  assert.equal(nessuno.key, 'visibility-selected');
  assert.equal(nessuno.count, 0);
  const alcuni = nodeExposure({ shared: true, visibility: 'selected', selected: ['a', 'b'] });
  assert.equal(alcuni.count, 2);
  assert.notEqual(nessuno.count, alcuni.count);
});

test('node-summary: senza visibilita\' dichiarata vale rete, come il backend', async () => {
  const { nodeExposure } = await mod();
  assert.equal(nodeExposure({ shared: true }).key, 'visibility-network');
  assert.equal(nodeExposure({ shared: true, visibility: 'relay-only' }).key, 'visibility-relay');
});

test('node-summary: un nodo in transito non ha un tunnel proprio', async () => {
  const { nodeReach } = await mod();
  const vivo = nodeReach({ kind: 'transitive' });
  assert.equal(vivo.routed, true);
  assert.equal(vivo.up, true);
  const stantio = nodeReach({ kind: 'transitive', stale: true });
  assert.equal(stantio.up, false, 'una catena stantia non e\' raggiungibile');
  assert.notEqual(stantio.key, vivo.key);
});

test('node-summary: passivo non e\' giu\'', async () => {
  const { nodeReach } = await mod();
  // Un inbound senza tunnel proprio e' in attesa, non guasto: confonderli
  // manda l'operatore a diagnosticare un problema che non esiste.
  const passivo = nodeReach({ tunnel: { status: 'passive' } });
  const giu = nodeReach({ tunnel: { status: 'down' } });
  assert.equal(passivo.up, false);
  assert.equal(passivo.passive, true);
  assert.notEqual(passivo.key, giu.key);
  assert.equal(nodeReach({ tunnel: { status: 'up' } }).up, true);
});

test('node-summary: la riga porta identita\' e riassunti, e nulla di piu\'', async () => {
  const { nodeRowSummary } = await mod();
  const row = nodeRowSummary({
    name: 'peer-1', label: 'Portatile', shared: true, visibility: 'selected', selected: ['a'],
    tunnel: { status: 'up' }, ssh: 'user@host', token: 'segreto', acceptToken: 'segreto2',
  });
  assert.equal(row.title, 'Portatile');
  assert.equal(row.subtitle, 'peer-1');
  assert.equal(row.reach.up, true);
  assert.equal(row.exposure.count, 1);
  // Nessun segreto e nessun dettaglio di trasporto entrano nella riga: il
  // dettaglio vive nel foglio, i segreti da nessuna parte.
  const serial = JSON.stringify(row);
  assert.equal(serial.includes('segreto'), false);
  assert.equal(serial.includes('user@host'), false);
});

test('node-summary: la label vuota o di soli spazi ricade sul nome', async () => {
  const { nodeRowSummary } = await mod();
  assert.equal(nodeRowSummary({ name: 'peer-1', label: '   ' }).title, 'peer-1');
  assert.equal(nodeRowSummary({ name: 'peer-1' }).title, 'peer-1');
  assert.equal(nodeRowSummary({ label: 'senza nome' }), null, 'senza name non c\'e\' riga');
  assert.equal(nodeRowSummary(null), null);
});
