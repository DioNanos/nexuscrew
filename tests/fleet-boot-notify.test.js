'use strict';
// Il boot fallito si vede e avvisa.
// Il companion, alla fine di un tentativo con esiti negativi, manda UNA
// notifica aggregata all'API operatore del demone (`POST /api/notify`,
// `lib/notify/routes.js:266`, montata su `/api` da `lib/server.js:2207`).
// Niente servizio reale: HTTP finto, come la sezione 4 di fleet-boot.test.js.
// La unit generata e' un TEMPLATE di stringa: qui non si tocca nessuna unit
// installata ne' si esegue systemctl.

const { test } = require('node:test');
const assert = require('node:assert');
const { runFleetBoot } = require('../lib/cli/commands.js');
const { generateFleetService } = require('../lib/cli/fleet-service.js');

const NODE_ID = 'ab'.repeat(16);

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, body });
    const hit = routes.find((r) => r.method === method && r.path === u.pathname);
    if (!hit) return { status: 404, json: async () => ({ error: 'not found' }) };
    const out = typeof hit.reply === 'function' ? hit.reply({ body }) : hit.reply;
    if (out instanceof Error) throw out;
    return { status: out.status, json: async () => out.json };
  };
  return { impl: (...a) => impl(...a), calls };
}

const cfgOk = { method: 'GET', path: '/api/config', reply: { status: 200, json: { instanceId: NODE_ID } } };
const supervisionOk = { lease: 'ready', control: 'ready' };
function statusOk(cells, supervision = supervisionOk) {
  return { method: 'GET', path: '/api/fleet/status', reply: { status: 200, json: { available: true, cells, supervision } } };
}
const upOk = { method: 'POST', path: '/api/fleet/up', reply: { status: 200, json: { ok: true } } };
const upDup = { method: 'POST', path: '/api/fleet/up', reply: { status: 409, json: { error: 'duplicate', code: 'SESSION_DUPLICATE' } } };
const launchMuto = { method: 'GET', path: '/api/fleet/launch-state', reply: { status: 200, json: null } };
const notifyOk = { method: 'POST', path: '/api/notify', reply: { status: 200, json: { ok: true } } };

function bootOpts(fetchFake, extra = {}) {
  return {
    log: () => {},
    cfg: {},
    token: 'token-di-test',
    readNodeId: () => NODE_ID,
    fetchImpl: fetchFake,
    readyBudget: 1500,
    readyTick: 10,
    ...extra,
  };
}

const notifiche = (fake) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/notify');

test('un esito failed manda UNA notifica aggregata con la cella e il codice', async () => {
  const fake = fakeFetch([cfgOk, statusOk([{ cell: 'Alpha', boot: true }]), upDup, launchMuto, notifyOk]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1, 'il fallimento resta un fallimento');
  const n = notifiche(fake);
  assert.equal(n.length, 1, 'una sola notifica aggregata, mai una per cella');
  assert.equal(n[0].body.urgency, 'high');
  assert.ok(typeof n[0].body.title === 'string' && n[0].body.title.length > 0);
  assert.ok(n[0].body.body.includes('Alpha'), `la cella fallita e' nel corpo: ${n[0].body.body}`);
  assert.ok(n[0].body.body.includes('SESSION_DUPLICATE'), `il codice e' nel corpo: ${n[0].body.body}`);
});

