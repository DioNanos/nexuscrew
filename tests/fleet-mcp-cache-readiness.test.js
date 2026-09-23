'use strict';
// Adattatore readiness MCP dalla cache client (versionato 2.1.280).
// Copre: encoding cwd, boot stamp, stati per-server sul SOLO boot corrente
// (mai log vecchi), tolleranza a righe malformate/schema variabile (error
// senza debug), attesa bounded con deadline composta e cancellazione.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ADAPTER_CLIENT_VERSION, bootStampOf, encodeCwdForCache, readinessNow, waitMcpReadiness,
} = require('../lib/fleet/mcp-cache-readiness.js');

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd342-mcp-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeBoot(root, cwd, server, stamp, lines) {
  const dir = path.join(root, encodeCwdForCache(cwd), `mcp-logs-${server}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stamp}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const START = Date.parse('2026-09-22T18:00:00.000Z');
const START_STAMP = bootStampOf(START);

test('bootStampOf riproduce lo stamp dei boot file del client ed ordina come il tempo', () => {
  assert.strictEqual(bootStampOf(Date.parse('2026-09-22T18:46:09.220Z')), '2026-09-22T18-46-09-220Z');
  assert.ok(bootStampOf(START) < bootStampOf(START + 1), 'ordinamento lessicografico = temporale');
});

test('encodeCwdForCache sostituisce ogni non-alfanumerico (forma misurata 2.1.280)', () => {
  assert.strictEqual(encodeCwdForCache('/tmp/d342-gateb/cwd-p2'), '-tmp-d342-gateb-cwd-p2');
  assert.strictEqual(encodeCwdForCache('/home/tester/Dev/.worktrees/WorkerX'), '-home-tester-Dev--worktrees-WorkerX');
});

test('readinessNow: ready/failed/pending sul boot corrente, record error senza debug = failed', () => {
  const root = tmpRoot({ after() {} });
  const cwd = '/tmp/probe-xyz';
  writeBoot(root, cwd, 'slow', START_STAMP, [
    { debug: 'Starting connection with timeout of 30000ms', timestamp: 'x', sessionId: 's1' },
    { debug: 'Successfully connected (transport: stdio) in 6068ms', timestamp: 'x', sessionId: 's1' },
  ]);
  writeBoot(root, cwd, 'dead', START_STAMP, [
    { debug: 'Starting connection with timeout of 30000ms' },
    { error: 'Connection failed (CONNECTION_CLOSED): Connection closed', timestamp: 'x' },
  ]);
  writeBoot(root, cwd, 'still', START_STAMP, [
    { debug: 'Starting connection with timeout of 30000ms' },
  ]);
  const r = readinessNow({ cacheRoot: root, cwd, expectedServers: ['slow', 'dead', 'still'], notBeforeMs: START });
  assert.deepStrictEqual(r.ready, ['slow']);
  assert.deepStrictEqual(r.failed, ['dead']);
  assert.deepStrictEqual(r.pending, ['still']);
  assert.strictEqual(r.state, 'pending');
  assert.strictEqual(r.adapterClientVersion, '2.1.280');
  assert.strictEqual(ADAPTER_CLIENT_VERSION, '2.1.280');
});

test('readinessNow: ensemble concluso senza pending = degraded; attesa vuota = ready', () => {
  const root = tmpRoot({ after() {} });
  const cwd = '/tmp/probe-xyz';
  writeBoot(root, cwd, 'ok', START_STAMP, [
    { debug: 'Successfully connected (transport: stdio) in 407ms' },
  ]);
  writeBoot(root, cwd, 'ko', START_STAMP, [
    { error: 'Connection failed (CONNECTION_CLOSED): Connection closed' },
  ]);
  const r = readinessNow({ cacheRoot: root, cwd, expectedServers: ['ok', 'ko'], notBeforeMs: START });
  assert.strictEqual(r.state, 'degraded');
  assert.deepStrictEqual(r.pending, []);
  const empty = readinessNow({ cacheRoot: root, cwd, expectedServers: [], notBeforeMs: START });
  assert.strictEqual(empty.state, 'ready');
});

test('readinessNow: log di generazioni precedenti NON sbloccano (boot corrente soltanto)', () => {
  const root = tmpRoot({ after() {} });
  const cwd = '/tmp/probe-xyz';
  const old = bootStampOf(START - 60000);
  writeBoot(root, cwd, 'gen0', old, [
    { debug: 'Successfully connected (transport: stdio) in 100ms' },
  ]);
  const r = readinessNow({ cacheRoot: root, cwd, expectedServers: ['gen0'], notBeforeMs: START });
  assert.strictEqual(r.servers.gen0, 'pending', 'handshake vecchio mai ready per la generazione nuova');
  assert.strictEqual(r.state, 'pending');
});

test('readinessNow: righe malformate e file spazzatura sono ignorati senza crash', () => {
  const root = tmpRoot({ after() {} });
  const cwd = '/tmp/probe-xyz';
  const dir = path.join(root, encodeCwdForCache(cwd), 'mcp-logs-weird');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = bootStampOf(START);
  fs.writeFileSync(path.join(dir, `${stamp}.jsonl`), '{non-json\n\n{"chiave":"strana"}\n[1,2]\nnull\n');
  const r = readinessNow({ cacheRoot: root, cwd, expectedServers: ['weird'], notBeforeMs: START });
  assert.strictEqual(r.servers.weird, 'pending');
});

test('waitMcpReadiness: ritorna subito su insieme concluso (anche degraded), attesa su pending, cancel', async () => {
  const root = tmpRoot({ after() {} });
  const cwd = '/tmp/probe-xyz';
  writeBoot(root, cwd, 'ok', START_STAMP, [{ debug: 'Successfully connected (transport: stdio) in 10ms' }]);
  writeBoot(root, cwd, 'ko', START_STAMP, [{ error: 'Connection failed (CONNECTION_CLOSED): x' }]);
  const done = await waitMcpReadiness({
    params: { cacheRoot: root, cwd, expectedServers: ['ok', 'ko'], notBeforeMs: START },
    deadlineMs: START + 20000,
  });
  assert.strictEqual(done.cancelled, undefined);
  assert.strictEqual(done.state, 'degraded');
  assert.strictEqual(done.timedOut, false);

  let polls = 0;
  let t = START;
  const becomesReady = await waitMcpReadiness({
    params: { cacheRoot: root, cwd: '/tmp/non-esiste-mai', expectedServers: ['x'], notBeforeMs: START },
    deadlineMs: START + 60,
    pollMs: 20,
    sleepImpl: async () => { polls += 1; t += 30; },
    nowImpl: () => t,
  });
  assert.strictEqual(becomesReady.timedOut, true);
  assert.strictEqual(becomesReady.state, 'pending');
  assert.ok(polls > 0);

  const cancelled = await waitMcpReadiness({
    params: { cacheRoot: root, cwd: '/tmp/non-esiste-mai', expectedServers: ['x'], notBeforeMs: START },
    deadlineMs: Date.now() + 60000,
    isCancelled: () => true,
  });
  assert.strictEqual(cancelled.cancelled, true);
});
