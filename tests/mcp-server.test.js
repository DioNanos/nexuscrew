'use strict';
// MCP bridge — server stdio (lib/mcp/server.js). MAI tmux reale: identita' via
// NEXUSCREW_MCP_SESSION o execFileImpl finto; la suite resta verde con TMUX
// rimosso dall'env (i test costruiscono SEMPRE il proprio env esplicito).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createMcpServer, resolveSession, resolveIdentity, transportError, HTTP_TIMEOUT_CODE } = require('../lib/mcp/server.js');
const { unavailableOwner } = require('../lib/mcp/cells.js');
const { TOOLS, commandForDiagnostics, failureForDiagnostics } = require('../lib/mcp/tools.js');
const bridgeAuth = require('../lib/audio/bridge-auth.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncmcp-')); }

function writeToken(dir, value = 'tok-mcp') {
  const p = path.join(dir, 'token');
  fs.writeFileSync(p, `${value}\n`, { mode: 0o600 });
  return p;
}

// Output finto: al server serve solo .write — niente stream reali, niente tick.
function makeOut() {
  const lines = [];
  return { lines, write: (s) => { for (const l of String(s).split('\n')) if (l.trim()) lines.push(JSON.parse(l)); } };
}

// fetch finto: registra le chiamate e risponde canned.
function makeFetch(responder) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const call = {
      url: String(url), method: opts.method || 'GET', headers: opts.headers || {},
      rawBody: opts.body, body: opts.body ? JSON.parse(opts.body) : undefined,
    };
    calls.push(call);
    const r = responder(call);
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  return { calls, impl };
}

function makeSrv({ env = {}, responder, execFileImpl, tokenPath, idFactory, identityRetryMs } = {}) {
  const dir = tmpdir();
  const tp = tokenPath || writeToken(dir);
  const out = makeOut();
  const f = makeFetch(responder || (() => ({ status: 200, json: {} })));
  const srv = createMcpServer({
    output: out,
    env,
    config: { port: 4242, tokenPath: tp, tmuxBin: 'tmux' },
    fetchImpl: f.impl,
    execFileImpl: execFileImpl || (() => { throw new Error('tmux non deve essere chiamato'); }),
    ...(idFactory ? { idFactory } : {}),
    ...(identityRetryMs !== undefined ? { identityRetryMs } : {}),
    errlog: () => {},
  });
  return { srv, out, calls: f.calls, dir };
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('initialize: echo protocolVersion, capabilities.tools, serverInfo', async () => {
  const { srv, out } = makeSrv();
  await srv.handleLine(rpc(1, 'initialize', { protocolVersion: '2026-01-01', capabilities: {} }));
  const r = out.lines[0];
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2026-01-01');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.result.serverInfo.name, 'nexuscrew');
  assert.match(r.result.instructions, /Discover the current client tools/);
  assert.match(r.result.instructions, /mcp-memory-rs/);
  assert.match(r.result.instructions, /mcp-vl-msa-rs/);
  assert.match(r.result.instructions, /mcp-crewd-rs/);
  assert.match(r.result.instructions, /mcp-email-rs/);
  assert.match(r.result.instructions, /does not install or configure companions automatically/);
  // notification: nessuna risposta
  await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(out.lines.length, 1);
});

test('tools/list: tool nc_* completi con readOnlyHint sui read-only', async () => {
  const { srv, out } = makeSrv();
  await srv.handleLine(rpc(2, 'tools/list'));
  const tools = out.lines[0].result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['nc_ask', 'nc_cell_diagnostics', 'nc_cells', 'nc_deck', 'nc_identity', 'nc_inbox', 'nc_lease_recovery', 'nc_lease_refresh', 'nc_lease_register', 'nc_notify', 'nc_send_cell', 'nc_send_file', 'nc_speak', 'nc_speak_group', 'nc_speak_group_status', 'nc_speak_group_stop', 'nc_speak_status', 'nc_speak_stop', 'nc_status', 'nc_vl_command', 'nc_vl_invite', 'nc_vl_nodes', 'nc_vl_revoke']);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.nc_status.annotations.readOnlyHint, true);
  assert.equal(byName.nc_deck.annotations.readOnlyHint, true);
  assert.equal(byName.nc_cells.annotations.readOnlyHint, true);
  assert.equal(byName.nc_vl_nodes.annotations.readOnlyHint, true);
  assert.equal(byName.nc_cell_diagnostics.annotations.readOnlyHint, true);
  assert.equal(byName.nc_inbox.annotations.readOnlyHint, true);
  assert.equal(byName.nc_identity.annotations.readOnlyHint, true);
  assert.equal(byName.nc_speak_status.annotations.readOnlyHint, true);
  assert.equal(byName.nc_speak_group_status.annotations.readOnlyHint, true);
  assert.equal(byName.nc_notify.annotations, undefined);
  assert.equal(byName.nc_send_cell.annotations, undefined);
  assert.equal(byName.nc_vl_invite.annotations, undefined);
  assert.equal(byName.nc_vl_command.annotations, undefined);
  assert.equal(byName.nc_vl_revoke.annotations, undefined);
  assert.equal(byName.nc_speak.annotations, undefined, 'nc_speak muta, no readOnlyHint');
  assert.equal(byName.nc_speak_group.annotations, undefined, 'nc_speak_group muta, no readOnlyHint');
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
});

test('nc_vl_nodes + nc_vl_command: directory owner-qualified e receipt live-only', async () => {
  const localId = 'a'.repeat(32); const nodeId = 'b'.repeat(32);
  const target = `${localId}:VL-${nodeId}`;
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { nodes: [] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'codex.native', active: true, canReceive: true },
      ] } };
      if (p === '/api/vl-nodes' && call.method === 'GET') return { status: 200, json: {
        instanceId: localId, protocol: 'vl-node/1', nodes: [{
          id: target, instanceId: localId, nodeId, cell: 'VL-bbbbbbbb', label: 'N900',
          online: true, canManage: true, generation: 1, capabilities: ['status'],
        }],
      } };
      if (p === `/api/vl-nodes/${nodeId}/commands`) return { status: 202, json: {
        id: 'c'.repeat(32), status: 'submitted', note: 'completion requires ack',
      } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(207, 'tools/call', { name: 'nc_vl_nodes', arguments: {} }));
  const directory = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(directory.nodes[0].id, target);
  assert.equal(directory.nodes[0].online, true);
  assert.deepEqual(directory.unavailable, []);
  await srv.handleLine(rpc(208, 'tools/call', {
    name: 'nc_vl_command', arguments: { target, kind: 'status', args: {} },
  }));
  const receipt = JSON.parse(out.lines[1].result.content[0].text);
  assert.equal(receipt.status, 'submitted');
  assert.equal(receipt.target, target);
  const commandCall = calls.find((call) => new URL(call.url).pathname.endsWith('/commands'));
  assert.deepEqual(commandCall.body, { kind: 'status', args: {} });
});

test('nc_vl_command: un owner inesistente accusa l\'OWNER, non il micro-device', async () => {
  // Stessa forma del difetto trovato su nc_send_cell: VL_TARGET_RE accetta
  // 16-64 esadecimali per l'owner, quindi un id ribattuto e troncato arriva
  // fino alla ricerca — e il messaggio unico mandava a cercare il device.
  const localId = 'a'.repeat(32); const nodeId = 'b'.repeat(32);
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { nodes: [] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, canReceive: true },
      ] } };
      if (p === '/api/vl-nodes' && call.method === 'GET') return { status: 200, json: {
        instanceId: localId, protocol: 'vl-node/1', nodes: [{
          id: `${localId}:VL-${nodeId}`, instanceId: localId, nodeId, cell: 'VL-bbbbbbbb',
          label: 'N900', online: true, canManage: true, generation: 1, capabilities: ['status'],
        }],
      } };
      return { status: 404, json: { error: p } };
    },
  });
  const troncato = localId.slice(0, 31);
  await srv.handleLine(rpc(220, 'tools/call', {
    name: 'nc_vl_command', arguments: { target: `${troncato}:VL-${nodeId}`, kind: 'status', args: {} },
  }));
  const testo = out.lines[0].result.content[0].text;
  assert.equal(out.lines[0].result.isError, true);
  assert.match(testo, /nessun owner con instanceId/);
  assert.match(testo, /copia l'id esatto da nc_vl_nodes/);
  assert.doesNotMatch(testo, /rete autorizzata/);

  // Owner giusto, device inesistente: qui il soggetto e' davvero il device.
  await srv.handleLine(rpc(221, 'tools/call', {
    name: 'nc_vl_command', arguments: { target: `${localId}:VL-${'e'.repeat(32)}`, kind: 'status', args: {} },
  }));
  assert.match(out.lines[1].result.content[0].text, /micro-device VL-e+ non trovato sull'owner/);
});

