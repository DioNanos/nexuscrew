'use strict';
// Frontend pairing decode (settings-model.js): UNA funzione pura per v1/v2 usata da
// Settings/Wizard/paste/QR. Cross-layer: i link li genera il backend peering.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const peering = require('../lib/nodes/peering.js');

const sm = () => import('../frontend/src/lib/settings-model.js');

function makeLink(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pairdec-'));
  const p = path.join(dir, 'invites.json');
  const made = peering.createInvite({ invitesPath: p, instanceId: 'd'.repeat(32), port: 41830, label: 'Relay', ...over });
  fs.rmSync(dir, { recursive: true, force: true });
  return made.pairingUrl;
}

test('decodePairingForm v1: solo label, nessun ssh/slug', async () => {
  const { decodePairingForm } = await sm();
  const d = decodePairingForm(makeLink());
  assert.equal(d.ok, true);
  assert.equal(d.version, 1);
  assert.equal(d.label, 'Relay');
  assert.equal(d.ssh, undefined);
  assert.equal(d.name, undefined);
});

test('decodePairingForm v2: label+slug+ssh+sshPort prefilled', async () => {
  const { decodePairingForm } = await sm();
  const d = decodePairingForm(makeLink({ ssh: 'user@relay.example', sshPort: 2222, name: 'home-relay' }));
  assert.equal(d.ok, true);
  assert.equal(d.version, 2);
  assert.equal(d.label, 'Relay');
  assert.equal(d.name, 'home-relay');
  assert.equal(d.ssh, 'user@relay.example');
  assert.equal(d.sshPort, 2222);
});

test('decodePairingForm v2: accetta un Host alias come il backend', async () => {
  const { decodePairingForm } = await sm();
  const d = decodePairingForm(makeLink({ ssh: 'my-relay', name: 'home-relay' }));
  assert.equal(d.ok, true);
  assert.equal(d.ssh, 'my-relay');
});

test('mergePairingIntoForm: v2 con ssh ma senza name deriva lo slug dalla label', async () => {
  const { decodePairingForm, mergePairingIntoForm } = await sm();
  const link = makeLink({ ssh: 'my-relay' });
  const payload = JSON.parse(Buffer.from(new URL(link).hash.replace(/^#pair=/, ''), 'base64url').toString('utf8'));
  delete payload.name; // simula un link v2 generato dalla prima implementazione
  const legacyV2 = `http://127.0.0.1:41830/#pair=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const merged = mergePairingIntoForm({ name: '', label: '', ssh: '', sshPort: '' }, decodePairingForm(legacyV2), new Set());
  assert.equal(merged.name, 'relay');
  assert.equal(merged.ssh, 'my-relay');
});

test('decodePairingForm: malformed/unknown/secret -> ok:false', async () => {
  const { decodePairingForm } = await sm();
  assert.equal(decodePairingForm('not a url').ok, false);
  assert.equal(decodePairingForm('http://127.0.0.1:1/#pair=garbage').ok, false);
  // unknown field (apiKey) su un payload altrimenti v2 -> rifiutato
  const link = makeLink({ ssh: 'u@h', name: 'n' });
  const x = JSON.parse(Buffer.from(new URL(link).hash.replace(/^#pair=/, ''), 'base64url').toString('utf8'));
  const bad = `http://127.0.0.1:41830/#pair=${Buffer.from(JSON.stringify({ ...x, apiKey: 'sk' })).toString('base64url')}`;
  assert.equal(decodePairingForm(bad).ok, false);
});

test('mergePairingIntoForm: precompila solo i campi non toccati a mano', async () => {
  const { decodePairingForm, mergePairingIntoForm } = await sm();
  const decoded = decodePairingForm(makeLink({ ssh: 'u@h', sshPort: 22, name: 'home-relay' }));
  // fresh form: tutto prefilled
  const a = mergePairingIntoForm({ name: '', label: '', ssh: '', sshPort: '' }, decoded, new Set());
  assert.equal(a.name, 'home-relay');
  assert.equal(a.ssh, 'u@h');
  assert.equal(a.sshPort, '22');
  // ssh già editato a mano -> conservato (non sovrascritto)
  const b = mergePairingIntoForm({ name: '', label: '', ssh: 'manual@host', sshPort: '' }, decoded, new Set(['ssh']));
  assert.equal(b.ssh, 'manual@host');
  assert.equal(b.name, 'home-relay', 'name non toccato -> prefilled');
});
