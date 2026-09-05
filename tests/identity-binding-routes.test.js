'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { notifyRoutes } = require('../lib/notify/routes.js');
const { filesRoutes } = require('../lib/files/routes.js');
const { audioRoutes } = require('../lib/audio/routes.js');
const { leaseRoutes } = require('../lib/fleet/lease-routes.js');
const { cellsRoutes } = require('../lib/cells/routes.js');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createAsksStore } = require('../lib/notify/asks.js');
const { createReceiptStore } = require('../lib/audio/receipt.js');

const LOCAL = 'a'.repeat(32);
const CELL = 'Dev';
const SESSION = `cloud-${CELL}`;
const TARGET_CELL = 'Alpha';
const TARGET_SESSION = `cloud-${TARGET_CELL}`;

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bindingHeader(reg, overrides = {}) {
  const context = {
    version: '1',
    kind: 'mcp-v1',
    verified: true,
    mode: 'shared',
    bindingId: `${CELL}:${reg.proof.incarnationId}`,
    ownerInstanceId: LOCAL,
    cellId: CELL,
    tmuxSession: SESSION,
    connectionId: `${CELL}:${reg.proof.incarnationId}`,
    threadId: reg.proof.incarnationId,
    origin: 'daemon',
    audience: 'nexuscrew-mcp',
    scopes: ['mcp:tools/call'],
    issuedAt: reg.proof.issuedAt,
    notBefore: reg.proof.issuedAt,
    expiresAt: reg.proof.expiresAt,
    ...(overrides.context || {}),
  };
  return {
    'x-nexuscrew-identity-binding': JSON.stringify({
      context,
      proof: reg.proof,
      ...(overrides.extra || {}),
    }),
  };
}