test('nc_vl_nodes: un owner remoto irraggiungibile e\' unreachable, non silenzioso', async () => {
  // I nodi VL SONO federati (vedi la NOTE in lib/proxy/federation.js): un owner
  // remoto va interrogato davvero. Se non risponde, deve comparire in
  // `unavailable` con la causa, non sparire dalla directory — un owner che
  // scompare in silenzio si legge come "non ha nodi", che e' un'altra cosa.
  const localId = 'a'.repeat(32); const remoteId = 'd'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') {
        return { status: 200, json: { nodes: [{ instanceId: remoteId, route: ['pixel'], label: 'Pixel' }] } };
      }
      if (p === '/api/vl-nodes' && call.method === 'GET') {
        return { status: 200, json: { instanceId: localId, protocol: 'vl-node/1', nodes: [] } };
      }
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(209, 'tools/call', { name: 'nc_vl_nodes', arguments: {} }));
  const directory = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(directory.unavailable, [{
    instanceId: remoteId, owner: 'Pixel', route: 'pixel', failure: 'unreachable',
  }]);
  // E la richiesta instradata parte davvero: un owner remoto va interrogato,
  // non dedotto.
  assert.equal(
    calls.some((call) => /\/api\/route\//.test(new URL(call.url).pathname)), true,
    'l\'owner remoto viene interrogato attraverso la federazione',
  );
});

test('nc_speak_group/status/stop: il bridge firma anche l orchestrazione multi-endpoint', async () => {
  const { srv, calls, dir } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => ({
      status: 200,
      json: call.url.includes('/groups/status/')
        ? { utteranceId: 'group-audio-1234', endpoints: [] }
        : { utteranceId: 'group-audio-1234', endpoints: [] },
    }),
  });
  await srv.handleLine(rpc(204, 'tools/call', {
    name: 'nc_speak_group', arguments: { group: 'studio', text: 'ciao', utteranceId: 'group-audio-1234' },
  }));
  await srv.handleLine(rpc(205, 'tools/call', {
    name: 'nc_speak_group_status', arguments: { utteranceId: 'group-audio-1234' },
  }));
  await srv.handleLine(rpc(206, 'tools/call', {
    name: 'nc_speak_group_stop', arguments: { utteranceId: 'group-audio-1234' },
  }));
  assert.equal(calls.length, 3);
  const secret = fs.readFileSync(path.join(dir, 'audio-bridge.key'), 'utf8').trim();
  const expected = [
    ['POST', '/api/audio/groups/speak'],
    ['GET', '/api/audio/groups/status/group-audio-1234'],
    ['POST', '/api/audio/groups/stop'],
  ];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]; const [method, apiPath] = expected[i];
    assert.equal(call.method, method);
    assert.equal(new URL(call.url).pathname, apiPath);
    const proof = bridgeAuth.verifyRequest({
      secret, method, path: apiPath, headers: call.headers,
      rawBody: call.rawBody === undefined ? '' : call.rawBody,
      nonceCache: bridgeAuth.createNonceCache(),
    });
    assert.deepEqual(proof, { ok: true, session: 'cloud-Dev' });
  }
  assert.deepEqual(calls[0].body, { group: 'studio', text: 'ciao', urgency: 'normal', utteranceId: 'group-audio-1234' });
  assert.deepEqual(calls[2].body, { utteranceId: 'group-audio-1234' });
});

test('nc_speak/status/stop: il bridge firma l origine, non mette la sessione nel body', async () => {
  const target = 'a'.repeat(32);
  const { srv, calls, dir } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => ({
      status: 200,
      json: {
        status: call.url.includes('/status/') ? 'spoken' : 'accepted',
        utteranceId: 'audio-test-1234',
      },
    }),
  });
  await srv.handleLine(rpc(201, 'tools/call', {
    name: 'nc_speak', arguments: { target, text: 'ciao', utteranceId: 'audio-test-1234' },
  }));
  await srv.handleLine(rpc(202, 'tools/call', {
    name: 'nc_speak_status', arguments: { utteranceId: 'audio-test-1234' },
  }));
  await srv.handleLine(rpc(203, 'tools/call', {
    name: 'nc_speak_stop', arguments: { target, utteranceId: 'audio-test-1234' },
  }));

  assert.equal(calls.length, 3);
  const secret = fs.readFileSync(path.join(dir, 'audio-bridge.key'), 'utf8').trim();
  const expected = [
    ['POST', '/api/audio/speak'],
    ['GET', '/api/audio/speak/status/audio-test-1234'],
    ['POST', '/api/audio/stop'],
  ];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const [method, apiPath] = expected[i];
    assert.equal(call.method, method);
    assert.equal(new URL(call.url).pathname, apiPath);
    assert.equal(call.body && call.body.session, undefined, 'la sessione non e una dichiarazione nel body');
    const proof = bridgeAuth.verifyRequest({
      secret, method, path: apiPath, headers: call.headers,
      rawBody: call.rawBody === undefined ? '' : call.rawBody,
      nonceCache: bridgeAuth.createNonceCache(),
    });
    assert.deepEqual(proof, { ok: true, session: 'cloud-Dev' });
  }
  assert.deepEqual(calls[0].body, { target, text: 'ciao', urgency: 'normal', utteranceId: 'audio-test-1234' });
  assert.equal(calls[1].rawBody, undefined, 'status firma il body vuoto e non invia JSON inutile');
  assert.deepEqual(calls[2].body, { target, utteranceId: 'audio-test-1234' });
});

test('nc_cells: aggrega celle locali e remote con id owner-qualified', async () => {
  const localId = 'a'.repeat(32); const remoteId = 'b'.repeat(32);
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { nodes: [{ instanceId: remoteId, route: ['pixel'], label: 'Pixel' }] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'codex.native', active: true, canReceive: true, lastSeen: 1 },
      ] } };
      if (p === '/api/route/pixel/_/cells') return { status: 200, json: { instanceId: remoteId, cells: [
        { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker', engine: 'claude.native', active: false, canReceive: false },
      ] } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(20, 'tools/call', { name: 'nc_cells', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.nodeId, localId);
  assert.deepEqual(j.cells.map((cell) => [cell.id, cell.route, cell.self, cell.canReceive]), [
    [`${localId}:Dev`, 'local', true, true],
    [`${remoteId}:Worker`, 'pixel', false, false],
  ]);
  assert.deepEqual(j.unavailable, []);
});

test('nc_cells: identifica esplicitamente il timeout del nodo locale', async () => {
  const localId = 'a'.repeat(32);
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { nodes: [] } };
      if (p === '/api/cells') throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(21, 'tools/call', { name: 'nc_cells', arguments: {} }));
  const directory = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(directory.cells, []);
  assert.deepEqual(directory.unavailable, [{
    instanceId: localId, owner: 'Local', route: 'local', local: true, failure: 'timeout',
  }]);
});

test('nc_cells: timeout strutturato non dipende dal testo localizzato della causa', () => {
  const raw = Object.assign(new Error('operazione lenta'), { name: 'TimeoutError' });
  const error = transportError('http://127.0.0.1:41820', raw);
  assert.equal(error.code, HTTP_TIMEOUT_CODE);
  assert.deepEqual(unavailableOwner({ instanceId: 'a'.repeat(32), label: 'Local', route: [] }, error), {
    instanceId: 'a'.repeat(32), owner: 'Local', route: 'local', local: true, failure: 'timeout',
  });
});

test('revoked owner omitted from topology is absent from nc_cells and nc_deck, not unavailable', async () => {
  const localId = 'a'.repeat(32); const pixelId = 'b'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { instanceId: localId, nodes: [] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, canReceive: true },
      ] } };
      if (p === '/api/decks') return { status: 200, json: { decks: [{
        name: 'main', revision: 1, layout: { columns: [{ width: 100, tiles: [
          { session: 'cloud-Dev', height: 50, fontSize: 14 },
          { session: 'cloud-Worker', ownerId: pixelId, node: 'pixel', height: 50, fontSize: 14 },
        ] }] },
      }] } };
      if (p === '/api/fleet/status') return { status: 200, json: { available: true, cells: [
        { cell: 'Dev', tmuxSession: 'cloud-Dev' },
      ] } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(201, 'tools/call', { name: 'nc_cells', arguments: {} }));
  const directory = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(directory.cells.map((cell) => cell.id), [`${localId}:Dev`]);
  assert.deepEqual(directory.unavailable, []);

  await srv.handleLine(rpc(202, 'tools/call', { name: 'nc_deck', arguments: {} }));
  const deck = JSON.parse(out.lines[1].result.content[0].text);
  assert.equal(deck.decks.length, 1);
  assert.deepEqual(deck.decks[0].members, [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', ownerId: localId, route: 'local', self: true },
  ]);
  assert.equal(calls.some((call) => /pixel/.test(new URL(call.url).pathname)), false,
    'authoritatively withdrawn owners are never probed through a stale route');
});

