const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { bindWs, createPtyGraceStore } = require('../lib/ws/bridge.js');

function fakeWs() {
  const ws = new EventEmitter();
  ws.sent = []; ws.bufferedAmount = 0; ws.closedCode = null;
  ws.send = (data) => ws.sent.push(data);
  ws.close = (code) => { ws.closedCode = code; ws.emit('__closed', code); };
  return ws;
}
// Il reconnectToken vive nel messaggio 'attached' — non e' detto che sia
// l'ULTIMO inviato (dopo l'attach possono esserci altri messaggi di stato).
function attachedTokenOf(ws) {
  const frame = ws.sent.map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .find((m) => m && m.type === 'attached');
  return frame ? frame.reconnectToken : undefined;
}
function fakePtyFactory() {
  const calls = []; const ptys = []; const handle = new EventEmitter();
  const fac = (session, opts) => {
    calls.push({ session, opts });
    const pty = {
      writes: [],
      write: (d) => { pty.writes.push(d); handle.emit('wrote', d); },
      resize: (c, r) => handle.emit('resized', { c, r }),
      promote: () => handle.emit('promoted'),
      demote: () => handle.emit('demoted'),
      onData: (cb) => handle.on('data', cb),
      onExit: (cb) => handle.on('exit', cb),
      kill: () => { pty.killed = true; handle.emit('killed'); },
    };
    ptys.push(pty);
    return pty;
  };
  fac.calls = calls; fac.ptys = ptys; fac.handle = handle; return fac;
}
const okDeps = (openAttach, over = {}) => ({ openAttach, verifyToken: () => true, isValidSession: () => true, ...over });

test('attach handshake opens pty and relays pty→ws as binary', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', cols: 90, rows: 30 }), false);
  assert.strictEqual(openAttach.calls.length, 1);
  assert.strictEqual(openAttach.calls[0].opts.cols, 90);
  openAttach.handle.emit('data', 'hello');
  // I frame di output portano il seq nei primi 4 byte : il payload segue.
  assert.ok(outFrames(ws).some((f) => f.text === 'hello'));
});

test('binary frame before attach closes 1002', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', Buffer.from('raw'), true);
  assert.strictEqual(openAttach.calls.length, 0);
  assert.strictEqual(ws.closedCode, 1002);
});

test('bad token closes 4401 without opening pty', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach, { verifyToken: () => false }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 'bad' }), false);
  assert.strictEqual(openAttach.calls.length, 0);
  assert.strictEqual(ws.closedCode, 4401);
});

test('unknown session closes 4404', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach, { isValidSession: () => false }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'ghost', token: 't' }), false);
  assert.strictEqual(openAttach.calls.length, 0);
  assert.strictEqual(ws.closedCode, 4404);
});

test('input binary writes to pty; resize json is clamped 20..300 / 5..120', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  let wrote = null, resized = null;
  openAttach.handle.on('wrote', (d) => (wrote = d));
  openAttach.handle.on('resized', (r) => (resized = r));
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', cols: 80, rows: 24 }), false);
  ws.emit('message', Buffer.from('ls\n'), true);
  assert.strictEqual(Buffer.from(wrote).toString(), 'ls\n');
  ws.emit('message', JSON.stringify({ type: 'resize', cols: 9999, rows: 0 }), false);
  assert.deepStrictEqual(resized, { c: 300, r: 5 });
});

test('second attach on same ws closes 1002 and opens no new pty', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'Y', token: 't' }), false);
  assert.strictEqual(openAttach.calls.length, 1);
  assert.strictEqual(ws.closedCode, 1002);
});

test('action message routes to runAction with attached session', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  const seen = [];
  bindWs(ws, okDeps(openAttach, { runAction: (s, n) => seen.push([s, n]) }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws.emit('message', JSON.stringify({ type: 'action', name: 'prev-window' }), false);
  assert.deepStrictEqual(seen, [['X', 'prev-window']]);
});

test('attach con takeSize:false resta ok e propaga takeSize (regressione F6)', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', takeSize: false }), false);
  assert.strictEqual(openAttach.calls.length, 1, 'attach riuscito');
  assert.strictEqual(openAttach.calls[0].opts.takeSize, false, 'takeSize false propagato al pty');
  assert.strictEqual(ws.closedCode, null, 'nessuna chiusura');
});


