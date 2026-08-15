'use strict';
// tests/panel-origin.test.js — P0 sicurezza (2026-08-16): il pannello vive su
// una PORTA SUA, non sulla stessa origin del control plane. La proprieta' che
// conta: un documento montato nel frame non deve poter leggere ne' scrivere le
// credenziali del control plane. Con porte diverse questo e' garantito dal
// browser (Same-Origin Policy: la porta fa parte dell'origin) — cio' che qui
// si verifica e' la CONDIZIONE strutturale che rende vera quella garanzia:
// due listener DISTINTI, e la porta pannello senza NULLA da rubare (nessuna
// API di controllo, nessun Bearer verificato).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../lib/server.js');

const TOKEN = 'origin-separata';

{
  const tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-panel-origin-tmux-'));
  process.env.TMUX_TMPDIR = tmuxDir;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
}

// fetch() (undici) tiene i socket keep-alive aperti: senza chiuderli a forza,
// server.close() aspetta connessioni che non si chiuderanno mai da sole
// (stesso rimedio di ws-preauth.test.js/notify-api.test.js).
function chiudi(srv) {
  srv.closeAllConnections?.();
  return new Promise((r) => srv.close(r));
}

// Un pannello finto vero (socket reale): registra cio' che riceve, cosi' i
// test negativi sui dati inoltrati provano dal lato del container.
async function pannelloFinto() {
  const seen = { requests: [] };
  const server = http.createServer((req, res) => {
    seen.requests.push({ url: req.url, headers: { ...req.headers } });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>pannello vero</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, seen, close: () => chiudi(server) };
}

function homeConCella(panelUrl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-panel-origin-'));
  const home = path.join(root, 'home');
  const state = path.join(home, '.nexuscrew');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(state, 'config.json'),
    JSON.stringify({ bind: '127.0.0.1', port: 0, panelPort: 0, fleetEnabled: true, autoUpdate: false }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(state, 'fleet.json'), JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'dummy', label: 'Dummy', command: 'sleep', args: ['1'], promptMode: 'send-keys' }],
    cells: [{ id: 'grafica', cwd: root, engine: 'dummy', tmuxSession: 'cloud-grafica', panelUrl }],
  }), { mode: 0o600 });
  return { root, home, state };
}

// `onListen(srv)` viene chiamato SUBITO dopo ogni singolo listen riuscito, cosi'
// il chiamante puo' registrare t.after per QUELLA risorsa prima di procedere:
// se il passo successivo lancia (es. panelServer non ancora esposto — e'
// proprio il rosso che questo file deve dimostrare), quanto e' gia' partito
// resta comunque tracciato dal chiamante e non diventa un handle orfano.
async function serverDiProva(panelUrl, onListen) {
  const p = homeConCella(panelUrl);
  const made = createServer({
    home: p.home, configDir: p.state, configPath: path.join(p.state, 'config.json'),
    nodesPath: path.join(p.state, 'nodes.json'), tokenPath: path.join(p.state, 'token'),
    filesRoot: path.join(p.root, 'files'),
    bind: '127.0.0.1', port: 0, panelPort: 0, autoPort: false, autoUpdate: false, fleetEnabled: true,
    log: () => {},
    settingsSeams: {
      platform: 'linux', fetchImpl: fetch, pairDelay: async () => {},
      stopTunnelImpl: () => ({ stopped: true }),
      startForwardImpl: () => ({ started: true, transport: 'panel-origin-test' }),
      readTunnelDiagnostic: () => ({ detail: 'panel origin test: tunnel non usato' }),
    },
  });
  await new Promise((resolve, reject) => { made.server.once('error', reject); made.server.listen(0, '127.0.0.1', resolve); });
  onListen(made.server);
  assert.ok(made.panelServer, 'createServer deve esporre un secondo server per il pannello');
  await new Promise((resolve, reject) => { made.panelServer.once('error', reject); made.panelServer.listen(0, '127.0.0.1', resolve); });
  onListen(made.panelServer);
  return { ...p, port: made.server.address().port, panelPort: made.panelServer.address().port, made };
}

async function chiediTicket(base, cell = 'grafica') {
  const r = await fetch(`${base}/api/panel/${cell}/ticket`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200, 'emissione ticket sul control plane, invariata');
  return (await r.json()).ticket;
}

// Ogni test registra t.after per il pannello finto PRIMA di chiamare
// serverDiProva, e passa un onListen che registra t.after per ogni server
// man mano che parte: un fallimento a meta' setup chiude tutto ugualmente,
// mai un'attesa infinita al posto di un rosso.
function harness(t) {
  const registrati = [];
  t.after(async () => { for (const srv of registrati.splice(0).reverse()) await chiudi(srv); });
  return (srv) => registrati.push(srv);
}