test('nc_cell_diagnostics: command locale + ultima causa bounded, senza interrogare la federazione', async () => {
  const localId = 'a'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-DevBis' },
    responder: (call) => {
      const u = new URL(call.url); const p = u.pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'DevBis', tmuxSession: 'cloud-DevBis', engine: 'codex-vl.native', active: true, canReceive: true },
        { instanceId: localId, cell: 'agy.native', tmuxSession: 'cloud-agy.native', engine: 'shell.local', active: false, canReceive: false },
      ] } };
      if (p === '/api/fleet/definitions') return { status: 200, json: { cells: [
        { id: 'agy.native', tmuxSession: 'cloud-agy.native', engine: 'shell.local', commands: { 'shell.local': 'agy' } },
      ] } };
      if (p === '/api/diagnostics/logs') return { status: 200, json: { records: [{
        seq: 7, ts: '2026-07-22T11:00:00.000Z', component: 'fleet', code: 'FLEET_ACTION_FAILED',
        message: 'must not escape', meta: {
          cell: 'agy.native', status: 500, code: 'SHELL_COMMAND_FAILED', phase: 'readiness', command: 'secret',
        },
      }], cursor: 7 } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(22, 'tools/call', {
    name: 'nc_cell_diagnostics', arguments: { target: `${localId}:agy.native` },
  }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j, {
    target: `${localId}:agy.native`, cell: 'agy.native', tmuxSession: 'cloud-agy.native',
    engine: 'shell.local', active: false,
    command: { configured: true, value: 'agy', redacted: false, truncated: false },
    lastFailure: {
      event: 'FLEET_ACTION_FAILED', at: '2026-07-22T11:00:00.000Z', status: 500,
      code: 'SHELL_COMMAND_FAILED', phase: 'readiness',
    },
  });
  assert.equal(JSON.stringify(j).includes('must not escape'), false);
  assert.equal(JSON.stringify(j).includes('secret'), false);
  assert.ok(calls.some((call) => new URL(call.url).pathname === '/api/fleet/definitions'));
  assert.ok(calls.every((call) => !/\/api\/(?:topology|route\/)/.test(new URL(call.url).pathname)));
});

test('nc_cell_diagnostics: rifiuta target remoto senza leggere topologia, definitions o logs', async () => {
  const localId = 'a'.repeat(32); const remoteId = 'b'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-DevBis' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'DevBis', tmuxSession: 'cloud-DevBis', active: true, canReceive: true },
      ] } };
      return { status: 500, json: { error: `unexpected ${p}` } };
    },
  });
  await srv.handleLine(rpc(23, 'tools/call', {
    name: 'nc_cell_diagnostics', arguments: { target: `${remoteId}:Worker` },
  }));
  assert.equal(out.lines[0].result.isError, true);
  assert.match(out.lines[0].result.content[0].text, /target remoto rifiutato/);
  assert.equal(calls.some((call) => /topology|\/api\/route\/|fleet\/definitions|diagnostics\/logs/.test(call.url)), false);
});

test('nc_cell_diagnostics helpers: redigono credential command e coercizzano cause ignote', () => {
  const command = commandForDiagnostics('deploy --token TOPSECRET OPENAI_API_KEY=plain-secret ZAI_API_KEY=sk_test_123456789');
  assert.equal(command.configured, true);
  assert.equal(command.redacted, true);
  assert.equal(command.value.includes('TOPSECRET'), false);
  assert.equal(command.value.includes('plain-secret'), false);
  assert.equal(command.value.includes('sk_test_123456789'), false);
  const failure = failureForDiagnostics({
    ts: '2026-07-22T11:00:00Z', component: 'fleet', code: 'FLEET_ACTION_FAILED',
    meta: { cell: 'Ops', status: 999, code: 'UNBOUNDED', phase: 'raw-path', payload: 'secret' },
  }, 'Ops');
  assert.deepEqual(failure, {
    event: 'FLEET_ACTION_FAILED', at: '2026-07-22T11:00:00Z', status: null,
    code: 'UNKNOWN', phase: 'UNKNOWN',
  });
});

test('commandForDiagnostics redigono le env maiuscole generiche (ZAIKEY/PASSWD/MYPASS)', () => {
  const command = commandForDiagnostics('run ZAIKEY=abc123456789 PASSWD=hunter2hunter2 MYPASS=hunter2hunter2 deploy');
  assert.equal(command.configured, true);
  assert.equal(command.redacted, true);
  // nessun segreto in chiaro
  for (const secret of ['abc123456789', 'hunter2hunter2']) {
    assert.equal(command.value.includes(secret), false, `secret leaked: ${secret}`);
  }
  // il nome della variabile e' preservato, il valore redatto (forma $1=[redacted])
  for (const name of ['ZAIKEY', 'PASSWD', 'MYPASS']) {
    assert.ok(command.value.includes(`${name}=[redacted]`), `missing redaction for ${name}`);
  }
});

test('commandForDiagnostics redigono per intero i valori env quotati (con spazi)', () => {
  const command = commandForDiagnostics('run DB_URL="postgres://u:secret@host/db space" next');
  assert.equal(command.redacted, true);
  assert.equal(command.value.includes('postgres://u:secret@host/db space'), false);
  assert.equal(command.value.includes('secret'), false);
  assert.ok(command.value.includes('DB_URL=[redacted]'));
});

test('commandForDiagnostics: la regola generica env non fa regredire le redazioni specifiche', () => {
  const command = commandForDiagnostics(
    'deploy --token TOPSECRET OPENAI_API_KEY=plain-secret Bearer xyz123 sk-test_1234567890abc',
  );
  assert.equal(command.redacted, true);
  for (const secret of ['TOPSECRET', 'plain-secret', 'xyz123', 'sk-test_1234567890abc']) {
    assert.equal(command.value.includes(secret), false, `regression: ${secret} leaked`);
  }
  assert.ok(command.value.includes('OPENAI_API_KEY=[redacted]'));
});

test('commandForDiagnostics: over-redaction benigno (NODE_ENV), shape e ACL invariate', () => {
  // comandi del tutto benigni risultano redacted:true: prezzo accettato per la
  // regola generica, coerente con lib/diagnostics/store.js. Il nome resta leggibile.
  const benign = commandForDiagnostics('NODE_ENV=production npm start');
  assert.equal(benign.redacted, true);
  assert.equal(benign.value.includes('production'), false);
  assert.ok(benign.value.includes('NODE_ENV=[redacted]'));
  assert.ok(benign.value.includes('npm start'));
  // la shape di output e' invariata
  assert.deepEqual(Object.keys(commandForDiagnostics('TOKEN=xyz')).sort(),
    ['configured', 'redacted', 'truncated', 'value']);
  // la redazione non tocca il registry tool: nc_cell_diagnostics resta read-only
  // e identity-gated (nessuna estensione di ACL/local-only).
  const diag = TOOLS.find((tool) => tool.name === 'nc_cell_diagnostics');
  assert.ok(diag, 'nc_cell_diagnostics presente');
  assert.equal(diag.annotations.readOnlyHint, true);
  assert.equal(TOOLS.length, 23, 'registry tool (23 tool: 20 + 3 lease child 2b)');
});