// Regressione bloccante trovata in revisione: readonlyDefault del server e' un
// PAVIMENTO. Un client che manda readonly:false NON puo' declassare un server
// READONLY. Il client puo' solo AGGIUNGERE restrizione (readonly:true su server RW).
test('READONLY: server readonlyDefault=true vince su client readonly:false (pavimento §4b(6))', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach, { defaults: { readonlyDefault: true } }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', readonly: false }), false);
  assert.strictEqual(openAttach.calls.length, 1);
  assert.strictEqual(openAttach.calls[0].opts.readonly, true, 'server READONLY forza readonly:true anche se il client chiede false');
});

test('READONLY: client puo\' solo aggiungere restrizione su server RW', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach, { defaults: { readonlyDefault: false } }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', readonly: true }), false);
  assert.strictEqual(openAttach.calls[0].opts.readonly, true, 'client readonly:true on server RW -> read-only');
  const ws2 = fakeWs(); const openAttach2 = fakePtyFactory();
  bindWs(ws2, okDeps(openAttach2, { defaults: { readonlyDefault: false } }));
  ws2.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', readonly: false }), false);
  assert.strictEqual(openAttach2.calls[0].opts.readonly, false, 'server RW + client false -> read-write (lecity)');
});

// L'upgrade viene accettato prima dell'autenticazione: il token arriva nel
// primo frame. Un socket che non manda mai l'attach resterebbe aperto e non
// autenticato a tempo indefinito, su ogni listener che serve l'app.
test('bridge: un socket che non si autentica entro la finestra viene chiuso', async () => {
  const ws = fakeWs();
  const fac = fakePtyFactory();
  bindWs(ws, {
    openAttach: fac, verifyToken: () => true,
    defaults: { attachTimeoutMs: 1000 },
  });
  assert.equal(ws.closedCode, null, 'nessuna chiusura immediata');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(ws.closedCode, 4408, 'chiuso per attach mancato');
  assert.equal(fac.calls.length, 0, 'nessun PTY aperto senza attach');
});

test('bridge: un attach valido disarma la scadenza e il socket resta vivo', async () => {
  const ws = fakeWs();
  const fac = fakePtyFactory();
  bindWs(ws, {
    openAttach: fac, verifyToken: () => true, isValidSession: () => true,
    defaults: { attachTimeoutMs: 1000 },
  });
  ws.emit('message', JSON.stringify({ type: 'attach', token: 't', session: 'cloud-Dev' }), false);
  assert.equal(fac.calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(ws.closedCode, null, 'una sessione attaccata non viene chiusa dalla scadenza');
});

test('pty grace: reconnect dello stesso client riusa il PTY senza nuovo attach', () => {
  const ws1 = fakeWs(); const ws2 = fakeWs(); const openAttach = fakePtyFactory();
  const grace = createPtyGraceStore({ graceMs: 1000, randomBytes: () => Buffer.alloc(32, 7) });
  const resized = []; let promoted = 0; let demoted = 0;
  openAttach.handle.on('resized', (value) => resized.push(value));
  openAttach.handle.on('promoted', () => promoted++);
  openAttach.handle.on('demoted', () => demoted++);
  bindWs(ws1, okDeps(openAttach, { ptyGrace: grace }));
  ws1.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', takeSize: true }), false);
  const firstPty = openAttach.ptys[0];
  const reconnectToken = attachedTokenOf(ws1);
  ws1.emit('close');
  assert.equal(firstPty.killed, undefined, 'la caduta transitoria non uccide il PTY');
  assert.equal(grace.size(), 1, 'il PTY entra nella finestra di grazia');

  bindWs(ws2, okDeps(openAttach, { ptyGrace: grace }));
  ws2.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', reconnectToken, takeSize: true }), false);
  assert.equal(openAttach.ptys.length, 1, 'il reconnect non crea un secondo attach');
  assert.equal(openAttach.ptys[0], firstPty, 'il reconnect riusa lo stesso PTY');
  assert.equal(grace.size(), 0, 'il resume rimuove la sospensione');
  ws2.emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), false);
  ws2.emit('message', JSON.stringify({ type: 'focus', on: true }), false);
  ws2.emit('message', JSON.stringify({ type: 'focus', on: false }), false);
  assert.deepEqual(resized, [{ c: 120, r: 40 }], 'il reconnect mantiene il percorso di resize');
  assert.equal(promoted, 1, 'il reconnect mantiene promote');
  assert.equal(demoted, 1, 'il reconnect mantiene demote');
  assert.equal(ws2.closedCode, null, 'il socket riagganciato resta vivo');
});

