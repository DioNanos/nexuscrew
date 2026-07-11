'use strict';
// MCP bridge — API notify/push/eventi (lib/notify/*). Server REALE (createServer)
// con path isolati in tmp: notifyDir deriva dal dirname del tokenPath, quindi
// vapid.json/push.json non toccano MAI la home reale. web-push SEMPRE mockato
// (webpushImpl iniettato): nessuna chiamata di rete.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { createServer } = require('../lib/server.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncntf-')); }

// webpush finto: comportamento per-endpoint (ok di default, statusCode se mappato).
function fakeWebpush(behavior = {}) {
  const sent = [];
  return {
    sent,
    generateVAPIDKeys: () => ({ publicKey: 'pub-test', privateKey: 'priv-test' }),
    sendNotification: async (sub, payload, options) => {
      const outcome = behavior[sub.endpoint];
      if (typeof outcome === 'number') { const e = new Error(`push ${outcome}`); e.statusCode = outcome; throw e; }
      if (outcome && typeof outcome === 'object') return outcome;
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
      return { statusCode: 201, options };
    },
  };
}

async function startSrv(t, extra = {}) {
  const dir = tmpdir();
  const webpush = extra.webpush || fakeWebpush(extra.pushBehavior);
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'),
    filesRoot: path.join(dir, 'files'),
    fleetEnabled: false,
    readonlyDefault: extra.readonlyDefault === true,
    webpushImpl: webpush,
    // Nessuna rete nei test: ogni hostname finto risolve a un IP pubblico.
    pushLookupImpl: extra.pushLookupImpl || (async () => [{ address: '93.184.216.34', family: 4 }]),
    ...(extra.pushMaxSubs ? { pushMaxSubs: extra.pushMaxSubs } : {}),
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    if (watcher) watcher.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = (p, opts = {}) => fetch(`${base}${p}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  return { base, token, dir, j, webpush };
}

function mode(p) { return fs.statSync(p).mode & 0o777; }

const SUB_A = { endpoint: 'https://push.example/a', keys: { p256dh: 'k1', auth: 'a1' } };
const SUB_B = { endpoint: 'https://push.example/b', keys: { p256dh: 'k2', auth: 'a2' } };

test('notify: 401 senza token, validazione strict, delivered', async (t) => {
  const { base, j } = await startSrv(t);
  // auth: senza Bearer -> 401
  assert.equal((await fetch(`${base}/api/notify`, { method: 'POST' })).status, 401);
  // titolo mancante / chiave estranea / urgency invalida -> 400
  assert.equal((await j('/api/notify', { method: 'POST', body: JSON.stringify({}) })).status, 400);
  assert.equal((await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'x', nope: 1 }) })).status, 400);
  assert.equal((await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'x', urgency: 'urgent' }) })).status, 400);
  // body JSON rotto -> 400 con causa (mai crash)
  assert.equal((await j('/api/notify', { method: 'POST', body: '{{{' })).status, 400);
  // ok: nessuna UI connessa, nessuna subscription -> delivered 0/0
  const r = await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'ciao', body: 'dettaglio' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { delivered: { ui: 0, push: 0 } });
});

// F1 (audit): il campo `session` e' controllato dal chiamante e NON puo' essere
// il confine di sicurezza. Il limite e' GLOBALE per principal/token (l'unico
// Bearer identifica l'installazione): cambiare session NON apre un bucket nuovo.
test('notify F1: rate-limit globale per token — session diverse non bypassano', async (t) => {
  const { j } = await startSrv(t);
  for (let i = 0; i < 6; i += 1) {
    const r = await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: `n${i}`, session: `cell-s${i}` }) });
    assert.equal(r.status, 200, `notify ${i} deve passare`);
  }
  // settima con session MAI vista -> 429 comunque (bucket globale per token)
  const blocked = await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'n7', session: 'cell-fresh' }) });
  assert.equal(blocked.status, 429);
  // anche senza session (sender 'unknown') -> 429
  const blocked2 = await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'n8' }) });
  assert.equal(blocked2.status, 429);
});

// F1: la mappa dei bucket per-sessione ha un cap duro con evizione LRU
// deterministica — nomi sempre nuovi non fanno crescere la memoria.
test('notify F1: cap sulla mappa dei bucket (LRU, niente crescita illimitata)', () => {
  const { createRateLimiter } = require('../lib/notify/routes.js');
  let now = 1000;
  const rl = createRateLimiter({ max: 2, windowMs: 60000, maxBuckets: 3, now: () => now });
  for (let i = 0; i < 10; i += 1) assert.equal(rl.allow(`key-${i}`), true);
  assert.ok(rl.size() <= 3, `size ${rl.size()} deve restare <= maxBuckets (3)`);
  // il limite continua a valere sul bucket vivo
  assert.equal(rl.allow('key-9'), true);
  assert.equal(rl.allow('key-9'), false);
  // finestra scaduta: i bucket morti vengono potati
  now += 61000;
  assert.equal(rl.allow('fresh'), true);
  assert.equal(rl.size(), 1);
});

// F4 (audit): file segreti preesistenti con mode/owner insicuro o symlink sono
// RIFIUTATI fail-closed (mai riparati in silenzio); i file 0600 regolari passano.
test('persist F4: mode 0644 e symlink rifiutati, 0600 ok, assente -> {}', () => {
  const { readJsonSafe, atomicWriteJson } = require('../lib/notify/persist.js');
  const dir = tmpdir();

  const ok = path.join(dir, 'ok.json');
  atomicWriteJson(ok, { a: 1 });
  assert.deepEqual(readJsonSafe(ok), { a: 1 });

  const loose = path.join(dir, 'loose.json');
  fs.writeFileSync(loose, '{"secret":1}', { mode: 0o644 });
  assert.throws(() => readJsonSafe(loose), /permessi|mode/i, 'mode 0644 deve essere rifiutato');
  // fail-closed, NON riparato: il mode resta quello trovato
  assert.equal(fs.statSync(loose).mode & 0o777, 0o644);

  const link = path.join(dir, 'link.json');
  fs.symlinkSync(ok, link);
  assert.throws(() => readJsonSafe(link), /symlink/i, 'symlink deve essere rifiutato');

  assert.deepEqual(readJsonSafe(path.join(dir, 'assente.json')), {});
});

// F4 integrato: vapid.json preesistente 0644 -> l'API rifiuta (500), non lo usa.
test('persist F4: vapid.json 0644 preesistente -> errore fail-closed dalla API', async (t) => {
  const { j, dir } = await startSrv(t);
  fs.writeFileSync(path.join(dir, 'vapid.json'),
    JSON.stringify({ publicKey: 'pub-x', privateKey: 'priv-x' }), { mode: 0o644 });
  const r = await j('/api/push/vapid');
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.match(body.error, /permessi|mode/i);
  assert.ok(!body.error.includes('priv-x'), 'la privata non deve mai comparire negli errori');
});

test('vapid: generazione lazy, chiave pubblica esposta, file 0600', async (t) => {
  const { j, dir } = await startSrv(t);
  const vapidPath = path.join(dir, 'vapid.json');
  assert.ok(!fs.existsSync(vapidPath), 'vapid.json NON deve esistere prima del primo uso');
  const r = await j('/api/push/vapid');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { publicKey: 'pub-test' });
  assert.equal(mode(vapidPath), 0o600);
  // la chiave privata non esce mai dall'API
  const raw = JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  assert.equal(raw.privateKey, 'priv-test');
});

test('push subscribe/unsubscribe: persistenza 0600, dedup per endpoint', async (t) => {
  const { j, dir } = await startSrv(t);
  const subsPath = path.join(dir, 'push.json');

  const r1 = await j('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB_A }) });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { subscribed: true, count: 1 });
  assert.equal(mode(subsPath), 0o600);

  // dedup: stesso endpoint -> sempre 1
  const r2 = await j('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB_A }) });
  assert.deepEqual(await r2.json(), { subscribed: true, count: 1 });

  // subscription malformata -> 400 fail-closed
  const bad = await j('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: { endpoint: 'ftp://x' } }) });
  assert.equal(bad.status, 400);

  const del = await j('/api/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: SUB_A.endpoint }) });
  assert.deepEqual(await del.json(), { removed: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(subsPath, 'utf8')).subscriptions, []);
});

test('push send: mock web-push, endpoint 410 rimosso, delivered.push conta i successi', async (t) => {
  const { j, dir, webpush } = await startSrv(t, {
    pushBehavior: { [SUB_A.endpoint]: 410 }, // A morto, B ok
  });
  await j('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB_A }) });
  await j('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB_B }) });

  const r = await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'push!', session: 'cell-p' }) });
  const out = await r.json();
  assert.equal(out.delivered.push, 1, 'solo B riceve');
  assert.equal(webpush.sent.length, 1);
  assert.equal(webpush.sent[0].endpoint, SUB_B.endpoint);
  assert.equal(webpush.sent[0].payload.title, 'push!');
  // la subscription morta (410) e' stata rimossa dallo store
  const left = JSON.parse(fs.readFileSync(path.join(dir, 'push.json'), 'utf8')).subscriptions;
  assert.deepEqual(left.map((s) => s.endpoint), [SUB_B.endpoint]);
});

test('READONLY: subscribe/unsubscribe bloccati (403), notify resta permesso', async (t) => {
  const { j } = await startSrv(t, { readonlyDefault: true });
  const sub = await j('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: SUB_A }) });
  assert.equal(sub.status, 403);
  const del = await j('/api/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: SUB_A.endpoint }) });
  assert.equal(del.status, 403);
  // notify e' un canale informativo verso l'operatore: non gated
  const r = await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'info' }) });
  assert.equal(r.status, 200);
});

// F3 (audit): READONLY e' un floor — GET vapid non deve GENERARE nulla (503 se
// mancano le chiavi, 200 solo su chiavi gia' esistenti), outbox e' gated 403,
// e il cleanup delle subscription morte NON riscrive push.json.
test('READONLY F3: vapid non genera (503 senza file, 200 con file preesistente)', async (t) => {
  const { j, dir } = await startSrv(t, { readonlyDefault: true });
  const vapidPath = path.join(dir, 'vapid.json');
  const r = await j('/api/push/vapid');
  assert.equal(r.status, 503);
  assert.ok(!fs.existsSync(vapidPath), 'in READONLY vapid.json NON deve nascere');
  // chiavi gia' presenti (0600): la lettura pura resta permessa
  fs.writeFileSync(vapidPath, JSON.stringify({ publicKey: 'pub-pre', privateKey: 'priv-pre' }), { mode: 0o600 });
  const r2 = await j('/api/push/vapid');
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { publicKey: 'pub-pre' });
});

test('READONLY F3: POST /api/files/outbox gated 403 (nessuna copia)', async (t) => {
  const { j, dir } = await startSrv(t, { readonlyDefault: true });
  const src = path.join(dir, 'doc.txt');
  fs.writeFileSync(src, 'x');
  const r = await j('/api/files/outbox', {
    method: 'POST', body: JSON.stringify({ session: 'cell-a', path: src }),
  });
  assert.equal(r.status, 403);
  assert.ok(!fs.existsSync(path.join(dir, 'files')), 'nessun file copiato in READONLY');
});

test('READONLY F3: notify consegnata ma cleanup subscription morte NON riscrive push.json', async (t) => {
  const { j, dir, webpush } = await startSrv(t, {
    readonlyDefault: true,
    pushBehavior: { [SUB_A.endpoint]: 410 }, // A morto, B ok
  });
  // stato preesistente scritto fuori banda (0600): chiavi + 2 subscription
  fs.writeFileSync(path.join(dir, 'vapid.json'),
    JSON.stringify({ publicKey: 'pub-pre', privateKey: 'priv-pre' }), { mode: 0o600 });
  const subsPath = path.join(dir, 'push.json');
  fs.writeFileSync(subsPath, JSON.stringify({ subscriptions: [SUB_A, SUB_B] }), { mode: 0o600 });
  const before = fs.readFileSync(subsPath, 'utf8');

  const r = await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'ro-push' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).delivered.push, 1, 'B riceve comunque');
  assert.equal(webpush.sent[0].endpoint, SUB_B.endpoint);
  // push.json INVARIATO: il cleanup persistente e' una scrittura, vietata in READONLY
  assert.equal(fs.readFileSync(subsPath, 'utf8'), before);
});

// F7 (audit): SSRF — endpoint push SOLO https, niente loopback/reti private,
// DNS verificato e connessione pinning sull'IP risolto, cap subscription.
test('push F7: endpoint http/loopback/privati rifiutati, cap subscription', async (t) => {
  const { j } = await startSrv(t, { pushMaxSubs: 2 });
  const mk = (endpoint) => ({ endpoint, keys: { p256dh: 'k', auth: 'a' } });
  const post = (sub) => j('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });

  assert.equal((await post(mk('http://push.example/x'))).status, 400, 'http:// rifiutato');
  assert.equal((await post(mk('https://127.0.0.1:9/internal'))).status, 400, 'loopback rifiutato');
  assert.equal((await post(mk('https://localhost/x'))).status, 400, 'localhost rifiutato');
  assert.equal((await post(mk('https://192.168.1.10/x'))).status, 400, 'rete privata rifiutata');
  assert.equal((await post(mk('https://10.0.0.5/x'))).status, 400, 'rete privata rifiutata');
  assert.equal((await post(mk('https://[::1]/x'))).status, 400, 'loopback v6 rifiutato');
  assert.equal((await post(mk('https://[fe90::1]/x'))).status, 400, 'tutto fe80::/10 rifiutato');
  assert.equal((await post(mk('https://[febf::1]/x'))).status, 400, 'limite alto fe80::/10 rifiutato');
  assert.equal((await post(mk('https://[fc00::1]/x'))).status, 400, 'ULA rifiutato');
  assert.equal((await post(mk('https://[::ffff:127.0.0.1]/x'))).status, 400, 'IPv4-mapped rifiutato');
  assert.equal((await post(mk('https://[64:ff9b::7f00:1]/x'))).status, 400, 'NAT64 IPv4-in-IPv6 rifiutato');
  assert.equal((await post(mk('https://[2002:7f00:1::]/x'))).status, 400, '6to4 IPv4-in-IPv6 rifiutato');
  assert.equal((await post(mk('https://[fec0::1]/x'))).status, 400, 'site-local deprecato rifiutato');
  assert.equal((await post(mk('https://user:pass@push.example/x'))).status, 400, 'credenziali URL rifiutate');
  assert.equal((await post(mk(`https://push.example/${'a'.repeat(3000)}`))).status, 400, 'URL oltre lunghezza max');

  // cap numero subscription (pushMaxSubs=2): la terza NUOVA -> 429
  assert.equal((await post(SUB_A)).status, 200);
  assert.equal((await post(SUB_B)).status, 200);
  assert.equal((await post(mk('https://push.example/c'))).status, 429);
  // il re-subscribe di un endpoint gia' noto NON conta come nuova
  assert.equal((await post(SUB_A)).status, 200);
});

