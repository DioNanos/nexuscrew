'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

// tmux finto: registra le chiamate su file e simula duplicate/missing session.
const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');

function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsl-'));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    tmuxBin: FAKE_TMUX, fleetEnabled: false, ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => {
      server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true });
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
    });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, dir });
  }));
}
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('list: exposes a shared working/status contract including the Pi capture fallback', async (t) => {
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'pi-working';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token } = await boot(t);
  const response = await fetch(`${base}/api/sessions`, { headers: H(token) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].name, 'pi-cell');
  assert.equal(body.sessions[0].paneTitle, 'π - project');
  assert.equal(body.sessions[0].working, true);
  assert.equal(body.sessions[0].status, 'Working...');
  assert.equal(body.sessions[0].preview, 'pi-model footer');
});

test('list: capture fallback cannot mark a non-Pi transcript as working', async (t) => {
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'quoted-working';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token } = await boot(t);
  const response = await fetch(`${base}/api/sessions`, { headers: H(token) });
  const body = await response.json();
  assert.equal(body.sessions[0].paneTitle, 'Dev');
  assert.equal(body.sessions[0].working, false);
  assert.equal(body.sessions[0].status, '');
  assert.equal(body.sessions[0].preview, 'claude-model footer');
});

test('list: pubblica lo stato di attivita della cella; assente = non verificato, mai «ferma»', async (t) => {
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'quoted-working';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token, dir } = await boot(t);
  const leggi = async () => (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  const primo = await leggi();
  const nome = primo.sessions[0].name;
  assert.equal(primo.sessions[0].attivita, null, 'nessun file -> null, non «ferma»');

  const dirSessione = path.join(dir, 'files', nome);
  fs.mkdirSync(dirSessione, { recursive: true });
  // La cella e' LANCIATA: generazione su disco col segno dell'uscita, ed eventi
  // che la dichiarano. Un evento senza generazione non e' leggibile — non e'
  // legato ad alcun lancio — quindi il fixture deve partire da un lancio vero.
  const GEN = 'gen-1';
  fs.writeFileSync(path.join(dirSessione, 'activity.gen'), `${GEN}\nexit:1`);
  const scrivi = (dato) => fs.writeFileSync(path.join(dirSessione, 'activity.json'),
    JSON.stringify({ generation: GEN, ...dato }));

  scrivi({ event: 'UserPromptSubmit', ts: Date.now(), session_id: 's1' });
  const lavoro = await leggi();
  assert.equal(lavoro.sessions[0].attivita.stato, 'lavora');
  assert.equal(lavoro.sessions[0].attivita.sessionId, 's1');
  // Il campo storico non si muove: gli altri consumatori di `working` non
  // cambiano comportamento per questa aggiunta.
  assert.equal(lavoro.sessions[0].working, primo.sessions[0].working);

  scrivi({ event: 'Stop', ts: Date.now() });
  assert.equal((await leggi()).sessions[0].attivita.stato, 'ferma');

  // Un dato di LAVORO vecchio oltre la finestra non diventa «ferma»: sparisce.
  // È la copertura del Ctrl-C, che non emette alcun evento e lascerebbe
  // «lavora» per sempre.
  scrivi({ event: 'UserPromptSubmit', ts: Date.now() - 6 * 60 * 1000 });
  assert.equal((await leggi()).sessions[0].attivita, null, 'scaduto -> non verificato');

  // «Ferma» invece NON scade con l'età: un turno finito resta finito, e la
  // fine del processo è già coperta dalla generazione, non da una finestra.
  scrivi({ event: 'Stop', ts: Date.now() - 6 * 60 * 1000 });
  assert.equal((await leggi()).sessions[0].attivita.stato, 'ferma', '«ferma» non scade');
});

test('list: SUPERVISORE MORTO con una seconda finestra viva → null', async (t) => {
  // Il caso misurato con tmux vero: `#{pane_dead}` della SESSIONE riguarda il
  // pane attivo, quindi con una seconda finestra viva selezionata direbbe
  // «vivo» anche col supervisore morto — e lo `Stop` con `exit:1` di un'ora
  // prima tornerebbe «ferma». La verita' e' il pane MARCATO al lancio.
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'dead-supervisor';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token, dir } = await boot(t);
  const primo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  const nome = primo.sessions[0].name;

  const dirSessione = path.join(dir, 'files', nome);
  fs.mkdirSync(dirSessione, { recursive: true });
  const GEN = 'gen-1';
  fs.writeFileSync(path.join(dirSessione, 'activity.gen'), `${GEN}\nexit:1`);
  fs.writeFileSync(path.join(dirSessione, 'activity.json'),
    JSON.stringify({ event: 'Stop', ts: Date.now() - 60 * 60 * 1000, generation: GEN }));

  const dopo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  assert.equal(dopo.sessions[0].attivita, null,
    'supervisore morto: nessuno stato, nemmeno con una seconda finestra viva');
});

