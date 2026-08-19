'use strict';
// tests/audio-groups.test.js — gruppi Audio Share.
//
// I test restano puramente deterministici: adapter e rete sono seam. Verificano
// soprattutto che una lista nominata non diventi un consenso implicito, che il
// failover attenda un ack onesto e che Stop blocchi la pipeline asincrona.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const groups = require('../lib/audio/groups.js');
const { createGroupReceiptStore } = require('../lib/audio/group-receipt.js');
const { createGroupSpeaker } = require('../lib/audio/group-speak.js');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const D = 'd'.repeat(32);
const ORIGIN = { node: A, cell: 'Dev' };

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitIdle(speaker, utteranceId, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    if (!speaker.isRunning({ origin: ORIGIN, utteranceId })) return;
    await tick();
  }
  throw new Error(`group ${utteranceId} non ha terminato nel tempo atteso`);
}

test('gruppi: store locale chiuso, target esatti e file 0600', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaudio-groups-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { home: dir, tokenPath: path.join(dir, '.nexuscrew', 'token') };
  const saved = groups.saveGroup(cfg, 'studio-1', { targets: [B.toUpperCase(), C], mode: 'primary-failover' }, dir);
  assert.deepEqual(saved, { name: 'studio-1', targets: [B, C], mode: 'primary-failover' });
  assert.deepEqual(groups.listGroups(cfg, dir), [saved]);
  assert.deepEqual(groups.getGroup(cfg, 'studio-1', dir), saved);
  const file = groups.groupsPath(cfg, dir);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => groups.saveGroup(cfg, 'Tutti', { targets: [B], mode: 'fanout' }, dir));
  assert.throws(() => groups.saveGroup(cfg, 'dup', { targets: [B, B], mode: 'fanout' }, dir));
  assert.throws(() => groups.saveGroup(cfg, 'wildcard', { targets: ['*'], mode: 'fanout' }, dir));
  assert.throws(() => groups.saveGroup(cfg, 'bad-mode', { targets: [B], mode: 'all' }, dir));
});

test('gruppi: non segue un audio-groups.json symlink', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaudio-groups-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, '.nexuscrew');
  fs.mkdirSync(state, { recursive: true });
  const victim = path.join(dir, 'victim.json');
  fs.writeFileSync(victim, JSON.stringify({ schemaVersion: 1, groups: { leak: { targets: [B], mode: 'fanout' } } }), { mode: 0o600 });
  const file = path.join(state, 'audio-groups.json');
  fs.symlinkSync(victim, file);
  const cfg = { home: dir, tokenPath: path.join(state, 'token') };
  assert.deepEqual(groups.listGroups(cfg, dir), [], 'un symlink non viene seguito neppure in lettura');
  assert.throws(() => groups.saveGroup(cfg, 'studio', { targets: [B], mode: 'fanout' }, dir));
  assert.match(fs.readFileSync(victim, 'utf8'), /"leak"/);
});

test('primary-failover: attende ack, prova il successivo su unknown e non tenta il terzo dopo spoken', async () => {
  let clock = 0;
  const receipts = createGroupReceiptStore({ now: () => clock });
  const seen = { capability: [], speak: [], status: [] };
  const speaker = createGroupSpeaker({
    getGroup: (name) => name === 'studio' ? { targets: [B, C, D], mode: 'primary-failover' } : null,
    receipts,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    ackTimeoutMs: 25,
    pollIntervalMs: 10,
    capability: async ({ target }) => { seen.capability.push(target); return { status: 'ready' }; },
    speak: async ({ target }) => {
      seen.speak.push(target);
      return target === B ? { status: 'accepted' } : { status: 'spoken' };
    },
    status: async ({ target }) => { seen.status.push(target); return { status: 'unknown', reason: 'ack-timeout' }; },
  });
  const initial = await speaker.speakGroup({ origin: ORIGIN, group: 'studio', text: 'non salvare questo testo', utteranceId: 'group-primary-0001' });
  assert.deepEqual(initial.endpoints.map((e) => [e.target, e.status, e.reason]), [
    [B, 'unknown', 'not-attempted'], [C, 'unknown', 'not-attempted'], [D, 'unknown', 'not-attempted'],
  ]);
  await waitIdle(speaker, initial.utteranceId);
  const result = speaker.getStatus({ origin: ORIGIN, utteranceId: initial.utteranceId });
  assert.deepEqual(seen.capability, [B, C]);
  assert.deepEqual(seen.speak, [B, C]);
  assert.deepEqual(seen.status, [B]);
  assert.deepEqual(result.endpoints.map((e) => [e.target, e.status, e.reason]), [
    [B, 'unknown', 'ack-timeout'], [C, 'spoken', undefined], [D, 'unknown', 'not-attempted'],
  ]);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes('non salvare questo testo'), false);
  assert.equal(Object.hasOwn(result, 'success'), false, 'nessun booleano aggregato nasconde il dettaglio endpoint');
});