test('pty grace: il timeout finito chiude il PTY sospeso', async () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  const grace = createPtyGraceStore({ graceMs: 10, randomBytes: () => Buffer.alloc(32, 8) });
  bindWs(ws, okDeps(openAttach, { ptyGrace: grace }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  const pty = openAttach.ptys[0];
  ws.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pty.killed, true, 'la scadenza forza la chiusura del PTY');
  assert.equal(grace.size(), 0, 'la scadenza rimuove il record');
});

test('pty grace: un altro client non può riprendere la sospensione altrui', () => {
  const ws1 = fakeWs(); const ws2 = fakeWs(); const openAttach = fakePtyFactory();
  const grace = createPtyGraceStore({ graceMs: 1000, randomBytes: () => Buffer.alloc(32, 9) });
  bindWs(ws1, okDeps(openAttach, { ptyGrace: grace }));
  ws1.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  const firstPty = openAttach.ptys[0];
  ws1.emit('close');

  bindWs(ws2, okDeps(openAttach, { ptyGrace: grace }));
  ws2.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', reconnectToken: 'wrong-capability' }), false);
  assert.equal(openAttach.ptys.length, 2, 'senza la capability si apre un attach distinto');
  assert.notEqual(openAttach.ptys[1], firstPty, 'il secondo client non raccoglie il PTY sospeso');
  assert.equal(grace.size(), 1, 'la sospensione originale resta protetta');
  ws2.emit('close');
  grace.close();
});

test('pty grace: i tetti separati limitano sessioni e memoria trattenute', () => {
  const ws1 = fakeWs(); const ws2 = fakeWs(); const openAttach = fakePtyFactory();
  let tokenValue = 12;
  const grace = createPtyGraceStore({
    graceMs: 1000, maxSessions: 2, maxMemoryBytes: 64, recordBytes: 64,
    randomBytes: () => Buffer.alloc(32, tokenValue++),
  });
  bindWs(ws1, okDeps(openAttach, { ptyGrace: grace }));
  ws1.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  const firstPty = openAttach.ptys[0];
  ws1.emit('close');
  assert.equal(grace.size(), 1);
  assert.equal(grace.memoryBytes(), 64);

  bindWs(ws2, okDeps(openAttach, { ptyGrace: grace }));
  ws2.emit('message', JSON.stringify({ type: 'attach', session: 'Y', token: 't' }), false);
  ws2.emit('close');
  assert.equal(openAttach.ptys.length, 2);
  assert.equal(openAttach.ptys[1].killed, true, 'il secondo PTY viene chiuso quando il tetto è pieno');
  assert.equal(firstPty.killed, undefined, 'il primo PTY resta nella grazia');
  assert.deepEqual(grace.limits(), { maxSessions: 2, maxMemoryBytes: 64 });
  grace.close();

  const ws3 = fakeWs(); const ws4 = fakeWs(); const openAttach2 = fakePtyFactory();
  let tokenValue2 = 20;
  const sessionCapped = createPtyGraceStore({
    graceMs: 1000, maxSessions: 1, maxMemoryBytes: 128, recordBytes: 64,
    randomBytes: () => Buffer.alloc(32, tokenValue2++),
  });
  bindWs(ws3, okDeps(openAttach2, { ptyGrace: sessionCapped }));
  ws3.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws3.emit('close');
  bindWs(ws4, okDeps(openAttach2, { ptyGrace: sessionCapped }));
  ws4.emit('message', JSON.stringify({ type: 'attach', session: 'Y', token: 't' }), false);
  ws4.emit('close');
  assert.equal(openAttach2.ptys[1].killed, true, 'il tetto di sessioni chiude il PTY eccedente');
  assert.equal(sessionCapped.size(), 1);
  sessionCapped.close();
});

