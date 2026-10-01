'use strict';
// tests/federation-ws-upgrade-error.test.js — l'upgrade WebSocket federato
// verso una porta locale CHIUSA non deve far morire il processo.
//
// Regressione 0.9.53: in forwardUpgrade (lib/proxy/federation.js) l'upstream
// `up = net.connect({ host: '127.0.0.1', port })` nel ramo hubMode registrava il
// listener 'error' solo DENTRO `up.once('connect', …)`. Se la porta locale del
// tunnel era giù (tunnel che si riavvia), ECONNREFUSED arrivava prima del
// 'connect': l'evento 'error' non aveva gestore → Unhandled 'error' event →
// crash del processo. Sul nodo Termux è caduto 5 volte.
//
// La correzione registra un listener 'error' SUBITO dopo net.connect, valido
// per entrambi i rami (hubMode e !hubMode), prima che qualunque I/O possa
// fallire.
//
// Per provare il CRASH serve un processo separato: qui in-process l'evento
// 'error' non gestito diventerebbe un uncaughtException del test runner e
// maschererebbe l'esito. Lo script figlio installa un gestore di
// uncaughtException, fa partire l'upgrade verso localPort: 1 (rifiuto prima
// del connect) e riporta l'esito su stderr. Il test verifica exit code 0,
// nessuna riga "UNCAUGHT" e il socket del client chiuso pulitamente.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

// Script del processo figlio: replica l'harness dei test resilient (coppia
// reale di socket browser↔proxy) ma in un processo che può CRASHARE senza
// trascinare il runner. hubMode decide con `mode` quale ramo esercitare.
function childScript(mode) {
  return `
'use strict';
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const federation = require(path.join(${JSON.stringify(REPO)}, 'lib', 'proxy', 'federation.js'));
const store = require(path.join(${JSON.stringify(REPO)}, 'lib', 'nodes', 'store.js'));

let crashed = false;
process.on('uncaughtException', (err) => {
  crashed = true;
  process.stderr.write('UNCAUGHT: ' + (err && err.stack || err && err.message || err) + '\\n');
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write('UNHANDLED_REJECTION: ' + (err && err.message || err) + '\\n');
  process.exit(1);
});

const PEER_ID = 'b'.repeat(32);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncws-err-'));
const nodesPath = path.join(dir, 'nodes.json');
store.initStore(nodesPath);
let st = store.loadStoreStrict(nodesPath);
st = store.addNode(st, {
  name: 'peer-a', remotePort: 41999, localPort: 44999, nodeId: PEER_ID,
  acceptToken: 'ACC', direction: 'inbound', shared: true, visibility: 'network',
});
store.atomicWriteStore(nodesPath, st);

const hubAttaches = federation.createHubAttachStore({ graceMs: 500, maxAttaches: 8, ringBytes: 4096 });

const key = crypto.randomBytes(16).toString('base64');
const attachId = 'a'.repeat(32);
const query = ${JSON.stringify(mode)} === 'hub'
  ? 'token=TOK&attachId=' + attachId + '&attachSession=work'
  : '';
const req = {
  url: '/federation/route/_/ws' + (query ? '?' + query : ''),
  method: 'GET',
  headers: {
    host: '127.0.0.1',
    'x-nexuscrew-visited': PEER_ID,
    'sec-websocket-key': key,
    'sec-websocket-version': '13',
    upgrade: 'websocket',
    connection: 'Upgrade',
  },
};

let serverSock = null;
const srv = net.createServer((sock) => { serverSock = sock; sock.on('error', () => {}); });
srv.listen(0, '127.0.0.1', () => {
  const client = net.connect(srv.address().port, '127.0.0.1');
  client.on('error', () => {});
  let raw = Buffer.alloc(0);
  // Il "browser" qui e' un socket raw che non parla WS: non risponde al frame
  // di close, quindi la handshake di chiusura ws resta half-open. Come i test
  // resilient, si cerca il close frame 4402 nei byte ricevuti (il proxy lo ha
  // scritto), non si aspetta la chiusura TCP.
  const scanForClose = (frame) => {
    let off = 0;
    while (off + 2 <= frame.length) {
      const opcode = frame[off] & 0x0f;
      const masked = (frame[off + 1] & 0x80) !== 0;
      let len = frame[off + 1] & 0x7f;
      let cursor = off + 2;
      if (len === 126) { if (cursor + 2 > frame.length) return null; len = frame.readUInt16BE(cursor); cursor += 2; }
      else if (len === 127) return null;
      if (masked) return null;
      if (cursor + len > frame.length) return null;
      if (opcode === 0x8) { const p = frame.subarray(cursor, cursor + len); return p.length >= 2 ? p.readUInt16BE(0) : 1005; }
      off = cursor + len;
    }
    return null;
  };
  let closeCode = null;
  const tryParse = () => {
    const headerEnd = raw.indexOf('\\r\\n\\r\\n');
    if (headerEnd >= 0) {
      const code = scanForClose(raw.subarray(headerEnd + 4));
      if (code !== null) { closeCode = code; finish(false); }
    }
  };
  client.on('data', (c) => { raw = Buffer.concat([raw, c]); tryParse(); });
  client.on('close', () => { finish(false); });

  const wait = setInterval(() => {
    if (!serverSock) return;
    clearInterval(wait);
    federation.forwardUpgrade({
      req, socket: serverSock, head: null, nodesPath,
      localPort: 1, // porta chiusa: ECONNREFUSED prima del connect
      localCredential: () => 'LOCAL-TOKEN',
      ingress: { nodeId: PEER_ID, visibility: 'network', shared: true, peerOperatorAccess: true },
      hubAttaches,
    });
  }, 5);

  const watchdog = setTimeout(() => { finish(true); }, 5000);
  watchdog.unref();

  let done = false;
  function finish(timedOut) {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    try { srv.close(); } catch (_) { /* gia' chiuso */ }
    try { client.destroy(); } catch (_) { /* idem */ }
    try { if (serverSock) serverSock.destroy(); } catch (_) { /* idem */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* absent */ }
    const got101 = raw.toString('latin1').startsWith('HTTP/1.1 101');
    process.stderr.write('RESULT mode=' + ${JSON.stringify(mode)} + ' got101=' + got101 + ' close=' + closeCode + ' len=' + raw.length + ' timedOut=' + !!timedOut + '\\n');
    if (timedOut) { process.stderr.write('TIMEOUT\\n'); process.exit(2); }
    process.exit(0);
  }
});
`;
}

