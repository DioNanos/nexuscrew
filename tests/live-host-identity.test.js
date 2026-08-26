const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { startThreadOnControlSocket } = require('../lib/live-host/bridge.js');

// Le prove della fase 3a: il ponte Dichiara l'identita della connessione
// nell'handshake initialize (ClientInfo.nexuscrewSession). Nessun socket
// reale: WebSocket finto che cattura i frame. Ogni negativo deve essere
// stato visto rosso prima dell'implementazione (gate dal coordinatore).

function capturingWsFactory() {
  const instances = [];
  const factory = function CapturingWs(url) {
    const ws = new EventEmitter();
    ws.url = url; ws.sent = [];
    // Simula anche il server: alla richiesta initialize risponde con
    // {userAgent, codexHome} come da protocollo misurato (bridge.js:49-50),
    // cosi' il flusso prosegue e possiamo osservare i frame successivi.
    ws.send = (data) => {
      const msg = JSON.parse(data);
      ws.sent.push(msg);
      if (msg.method === 'initialize') {
        queueMicrotask(() => ws.emit('message', JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { userAgent: 'fake-daemon', codexHome: '/tmp/fake-home' },
        })));
      }
    };
    ws.close = () => ws.emit('close');
    ws.terminate = () => ws.emit('close');
    queueMicrotask(() => ws.emit('open'));
    instances.push(ws);
    return ws;
  };
  factory.instances = instances;
  return factory;
}

async function capturedInitialize(declaredSession, polluteEnv) {
  const keysSaved = {};
  const pollute = {
    TMUX: '/tmp/tmux-test/default,FORZA',
    TMUX_PANE: '%6-morto',
  };
  if (polluteEnv) {
    for (const [k, v] of Object.entries(pollute)) { keysSaved[k] = process.env[k]; process.env[k] = v; }
  }
  try {
    const WSf = capturingWsFactory();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-id-'));
    const p = startThreadOnControlSocket({
      socketPath: path.join(tmp, 'rc.sock'),
      cwd: '/tmp',
      ...(declaredSession !== undefined ? { declaredSession } : {}),
      timeoutMs: 120,
      WebSocket: WSf,
      log: () => {},
    });
    p.catch(() => {}); // la thread/start non arriva mai: atteso, chiudiamo col timer
    // attende che l'istanza finta riceva open e invii l'initialize
    await new Promise((res) => setTimeout(res, 20));
    const ws = WSf.instances[0];
    const initFrame = ws.sent.find((m) => m.method === 'initialize');
    return initFrame || null;
  } finally {
    for (const [k, v] of Object.entries(keysSaved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('T+ sessione designata -> ClientInfo.nexuscrewSession dichiara il valore', async () => {
  const frame = await capturedInitialize('cloud-X', false);
  assert.ok(frame, 'nessun initialize inviato');
  assert.strictEqual(frame.params.clientInfo.nexuscrewSession, 'cloud-X');
});

test("N1' nessuna sessione disponibile -> il campo e ASSENTE (non vuoto), MAI derivato dall'ambiente", async () => {
  const frame = await capturedInitialize(undefined, true); // ambiente inquinator TMUX_PANE stantio presente
  assert.ok(frame, 'nessun initialize inviato');
  assert.ok(!('nexuscrewSession' in frame.params.clientInfo),
    'clientInfo non deve contenere nexuscrewSession se non dichiarata');
});

test("B1-bis ambiente POPOLATO STANTIO + dichiarazione presente -> la dichiarazione VINCE", async () => {
  const frame = await capturedInitialize('cloud-dag-viva', true);
  assert.ok(frame, 'nessun initialize inviato');
  assert.strictEqual(frame.params.clientInfo.nexuscrewSession, 'cloud-dag-viva');
  assert.ok(!JSON.stringify(frame).includes('%6-morto'), 'lo stato ambiente stantio non deve filtrare nel wire');
});

test("N2' valore malformato trasmesso IDENTICO (il ponte non sanitizza)", async () => {
  const frame = await capturedInitialize('###', false);
  assert.ok(frame, 'nessun initialize inviato');
  assert.strictEqual(frame.params.clientInfo.nexuscrewSession, '###');
});

test('N+ initialized resta notifica senza params anche con sessione presente', async () => {
  const WSf = capturingWsFactory();
  const p = startThreadOnControlSocket({
    socketPath: path.join(os.tmpdir(), 'nope.sock'),
    cwd: '/tmp',
    declaredSession: 'cloud-X',
    timeoutMs: 120,
    WebSocket: WSf,
    log: () => {},
  });
  p.catch(() => {});
  await new Promise((res) => setTimeout(res, 20));
  const ws = WSf.instances[0];
  const initNotif = ws.sent.find((m) => m.method === 'initialized');
  assert.ok(initNotif, 'initialized mancata');
  assert.ok(!('params' in initNotif));
});