test('push F7: DNS privato fail-closed e redirect non seguito', async (t) => {
  const privateDns = await startSrv(t, {
    pushLookupImpl: async () => [{ address: '10.23.4.5', family: 4 }],
  });
  const denied = await privateDns.j('/api/push/subscribe', {
    method: 'POST', body: JSON.stringify({ subscription: SUB_A }),
  });
  assert.equal(denied.status, 400, 'hostname che risolve privato deve essere rifiutato');
  assert.match((await denied.json()).error, /DNS|privat|global/i);

  const redirect = await startSrv(t, {
    webpush: fakeWebpush({ [SUB_A.endpoint]: { statusCode: 302, headers: { location: 'https://127.0.0.1/private' } } }),
  });
  assert.equal((await redirect.j('/api/push/subscribe', {
    method: 'POST', body: JSON.stringify({ subscription: SUB_A }),
  })).status, 200);
  const sent = await redirect.j('/api/notify', {
    method: 'POST', body: JSON.stringify({ title: 'no redirect' }),
  });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).delivered.push, 0, '3xx non deve contare come consegna');
  assert.equal(redirect.webpush.sent.length, 0, 'redirect non seguito');
});

test('push F7: DNS ri-verificato al send e https.Agent pinna solo IP verificati', async (t) => {
  let lookups = 0;
  const srv = await startSrv(t, {
    pushLookupImpl: async () => {
      lookups += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });
  assert.equal((await srv.j('/api/push/subscribe', {
    method: 'POST', body: JSON.stringify({ subscription: SUB_A }),
  })).status, 200);
  assert.equal((await srv.j('/api/notify', {
    method: 'POST', body: JSON.stringify({ title: 'pinned' }),
  })).status, 200);
  assert.equal(lookups, 2, 'subscribe + send devono risolvere indipendentemente');
  const agent = srv.webpush.sent[0].options.agent;
  assert.ok(agent instanceof https.Agent);
  const pinned = await new Promise((resolve, reject) => {
    agent.options.lookup('push.example', {}, (e, address, family) => (e ? reject(e) : resolve({ address, family })));
  });
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
});

test('SSE /api/events: 401 senza token, frame notify alle UI connesse', async (t) => {
  const { base, token, j } = await startSrv(t);
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
  assert.equal((await fetch(`${base}/api/events?token=nope`)).status, 401);

  const es = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`);
  assert.equal(es.status, 200);
  assert.match(es.headers.get('content-type'), /text\/event-stream/);
  const reader = es.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const dec = new TextDecoder();
  let buf = '';
  async function nextData() {
    for (;;) {
      const m = buf.match(/data: (.*)\n\n/);
      if (m) { buf = buf.slice(m.index + m[0].length); return JSON.parse(m[1]); }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream chiuso');
      buf += dec.decode(value, { stream: true });
    }
  }

  const r = await j('/api/notify', { method: 'POST', body: JSON.stringify({ title: 'evento', session: 'cell-sse' }) });
  assert.deepEqual((await r.json()).delivered, { ui: 1, push: 0 });
  const frame = await nextData();
  assert.equal(frame.type, 'notify');
  assert.equal(frame.title, 'evento');
  assert.equal(frame.session, 'cell-sse');
  assert.equal(frame.urgency, 'normal');
});