test('fanout esplicito: ogni endpoint conserva il proprio esito e un consenso negato non viene parlato', async () => {
  const receipts = createGroupReceiptStore();
  const spoken = [];
  const speaker = createGroupSpeaker({
    getGroup: (name) => name === 'sala' ? { targets: [B, C, D], mode: 'fanout' } : null,
    receipts,
    capability: async ({ target }) => target === C ? { status: 'refused', reason: 'consent' } : { status: 'ready' },
    speak: async ({ target }) => { spoken.push(target); return target === D ? { status: 'unreachable', reason: 'transport' } : { status: 'spoken' }; },
  });
  const initial = await speaker.speakGroup({ origin: ORIGIN, group: 'sala', text: 'prova', utteranceId: 'group-fanout-0001' });
  await waitIdle(speaker, initial.utteranceId);
  const result = speaker.getStatus({ origin: ORIGIN, utteranceId: initial.utteranceId });
  assert.deepEqual([...spoken].sort(), [B, D], 'un endpoint senza consenso non riceve nemmeno speak');
  assert.deepEqual(result.endpoints.map((e) => [e.target, e.status, e.reason]), [
    [B, 'spoken', undefined], [C, 'refused', 'consent'], [D, 'unreachable', 'transport'],
  ]);
});

test('stop gruppo: ferma solo endpoint gia ammessi e impedisce il failover tardivo', async () => {
  const receipts = createGroupReceiptStore();
  let releaseStatus;
  const called = { speak: [], stop: [] };
  const speaker = createGroupSpeaker({
    getGroup: () => ({ targets: [B, C], mode: 'primary-failover' }),
    receipts,
    capability: async () => ({ status: 'ready' }),
    speak: async ({ target }) => { called.speak.push(target); return { status: 'accepted' }; },
    status: async () => new Promise((resolve) => { releaseStatus = resolve; }),
    stop: async ({ target }) => { called.stop.push(target); return { status: 'accepted' }; },
    ackTimeoutMs: 60_000,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  const initial = await speaker.speakGroup({ origin: ORIGIN, group: 'studio', text: 'stop', utteranceId: 'group-stop-0001' });
  for (let i = 0; i < 20 && !releaseStatus; i += 1) await tick();
  assert.ok(releaseStatus, 'il primary e arrivato alla fase di attesa ack');
  const stopped = await speaker.stopGroup({ origin: ORIGIN, utteranceId: initial.utteranceId });
  assert.deepEqual(called.stop, [B]);
  assert.deepEqual(stopped.endpoints.map((e) => [e.target, e.status, e.reason]), [
    [B, 'accepted', undefined], [C, 'refused', 'stopped'],
  ]);
  releaseStatus({ status: 'unknown', reason: 'ack-timeout' });
  await waitIdle(speaker, initial.utteranceId);
  assert.deepEqual(called.speak, [B], 'lo stop non lascia partire il failover C');
});

// —— R31-A4: il difetto nasce qui, e qui va provato ——
// saveGroup/removeGroup lanciavano Error generici indistinguibili dagli errori
// di I/O di atomicWrite: il chiamante poteva separarli solo col match sul
// testo del messaggio. Il contratto diventa: validazione = status 400 + code
// chiuso; scrittura fallita = errore fs nativo con il suo errno, mai 400.
test('R31-A4: validazione distinguibile per contratto (status+code), non per testo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaudio-groups-a4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { home: dir, tokenPath: path.join(dir, '.nexuscrew', 'token') };

  assert.throws(
    () => groups.saveGroup(cfg, 'Non-Valido!', { targets: [B], mode: 'fanout' }, dir),
    (e) => e.status === 400 && e.code === 'AUDIO_GROUP_NAME_INVALID',
  );
  assert.throws(
    () => groups.saveGroup(cfg, 'ok-name', { targets: [], mode: 'fanout' }, dir),
    (e) => e.status === 400 && e.code === 'AUDIO_GROUP_SPEC_INVALID',
  );
  assert.throws(
    () => groups.removeGroup(cfg, 'Non-Valido!', dir),
    (e) => e.status === 400 && e.code === 'AUDIO_GROUP_NAME_INVALID',
  );
});

test('R31-A4: scrittura fallita resta errore fs nativo, senza status 400', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaudio-groups-a4-ro-'));
  // Il ripristino tocca .nexuscrew, non la radice: è quella la dir 0o500,
  // e rmSync non può svuotarla finché resta senza scrittura.
  t.after(() => {
    fs.chmodSync(path.join(dir, '.nexuscrew'), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = { home: dir, tokenPath: path.join(dir, '.nexuscrew', 'token') };
  fs.mkdirSync(path.join(dir, '.nexuscrew'), { recursive: true });
  // Prima un salvataggio buono, poi la directory diventa non scrivibile: il
  // prossimo saveGroup deve lanciare l'errore fs CON il suo errno e SENZA
  // status — cosi' la route non puo' confonderlo con una validazione.
  groups.saveGroup(cfg, 'studio', { targets: [B], mode: 'fanout' }, dir);
  fs.chmodSync(path.join(dir, '.nexuscrew'), 0o500);
  assert.throws(
    () => groups.saveGroup(cfg, 'studio', { targets: [C], mode: 'fanout' }, dir),
    (e) => e.code === 'EACCES' && e.status === undefined,
  );
});