test('nc_send_cell: risolve sender e target dalla directory e restituisce receipt onesto', async () => {
  const localId = 'a'.repeat(32); const remoteId = 'b'.repeat(32);
  const messageId = '12345678-1234-1234-1234-123456789abc';
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' }, idFactory: () => messageId,
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { nodes: [{ instanceId: remoteId, route: ['pixel'], label: 'Pixel' }] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, canReceive: true },
      ] } };
      if (p === '/api/route/pixel/_/cells') return { status: 200, json: { instanceId: remoteId, cells: [
        { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker', active: true, canReceive: true },
      ] } };
      if (p === '/api/route/pixel/_/cells/send') return { status: 200, json: {
        id: messageId, status: 'submitted', at: 42,
        to: { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker' },
        note: 'transport only',
      } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(21, 'tools/call', {
    name: 'nc_send_cell', arguments: { target: `${remoteId}:Worker`, message: 'fai il debug' },
  }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j, {
    id: messageId, status: 'submitted', at: 42,
    to: { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker' }, note: 'transport only',
  });
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(new URL(post.url).pathname, '/api/route/pixel/_/cells/send');
  assert.deepEqual(post.body.from, { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev' });
  assert.deepEqual(post.body.to, { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker' });
});

// Una ricerca fallita deve dire QUALE delle tre cose e' andata storta, perche'
// portano a tre azioni diverse. Il messaggio unico ha gia' fatto il suo danno:
// un id ribattuto invece che copiato ha prodotto «non trovata nella rete
// autorizzata», e l'indagine e' finita sul canale di trasporto — che
// funzionava.
function srvPerRicerca({ cellePixel = true } = {}) {
  const localId = 'a'.repeat(32); const remoteId = 'b'.repeat(32);
  return makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    idFactory: () => '12345678-1234-1234-1234-123456789abc',
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/cells/send') return { status: 200, json: {
        id: '12345678-1234-1234-1234-123456789abc', status: 'submitted', at: 7,
        to: { instanceId: localId, cell: 'Fork', tmuxSession: 'cloud-Fork' },
      } };
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { nodes: [{ instanceId: remoteId, route: ['pixel'], label: 'Pixel' }] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, canReceive: true },
        { instanceId: localId, cell: 'Fork', tmuxSession: 'cloud-Fork', active: true, canReceive: true },
      ] } };
      if (p === '/api/route/pixel/_/cells') {
        return cellePixel
          ? { status: 200, json: { instanceId: remoteId, cells: [
            { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker', active: true, canReceive: true },
          ] } }
          // Il nodo e' autorizzato e in topologia, ma adesso non risponde.
          : { status: 502, json: { error: 'peer down' } };
      }
      return { status: 404, json: { error: p } };
    },
  });
}

