'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { createMcpServer } = require('../lib/mcp/server.js');
const { leaseRoutes } = require('../lib/fleet/lease-routes.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const net = require('node:net');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('MCP register attraversa HTTP e lease manager reali in authority mode', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lease-mcp-real-'));
  const tokenPath = path.join(home, 'token');
  fs.writeFileSync(tokenPath, 'fixture-token\n', { mode: 0o600 });
  const authority = createIdentityAuthority({
    dir: path.join(home, 'identity'), daemonCredential: 'daemon-credential',
    launcherCredential: 'launcher-credential', subjectResolver: () => true,
  });
  const tuple = {
    ownerInstanceId: 'owner-a', cellId: 'Dev', incarnationId: 'incarnation-a', launchEpoch: 'epoch-a',
  };
  const challenge = authority.registerDaemonChallenge({
    daemonCredential: 'daemon-credential', audience: 'nexuscrew-lease',
    daemonBootId: 'boot-a', connectionId: 'connection-a',
  });
  const grant = authority.issueLaunchGrant({
    launcherCredential: 'launcher-credential', challenge: challenge.challenge, subject: tuple,
  });
  const identity = authority.issueChallengeProof({
    launchGrant: grant.grant, challenge: challenge.challenge,
  });
  const manager = createLeaseManager({ home, log: () => {}, identityAuthority: authority });
  const lease = await manager.track('Dev');
  tuple.launchEpoch = lease.launchEpoch;
  assert.equal(manager.setLaunchSubject('Dev', tuple), true);
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/lease', leaseRoutes({
    fleetP: Promise.resolve({ available: true, lease: manager, identityAuthority: authority }),
    identityMode: 'authority',
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const lines = [];
  const mcp = createMcpServer({
    output: { write: (s) => { for (const line of String(s).split('\n')) if (line.trim()) lines.push(JSON.parse(line)); } },
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    config: { port: server.address().port, tokenPath, tmuxBin: 'tmux' },
    identityContextProvider: async () => {
      const now = Date.now();
      return {
        version: '1', kind: 'mcp-v1', verified: true, mode: 'shared',
        bindingId: 'binding-real', ownerInstanceId: 'owner-a', cellId: 'Dev',
        tmuxSession: 'cloud-Dev', connectionId: 'connection-a', threadId: 'thread-a',
        origin: 'local_tui', audience: 'nexuscrew-mcp', scopes: ['mcp:tools/call'],
        issuedAt: now - 1000, notBefore: now - 1000, expiresAt: now + 60_000,
      };
    },
    errlog: () => {},
  });
  try {
    await mcp.handleLine(rpc(1, 'initialize', { protocolVersion: '2025-03-26' }));
    assert.equal(lines[0].result.serverInfo.name, 'nexuscrew');
    lines.length = 0;
    await mcp.handleLine(rpc(2, 'tools/call', {
      name: 'nc_lease_register', arguments: { proof: identity.proof },
    }));
    const result = lines[0].result;
    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.status, 'registered');
    assert.equal(body.proof.kind, 'child');

    const socketPath = path.join(home, 'challenge-pair.sock');
    const pairServer = net.createServer();
    const connected = new Promise((resolve) => pairServer.once('connection', resolve));
    await new Promise((resolve) => pairServer.listen(socketPath, resolve));
    const challengeClient = net.createConnection(socketPath);
    const [serverSide] = await Promise.all([
      connected,
      new Promise((resolve) => challengeClient.once('connect', resolve)),
    ]);
    assert.equal(manager.attachInitial('Dev', serverSide, { generation: 0 }), true);
    const relayed = new Promise((resolve) => {
      let buffer = '';
      challengeClient.on('data', (chunk) => {
        buffer += String(chunk);
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        resolve(JSON.parse(buffer.slice(0, nl)));
      });
    });
    const now = Date.now();
    challengeClient.write(`${JSON.stringify({
      type: 'challengeProof',
      requestId: 'mcp-init',
      generation: 0,
      challenge: {
        version: 1,
        audience: 'daemon/connection-real',
        daemonBootId: 'boot-real',
        connectionId: 'connection-real',
        nonce: 'e'.repeat(64),
        issuedAt: now,
        expiresAt: now + 15000,
      },
    })}\n`);
    const relay = await relayed;
    assert.equal(relay.ok, true);
    assert.equal(relay.proof.incarnationId, body.incarnationId);
    challengeClient.destroy();
    pairServer.close();
  } finally {
    manager.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
