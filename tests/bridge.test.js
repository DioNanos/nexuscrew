const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { bindWs } = require('../lib/ws/bridge.js');

function fakeWs() {
  const ws = new EventEmitter();
  ws.sent = []; ws.bufferedAmount = 0; ws.closedCode = null;
  ws.send = (data) => ws.sent.push(data);
  ws.close = (code) => { ws.closedCode = code; ws.emit('__closed', code); };
  return ws;
}
function fakePtyFactory() {
  const calls = []; const handle = new EventEmitter();
  const fac = (session, opts) => {
    calls.push({ session, opts });
    return {
      write: (d) => handle.emit('wrote', d),
      resize: (c, r) => handle.emit('resized', { c, r }),
      onData: (cb) => handle.on('data', cb),
      onExit: (cb) => handle.on('exit', cb),
      kill: () => handle.emit('killed'),
    };
  };
  fac.calls = calls; fac.handle = handle; return fac;
}
const okDeps = (openAttach, over = {}) => ({ openAttach, verifyToken: () => true, isValidSession: () => true, ...over });

test('attach handshake opens pty and relays pty→ws as binary', () => {
  const ws = fakeWs(); const openAttach = fakePtyFactory();
  bindWs(ws, okDeps(openAttach));
  ws.emit('message', JSON.stringify({ type: 'attach', session: 'X', token: 't', cols: 90, rows: 30 }), false);
  assert.strictEqual(openAttach.calls.length, 1);
  assert.strictEqual(openAttach.calls[0].opts.cols, 90);
  openAttach.handle.emit('data', 'hello');
  assert.ok(ws.sent.some((b) => Buffer.from(b).toString() === 'hello'));
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