test('createServer espone panelServer come listener DISTINTO dal control plane (porta diversa)', async (t) => {
  const onListen = harness(t);
  const panel = await pannelloFinto(); onListen(panel.server);
  const s = await serverDiProva(`http://127.0.0.1:${panel.port}`, onListen);
  assert.notEqual(s.panelPort, s.port, 'due porte diverse: e\' questo che rende l\'origin diversa per il browser');
});

test('la porta pannello serve il consumo: ticket valido -> il contenuto del pannello arriva', async (t) => {
  const onListen = harness(t);
  const panel = await pannelloFinto(); onListen(panel.server);
  const s = await serverDiProva(`http://127.0.0.1:${panel.port}`, onListen);
  const ticket = await chiediTicket(`http://127.0.0.1:${s.port}`);
  const r = await fetch(`http://127.0.0.1:${s.panelPort}/panel/grafica/?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(r.status, 200, 'il ticket consumato sulla porta pannello raggiunge davvero il contenuto');
  assert.match(await r.text(), /pannello vero/);
});

test('DIFETTO CHIUSO: la porta pannello non ha nessuna API di controllo — /api/* non risponde con dati', async (t) => {
  const onListen = harness(t);
  const panel = await pannelloFinto(); onListen(panel.server);
  const s = await serverDiProva(`http://127.0.0.1:${panel.port}`, onListen);
  // Con Bearer valido: se questa porta avesse anche solo un'eco dell'API del
  // control plane, il Bearer la aprirebbe. Deve fallire comunque — la porta
  // pannello non monta l'API, punto: non e' una questione di credenziali.
  const r = await fetch(`http://127.0.0.1:${s.panelPort}/api/sessions`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.notEqual(r.status, 200, 'nessuna API di controllo raggiungibile sulla porta pannello');
});

test('DIFETTO CHIUSO: la porta pannello non serve la SPA — niente app da imitare o dirottare', async (t) => {
  const onListen = harness(t);
  const panel = await pannelloFinto(); onListen(panel.server);
  const s = await serverDiProva(`http://127.0.0.1:${panel.port}`, onListen);
  const r = await fetch(`http://127.0.0.1:${s.panelPort}/`);
  const body = await r.text().catch(() => '');
  assert.ok(!/<div id="root"|NexusCrew/i.test(body), 'la porta pannello non serve mai la SPA dell\'app');
});

test('DIFETTO CHIUSO: senza ticket ne\' cookie, la porta pannello rifiuta (non e\' un port-forward libero)', async (t) => {
  const onListen = harness(t);
  const panel = await pannelloFinto(); onListen(panel.server);
  const s = await serverDiProva(`http://127.0.0.1:${panel.port}`, onListen);
  const r = await fetch(`http://127.0.0.1:${s.panelPort}/panel/grafica/`);
  assert.equal(r.status, 401, 'nessuna credenziale, nessun contenuto');
});

test('CSP: la pagina del control plane porta frame-ancestors — l\'app non e\' incorporabile', async (t) => {
  const onListen = harness(t);
  const panel = await pannelloFinto(); onListen(panel.server);
  const s = await serverDiProva(`http://127.0.0.1:${panel.port}`, onListen);
  const r = await fetch(`http://127.0.0.1:${s.port}/`);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /frame-ancestors/, 'CSP frame-ancestors presente sulla pagina dell\'app');
});

test('bind ::1 (best-effort): la porta pannello risponde anche su IPv6 loopback, se disponibile', async (t) => {
  const onListen = harness(t);
  const panel = await pannelloFinto(); onListen(panel.server);
  const s = await serverDiProva(`http://127.0.0.1:${panel.port}`, onListen);
  if (!s.made.panelServerV6) {
    t.skip('nessun secondo listener IPv6 esposto da createServer');
    return;
  }
  onListen(s.made.panelServerV6);
  let ipv6Ok = true;
  await new Promise((resolve) => {
    s.made.panelServerV6.once('error', (e) => { ipv6Ok = false; t.skip(`IPv6 non disponibile in questo ambiente: ${e && e.code}`); resolve(); });
    s.made.panelServerV6.listen(s.panelPort, '::1', resolve);
  });
  if (!ipv6Ok) return;
  const ticket = await chiediTicket(`http://127.0.0.1:${s.port}`);
  const r = await fetch(`http://[::1]:${s.panelPort}/panel/grafica/?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(r.status, 200, 'stessa porta, anche su ::1');
});