function runChild(mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncws-err-home-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncws-err-tmp-'));
  try {
    const res = spawnSync(process.execPath, ['-e', childScript(mode)], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        HOME: home,
        TMUX_TMPDIR: tmp,
        NEXUSCREW_TEST_HOME_ROOT: home,
        NEXUSCREW_AUTO_UPDATE: '0',
      },
    });
    return res;
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* absent */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* absent */ }
  }
}

test('hubMode: upgrade federato verso porta chiusa non crasha il processo', () => {
  const res = runChild('hub');
  assert.equal(res.status, 0,
    `il figlio deve uscire 0 (no uncaughtException). status=${res.status} signal=${res.signal}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.ok(!res.stderr.includes('UNCAUGHT'),
    `non deve esserci un 'error' non gestito:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('UNHANDLED_REJECTION'),
    `non devono esserci rejection non gestite:\n${res.stderr}`);
  assert.ok(res.stderr.includes('RESULT mode=hub got101=true close=4402'),
    `il client deve ricevere 101 + close 4402 leggibile:\n${res.stderr}`);
});

test('!hubMode: upgrade federato verso porta chiusa non crasha il processo', () => {
  const res = runChild('direct');
  assert.equal(res.status, 0,
    `il figlio deve uscire 0. status=${res.status} signal=${res.signal}\nstderr:\n${res.stderr}`);
  assert.ok(!res.stderr.includes('UNCAUGHT'),
    `non deve esserci un 'error' non gestito:\n${res.stderr}`);
  assert.ok(res.stderr.includes('RESULT mode=direct got101=true close=4402'),
    `il client deve ricevere 101 + close 4402 leggibile:\n${res.stderr}`);
});