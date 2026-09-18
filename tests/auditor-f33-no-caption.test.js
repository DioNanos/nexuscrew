'use strict';
// tests/file-notice-parity.test.js — the file-notice CONTRACT (project §7).
//
// A delivered file is an ALERT, both when the delivery happens here and when
// the notice arrives from a federated owner. The two paths are built from
// different code (local: files route -> notifier -> push facade; imported:
// event-feed subscriber -> local re-emission into the import hub -> push
// relay) and NOTHING in the product ties them together: today the parity is a
// fact, not a rule. This test makes it a rule, so a change that silently mutes
// one side breaks here instead of drifting unnoticed.
//
// It is deliberately not a restatement of either implementation: the local
// side drives the REAL route, the REAL notifier and the REAL push facade with
// only the transports faked, and the imported side drives the REAL subscriber
// re-emission and the REAL relay.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { filesRoutes } = require('../lib/files/routes.js');
const { createNotifier } = require('../lib/notify/notifier.js');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
const { createPushRelay, createPushDedup } = require('../lib/notify/push-relay.js');

const OWNER = 'b'.repeat(32);

// The class BOTH paths must land on: the same face to the hub and the same
// number of OS alerts. The WORDING is not the contract (the local notice reads
// "file da <session>", the imported one "file: <name>"), the class is.
function alertClass(hubFrame, alerts) {
  return {
    hubType: hubFrame && hubFrame.type,
    hasTitle: Boolean(hubFrame && hubFrame.title),
    hasBody: Boolean(hubFrame && hubFrame.body),
    alerts: alerts.length,
  };
}

// The LOCAL path, exactly as the product wires it: a real delivery request
// against the real route, the real notifier and the real push facade. Only the
// hub and the push transport are spies.
async function localDelivery(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfilenotice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hubFrames = [];
  const alerts = [];
  const notifier = createNotifier({
    hub: { broadcast: (f) => { hubFrames.push(f); return 1; } },
    push: { sendToAll: async (p) => { alerts.push(p); return { sent: 1 }; } },
  });
  const app = express();
  app.use('/api/files', filesRoutes({
    cfg: { filesRoot: root, home: root, maxUpload: 1024 * 1024 },
    sessionExists: (s) => s === 'sess1',
    paste: () => true,
    notifier,
    readonly: () => false,
  }));
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  t.after(() => srv.close());
  const src = path.join(root, 'report.pdf');
  fs.writeFileSync(src, 'report');
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/files/outbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'sess1', path: src, caption: undefined }),
  });
  assert.equal(r.status, 200, 'la consegna locale passa dalla route reale');
  await new Promise((res) => setImmediate(res)); // la notify e' fire-and-forget nella route
  return { hubFrames, alerts };
}

// The IMPORTED path, exactly as the product wires it: the same hub adapter the
// server installs (broadcast for the UI + the relay fed from there) and the
// real subscriber re-emission.
function importedDelivery(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfilenoticefed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hubFrames = [];
  const alerts = [];
  const relay = createPushRelay({
    pushDedup: createPushDedup({ filePath: path.join(dir, 'push-dedup.json') }),
    send: async (p) => { alerts.push(p); return { sent: 1 }; },
  });
  const client = createEventFeedClient({
    eventsHub: { broadcast: (e) => { hubFrames.push(e); relay.considerImported(e); return 1; } },
  });
  const envelope = (eventId, over = {}) => ({
    v: 1, ownerId: OWNER, eventId, scope: 'cell', cellId: 'dev', hop: 1, emittedAt: 1,
    frame: { type: 'file-notice', name: 'report.pdf', caption: undefined },
    ...over,
  });
  return { hubFrames, alerts, client, envelope };
}

test('file-notice: consegna locale e file-notice importato sono la STESSA classe di avviso', async (t) => {
  const local = await localDelivery(t);
  const imported = importedDelivery(t);
  assert.equal(imported.client.reemit(imported.envelope('ev-file-1')), true, 'la ri-emissione locale avviene');
  await new Promise((res) => setImmediate(res));

  // Il percorso locale NON e' silenzioso: frame d'hub `notify` + un push che
  // nomina davvero il file consegnato.
  assert.equal(local.hubFrames.length, 1, 'il locale emette un solo frame');
  assert.equal(local.hubFrames[0].type, 'notify');
  assert.equal(local.alerts.length, 1, 'il locale manda un push');
  assert.match(local.alerts[0].title, /file da sess1/);
  assert.match(String(local.alerts[0].body), /report\.pdf/);

  // L'importato, dopo la ri-emissione, fa la stessa cosa e in piu' e'
  // attribuito all'owner (tag e route dell'owner, mai un URL del peer).
  assert.equal(imported.hubFrames.length, 1, 'la ri-emissione produce un frame notify');
  assert.equal(imported.hubFrames[0].type, 'notify');
  assert.equal(imported.alerts.length, 1, 'il relay manda un avviso OS');
  assert.equal(imported.alerts[0].tag, `nc:${OWNER}:ev-file-1`);
  assert.match(String(imported.alerts[0].url), /^\/#owner=/);

  // LA PARITA': se il locale diventasse silenzioso (o l'importato smettesse di
  // essere ri-emesso come notify) questa uguaglianza non regge piu'.
  assert.deepEqual(
    alertClass(local.hubFrames[0], local.alerts),
    alertClass(imported.hubFrames[0], imported.alerts),
    'le due strade devono arrivare alla stessa classe di avviso',
  );
});

test('file-notice importato: solo NUOVI e attribuiti — il replay non suona due volte', async (t) => {
  const imported = importedDelivery(t);
  assert.equal(imported.client.reemit(imported.envelope('ev-file-2')), true);
  await new Promise((res) => setImmediate(res));
  assert.equal(imported.alerts.length, 1);
  assert.equal(imported.hubFrames.length, 1);

  // Replay dello stesso evento: nessun secondo frame, nessun secondo avviso
  // (dedup (owner, eventId) prima dell'invio, §7).
  assert.equal(imported.client.reemit(imported.envelope('ev-file-2')), false);
  await new Promise((res) => setImmediate(res));
  assert.equal(imported.alerts.length, 1, 'un evento gia noto non suona due volte');
  assert.equal(imported.hubFrames.length, 1);

  // Un frame senza la prima hop non e' attribuito: non entra nel hub, quindi
  // non puo' suonare.
  assert.equal(imported.client.reemit(imported.envelope('ev-file-3', { hop: 0 })), false);
  await new Promise((res) => setImmediate(res));
  assert.equal(imported.alerts.length, 1, 'un evento non attribuito non suona');
  assert.equal(imported.hubFrames.length, 1);
});