test('pty grace: exit durante la grazia viene consegnato al client di ritorno', () => {
  const ws1 = fakeWs(); const ws2 = fakeWs(); const openAttach = fakePtyFactory();
  const grace = createPtyGraceStore({ graceMs: 1000, randomBytes: () => Buffer.alloc(32, 10) });
  bindWs(ws1, okDeps(openAttach, { ptyGrace: grace, isValidSession: () => true }));
  ws1.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  const reconnectToken = attachedTokenOf(ws1);
  ws1.emit('close');
  openAttach.handle.emit('exit', { exitCode: 23 });

  bindWs(ws2, okDeps(openAttach, { ptyGrace: grace, isValidSession: () => false }));
  ws2.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', reconnectToken }), false);
  assert.equal(openAttach.ptys.length, 1, 'un exit non crea un nuovo PTY');
  assert.deepEqual(ws2.sent.map((value) => typeof value === 'string' ? JSON.parse(value) : value), [
    { type: 'exit', code: 23 },
  ]);
  assert.equal(ws2.closedCode, 1000, 'il ritorno riceve la fine della sessione');
  ws2.emit('message', Buffer.from('late-write'), true);
  assert.equal(openAttach.ptys[0].writes.length, 0, 'un record terminato non accetta scritture successive');
  grace.close();
});

test('pty grace: capability valida fuori scope non riprende un PTY vivo', () => {
  const ws1 = fakeWs(); const ws2 = fakeWs(); const openAttach = fakePtyFactory();
  const grace = createPtyGraceStore({ graceMs: 1000, randomBytes: () => Buffer.alloc(32, 12) });
  bindWs(ws1, okDeps(openAttach, { ptyGrace: grace, isValidSession: () => true }));
  ws1.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  const reconnectToken = attachedTokenOf(ws1);
  ws1.emit('close');

  bindWs(ws2, okDeps(openAttach, { ptyGrace: grace, isValidSession: () => false }));
  ws2.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', reconnectToken }), false);
  console.log(`wrong_session=${ws2.closedCode} live_resume_consumed=${grace.size() === 0} pty_count=${openAttach.ptys.length}`);
  assert.equal(ws2.closedCode, 4404, 'una capability non autorizza il resume di un PTY vivo');
  assert.equal(grace.size(), 1, 'il PTY vivo resta sospeso e non viene consumato');
  assert.equal(openAttach.ptys.length, 1, 'nessun nuovo PTY viene aperto');
  grace.close();
});

test('pty grace: un attach read-only resta read-only al reconnect', () => {
  const ws1 = fakeWs(); const ws2 = fakeWs(); const openAttach = fakePtyFactory();
  const grace = createPtyGraceStore({ graceMs: 1000, randomBytes: () => Buffer.alloc(32, 11) });
  bindWs(ws1, okDeps(openAttach, { ptyGrace: grace }));
  ws1.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', readonly: true }), false);
  const reconnectToken = attachedTokenOf(ws1);
  ws1.emit('close');
  bindWs(ws2, okDeps(openAttach, { ptyGrace: grace }));
  ws2.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', reconnectToken, readonly: false }), false);
  ws2.emit('message', Buffer.from('must-not-write'), true);
  assert.equal(openAttach.ptys[0].writes.length, 0, 'il reconnect non declassifica il PTY read-only');
  grace.close();
});