test('un esito unconfirmed distingue «avvio non confermato» da cella spenta', async () => {
  const persa = { method: 'POST', path: '/api/fleet/up', reply: new TypeError('fetch failed') };
  const fake = fakeFetch([cfgOk, statusOk([{ cell: 'Beta', boot: true }]), persa, launchMuto, notifyOk]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  const n = notifiche(fake);
  assert.equal(n.length, 1);
  assert.ok(/not confirmed/i.test(n[0].body.body), `il corpo dichiara l'incertezza: ${n[0].body.body}`);
  assert.ok(n[0].body.body.includes('Beta'));
});

test('tutto started: nessuna notifica', async () => {
  const fake = fakeFetch([cfgOk, statusOk([{ cell: 'Alpha', boot: true }]), upOk, notifyOk]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 0);
  assert.equal(notifiche(fake).length, 0, 'nessun rumore quando il boot e\' completo');
});

test('API di notifica giu\': exit 1 conservato, riga di log, nessuna eccezione', async () => {
  const righe = [];
  const giu = { method: 'POST', path: '/api/notify', reply: new TypeError('fetch failed') };
  const fake = fakeFetch([cfgOk, statusOk([{ cell: 'Alpha', boot: true }]), upDup, launchMuto, giu]);
  const r = await runFleetBoot(bootOpts(fake.impl, { log: (m) => righe.push(String(m)) }));
  assert.equal(r.code, 1, 'la notifica non disponibile non cambia l\'esito');
  assert.ok(righe.some((m) => /notify|notific/i.test(m)), `l'esito della notifica va nel log: ${righe.join(' | ')}`);
  assert.ok(r.summary && r.summary.failed.length === 1);
});

test('la notifica non cambia l\'esito degli avvii riusciti', async () => {
  const up = { method: 'POST', path: '/api/fleet/up', reply: ({ body }) => (body.cell === 'Alpha'
    ? { status: 200, json: { ok: true } }
    : { status: 409, json: { error: 'duplicate', code: 'SESSION_DUPLICATE' } }) };
  const fake = fakeFetch([cfgOk, statusOk([{ cell: 'Alpha', boot: true }, { cell: 'Beta', boot: true }]), up, launchMuto, notifyOk]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.deepEqual(r.summary.started, ['Alpha']);
  assert.equal(r.summary.failed.length, 1);
  assert.equal(notifiche(fake).length, 1);
});

test('readiness fallita: notifica con il motivo, exit 1', async () => {
  const fake = fakeFetch([
    cfgOk,
    { method: 'GET', path: '/api/fleet/status', reply: { status: 200, json: { available: true, cells: [], supervision: { lease: 'absent', control: 'absent' } } } },
    notifyOk,
  ]);
  const r = await runFleetBoot(bootOpts(fake.impl));
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'supervision-absent');
  const n = notifiche(fake);
  assert.equal(n.length, 1, 'anche un fallimento prima della lista avvisa');
  assert.ok(n[0].body.body.includes('supervision-absent'), `il motivo e' nel corpo: ${n[0].body.body}`);
});

// ---------------------------------------------------------------------------
// Il boot senza identita' non resta muto (e non puo' avvisare nessuno)
// ---------------------------------------------------------------------------

test('identità del nodo assente: UNA riga di log col motivo, exit 1, zero richieste', async () => {
  const righe = [];
  const fake = fakeFetch([notifyOk]);
  const r = await runFleetBoot(bootOpts(fake.impl, {
    readNodeId: () => null,
    log: (m) => righe.push(String(m)),
  }));
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'identity-unavailable');
  const toccate = righe.filter((m) => /identit/i.test(m));
  assert.equal(toccate.length, 1, `una riga sola, non un silenzio: ${righe.join(' | ')}`);
  assert.ok(/no notice/i.test(toccate[0]), `la riga dice che senza identita' non si puo' avvisare: ${toccate[0]}`);
  assert.equal(fake.calls.length, 0, "senza identita' nessuna richiesta: né avvii né notifiche");
});

test('identità del nodo illeggibile: il motivo della lettura finisce nella riga di log', async () => {
  const righe = [];
  const fake = fakeFetch([notifyOk]);
  const r = await runFleetBoot(bootOpts(fake.impl, {
    readNodeId: undefined,
    nodesStore: {
      defaultNodesPath: () => '/non/lesibile/nodes.json',
      loadStore: () => { throw new Error('node store illeggibile'); },
    },
    log: (m) => righe.push(String(m)),
  }));
  assert.equal(r.code, 1);
  assert.equal(r.reason, 'identity-unavailable');
  assert.ok(righe.some((m) => /node store illeggibile/.test(m)), `il motivo della lettura e' nel log: ${righe.join(' | ')}`);
  assert.equal(fake.calls.length, 0, 'zero richieste anche con lo store non leggibile');
});

test('unit generata: Wants/After sul servizio principale e KillMode=process conservato', () => {
  const unit = generateFleetService({
    platform: 'linux', nodeBin: '/usr/bin/node',
    entryPath: '/home/x/repo/bin/nexuscrew.js', repoRoot: '/home/x/repo',
  });
  assert.match(unit, /^Wants=nexuscrew\.service$/m, 'Wants sul servizio principale');
  assert.match(unit, /^After=nexuscrew\.service$/m, 'After sul servizio principale');
  assert.match(unit, /^After=network-online\.target$/m, 'l\'ordine rete esistente resta');
  assert.match(unit, /^KillMode=process$/m, 'KillMode=process conservato');
  assert.ok(!/^(Requires|PartOf|BindsTo)=/m.test(unit), 'nessun aggancio di sopravvivenza');
});