async function erroreSend(srv, out, target) {
  await srv.handleLine(rpc(77, 'tools/call', { name: 'nc_send_cell', arguments: { target, message: 'x' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, true, 'deve essere un errore');
  return r.result.content[0].text;
}

test('nc_send_cell: un instanceId inesistente accusa il NODO, non la cella ne\' l\'autorizzazione', async () => {
  // Riproduce l'incidente: l'id del nodo locale con UN carattere in meno.
  // Passa `NODE_ID_RE` (16-64 esadecimali), quindi arriva fino alla ricerca.
  const localId = 'a'.repeat(32);
  const troncato = localId.slice(0, 31);
  assert.equal(troncato.length, 31);
  assert.ok(/^[a-f0-9]{16,64}$/.test(troncato), 'un id troncato supera ancora la validazione');
  const { srv, out } = srvPerRicerca();
  const testo = await erroreSend(srv, out, `${troncato}:Fork`);
  assert.match(testo, /nessun nodo con instanceId/);
  assert.match(testo, /copia l'id esatto da nc_cells/, 'deve dire cosa fare, non solo cosa manca');
  // Le due parole che hanno sviato l'indagine non devono comparire.
  assert.doesNotMatch(testo, /rete autorizzata/);
});

test('nc_send_cell: su un nodo NOTO l\'errore nomina la cella e il nodo', async () => {
  const localId = 'a'.repeat(32);
  const { srv, out } = srvPerRicerca();
  const testo = await erroreSend(srv, out, `${localId}:Inesistente`);
  assert.match(testo, /cella "Inesistente" non trovata sul nodo/);
  assert.match(testo, new RegExp(localId));
});

test('nc_send_cell: un nodo irraggiungibile si dichiara tale, non «non trovato»', async () => {
  // Distinguerlo conta: qui non c'e' niente da correggere nella
  // configurazione, c'e' un dispositivo da accendere.
  const remoteId = 'b'.repeat(32);
  const { srv, out } = srvPerRicerca({ cellePixel: false });
  const testo = await erroreSend(srv, out, `${remoteId}:Worker`);
  assert.match(testo, /non raggiungibile \(unreachable\)/);
  assert.match(testo, new RegExp(remoteId));
});

test('nc_send_cell: l\'id CORRETTO continua a risolvere una cella locale', async () => {
  // La guardia che impedisce di far passare i tre messaggi nuovi per una
  // regressione del percorso felice.
  const localId = 'a'.repeat(32);
  const { srv, out, calls } = srvPerRicerca();
  await srv.handleLine(rpc(78, 'tools/call', {
    name: 'nc_send_cell', arguments: { target: `${localId}:Fork`, message: 'ciao' },
  }));
  assert.equal(out.lines[0].result.isError, undefined, out.lines[0].result.content[0].text);
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(new URL(post.url).pathname, '/api/cells/send');
  assert.deepEqual(post.body.to, { instanceId: localId, cell: 'Fork', tmuxSession: 'cloud-Fork' });
});

test('nc_notify: POST /api/notify con Bearer + sessione da NEXUSCREW_MCP_SESSION', async () => {
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-a' },
    responder: () => ({ status: 200, json: { delivered: { ui: 2, push: 1 } } }),
  });
  await srv.handleLine(rpc(3, 'tools/call', {
    name: 'nc_notify', arguments: { title: 'fatto', urgency: 'high', lang: ' IT-it ' },
  }));
  const r = out.lines[0];
  assert.equal(r.result.isError, undefined);
  assert.deepEqual(JSON.parse(r.result.content[0].text), { delivered: { ui: 2, push: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4242/api/notify');
  assert.equal(calls[0].headers.authorization, 'Bearer tok-mcp');
  assert.deepEqual(calls[0].body, {
    title: 'fatto', urgency: 'high', lang: 'it-IT', session: 'cell-a',
  });
});

test('nc_notify: lang invalida fallisce localmente senza perdere una chiamata valida successiva', async () => {
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-a' },
    responder: () => ({ status: 200, json: { delivered: { ui: 0, push: 0 } } }),
  });
  await srv.handleLine(rpc(301, 'tools/call', {
    name: 'nc_notify', arguments: { title: 'bad', lang: 'xx' },
  }));
  assert.equal(out.lines[0].result.isError, true);
  assert.match(out.lines[0].result.content[0].text, /lang/);
  assert.equal(calls.length, 0);

  await srv.handleLine(rpc(302, 'tools/call', {
    name: 'nc_notify', arguments: { title: 'legacy' },
  }));
  assert.equal(out.lines[1].result.isError, undefined);
  assert.deepEqual(calls[0].body, { title: 'legacy', session: 'cell-a' });
});

test('identita cella: con $TMUX la sessione viene da display-message (execFile finto)', async () => {
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.equal(bin, 'tmux');
    assert.deepEqual(args, ['display-message', '-t', '%5', '-p', '#S']);
    cb(null, 'work-build\n');
  };
  const { srv, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%5' },
    execFileImpl,
    responder: () => ({ status: 200, json: { delivered: { ui: 0, push: 0 } } }),
  });
  await srv.handleLine(rpc(4, 'tools/call', { name: 'nc_notify', arguments: { title: 'x' } }));
  assert.equal(calls[0].body.session, 'work-build');
});

// --- nc_identity: diagnostica read-only, nessuna API/token call (P0) ---------
test('nc_identity: missing (nessun TMUX/NEXUSCREW_MCP_SESSION), NESSUNA chiamata HTTP/token', async () => {
  const { srv, out, calls } = makeSrv({ env: {} });
  await srv.handleLine(rpc(31, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const r = out.lines[0];
  assert.equal(r.result.isError, undefined); // non e' un errore tool
  const j = JSON.parse(r.result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined); // session solo se validata
  assert.equal(j.source, 'missing');
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_MISSING');
  assert.deepEqual(j.envPresence, { TMUX: false, TMUX_PANE: false, NEXUSCREW_MCP_SESSION: false });
  assert.deepEqual(j.requiredEnvVars, ['TMUX', 'TMUX_PANE', 'NEXUSCREW_MCP_SESSION']);
  assert.match(j.remediation, /--env-var/); // suggerimento senza valori
  assert.equal(calls.length, 0); // NESSUNA API HTTP
});

test('nc_identity: invalid (NEXUSCREW_MCP_SESSION presente ma non valida) -> code INVALID', async () => {
  const { srv, out, calls } = makeSrv({ env: { NEXUSCREW_MCP_SESSION: 'sessione non valida!' } });
  await srv.handleLine(rpc(32, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined);
  assert.equal(j.source, 'missing');
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_INVALID');
  assert.deepEqual(j.envPresence, { TMUX: false, TMUX_PANE: false, NEXUSCREW_MCP_SESSION: true });
  assert.equal(calls.length, 0);
});

test('nc_identity: fallback valido (no TMUX, NEXUSCREW_MCP_SESSION valido) -> source NEXUSCREW_MCP_SESSION', async () => {
  const { srv, out, calls } = makeSrv({ env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' } });
  await srv.handleLine(rpc(33, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cloud-Dev');
  assert.equal(j.source, 'NEXUSCREW_MCP_SESSION');
  assert.equal(j.code, 'OK');
  assert.equal(calls.length, 0);
});

test('nc_identity: tmux valido (TMUX set, display-message ok) -> source tmux', async () => {
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.deepEqual([bin, args], ['tmux', ['display-message', '-t', '%5', '-p', '#S']]);
    cb(null, 'work-build\n');
  };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%5' },
    execFileImpl,
  });
  await srv.handleLine(rpc(34, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'work-build');
  assert.equal(j.source, 'tmux');
  assert.equal(j.code, 'OK');
  assert.deepEqual(j.envPresence, { TMUX: true, TMUX_PANE: true, NEXUSCREW_MCP_SESSION: false });
  assert.equal(calls.length, 0);
});

test('nc_identity: tmux fallito + fallback valido -> source NEXUSCREW_MCP_SESSION (precedenza preservata)', async () => {
  const execFileImpl = (_bin, _args, _opts, cb) => cb(new Error('no server')); // tmux fallisce
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    execFileImpl,
  });
  await srv.handleLine(rpc(35, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cloud-Dev');
  assert.equal(j.source, 'NEXUSCREW_MCP_SESSION'); // caduto sul fallback
  assert.equal(j.code, 'OK');
  assert.equal(calls.length, 0);
});

test('nc_identity: risponde anche con token mancante (nessun readToken)', async () => {
  const dir = tmpdir();
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-x' },
    tokenPath: path.join(dir, 'inesistente'),
  });
  await srv.handleLine(rpc(36, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const r = out.lines[0];
  assert.equal(r.result.isError, undefined); // token mancante NON blocca nc_identity
  const j = JSON.parse(r.result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cell-x');
  assert.equal(j.code, 'OK');
  assert.equal(calls.length, 0); // NESSUNA chiamata HTTP / nessun readToken
});

test('resolveIdentity: sorgente/code osservabili senza cambiare resolveSession', async () => {
  // missing
  const missing = await resolveIdentity({ env: {}, tmuxBin: 'tmux', execFileImpl: () => { throw new Error('nope'); } });
  assert.equal(missing.session, null);
  assert.equal(missing.source, 'missing');
  assert.equal(missing.code, 'NEXUSCREW_MCP_IDENTITY_MISSING');
  // invalid (fallback presente ma non valido)
  const invalid = await resolveIdentity({ env: { NEXUSCREW_MCP_SESSION: ' ' }, tmuxBin: 'tmux', execFileImpl: () => { throw new Error('nope'); } });
  // ' '.trim() = '' -> fallbackPresent false -> MISSING (stringa vuota dopo trim non e' un segnale)
  assert.equal(invalid.code, 'NEXUSCREW_MCP_IDENTITY_MISSING');
  const invalidReal = await resolveIdentity({ env: { NEXUSCREW_MCP_SESSION: 'bad/session' }, tmuxBin: 'tmux', execFileImpl: () => { throw new Error('nope'); } });
  assert.equal(invalidReal.session, null);
  assert.equal(invalidReal.source, 'missing');
  assert.equal(invalidReal.code, 'NEXUSCREW_MCP_IDENTITY_INVALID');
  // fallback valido
  const fb = await resolveIdentity({ env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' }, tmuxBin: 'tmux', execFileImpl: () => { throw new Error('nope'); } });
  assert.equal(fb.session, 'cloud-Dev');
  assert.equal(fb.source, 'NEXUSCREW_MCP_SESSION');
  assert.equal(fb.code, 'OK');
  // resolveSession wrapper resta Promise<string|null>
  assert.equal(await resolveSession({ env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' }, tmuxBin: 'tmux', execFileImpl: () => {} }), 'cloud-Dev');
  assert.equal(await resolveSession({ env: {}, tmuxBin: 'tmux', execFileImpl: () => {} }), null);
});

test('nc_ask senza sessione: errore chiaro, NESSUNA chiamata HTTP', async () => {
  const { srv, out, calls } = makeSrv({ env: {} }); // no TMUX, no NEXUSCREW_MCP_SESSION
  await srv.handleLine(rpc(5, 'tools/call', { name: 'nc_ask', arguments: { question: 'procedo?' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /NEXUSCREW_MCP_SESSION/);
  // P0: codice stabile di identita nel messaggio umano, isError preservato.
  assert.match(r.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_MISSING/);
  assert.equal(calls.length, 0);
});

test('nc_ask con identita presente ma invalida usa il codice INVALID e non chiama HTTP', async () => {
  const { srv, out, calls } = makeSrv({ env: { NEXUSCREW_MCP_SESSION: 'bad/session' } });
  await srv.handleLine(rpc(51, 'tools/call', { name: 'nc_ask', arguments: { question: 'procedo?' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_INVALID/);
  assert.equal(calls.length, 0);
});

test('nc_ask con sessione: ritorna subito askId + nota', async () => {
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-b' },
    responder: (c) => {
      assert.equal(c.url, 'http://127.0.0.1:4242/api/asks');
      assert.deepEqual(c.body, { question: 'procedo?', options: ['si', 'no'], session: 'cell-b' });
      return { status: 201, json: { id: 'abc123' } };
    },
  });
  await srv.handleLine(rpc(6, 'tools/call', { name: 'nc_ask', arguments: { question: 'procedo?', options: ['si', 'no'] } }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.askId, 'abc123');
  assert.match(j.note, /incollat/);
});

test('nc_send_file: valida path sotto HOME e chiama /api/files/outbox', async () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, 'report.txt'), 'dati');
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-c', HOME: home },
    responder: () => ({ status: 200, json: { name: '20260711-1200_report.txt', box: 'outbox', size: 4 } }),
  });
  await srv.handleLine(rpc(7, 'tools/call', {
    name: 'nc_send_file', arguments: { path: path.join(home, 'report.txt'), caption: 'il report' },
  }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j, { name: '20260711-1200_report.txt', box: 'outbox' });
  assert.deepEqual(calls[0].body, { session: 'cell-c', path: path.join(home, 'report.txt'), caption: 'il report' });

  // fuori HOME -> errore locale, nessuna chiamata
  await srv.handleLine(rpc(8, 'tools/call', { name: 'nc_send_file', arguments: { path: '/etc/hostname' } }));
  assert.equal(out.lines[1].result.isError, true);
  assert.equal(calls.length, 1);
});

test('nc_status: sessioni compatte + fleet null se non disponibile', async () => {
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-a' },
    responder: (c) => {
      if (c.url.endsWith('/api/sessions')) {
        return { status: 200, json: { sessions: [{ name: 'cloud-Sys', attached: true, outbox: {} }, { name: 'work', attached: false }] } };
      }
      return { status: 200, json: { available: false } };
    },
  });
  await srv.handleLine(rpc(9, 'tools/call', { name: 'nc_status', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j.sessions, [{ name: 'cloud-Sys', active: true }, { name: 'work', active: false }]);
  assert.equal(j.fleet, null);
});

test('nc_deck: trova i deck propri e risolve celle locali/remote in ordine visuale', async () => {
  const localId = 'a'.repeat(32); const relayId = 'b'.repeat(32);
  const layout = (columns) => ({ columns });
  const tile = (session, node, ownerId) => ({ session, ...(node ? { node } : {}), ...(ownerId ? { ownerId } : {}), height: 50, fontSize: 14 });
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (c) => {
      const pathname = new URL(c.url).pathname;
      if (pathname === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (pathname === '/api/topology') return { status: 200, json: { instanceId: localId, nodes: [{ instanceId: relayId, name: 'relay', route: ['relay'] }] } };
      if (pathname === '/api/route/relay/_/decks') return { status: 200, json: { schemaVersion: 1, decks: [] } };
      if (pathname === '/api/route/relay/_/topology') return { status: 200, json: { instanceId: relayId, nodes: [] } };
      if (pathname === '/api/decks') {
        return {
          status: 200,
          json: {
            schemaVersion: 1,
            decks: [
              {
                name: 'main', revision: 2,
                layout: layout([
                  { width: 50, tiles: [tile('cloud-Dev'), tile('shell')] },
                  { width: 50, tiles: [tile('cloud-Auditor', 'relay', relayId)] },
                ]),
              },
              {
                name: 'research', revision: 1,
                layout: layout([{ width: 100, tiles: [tile('cloud-Dev')] }]),
              },
              {
                name: 'remote-only', revision: 0,
                layout: layout([{ width: 100, tiles: [tile('cloud-Dev', 'relay')] }]),
              },
            ],
          },
        };
      }
      if (pathname === '/api/fleet/status') {
        return { status: 200, json: { available: true, cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev' }] } };
      }
      if (pathname === '/api/route/relay/_/fleet/status') {
        return { status: 200, json: { available: true, cells: [{ cell: 'Auditor', tmuxSession: 'cloud-Auditor' }] } };
      }
      return { status: 404, json: { error: 'unexpected' } };
    },
  });

  await srv.handleLine(rpc(14, 'tools/call', { name: 'nc_deck', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j, {
    tmuxSession: 'cloud-Dev', nodeId: localId,
    decks: [
      {
        id: `${localId}:main`, name: 'main',
        owner: { instanceId: localId, route: 'local', label: 'Local' },
        members: [
          { cell: 'Dev', tmuxSession: 'cloud-Dev', ownerId: localId, route: 'local', self: true },
          { cell: 'Auditor', tmuxSession: 'cloud-Auditor', ownerId: relayId, route: 'relay', self: false },
          { cell: null, tmuxSession: 'shell', ownerId: localId, route: 'local', self: false },
        ],
      },
      {
        id: `${localId}:research`, name: 'research',
        owner: { instanceId: localId, route: 'local', label: 'Local' },
        members: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', ownerId: localId, route: 'local', self: true }],
      },
    ],
  });
  assert.deepEqual(new Set(calls.map((call) => new URL(call.url).pathname)), new Set([
    '/api/config', '/api/topology', '/api/decks',
    '/api/route/relay/_/decks', '/api/route/relay/_/topology',
    '/api/fleet/status', '/api/route/relay/_/fleet/status',
  ]));
});

test('nc_deck: scopre un deck posseduto da un nodo condiviso che contiene la cella locale', async () => {
  const localId = 'a'.repeat(32); const relayId = 'b'.repeat(32);
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (c) => {
      const pathname = new URL(c.url).pathname;
      if (pathname === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (pathname === '/api/topology') return { status: 200, json: { nodes: [{ instanceId: relayId, name: 'relay', route: ['relay'], label: 'Relay' }] } };
      if (pathname === '/api/decks') return { status: 200, json: { decks: [{ name: 'main', revision: 0, layout: { columns: [] } }] } };
      if (pathname === '/api/route/relay/_/topology') return { status: 200, json: { nodes: [] } };
      if (pathname === '/api/route/relay/_/decks') return { status: 200, json: { decks: [{
        name: 'shared', revision: 1, layout: { columns: [{ width: 1, tiles: [
          { session: 'cloud-Dev', ownerId: localId, height: 1, fontSize: 11 },
          { session: 'cloud-Research', ownerId: relayId, height: 1, fontSize: 11 },
        ] }] },
      }] } };
      if (pathname === '/api/fleet/status') return { status: 200, json: { available: true, cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev' }] } };
      if (pathname === '/api/route/relay/_/fleet/status') return { status: 200, json: { available: true, cells: [{ cell: 'Research', tmuxSession: 'cloud-Research' }] } };
      return { status: 404, json: { error: pathname } };
    },
  });
  await srv.handleLine(rpc(17, 'tools/call', { name: 'nc_deck', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.decks.length, 1);
  assert.deepEqual(j.decks[0], {
    id: `${relayId}:shared`, name: 'shared',
    owner: { instanceId: relayId, route: 'relay', label: 'Relay' },
    members: [
      { cell: 'Dev', tmuxSession: 'cloud-Dev', ownerId: localId, route: 'local', self: true },
      { cell: 'Research', tmuxSession: 'cloud-Research', ownerId: relayId, route: 'relay', self: false },
    ],
  });
});

test('nc_deck: senza identita tmux fallisce prima di leggere le API', async () => {
  const { srv, out, calls } = makeSrv({ env: {} });
  await srv.handleLine(rpc(15, 'tools/call', { name: 'nc_deck', arguments: {} }));
  assert.equal(out.lines[0].result.isError, true);
  assert.match(out.lines[0].result.content[0].text, /NEXUSCREW_MCP_SESSION/);
  // P0: codice stabile di identita nel messaggio umano, isError preservato.
  assert.match(out.lines[0].result.content[0].text, /NEXUSCREW_MCP_IDENTITY_MISSING/);
  assert.equal(calls.length, 0);
});

test('nc_deck: sessione fuori dai deck ritorna vuoto senza interrogare Fleet', async () => {
  const localId = 'a'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Other' },
    responder: (c) => {
      const pathname = new URL(c.url).pathname;
      if (pathname === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (pathname === '/api/topology') return { status: 200, json: { nodes: [] } };
      assert.equal(pathname, '/api/decks');
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          decks: [{
            name: 'main', revision: 0,
            layout: { columns: [{ width: 100, tiles: [{ session: 'cloud-Dev', height: 100, fontSize: 14 }] }] },
          }],
        },
      };
    },
  });
  await srv.handleLine(rpc(16, 'tools/call', { name: 'nc_deck', arguments: {} }));
  assert.deepEqual(JSON.parse(out.lines[0].result.content[0].text), {
    tmuxSession: 'cloud-Other', nodeId: localId, decks: [],
  });
  assert.equal(calls.length, 3);
});

test('garbage e protocollo: JSON rotto -> -32700, metodo ignoto -> -32601, tool ignoto -> -32602, MAI crash', async () => {
  const { srv, out } = makeSrv({ env: {} });
  await srv.handleLine('garbage{{{ non json');
  assert.equal(out.lines[0].error.code, -32700);
  assert.equal(out.lines[0].id, null);
  await srv.handleLine(JSON.stringify([1, 2, 3])); // batch/array: invalid request
  assert.equal(out.lines[1].error.code, -32600);
  await srv.handleLine(rpc(10, 'resources/list'));
  assert.equal(out.lines[2].error.code, -32601);
  await srv.handleLine(rpc(11, 'tools/call', { name: 'nc_boom', arguments: {} }));
  assert.equal(out.lines[3].error.code, -32602);
  // il server e' ancora vivo: ping risponde
  await srv.handleLine(rpc(12, 'ping'));
  assert.deepEqual(out.lines[4], { jsonrpc: '2.0', id: 12, result: {} });
});

// F6: il server accetta SOLO JSON-RPC 2.0 — versione assente/errata -> -32600.
test('jsonrpc version: assente o !== "2.0" -> -32600, notification valida resta no-op', async () => {
  const { srv, out } = makeSrv({ env: {} });
  // richiesta senza campo jsonrpc -> -32600 (prima rispondeva col result)
  await srv.handleLine(JSON.stringify({ id: 1, method: 'tools/list' }));
  assert.equal(out.lines[0].error.code, -32600);
  assert.equal(out.lines[0].id, 1);
  // versione sbagliata -> -32600
  await srv.handleLine(JSON.stringify({ jsonrpc: '1.0', id: 2, method: 'tools/list' }));
  assert.equal(out.lines[1].error.code, -32600);
  assert.equal(out.lines[1].id, 2);
  // notification NON 2.0 -> errore (il no-op vale solo per notification 2.0 valide)
  await srv.handleLine(JSON.stringify({ method: 'notifications/initialized' }));
  assert.equal(out.lines[2].error.code, -32600);
  assert.equal(out.lines[2].id, null);
  // notification 2.0 valida -> nessuna risposta; server ancora vivo
  await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(out.lines.length, 3);
  await srv.handleLine(rpc(3, 'ping'));
  assert.deepEqual(out.lines[3], { jsonrpc: '2.0', id: 3, result: {} });
});

test('token mancante: errore tool pulito (niente crash, niente segreti)', async () => {
  const dir = tmpdir();
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-a' },
    tokenPath: path.join(dir, 'assente'),
  });
  await srv.handleLine(rpc(13, 'tools/call', { name: 'nc_notify', arguments: { title: 'x' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /token/i);
});

// --- end-to-end: subcomando reale `nexuscrew mcp` via pipe stdio ---------------
test('subprocess: handshake + tools/call nc_notify contro server HTTP finto', async (t) => {
  const dir = tmpdir();
  const tokenPath = writeToken(dir, 'tok-e2e');

  // server HTTP finto locale (porta effimera) che registra la richiesta
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ delivered: { ui: 1, push: 0 } }));
    });
  });
  await new Promise((res) => fake.listen(0, '127.0.0.1', res));
  t.after(() => fake.close());

  const bin = path.join(__dirname, '..', 'bin', 'nexuscrew.js');
  // env ESPLICITO e minimale: niente TMUX, config file inesistente (isolato).
  const child = spawn(process.execPath, [bin, 'mcp'], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      NEXUSCREW_CONFIG_FILE: path.join(dir, 'config.json'),
      NEXUSCREW_PORT: String(fake.address().port),
      NEXUSCREW_TOKEN_FILE: tokenPath,
      NEXUSCREW_MCP_SESSION: 'cell-e2e',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill(); } catch (_) {} });

  const pending = new Map();
  const noId = [];
  let waitNoId = null;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== null && msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg); pending.delete(msg.id);
      } else {
        noId.push(msg);
        if (waitNoId) { waitNoId(); waitNoId = null; }
      }
    }
  });
  const call = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${rpc(id, method, params)}\n`);
  });

  const init = await call(1, 'initialize', { protocolVersion: '2026-01-01' });
  assert.equal(init.result.protocolVersion, '2026-01-01');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await call(2, 'tools/list');
  assert.equal(list.result.tools.length, 23);

  const notif = await call(3, 'tools/call', { name: 'nc_notify', arguments: { title: 'e2e ok' } });
  assert.deepEqual(JSON.parse(notif.result.content[0].text), { delivered: { ui: 1, push: 0 } });
  assert.equal(seen[0].url, '/api/notify');
  assert.equal(seen[0].auth, 'Bearer tok-e2e');
  assert.deepEqual(seen[0].body, { title: 'e2e ok', session: 'cell-e2e' });

  // garbage in mezzo allo stream: errore JSON-RPC, il processo NON muore
  const gp = new Promise((resolve) => { waitNoId = resolve; });
  child.stdin.write('!!!garbage!!!\n');
  await gp;
  assert.equal(noId[0].error.code, -32700);
  const pong = await call(4, 'ping');
  assert.deepEqual(pong.result, {});

  // chiusura pulita: stdin end -> exit 0
  const exit = new Promise((resolve) => child.on('exit', resolve));
  child.stdin.end();
  assert.equal(await exit, 0);
});

test('subprocess: EOF immediato non tronca una tools/call asincrona', async (t) => {
  const dir = tmpdir();
  const tokenPath = writeToken(dir, 'tok-eof');
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ delivered: { ui: 1, push: 0 } }));
      }, 50);
    });
  });
  await new Promise((res) => fake.listen(0, '127.0.0.1', res));
  t.after(() => fake.close());

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'nexuscrew.js'), 'mcp'], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      NEXUSCREW_CONFIG_FILE: path.join(dir, 'config.json'),
      NEXUSCREW_PORT: String(fake.address().port),
      NEXUSCREW_TOKEN_FILE: tokenPath,
      NEXUSCREW_MCP_SESSION: 'cell-eof',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill(); } catch (_) {} });

  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stdin.end([
    rpc(1, 'initialize', { protocolVersion: '2026-01-01' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    rpc(2, 'tools/call', { name: 'nc_notify', arguments: { title: 'EOF safe' } }),
    '',
  ].join('\n'));

  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(exitCode, 0);
  const messages = stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(messages.find((m) => m.id === 1)?.result?.serverInfo?.name, 'nexuscrew');
  const toolReply = messages.find((m) => m.id === 2);
  assert.deepEqual(JSON.parse(toolReply.result.content[0].text), { delivered: { ui: 1, push: 0 } });
});

// NC-R — aggiornare NexusCrew non aggiorna il bridge MCP di una cella gia' in
// piedi. Il sintomo e' crudele: si installa una correzione, si riprova, e si
// riceve l'errore VECCHIO. Chi lo subisce conclude che la correzione non
// funziona. E' successo il 2026-08-07 su rc.26, e ci e' voluto un giro intero
// per capirlo. Da qui in poi lo dice l'errore stesso.
test('un errore dice se il bridge e\' di una versione diversa dall\'hub', async () => {
  const nostra = require('../package.json').version;
  const { srv, out } = makeSrv({
    responder: (call) => (call.url.endsWith('/api/config')
      ? { status: 200, json: { version: '9.9.9' } }
      : { status: 500, json: { error: 'qualcosa e\' andato storto' } }),
  });
  await srv.handleLine(rpc(1, 'tools/call', { name: 'nc_status', arguments: {} }));
  const testo = JSON.stringify(out.lines[0]);

  assert.match(testo, /qualcosa e/, 'l\'errore originale resta il messaggio principale');
  assert.match(testo, /9\.9\.9/, 'deve nominare la versione dell\'hub');
  assert.match(testo, new RegExp(nostra.replace(/\./g, '\\.')), 'e la propria');
  assert.match(testo, /riavvia questa cella/, 'e dire cosa fare');
});

test('nessuna nota quando le due versioni coincidono', async () => {
  const nostra = require('../package.json').version;
  const { srv, out } = makeSrv({
    responder: (call) => (call.url.endsWith('/api/config')
      ? { status: 200, json: { version: nostra } }
      : { status: 500, json: { error: 'errore semplice' } }),
  });
  await srv.handleLine(rpc(1, 'tools/call', { name: 'nc_status', arguments: {} }));
  const testo = JSON.stringify(out.lines[0]);
  assert.match(testo, /errore semplice/);
  assert.doesNotMatch(testo, /riavvia questa cella/,
    'un avviso che compare sempre smette di essere letto');
});

test('se la verifica di versione fallisce, l\'errore originale esce intatto', async () => {
  // La nota e' un di piu': non deve MAI sostituire ne' mascherare la diagnosi
  // vera. Qui /api/config risponde 500 — come farebbe un hub piu' vecchio che
  // non espone quel campo, o un hub che sta ripartendo.
  const { srv, out } = makeSrv({
    responder: (call) => (call.url.endsWith('/api/config')
      ? { status: 500, json: {} }
      : { status: 403, json: { error: 'permesso negato' } }),
  });
  await srv.handleLine(rpc(1, 'tools/call', { name: 'nc_status', arguments: {} }));
  const testo = JSON.stringify(out.lines[0]);
  assert.match(testo, /permesso negato/);
  assert.doesNotMatch(testo, /riavvia questa cella/);
});

// --- P0: identità fail-closed — pane stantio (prima stesura + rifinitura) ---
// Modello tmux vero (misurato su 3.4 dall'audit): senza `-t` il CLI risolve il
// pane dall'ENVIRON DEL PROCESSO FIGLIO; se quel pane è morto (environ stale)
// ricade sul CLIENT ATTACHED attivo e risponde rc=0 col nome di quel client —
// l'incidente di partenza. Con `-t $TMUX_PANE` la query è deterministica: un
// pane morto risponde rc=0 con stdout VUOTO, e il vuoto è il segnale dello
// stantio (STALE_PANE). Se tmux e NEXUSCREW_MCP_SESSION sono entrambi validi
// ma divergono, l'identità è ambigua (SESSION_MISMATCH).
test('P0: TMUX_PANE inesistente -> identita NON attribuita (fail-closed, STALE_PANE)', async () => {
  // Finto FEDELE al tmux reale (3.4, probe A1/A2 dell'audit): un pane morto con
  // -t risponde rc=0 con stdout VUOTO, non un errore. Il rilevamento dello
  // stantio deve basarsi sulla stringa vuota.
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.equal(bin, 'tmux');
    if (args[0] === 'display-message' && args[1] === '-t' && args[2] === '%999') {
      cb(null, '\n'); // pane morto: rc=0, stdout vuoto
    } else {
      cb(new Error('argv inatteso: ' + JSON.stringify(args)));
    }
  };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%999' },
    execFileImpl,
  });
  await srv.handleLine(rpc(37, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined);
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_STALE_PANE');
  assert.equal(calls.length, 0);
});

test('P0: TMUX presente ma TMUX_PANE assente -> identita NON attribuita (fail-closed, STALE_PANE)', async () => {
  // Senza TMUX_PANE il pane non è targetizzabile: NESSUNA chiamata a tmux è
  // attesa — il finto fallisce se viene toccato.
  const execFileImpl = () => { throw new Error('tmux non doveva essere chiamato senza TMUX_PANE'); };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0' }, // niente TMUX_PANE
    execFileImpl,
  });
  await srv.handleLine(rpc(38, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined);
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_STALE_PANE');
  assert.equal(calls.length, 0);
});

test('P0: TMUX_PANE malformato -> STALE_PANE, NESSUNA chiamata tmux (il valore non parte mai)', async () => {
  const execFileImpl = () => { throw new Error('tmux non doveva essere chiamato con TMUX_PANE malformato'); };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '5; rm -rf /' }, // senza %: malformato
    execFileImpl,
  });
  await srv.handleLine(rpc(39, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined);
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_STALE_PANE');
  assert.equal(calls.length, 0);
});

test('P0: pane VIVO di un\'altra sessione + NEXUSCREW_MCP_SESSION divergente -> NON attribuire (mismatch)', async () => {
  // Probe S3 dell'audit: TMUX_PANE=%21 (pane vivo di cloud-Dev) risolve
  // cloud-Dev via tmux anche quando la cella è un'altra (env dice cloud-Research).
  // Due fonti valide in disaccordo: l'identità è ambigua -> fail-closed.
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.equal(bin, 'tmux');
    assert.deepEqual(args, ['display-message', '-t', '%21', '-p', '#S']);
    cb(null, 'cloud-Dev\n'); // nome della sessione a cui il pane APPARTIENE
  };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%21', NEXUSCREW_MCP_SESSION: 'cloud-Research' },
    execFileImpl,
  });
  await srv.handleLine(rpc(44, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined);
  assert.equal(j.source, 'session-mismatch');
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_SESSION_MISMATCH');
  assert.equal(calls.length, 0);
});

test('P0: pane vivo ma client attached altrove -> display -t risponde col nome DEL PANE (attribuzione corretta)', async () => {
  // Con -t il nome arriva dal pane TARGET: indipendente dal client attached e
  // dall'environ ereditato dal figlio. È il caso che il no-t su environ stale
  // degrada al client attached, attribuendo la sessione sbagliata.
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.equal(bin, 'tmux');
    assert.deepEqual(args, ['display-message', '-t', '%5', '-p', '#S']);
    cb(null, 'cloud-CheVaLentissimo\n'); // sessione del PANE %5
  };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%5' },
    execFileImpl,
  });
  await srv.handleLine(rpc(40, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cloud-CheVaLentissimo');
  assert.equal(j.source, 'tmux');
  assert.equal(j.code, 'OK');
  assert.equal(calls.length, 0);
});

test('P0: display-message in errore (tmux rotto) + fallback valido -> source NEXUSCREW_MCP_SESSION (precedenza storica)', async () => {
  // rc!=0 NON è il percorso dello stantio (il pane morto risponde rc=0 vuoto):
  // un errore qui è tmux irraggiungibile/rotto, e vale il comportamento storico.
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.equal(bin, 'tmux');
    assert.deepEqual(args, ['display-message', '-t', '%5', '-p', '#S']);
    cb(new Error('tmux rotto'));
  };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%5', NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    execFileImpl,
  });
  await srv.handleLine(rpc(41, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cloud-Dev');
  assert.equal(j.source, 'NEXUSCREW_MCP_SESSION'); // precedenza preservata
  assert.equal(j.code, 'OK');
  assert.equal(calls.length, 0);
});

test('P0: display-message in errore (tmux rotto), senza fallback -> INVALID (storico), NON STALE_PANE', async () => {
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.equal(bin, 'tmux');
    assert.deepEqual(args, ['display-message', '-t', '%5', '-p', '#S']);
    cb(new Error('tmux rotto'));
  };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%5' },
    execFileImpl,
  });
  await srv.handleLine(rpc(42, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined);
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_INVALID'); // segnale presente, tmux rotto
  assert.equal(calls.length, 0);
});

// --- identita': il fallimento non resta cacheato a vita (Area 1, boot) ------
// Il caso reale: il server MCP parte in un daemon avviato da systemd PRIMA che
// tmux sia raggiungibile; display-message fallisce, e con la cache a vita
// l'identita' restava assente anche dopo che tmux era su.
test('identita: fallimento al boot non resta bloccato — retry dopo la finestra (revival)', async () => {
  let tmuxUp = false;
  const execFileImpl = (_bin, _args, _opts, cb) => {
    if (!tmuxUp) return cb(new Error('connect failed'));
    cb(null, 'cloud-Revived\n');
  };
  const { srv, out } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%7' },
    execFileImpl,
    identityRetryMs: 5,
  });
  await srv.handleLine(rpc(61, 'tools/call', { name: 'nc_identity', arguments: {} }));
  let j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, false);
  // Contratto storico: TMUX presente + tmux irraggiungibile -> INVALID
  // (segnale di identita' presente ma non risolvibile), non MISSING.
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_INVALID');
  tmuxUp = true; // il server tmux parte DOPO il primo tentativo
  await new Promise((r) => setTimeout(r, 20)); // oltre la finestra di retry
  await srv.handleLine(rpc(62, 'tools/call', { name: 'nc_identity', arguments: {} }));
  j = JSON.parse(out.lines[1].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cloud-Revived'); // il fallimento NON ha bloccato la risoluzione
  assert.equal(j.code, 'OK');
});

// Controllo negativo del revival: dentro la finestra di anti-hammering il
// fallimento resta cacheato — un tmux rotto non esegue display-message per
// ogni tool call. Il revival esiste SOLO oltre la finestra.
test('identita: anti-hammering — dentro la finestra NON si ri-esegue display-message', async () => {
  let calls = 0;
  const execFileImpl = (_bin, _args, _opts, cb) => {
    calls += 1;
    cb(new Error('connect failed'));
  };
  const { srv, out } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%8' },
    execFileImpl,
    identityRetryMs: 60_000,
  });
  await srv.handleLine(rpc(63, 'tools/call', { name: 'nc_identity', arguments: {} }));
  await srv.handleLine(rpc(64, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j1 = JSON.parse(out.lines[0].result.content[0].text);
  const j2 = JSON.parse(out.lines[1].result.content[0].text);
  assert.equal(j1.identified, false);
  assert.equal(j2.identified, false);
  assert.equal(calls, 1); // UNA sola execFile per due chiamate dentro la finestra
});

// --- il tool bloccato nomina la causa, non piu' il solo MISSING generico ----
// (Area 1: nc_identity distingueva STALE_PANE, ma l'errore del tool che si
// bloccava riduceva tutto a MISSING — chi leggeva andava a allowlistare
// variabili che erano gia' allowlistate.)
test('tool bloccato nomina la causa STALE_PANE (pane morto, non MISSING generico)', async () => {
  // tmux 3.4, -t su pane morto: rc=0 e stdout VUOTO — il segnale dello stantio.
  const execFileImpl = (_bin, _args, _opts, cb) => cb(null, '\n');
  const { srv, out } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%9' },
    execFileImpl,
    identityRetryMs: 60_000,
  });
  await srv.handleLine(rpc(65, 'tools/call', { name: 'nc_ask', arguments: { question: 'x' } }));
  const r = out.lines[0].result;
  assert.equal(r.isError, true);
  const msg = r.content[0].text;
  assert.match(msg, /\[NEXUSCREW_MCP_IDENTITY_STALE_PANE\]/);
  assert.match(msg, /pane tmux/); // la causa e' nominata nel messaggio del tool
  assert.equal(/NEXUSCREW_MCP_IDENTITY_MISSING/.test(msg), false);
});

test('tool bloccato nomina la causa SESSION_MISMATCH (fonti discordi)', async () => {
  const execFileImpl = (_bin, _args, _opts, cb) => cb(null, 'cloud-Real\n');
  const { srv, out } = makeSrv({
    env: {
      TMUX: '/tmp/fake-tmux,1,0',
      TMUX_PANE: '%10',
      NEXUSCREW_MCP_SESSION: 'cloud-Altra',
    },
    execFileImpl,
    identityRetryMs: 60_000,
  });
  await srv.handleLine(rpc(66, 'tools/call', { name: 'nc_ask', arguments: { question: 'x' } }));
  const r = out.lines[0].result;
  assert.equal(r.isError, true);
  const msg = r.content[0].text;
  assert.match(msg, /\[NEXUSCREW_MCP_IDENTITY_SESSION_MISMATCH\]/);
  assert.match(msg, /sessioni diverse/);
});