test('list: supervisore VIVO con lo stesso «ferma» exit:1 → ferma', async (t) => {
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'quoted-working';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token, dir } = await boot(t);
  const primo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  const nome = primo.sessions[0].name;
  const dirSessione = path.join(dir, 'files', nome);
  fs.mkdirSync(dirSessione, { recursive: true });
  const GEN = 'gen-1';
  fs.writeFileSync(path.join(dirSessione, 'activity.gen'), `${GEN}\nexit:1`);
  fs.writeFileSync(path.join(dirSessione, 'activity.json'),
    JSON.stringify({ event: 'Stop', ts: Date.now(), generation: GEN }));

  const dopo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  assert.equal(dopo.sessions[0].attivita.stato, 'ferma', 'pane del supervisore vivo: lo stato si legge');
});

test('list: senza marcatore, con `exit:1` nel file (lancio nuovo, marcatura fallita) → null', async (t) => {
  // Un lancio NUOVO in cui la marcatura del pane non e' riuscita: il file porta
  // il segno, quindi il suo `Stop` non scadrebbe mai — e nessuno garantisce il
  // supervisore. Non si legge.
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'unmarked';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token, dir } = await boot(t);
  const primo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  const nome = primo.sessions[0].name;
  const dirSessione = path.join(dir, 'files', nome);
  fs.mkdirSync(dirSessione, { recursive: true });
  const GEN = 'gen-1';
  fs.writeFileSync(path.join(dirSessione, 'activity.gen'), `${GEN}\nexit:1`);
  fs.writeFileSync(path.join(dirSessione, 'activity.json'),
    JSON.stringify({ event: 'Stop', ts: Date.now(), generation: GEN }));

  const dopo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  assert.equal(dopo.sessions[0].attivita, null, 'con exit:1 e nessun marcatore: non si legge');
});

test('list: senza marcatore e SENZA `exit:1` (lancio vecchio) → decide il lettore, 5 minuti', async (t) => {
  // E' la regola che evita la regressione: dopo un aggiornamento, su ogni nodo,
  // le celle vive non devono diventare tutte «non verificate». Un lancio VECCHIO
  // non ha nessuna non-scadenza da proteggere: si legge, e il lettore fa
  // scadere `Stop` a cinque minuti. Il caso peggiore dura cinque minuti.
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'unmarked';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token, dir } = await boot(t);
  const primo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  const nome = primo.sessions[0].name;
  const dirSessione = path.join(dir, 'files', nome);
  fs.mkdirSync(dirSessione, { recursive: true });
  const GEN = 'gen-1';
  fs.writeFileSync(path.join(dirSessione, 'activity.gen'), GEN);   // una riga: lancio vecchio
  const scrivi = (ts) => fs.writeFileSync(path.join(dirSessione, 'activity.json'),
    JSON.stringify({ event: 'Stop', ts, generation: GEN }));

  scrivi(Date.now());
  const fresco = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  assert.equal(fresco.sessions[0].attivita.stato, 'ferma', 'fresco: si legge');

  scrivi(Date.now() - 60 * 60 * 1000);
  const vecchio = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  assert.equal(vecchio.sessions[0].attivita, null, 'dopo un\'ora: scaduto, non «ferma» per sempre');
});

test('create: 201 con preset shell, 400 nome/preset invalidi', async (t) => {
  const { base, token } = await boot(t);
  const home = os.homedir();
  const ok = await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'w1', cwd: home, preset: 'shell' }) });
  assert.equal(ok.status, 201);
  assert.deepEqual(await ok.json(), { created: true, name: 'w1' });
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: '-bad', cwd: home }) })).status, 400);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'cloud-Fake', cwd: home, preset: 'shell' }) })).status, 409, 'namespace cloud-* riservato anche in create');
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'w2', cwd: home, preset: 'rm -rf' }) })).status, 400);
});

test('create: alternateScreen viene applicato solo alla nuova sessione PWA, con hook per le finestre successive', async (t) => {
  const { base, token, dir } = await boot(t, { alternateScreen: false });
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ name: 'web-scroll', cwd: os.homedir(), preset: 'shell' }),
  });
  assert.equal(response.status, 201);
  const log = fs.readFileSync(path.join(dir, 'tmux.log'), 'utf8');
  assert.match(log, /set-option -t =web-scroll: -w alternate-screen off/);
  assert.match(log, /set-hook -t =web-scroll: after-new-window set-option -w alternate-screen off/);
  assert.doesNotMatch(log, /set-option -g .*alternate-screen/);
});