async function makeWorld(t, { identityMode = 'authority' } = {}) {
  const home = tmpdir('nc-binding-routes-');
  const mgr = createLeaseManager({ home, log: () => {} });
  await mgr.track(CELL);
  const reg = mgr.childRegister(CELL, { authority: true });

  const calls = {
    notify: [],
    paste: [],
    submit: [],
    audioEnqueue: [],
    audioStop: [],
    groupSpeak: [],
    groupStop: [],
    leaseRefresh: 0,
    leaseRecovery: 0,
    liveSet: [],
  };

  const leaseFacade = {
    childIntrospect: (...args) => mgr.childIntrospect(...args),
    childRefresh: (...args) => {
      calls.leaseRefresh += 1;
      return mgr.childRefresh(...args);
    },
    childRecovery: (...args) => {
      calls.leaseRecovery += 1;
      return mgr.childRecovery(...args);
    },
    childRegister: (...args) => mgr.childRegister(...args),
  };

  const fleetP = Promise.resolve({
    available: true,
    lease: leaseFacade,
    status: async () => ({
      available: true,
      cells: [
        { cell: CELL, tmuxSession: SESSION, active: true, tmux: true, engine: 'claude', model: '' },
        { cell: TARGET_CELL, tmuxSession: TARGET_SESSION, active: true, tmux: true, engine: 'claude', model: '' },
      ],
    }),
  });

  const notifier = {
    emits: [],
    emit: async (frame) => {
      notifier.emits.push(frame);
      return { ui: 1, push: 0 };
    },
    emitRaw: (frame) => {
      notifier.emits.push(frame);
      return 1;
    },
  };
  const push = {
    sendToAll: async () => ({ sent: 0, removed: 0 }),
    vapidPublicKey: () => 'public-test',
    subscribe: async () => ({ ok: true, count: 1 }),
    unsubscribe: async () => ({ ok: true, removed: 1 }),
  };
  const asks = createAsksStore({ dir: path.join(home, 'asks') });
  const paste = async (session, text) => {
    calls.paste.push([session, text]);
    return true;
  };
  const sessionExists = (session) => session === SESSION;
  const filesRoot = path.join(home, 'files');
  fs.mkdirSync(path.join(filesRoot, SESSION, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(filesRoot, SESSION, 'outbox'), { recursive: true });

  const queue = {
    enqueue: (input) => {
      calls.audioEnqueue.push(input);
      return { status: 'accepted' };
    },
    stop: (utteranceId) => {
      calls.audioStop.push(utteranceId);
      return true;
    },
    stopAll: () => true,
  };
  const groupSpeaker = {
    speakGroup: async (input) => {
      calls.groupSpeak.push(input);
      return { status: 'accepted' };
    },
    stopGroup: async (input) => {
      calls.groupStop.push(input);
      return { status: 'accepted' };
    },
  };
  const originResolver = {
    resolve: async () => ({
      ok: true,
      origin: { node: LOCAL, cell: CELL, attested: false },
      trust: 'local-bridge',
      visited: [],
    }),
  };
  const receiptStore = createReceiptStore();
  // Stop ha senso per un enunciato già ammesso dalla stessa origine. Il fixture
  // lo registra qui per entrambi i mondi, senza falsare lo store di produzione.
  receiptStore.record({
    origin: { node: LOCAL, cell: CELL, attested: false },
    target: LOCAL,
    status: 'accepted',
    utteranceId: 'stop-12345678',
  });
  const submit = async (session, text) => {
    calls.submit.push([session, text]);
    return { submitted: true };
  };
  const liveStore = {
    snapshot: () => ({ hostCell: null, revision: 0 }),
    compareAndSet: async (revision, cellId) => {
      calls.liveSet.push({ revision, cellId });
      return { ok: true, revision: revision + 1, hostCell: cellId };
    },
  };

  const app = express();
  app.use('/api', notifyRoutes({
    cfg: {},
    notifier,
    push,
    asks,
    paste,
    sessionExists,
    fleetP,
    instanceId: () => LOCAL,
    identityMode,
    localNodeId: () => LOCAL,
  }));
  app.use('/api/files', filesRoutes({
    cfg: { filesRoot, home, maxUpload: 1024 * 1024 },
    sessionExists,
    paste,
    notifier,
    readonly: () => false,
    fleetP,
    instanceId: () => LOCAL,
    identityMode,
  }));
  app.use('/api/audio', audioRoutes({
    readonly: () => false,
    localNodeId: () => LOCAL,
    fleetP,
    identityMode,
    originResolver,
    receiptStore,
    queue,
    groupSpeaker,
    consent: () => true,
    getGroup: () => ({ targets: [LOCAL], mode: 'primary-failover' }),
  }));
  app.use('/api/lease', leaseRoutes({
    fleetP,
    readonly: () => false,
    identityMode,
    instanceId: () => LOCAL,
  }));
  app.use('/api/cells', cellsRoutes({
    fleetP,
    instanceId: () => LOCAL,
    submit,
    readonly: () => false,
    identityMode,
  }));
  app.use('/api/live-host', liveHostRoutes({
    fleetP,
    store: liveStore,
    readonly: () => false,
    bridge: null,
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.close();
    try { mgr.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  });

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    home,
    filesRoot,
    asks,
    reg,
    calls,
    notifier,
    leaseFacade,
    liveStore,
    receiptStore,
  };
}

async function postJson(base, apiPath, body, headers = {}) {
  return fetch(`${base}${apiPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('notify: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { title: 'ciao', session: SESSION };

  const neg = await postJson(w.base, '/api/notify', body,
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.notifier.emits.length, 0, 'binding forgiato: nessuna notify');

  const pos = await postJson(w.base, '/api/notify', body, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.notifier.emits.length, 1, 'binding valido: notify emessa');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/notify', body);
  assert.equal(l.status, 200);
  assert.equal(legacy.notifier.emits.length, 1, 'legacy senza binding: notify emessa');
});

test('asks create: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { question: 'procedo?', session: SESSION };

  const neg = await postJson(w.base, '/api/asks', body,
    bindingHeader(w.reg, { context: { tmuxSession: 'cloud-Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.asks.openCount(), 0, 'binding forgiato: nessun ask creato');

  const pos = await postJson(w.base, '/api/asks', body, bindingHeader(w.reg));
  assert.equal(pos.status, 201);
  assert.equal(w.asks.openCount(), 1, 'binding valido: ask creato');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/asks', body);
  assert.equal(l.status, 201);
  assert.equal(legacy.asks.openCount(), 1, 'legacy senza binding: ask creato');
});

test('asks dismiss: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const created = w.asks.create({ question: 'q', session: SESSION });
  const id = created.ask.id;

  const neg = await fetch(`${w.base}/api/asks/${id}`, {
    method: 'DELETE',
    headers: bindingHeader(w.reg, { context: { cellId: 'Ghost' } }),
  });
  assert.equal(neg.status, 403);
  assert.equal(w.asks.get(id).dismissed, false, 'binding forgiato: ask non scartato');

  const pos = await fetch(`${w.base}/api/asks/${id}`, {
    method: 'DELETE',
    headers: bindingHeader(w.reg),
  });
  assert.equal(pos.status, 200);
  assert.equal(w.asks.get(id).dismissed, true, 'binding valido: ask scartato');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const lc = legacy.asks.create({ question: 'q', session: SESSION });
  const l = await fetch(`${legacy.base}/api/asks/${lc.ask.id}`, { method: 'DELETE' });
  assert.equal(l.status, 200);
  assert.equal(legacy.asks.get(lc.ask.id).dismissed, true, 'legacy senza binding: ask scartato');
});

test('asks answer: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const created = w.asks.create({ question: 'q', session: SESSION });
  const id = created.ask.id;

  const neg = await postJson(w.base, `/api/asks/${id}/answer`, { text: 'no' },
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.paste.length, 0, 'binding forgiato: nessun paste');
  assert.equal(w.asks.get(id).answered, false, 'binding forgiato: ask resta aperto');

  const pos = await postJson(w.base, `/api/asks/${id}/answer`, { text: 'sì' },
    bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.paste.length, 1, 'binding valido: paste eseguito');
  assert.equal(w.asks.get(id).answered, true, 'binding valido: ask risposto');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const lc = legacy.asks.create({ question: 'q', session: SESSION });
  const l = await postJson(legacy.base, `/api/asks/${lc.ask.id}/answer`, { text: 'sì' });
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.paste.length, 1, 'legacy senza binding: paste eseguito');
});

test('files upload: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const upload = (w, name, headers = {}) => {
    const fd = new FormData();
    fd.append('session', SESSION);
    fd.append('file', new Blob(['x']), name);
    return fetch(`${w.base}/api/files/upload`, { method: 'POST', headers, body: fd });
  };

  const w = await makeWorld(t, { identityMode: 'authority' });
  const neg = await upload(w, 'neg.txt', bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.paste.length, 0, 'binding forgiato: nessun paste');
  assert.equal(fs.readdirSync(path.join(w.filesRoot, SESSION, 'inbox')).length, 0,
    'binding forgiato: nessun file salvato');

  const pos = await upload(w, 'pos.txt', bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.paste.length, 1, 'binding valido: paste eseguito');
  assert.equal(fs.readdirSync(path.join(w.filesRoot, SESSION, 'inbox')).length, 1,
    'binding valido: file salvato');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await upload(legacy, 'legacy.txt');
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.paste.length, 1, 'legacy senza binding: paste eseguito');
  assert.equal(fs.readdirSync(path.join(legacy.filesRoot, SESSION, 'inbox')).length, 1,
    'legacy senza binding: file salvato');
});

test('files outbox: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const outbox = (w, headers = {}) => {
    const src = path.join(w.home, 'src.txt');
    fs.writeFileSync(src, 'x');
    return postJson(w.base, '/api/files/outbox', { session: SESSION, path: src }, headers);
  };

  const w = await makeWorld(t, { identityMode: 'authority' });
  const neg = await outbox(w, bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(fs.readdirSync(path.join(w.filesRoot, SESSION, 'outbox')).length, 0,
    'binding forgiato: nessun file consegnato');

  const pos = await outbox(w, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(fs.readdirSync(path.join(w.filesRoot, SESSION, 'outbox')).length, 1,
    'binding valido: file consegnato');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await outbox(legacy);
  assert.equal(l.status, 200);
  assert.equal(fs.readdirSync(path.join(legacy.filesRoot, SESSION, 'outbox')).length, 1,
    'legacy senza binding: file consegnato');
});

test('files delete: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const dir = path.join(w.filesRoot, SESSION, 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x.txt');
  fs.writeFileSync(file, 'x');

  const neg = await fetch(`${w.base}/api/files?session=${SESSION}&box=outbox&name=x.txt`, {
    method: 'DELETE',
    headers: bindingHeader(w.reg, { context: { cellId: 'Ghost' } }),
  });
  assert.equal(neg.status, 403);
  assert.equal(fs.existsSync(file), true, 'binding forgiato: file non cancellato');

  const pos = await fetch(`${w.base}/api/files?session=${SESSION}&box=outbox&name=x.txt`, {
    method: 'DELETE',
    headers: bindingHeader(w.reg),
  });
  assert.equal(pos.status, 200);
  assert.equal(fs.existsSync(file), false, 'binding valido: file cancellato');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const ldir = path.join(legacy.filesRoot, SESSION, 'outbox');
  fs.mkdirSync(ldir, { recursive: true });
  const lfile = path.join(ldir, 'y.txt');
  fs.writeFileSync(lfile, 'y');
  const l = await fetch(`${legacy.base}/api/files?session=${SESSION}&box=outbox&name=y.txt`, { method: 'DELETE' });
  assert.equal(l.status, 200);
  assert.equal(fs.existsSync(lfile), false, 'legacy senza binding: file cancellato');
});

test('audio speak: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { target: LOCAL, text: 'ciao' };

  const neg = await postJson(w.base, '/api/audio/speak', body,
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.audioEnqueue.length, 0, 'binding forgiato: nessuna voce');

  const pos = await postJson(w.base, '/api/audio/speak', body, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.audioEnqueue.length, 1, 'binding valido: voce accodata');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/audio/speak', body);
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.audioEnqueue.length, 1, 'legacy senza binding: voce accodata');
});

test('audio stop: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { target: LOCAL, utteranceId: 'stop-12345678' };

  const neg = await postJson(w.base, '/api/audio/stop', body,
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.audioStop.length, 0, 'binding forgiato: nessuno stop');

  const pos = await postJson(w.base, '/api/audio/stop', body, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.audioStop.length, 1, 'binding valido: stop eseguito');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/audio/stop', body);
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.audioStop.length, 1, 'legacy senza binding: stop eseguito');
});

test('audio groups speak: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { group: 'team', text: 'ciao', utteranceId: 'grp-12345678' };

  const neg = await postJson(w.base, '/api/audio/groups/speak', body,
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.groupSpeak.length, 0, 'binding forgiato: nessuna voce di gruppo');

  const pos = await postJson(w.base, '/api/audio/groups/speak', body, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.groupSpeak.length, 1, 'binding valido: voce di gruppo avviata');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/audio/groups/speak', body);
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.groupSpeak.length, 1, 'legacy senza binding: voce di gruppo avviata');
});

test('audio groups stop: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { utteranceId: 'grp-stop-1234' };

  const neg = await postJson(w.base, '/api/audio/groups/stop', body,
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.groupStop.length, 0, 'binding forgiato: nessuno stop di gruppo');

  const pos = await postJson(w.base, '/api/audio/groups/stop', body, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.groupStop.length, 1, 'binding valido: stop di gruppo eseguito');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/audio/groups/stop', body);
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.groupStop.length, 1, 'legacy senza binding: stop di gruppo eseguito');
});

test('lease refresh: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { proof: w.reg.proof, session: SESSION };

  const neg = await postJson(w.base, '/api/lease/refresh', body,
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.leaseRefresh, 0, 'binding forgiato: nessun refresh');

  const pos = await postJson(w.base, '/api/lease/refresh', body, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.leaseRefresh, 1, 'binding valido: refresh eseguito');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/lease/refresh', body);
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.leaseRefresh, 1, 'legacy senza binding: refresh eseguito');
});

test('lease recovery: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { proof: w.reg.proof, session: SESSION };

  const neg = await postJson(w.base, '/api/lease/recovery', body,
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.leaseRecovery, 0, 'binding forgiato: nessun recovery');

  const pos = await postJson(w.base, '/api/lease/recovery', body, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.leaseRecovery, 1, 'binding valido: recovery eseguito');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/lease/recovery', body);
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.leaseRecovery, 1, 'legacy senza binding: recovery eseguito');
});

test('cells send: binding valido consente, forgiato rifiuta senza effetto, legacy resta', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = {
    id: '12345678-1234-1234-1234-123456789abc',
    from: { instanceId: LOCAL, cell: CELL, tmuxSession: SESSION },
    to: { instanceId: LOCAL, cell: TARGET_CELL, tmuxSession: TARGET_SESSION },
    message: 'ciao',
  };

  const neg = await postJson(w.base, '/api/cells/send', body,
    bindingHeader(w.reg, { context: { cellId: 'Ghost' } }));
  assert.equal(neg.status, 403);
  assert.equal(w.calls.submit.length, 0, 'binding forgiato: nessun invio');

  const pos = await postJson(w.base, '/api/cells/send', body, bindingHeader(w.reg));
  assert.equal(pos.status, 200);
  assert.equal(w.calls.submit.length, 1, 'binding valido: invio eseguito');

  const legacy = await makeWorld(t, { identityMode: 'legacy' });
  const l = await postJson(legacy.base, '/api/cells/send', body);
  assert.equal(l.status, 200);
  assert.equal(legacy.calls.submit.length, 1, 'legacy senza binding: invio eseguito');
});

test('live-host è dichiarato fuori dal perimetro binding: il header non cambia l’esito', async (t) => {
  const w = await makeWorld(t, { identityMode: 'authority' });
  const body = { cellId: CELL, expectedRevision: 0 };
  const forged = bindingHeader(w.reg, { context: { cellId: 'Ghost' } });

  const res = await postJson(w.base, '/api/live-host/designate', body, forged);
  assert.equal(res.status, 200, 'la superficie di gestione locale non è gate dal binding MCP');
  assert.equal(w.liveStore.calls ?? w.calls.liveSet.length, w.calls.liveSet.length);
  assert.equal(w.calls.liveSet.length, 1, 'la designazione avviene anche con binding non pertinente');
});
