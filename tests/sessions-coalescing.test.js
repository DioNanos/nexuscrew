'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

// Coalescing di /api/sessions: la finestra di una UI colpirà l'endpoint ogni
// 4 s per pannello in più (fino a ieri) e ogni nodo serve più client. Il
// contratto qui è a spese ZERO di freschezza percepita: entro la finestra di
// coalescing (2 s) le letture vicine diventano UNA serie di spawn tmux — una
// sola list-panes con dentro anche i campi sessione, nessuna list-sessions —
// e la risposta è la stessa per tutti. Oltre la finestra, il cambiamento di
// tmux DEVE tornare visibile: la cache serve la finestra, non il secolo.
const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');

function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsc-'));
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

function spawnCounts(dir) {
  const lines = fs.readFileSync(path.join(dir, 'tmux.log'), 'utf8').split('\n');
  return {
    listPanes: lines.filter((l) => l.startsWith('list-panes')).length,
    listSessions: lines.filter((l) => l.startsWith('list-sessions')).length,
  };
}

const resetLog = (dir) => { fs.writeFileSync(path.join(dir, 'tmux.log'), ''); };

test('due letture vicine: una sola series di spawn tmux, stessa risposta', async (t) => {
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'pi-working';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token, dir } = await boot(t);
  const prima = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  resetLog(dir);
  const seconda = await fetch(`${base}/api/sessions`, { headers: H(token) });
  const corpo = await seconda.json();
  const counts = spawnCounts(dir);
  // La seconda lettura, dentro la finestra, serve la risposta pronta: ZERO
  // spawn. E NESSUNA list-sessions: le sessioni arrivano dalla stessa
  // list-panes del giro originario.
  assert.equal(counts.listPanes, 0);
  assert.equal(counts.listSessions, 0);
  assert.deepEqual(corpo, prima);
  assert.equal(corpo.sessions.length, 1);
  assert.equal(corpo.sessions[0].name, 'pi-cell');
});

test('burst parallelo di letture: chi arriva mentre il giro e in volo aspetta quello', async (t) => {
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'pi-working';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token, dir } = await boot(t);
  resetLog(dir);
  const [a, b] = await Promise.all([
    fetch(`${base}/api/sessions`, { headers: H(token) }),
    fetch(`${base}/api/sessions`, { headers: H(token) }),
  ]);
  const corpoA = await a.json();
  const corpoB = await b.json();
  const counts = spawnCounts(dir);
  assert.equal(counts.listPanes, 1);
  assert.equal(counts.listSessions, 0);
  assert.deepEqual(corpoA, corpoB);
});

test('oltre la finestra di coalescing il cambiamento di tmux torna visibile', async (t) => {
  // Cache corta (100 ms) per non dormire nel test: il contratto e' sulla
  // finestra, non sulla durata dell'attesa.
  process.env.FAKE_TMUX_SESSIONS_STATE = 'a';
  const { base, token, dir } = await boot(t, { sessionsCacheMs: 100 });
  const prima = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  assert.equal(prima.sessions.length, 1);
  assert.equal(prima.sessions[0].name, 'cell-a');
  // tmux cambia sotto la cache (nuova sessione al posto della vecchia).
  process.env.FAKE_TMUX_SESSIONS_STATE = 'b';
  await new Promise((r) => setTimeout(r, 150));
  resetLog(dir);
  const dopo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  assert.equal(dopo.sessions.length, 1);
  assert.equal(dopo.sessions[0].name, 'cell-b');
  t.after(() => { delete process.env.FAKE_TMUX_SESSIONS_STATE; });
});

test('la riga sessione viene dal pane ATTIVO, non dal primo pane della lista', async (t) => {
  // dead-supervisor: il primo pane e' il supervisore morto (titolo diverso),
  // la riga sessione deve parlare col pane attivo della seconda finestra —
  // lo stesso pane a cui si rivolgevano i formati di list-sessions.
  process.env.FAKE_TMUX_ACTIVITY_MODE = 'dead-supervisor';
  t.after(() => { delete process.env.FAKE_TMUX_ACTIVITY_MODE; });
  const { base, token } = await boot(t);
  const corpo = await (await fetch(`${base}/api/sessions`, { headers: H(token) })).json();
  assert.equal(corpo.sessions.length, 1);
  assert.equal(corpo.sessions[0].name, 'claude-dead');
  assert.equal(corpo.sessions[0].paneTitle, 'Dev');
});