// ── Observability (2026-08-28): chiusure classificate, contatore cadute ──
function fakeDiag() {
  const calls = [];
  return { calls, record: (level, component, code, message, meta) => calls.push({ level, component, code, meta }) };
}
const diagDeps = (openAttach, diagnostics, over = {}) => okDeps(openAttach, { diagnostics, dropCounter: require('../lib/ws/drop-counter.js').createDropCounter(), ...over });

test('backpressure chiusa dal server produce WS_SERVER_CLOSE warn con motivo e conteggio', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory(); const diag = fakeDiag();
  bindWs(ws, diagDeps(openAttach, diag));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  const pty = openAttach.ptys[0];
  ws.bufferedAmount = 13 * 1024 * 1024;
  pty.onData ? openAttach.handle.emit('data', 'overflow') : null;
  const ev = diag.calls.find((c) => c.code === 'WS_SERVER_CLOSE');
  assert.ok(ev, 'manca WS_SERVER_CLOSE');
  assert.equal(ev.level, 'warn');
  assert.equal(ev.meta.reason, 'backpressure');
  assert.equal(ev.meta.cell, 'X');
  assert.equal(ev.meta.drops, 1, 'la caduta deve essere contata');
});

test('heartbeat marcato -> close 1006 classificato WS_HEARTBEAT_DROPPED, non drop TCP', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory(); const diag = fakeDiag();
  bindWs(ws, diagDeps(openAttach, diag));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws.__ncCloseReason = 'heartbeat-timeout';
  ws.emit('close', 1006);
  const ev = diag.calls.find((c) => c.code === 'WS_HEARTBEAT_DROPPED');
  assert.ok(ev, 'manca WS_HEARTBEAT_DROPPED');
  assert.equal(ev.level, 'warn');
  assert.equal(ev.meta.closeCode, 1006);
  const closeLines = diag.calls.filter((c) => ['WS_SERVER_CLOSE','WS_HEARTBEAT_DROPPED','WS_ABNORMAL_CLOSE','WS_CLIENT_CLOSE','PTY_EXIT'].includes(c.code));
  assert.equal(closeLines.length, 1, 'una sola riga di CHIUSURA per socket (WS_ATTACHED debug non conta)');
});

test('client close pulito = notice, pty exit = PTY_EXIT senza conteggio caduta', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory(); const diag = fakeDiag();
  bindWs(ws, diagDeps(openAttach, diag));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws.emit('close', 1000);
  const ev = diag.calls.find((c) => c.code === 'WS_CLIENT_CLOSE');
  assert.ok(ev && ev.level === 'notice');
  assert.equal(ev.meta.drops, 1, 'anche uno staccamento pulito e una caduta: conta');

  const ws2 = fakeWs(); const open2 = fakePtyFactory(); const diag2 = fakeDiag();
  bindWs(ws2, diagDeps(open2, diag2));
  ws2.emit('message', JSON.stringify({ type: 'attach', session: 'Y', token: 't' }), false);
  open2.handle.emit('exit', { exitCode: 3 });
  const exit = diag2.calls.find((c) => c.code === 'PTY_EXIT');
  assert.ok(exit && exit.meta.exitCode === 3 && exit.level === 'notice');
  ws2.emit('close', 1000);
  assert.equal(diag2.calls.filter((c) => c.code === 'WS_CLIENT_CLOSE').length, 0, 'il close post-exit non genera seconda riga');
});

// ---- Streaming resiliente: stato del link dopo l'attach e resync con
// ---- capture-pane quando il client torna dopo una caduta.

test('attach confermato dichiara il link live', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  const json = ws.sent.map((s) => JSON.parse(s));
  assert.ok(json.some((m) => m.type === 'link' && m.state === 'live'), 'link live dopo attach');
});

