'use strict';
// 0.9.80 strato 2c — compositore pubblico dello stato della consegna e
// applicabilita' (parte pura). Nessun fs, nessun runtime.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  composePromptDelivery, composePromptDeliveryQualified, promptDeliveryApplicable,
  PROMPT_STATES,
} = require('../lib/fleet/prompt-outcome.js');
const {
  scriviRecordPrompt, leggiEsitoPromptCorrente, esitoPromptEPersistito,
} = require('../lib/files/activity.js');

const L1 = 'a1b2c3d4e5f60718';
const L2 = '0123456789abcdef';
const rec = (extra = {}) => ({ launchId: L1, generation: 1, state: 'submitted', ts: 5000, ...extra });
const comp = (over = {}) => composePromptDeliveryQualified({
  applicable: true, launchId: L1, generation: 1, letto: rec(), persistito: true, ...over,
});

test('applicabilita\': kimi/claude/vl, enter, reprompt off sono posseduti; legacy no', () => {
  for (const client of ['kimi', 'claude', 'vl']) assert.equal(promptDeliveryApplicable({ client }), true, client);
  assert.equal(promptDeliveryApplicable({ client: 'custom', submit: 'enter' }), true);
  assert.equal(promptDeliveryApplicable({ client: 'custom', submit: true }), true);
  assert.equal(promptDeliveryApplicable({ client: 'custom', repromptOff: true }), true);
  assert.equal(promptDeliveryApplicable({ client: 'custom' }), false);
  assert.equal(promptDeliveryApplicable({ client: 'shell', submit: false }), false);
  assert.equal(promptDeliveryApplicable(null), false);
  assert.equal(promptDeliveryApplicable('claude'), false);
});

test('tupla attestata: chiavi esatte, nessun deadlineTs o campo di trasporto', () => {
  const { delivery, terminalPersisted } = comp();
  assert.deepEqual(delivery, { state: 'submitted', launchId: L1, generation: 1, ts: 5000 });
  assert.equal(terminalPersisted, true);
  const pend = comp({ letto: rec({ state: 'pending', deadlineTs: 9999 }) });
  assert.deepEqual(pend.delivery, { state: 'pending', launchId: L1, generation: 1, ts: 5000 });
  assert.equal(pend.terminalPersisted, false);
  const sk = comp({ letto: rec({ state: 'skipped', reason: 'not-ready', notReady: 'busy' }) });
  assert.deepEqual(sk.delivery, {
    state: 'skipped', reason: 'not-ready', notReady: 'busy', launchId: L1, generation: 1, ts: 5000,
  });
});

test('non applicabile: null, qualunque cosa sia stata letta', () => {
  assert.equal(composePromptDelivery({ applicable: false, launchId: L1, generation: 1, letto: rec() }), null);
  assert.equal(composePromptDelivery(undefined) !== null, true); // input ignoto = unknown, non omissione
});

test('applicabile senza record, senza autorita\' o con record rotto: unknown senza dati inventati', () => {
  assert.deepEqual(comp({ letto: { state: 'absent', launchId: L1 } }).delivery,
    { state: 'unknown', launchId: L1, generation: 1 });
  assert.deepEqual(comp({ generation: null }).delivery, { state: 'unknown', launchId: L1 });
  assert.deepEqual(comp({ launchId: null }).delivery, { state: 'unknown' });
  assert.deepEqual(comp({ letto: { state: 'unknown', reason: 'record-broken', launchId: L1 } }).delivery,
    { state: 'unknown', reason: 'record-broken', launchId: L1 });
  assert.deepEqual(comp({ letto: null }).delivery, { state: 'unknown', launchId: L1, generation: 1 });
  // mai generation: 0 / ts: now per completare la forma
  for (const d of [comp({ generation: null }).delivery, comp({ launchId: null }).delivery]) {
    assert.equal(Object.hasOwn(d, 'generation'), false);
    assert.equal(Object.hasOwn(d, 'ts'), false);
  }
});

test('record anteriore/posteriore o di altro lancio: nessuna promozione', () => {
  const ant = comp({ letto: { state: 'unknown', reason: 'generation-not-recorded', launchId: L1, generation: 1 } });
  assert.deepEqual(ant.delivery, { state: 'unknown', reason: 'generation-not-recorded', launchId: L1, generation: 1 });
  assert.equal(ant.terminalPersisted, false);
  // un submitted di generazione diversa dall'autorita' non esce come tale
  assert.deepEqual(comp({ letto: rec({ generation: 0 }) }).delivery, { state: 'unknown', launchId: L1, generation: 1 });
  assert.deepEqual(comp({ letto: rec({ generation: 2 }) }).delivery, { state: 'unknown', launchId: L1, generation: 1 });
  assert.deepEqual(comp({ letto: rec({ launchId: L2 }) }).delivery, { state: 'unknown', launchId: L1, generation: 1 });
  // lancio ostile o ragione fuori catalogo
  assert.deepEqual(comp({ launchId: '../x' }).delivery, { state: 'unknown' });
  assert.deepEqual(comp({ letto: rec({ state: 'skipped', reason: 'inventata' }) }).delivery,
    { state: 'skipped', launchId: L1, generation: 1, ts: 5000 });
  assert.deepEqual(comp({ letto: rec({ state: 'weird' }) }).delivery, { state: 'unknown', launchId: L1, generation: 1 });
});