test('create: alternateScreen=true non emette policy PWA e un errore best-effort non blocca 201', async (t) => {
  const optedOut = await boot(t, { alternateScreen: true });
  const skipped = await fetch(`${optedOut.base}/api/sessions`, {
    method: 'POST', headers: H(optedOut.token), body: JSON.stringify({ name: 'web-standard', cwd: os.homedir(), preset: 'shell' }),
  });
  assert.equal(skipped.status, 201);
  assert.doesNotMatch(fs.readFileSync(path.join(optedOut.dir, 'tmux.log'), 'utf8'), /alternate-screen/);

  const warnings = [];
  const bestEffort = await boot(t, { alternateScreen: false, log: (message) => warnings.push(message) });
  const created = await fetch(`${bestEffort.base}/api/sessions`, {
    method: 'POST', headers: H(bestEffort.token), body: JSON.stringify({ name: 'web-best-effort', cwd: os.homedir(), preset: 'shell' }),
  });
  assert.equal(created.status, 201);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((message) => message === 'session alternate-screen setup failed for web-best-effort; continuing'));
});

test('kill: 409 su cloud-* ANCHE con fleet unavailable (F2), 200 su generica, 404 su assente', async (t) => {
  const { base, token } = await boot(t);
  assert.equal((await fetch(`${base}/api/sessions/cloud-Build`, { method: 'DELETE', headers: H(token) })).status, 409);
  assert.equal((await fetch(`${base}/api/sessions/w1`, { method: 'DELETE', headers: H(token) })).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/ghost`, { method: 'DELETE', headers: H(token) })).status, 404);
});

test('READONLY is a destination floor for direct session create and kill', async (t) => {
  const { base, token } = await boot(t, { readonlyDefault: true });
  const create = await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'blocked', cwd: os.homedir(), preset: 'shell' }) });
  assert.equal(create.status, 403);
  assert.equal((await fetch(`${base}/api/sessions/w1`, { method: 'DELETE', headers: H(token) })).status, 403);
  assert.equal((await fetch(`${base}/api/sessions/w1/visibility`, { method: 'PATCH', headers: H(token), body: JSON.stringify({ technical: true }) })).status, 403);
});

test('visibility marks only unmanaged sessions using explicit tmux metadata', async (t) => {
  const { base, token, dir } = await boot(t);
  const marked = await fetch(`${base}/api/sessions/w1/visibility`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ technical: true }),
  });
  assert.equal(marked.status, 200);
  assert.deepEqual(await marked.json(), { name: 'w1', technical: true });
  assert.match(fs.readFileSync(path.join(dir, 'tmux.log'), 'utf8'), /set-option -t =w1 @nexuscrew_visibility technical/);
  assert.equal((await fetch(`${base}/api/sessions/cloud-Build/visibility`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ technical: true }),
  })).status, 409, 'managed namespace cannot be hidden as an unmanaged technical session');
});

test('destination READONLY also wins through the compatible /node path', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsl-node-ro-'));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const dest = createServer({ home: dir, tokenPath: path.join(dir, 'dest-token'), nodesPath: path.join(dir, 'dest-nodes.json'), filesRoot: path.join(dir, 'dest-files'), tmuxBin: FAKE_TMUX, fleetEnabled: false, readonlyDefault: true });
  await new Promise((resolve) => dest.server.listen(0, '127.0.0.1', resolve));
  const rootNodes = path.join(dir, 'root-nodes.json');
  let st = nodesStore.emptyStore('a'.repeat(32));
  st = nodesStore.addNode(st, { name: 'dest', ssh: 'dest', remotePort: dest.server.address().port, localPort: dest.server.address().port, direction: 'outbound', transport: 'ssh', autostart: false, visibility: 'network', nodeId: 'b'.repeat(32), token: dest.token, acceptToken: 'dest-back' });
  nodesStore.atomicWriteStore(rootNodes, st);
  const root = createServer({ home: dir, tokenPath: path.join(dir, 'root-token'), nodesPath: rootNodes, filesRoot: path.join(dir, 'root-files'), tmuxBin: FAKE_TMUX, fleetEnabled: false });
  await new Promise((resolve) => root.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { root.server.close(); dest.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${root.server.address().port}`;
  const headers = H(root.token);
  assert.equal((await fetch(`${base}/node/dest/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ name: 'blocked', cwd: os.homedir(), preset: 'shell' }) })).status, 403);
  assert.equal((await fetch(`${base}/node/dest/api/sessions/w1`, { method: 'DELETE', headers })).status, 403);
});