test('resync risponde con lo snapshot dal capture-pane (nessuno svuotamento)', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  const captures = [];
  bindWs(ws, okDeps(openAttach, {
    capturePane: (session, tmuxBin, captureLines, cb) => { captures.push({ session, tmuxBin, captureLines }); cb(null, 'CAPTURE-DATA'); },
  }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws.emit('message', JSON.stringify({ type: 'resync' }), false);
  assert.deepEqual(captures, [{ session: 'X', tmuxBin: 'tmux', captureLines: undefined }]);
  const json = ws.sent.map((s) => JSON.parse(s));
  assert.ok(json.some((m) => m.type === 'snapshot' && m.data === 'CAPTURE-DATA'),
    'lo snapshot arriva come messaggio dedicato');
});

test('resync con capture fallita NON chiude il canale: lo stream live continua', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach, {
    capturePane: (session, tmuxBin, captureLines, cb) => cb(new Error('tmux gone')),
  }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws.emit('message', JSON.stringify({ type: 'resync' }), false);
  assert.strictEqual(ws.closedCode, null, 'nessuna chiusura per un capture fallito');
  openAttach.handle.emit('data', 'live-after-failed-resync');
  assert.ok(outFrames(ws).some((f) => f.text === 'live-after-failed-resync'));
});

// ---- ripresa per sequenza. Il bridge numera i frame di output e tiene un
// ---- ring buffer per sessione: al ritorno il client chiede solo il mancante.

// Il seq viaggia nei primi 4 byte del frame binario (big endian).
function outFrames(ws) {
  return ws.sent
    .filter((b) => Buffer.isBuffer(b) || (b && b.length >= 4 && typeof b.toString === 'function' && !b.toString().startsWith('{')))
    .map((b) => Buffer.from(b))
    .filter((b) => b.length >= 4 && ![0x7b].includes(b[0])) // scarta i JSON testuali
    .map((b) => ({ seq: b.readUInt32BE(0), text: b.subarray(4).toString() }));
}

test('resume dentro il buffer rimanda SOLO il mancante, senza duplicati', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  openAttach.handle.emit('data', 'AAAA'); // seq 0
  openAttach.handle.emit('data', 'BBBB'); // seq 1
  openAttach.handle.emit('data', 'CCCC'); // seq 2
  const before = outFrames(ws);
  assert.deepEqual(before.map((f) => f.text), ['AAAA', 'BBBB', 'CCCC'], 'ogni frame porta il suo seq');

  ws.emit('message', JSON.stringify({ type: 'resume', seq: 0 }), false); // ho fino ad AAAA
  const after = outFrames(ws).slice(before.length);
  assert.deepEqual(after.map((f) => f.text), ['BBBB', 'CCCC'], 'solo i frame oltre il seq dichiarato');
  assert.deepEqual(after.map((f) => f.seq), [1, 2], 'nessuna duplicazione: i seq ripartono da 1');
});

test('un gap oltre il buffer chiede il repaint invece di inventare il delta', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach, { defaults: { outputRingBytes: 4 } }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  for (const t of ['AAAA', 'BBBB', 'CCCC']) openAttach.handle.emit('data', t); // ring cap 8: restano le ultime
  ws.emit('message', JSON.stringify({ type: 'resume', seq: 0 }), false); // il primo frame non è più in buffer
  const json = ws.sent.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  assert.ok(json.some((m) => m.type === 'resync-needed'), 'il bridge deve chiedere il repaint');
});

test('resume senza nulla da rimandare non manda frame e dichiara live', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  openAttach.handle.emit('data', 'AAAA');
  const n = outFrames(ws).length;
  ws.emit('message', JSON.stringify({ type: 'resume', seq: 0 }), false); // già aggiornato
  assert.equal(outFrames(ws).length, n, 'nessun frame nuovo');
  const json = ws.sent.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  assert.ok(json.some((m) => m.type === 'link' && m.state === 'live'));
});

test('il numero di righe del resync viene dalla config del server', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  let seen;
  bindWs(ws, okDeps(openAttach, {
    defaults: { captureLines: 123 },
    capturePane: (session, tmuxBin, captureLines, cb) => { seen = captureLines; cb(null, 'X'); },
  }));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't' }), false);
  ws.emit('message', JSON.stringify({ type: 'resync' }), false);
  assert.equal(seen, 123, 'il capture usa il valore configurato');
});