test('submitted esce SOLO dal terminale submitted del lancio e della generazione attestati', () => {
  const casi = [];
  for (const state of [...PROMPT_STATES, 'absent', 'weird', undefined]) {
    for (const generation of [null, 0, 1, 2]) {
      for (const lettoGen of [0, 1, 2]) {
        casi.push({ state, generation, lettoGen });
      }
    }
  }
  for (const c of casi) {
    const out = composePromptDelivery({
      applicable: true, launchId: L1, generation: c.generation,
      letto: { state: c.state, launchId: L1, generation: c.lettoGen, ts: 1 },
    });
    if (out.state === 'submitted') {
      assert.equal(c.state, 'submitted');
      assert.equal(c.generation, c.lettoGen);
    }
  }
});

test('unknown derivato dal lettore (pending scaduto, nessuna autorita\') non e\' un terminale persistito', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstatus-'));
  const dir = path.join(root, 'sess');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = { version: 1, event: 'prompt-delivery', launchId: L1 };
  // terminale scritto dal proprietario, gen 1
  assert.equal(scriviRecordPrompt(dir, { ...base, generation: 1, state: 'submitted', ts: Date.now() }), true);
  const coincide = leggiEsitoPromptCorrente(root, 'sess', { launchId: L1, generation: 1 });
  assert.equal(coincide.state, 'submitted');
  assert.equal(esitoPromptEPersistito(coincide), true);
  // senza autorita': derivato
  const senza = leggiEsitoPromptCorrente(root, 'sess', { launchId: L1 });
  assert.equal(esitoPromptEPersistito(senza), false);
  // autorita' 2: generation-not-recorded, derivato
  const ant = leggiEsitoPromptCorrente(root, 'sess', { launchId: L1, generation: 2 });
  assert.equal(ant.reason, 'generation-not-recorded');
  assert.equal(esitoPromptEPersistito(ant), false);
  // pending scaduto: derivato anche se la forma e' un unknown con ts
  assert.equal(scriviRecordPrompt(dir, {
    ...base, generation: 2, state: 'pending', ts: Date.now() - 10_000, deadlineTs: Date.now() - 5000,
  }), true);
  const scaduto = leggiEsitoPromptCorrente(root, 'sess', { launchId: L1, generation: 2 });
  assert.equal(scaduto.reason, 'deadline-exceeded');
  assert.equal(esitoPromptEPersistito(scaduto), false);
  const q = composePromptDeliveryQualified({
    applicable: true, launchId: L1, generation: 2, letto: scaduto, persistito: esitoPromptEPersistito(scaduto),
  });
  assert.equal(q.delivery.state, 'unknown');
  assert.equal(q.terminalPersisted, false);
  // un unknown realmente persistito (report-timeout) conta come terminale
  assert.equal(scriviRecordPrompt(dir, {
    ...base, generation: 3, state: 'unknown', reason: 'report-timeout', ts: Date.now(),
  }), true);
  const unk = leggiEsitoPromptCorrente(root, 'sess', { launchId: L1, generation: 3 });
  assert.equal(composePromptDeliveryQualified({
    applicable: true, launchId: L1, generation: 3, letto: unk, persistito: esitoPromptEPersistito(unk),
  }).terminalPersisted, true);
});

// ── cellStatus: campo `promptDelivery` (GET passivo) ─────────────────────────
const { registraLancioCorrente } = require('../lib/files/activity.js');
const { mondoStato, SESSIONE } = require('./helpers/prompt-stato-world.js');

function leaseFinto({ launchId = L1, generation = 1, applicable = true, vivo = true, binding = true, foto } = {}) {
  const chiamate = { snapshot: 0 };
  return {
    chiamate,
    status: () => ({ state: vivo ? 'live' : 'none' }),
    readPromptSnapshot: async () => {
      chiamate.snapshot += 1;
      return foto || { ok: true, launchId, applicable, generation, epoch: 1, leaseId: 'x' };
    },
    promptSnapshotBinding: () => binding,
  };
}

function scriviTerminale(w, over = {}) {
  fs.mkdirSync(w.dirSessione, { recursive: true, mode: 0o700 });
  return scriviRecordPrompt(w.dirSessione, {
    version: 1, event: 'prompt-delivery', launchId: L1, generation: 1, state: 'submitted', ts: Date.now(), ...over,
  });
}

