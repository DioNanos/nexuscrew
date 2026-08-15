'use strict';
// tests/live-host-proxy-deny.test.js — federazione default-deny: il proxy /node
// NON instrada /api/live-host. Un peer non puo' designare (o leggere lo stato di
// designazione di) una cella di questo nodo via /node/<name>. Comportamentale.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { createNodeProxy } = require('../lib/proxy/node-proxy.js');
const { requireToken } = require('../lib/auth/middleware.js');

const TOKEN = 'tok';

async function boot() {
  const app = express();
  app.use('/node', requireToken({ get: () => TOKEN }), createNodeProxy({
    resolveNode: () => ({ localPort: 1, token: 'remote-tok' }),
    readonly: () => false,
    // Il blocklist chiude /api/live-host PRIMA di resolveNode/proxy, quindi questo
    // seam non deve mai girare per i path local-only. Se girasse, fallirebbe di
    // schianto: nessun upstream in questo test.
    httpRequest: () => { throw new Error('non doveva fare proxy: local-only'); },
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('POST /node/<name>/api/live-host/designate -> 403 local-only', async () => {
  const ctx = await boot();
  try {
    const r = await fetch(`${ctx.base}/node/x/api/live-host/designate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cellId: 'cloud-Dev', expectedRevision: 0 }),
    });
    assert.equal(r.status, 403);
  } finally { await ctx.close(); }
});

test('GET /node/<name>/api/live-host -> 403 local-only (nemmeno in lettura via federazione)', async () => {
  const ctx = await boot();
  try {
    const r = await fetch(`${ctx.base}/node/x/api/live-host`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 403);
  } finally { await ctx.close(); }
});

test('selettivo: /api/cells via proxy NON e\' bloccato (il deny colpisce SOLO /api/live-host)', async () => {
  // Un path non local-only procede verso il proxy: qui httpRequest e' un seam
  // che fa risolvere 502 all'upstream. L'assertione chiave e' che NON e' il 403
  // local-only: il blocklist e' mirato, non una sega a tutto /api.
  const ctx = await boot();
  try {
    const r = await fetch(`${ctx.base}/node/x/api/cells`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.notEqual(r.status, 403);
    assert.equal(r.status, 502); // arrivato al proxy (seam httpRequest -> 502)
  } finally { await ctx.close(); }
});

test('WS upgrade /node/<name>/api/live-host -> abortUpgrade 403 (prima di resolve/connect)', () => {
  // Parita\' con isLocalOnly dell'HTTP handler (403 = divieto federazione esplicito),
  // distinto da isTransitiveRest=404. handleNodeUpgrade e' sync fino all'abort:
  // il resolveNode/connect mock throwerebbero se raggiunti (non lo sono).
  const { handleNodeUpgrade } = require('../lib/proxy/node-proxy.js');
  let written = '';
  const socket = {
    write: (s) => { written += String(s); },
    destroy() {}, end() {}, once() {}, on() {},
  };
  const req = {
    url: '/x/api/live-host',
    headers: {
      upgrade: 'websocket', connection: 'Upgrade',
      'sec-websocket-key': 'k', 'sec-websocket-version': '13',
      authorization: `Bearer ${TOKEN}`,
    },
  };
  handleNodeUpgrade({
    req, socket, head: Buffer.alloc(0),
    resolveNode: () => { throw new Error('non doveva risolvere: local-only'); },
    verifyToken: (t) => t === TOKEN,
    readonly: () => false,
    connect: () => { throw new Error('non doveva connettere: local-only'); },
  });
  assert.match(written, /403/, 'upgrade local-only abortato con 403');
});