function fotoFs(dir) {
  const out = {};
  const giro = (d) => {
    if (!fs.existsSync(d)) return;
    for (const v of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, v.name);
      if (v.isDirectory()) giro(p);
      else out[p] = fs.statSync(p).mtimeMs;
    }
  };
  giro(dir);
  return out;
}

async function statoCella(w, lease) {
  const rt = w.apri(lease);
  const st = await rt.status({});
  return st.cells[0];
}

test('cellStatus: terminale della generazione attestata dal proprietario esce come tupla', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId: L1, canale: 'none' });
  assert.equal(scriviTerminale(w, { generation: 1 }), true);
  const lease = leaseFinto({ generation: 1 });
  const c = await statoCella(w, lease);
  assert.equal(lease.chiamate.snapshot, 1);
  assert.deepEqual(Object.keys(c.promptDelivery).sort(), ['generation', 'launchId', 'state', 'ts']);
  assert.equal(c.promptDelivery.state, 'submitted');
  assert.equal(c.promptDelivery.launchId, L1);
  assert.equal(c.promptDelivery.generation, 1);
});

test('cellStatus: il vecchio submitted gen0 non e\' mai quello corrente se il proprietario ha ammesso gen1', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId: L1, canale: 'none' });
  scriviTerminale(w, { generation: 0 });
  const c = await statoCella(w, leaseFinto({ generation: 1 }));
  assert.deepEqual(c.promptDelivery, {
    state: 'unknown', reason: 'generation-not-recorded', launchId: L1, generation: 1,
  });
});

test('cellStatus: senza fotografia (nessun lease) la consegna possibile e\' unknown, mai il terminale vecchio', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId: L1, canale: 'none' });
  scriviTerminale(w, { generation: 0 });
  for (const lease of [undefined, leaseFinto({ vivo: false })]) {
    const c = await statoCella(w, lease);
    assert.deepEqual(c.promptDelivery, { state: 'unknown', launchId: L1 });
  }
});

test('cellStatus: fotografia di un altro lancio o connessione non piu\' legata: unknown, nessun dato', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId: L1, canale: 'none' });
  scriviTerminale(w, { generation: 1 });
  for (const lease of [leaseFinto({ launchId: L2 }), leaseFinto({ binding: false }), leaseFinto({ foto: { ok: false, reason: 'timeout' } })]) {
    const c = await statoCella(w, lease);
    assert.deepEqual(c.promptDelivery, { state: 'unknown', launchId: L1 });
  }
});

test('cellStatus: campo omesso se non applicabile; unknown senza id se manca il registro e la consegna e\' possibile', async () => {
  const legacy = mondoStato();                         // send-keys senza opt-in
  registraLancioCorrente(legacy.filesRoot, SESSIONE, { launchId: L1, canale: 'none' });
  assert.equal(Object.hasOwn(await statoCella(legacy, undefined), 'promptDelivery'), false);
  // snapshot attesta che la consegna NON e' posseduta: omesso
  const c2 = await statoCella(legacy, leaseFinto({ applicable: false }));
  assert.equal(Object.hasOwn(c2, 'promptDelivery'), false);
  const senzaRegistro = mondoStato({ engineExtra: { submit: 'enter' } });
  assert.deepEqual((await statoCella(senzaRegistro, undefined)).promptDelivery, { state: 'unknown' });
  const senzaPrompt = mondoStato({ engineExtra: { submit: 'enter' }, prompt: '' });
  assert.equal(Object.hasOwn(await statoCella(senzaPrompt, undefined), 'promptDelivery'), false);
});

test('cellStatus: cella spenta, omesso solo con chiusura attestata', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId: L1, canale: 'none' });
  scriviTerminale(w, { generation: 1 });
  w.imposta({ viva: false, errore: 'no server running on /tmp/tmux-1000/default' });
  assert.equal(Object.hasOwn(await statoCella(w, leaseFinto()), 'promptDelivery'), false);
  w.imposta({ viva: false, errore: 'protocol version mismatch' });
  const c = await statoCella(w, leaseFinto());
  assert.deepEqual(c.promptDelivery, { state: 'unknown', launchId: L1 });
});

test('cellStatus: un lancio nuovo non eredita il terminale del vecchio', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId: L2, canale: 'none' });
  scriviTerminale(w, { generation: 1 });               // record di L1
  const c = await statoCella(w, leaseFinto({ launchId: L2, generation: 1 }));
  assert.deepEqual(c.promptDelivery, { state: 'unknown', launchId: L2, generation: 1 });
});

test('cellStatus e\' passivo: nessun file creato, modificato o potato; nessuna scrittura nel mondo', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId: L1, canale: 'none' });
  scriviTerminale(w, { generation: 1 });
  const prima = fotoFs(w.root);
  await statoCella(w, leaseFinto());
  await statoCella(w, leaseFinto({ generation: 3 }));
  assert.deepEqual(fotoFs(w.root), prima);
});
