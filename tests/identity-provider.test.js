'use strict';
// Canale produttivo del bridge MCP: il proof child authority-backed persistito
// accanto al token e' la sola fonte del contesto shared. L'env seleziona il
// file del canale, MAI l'identita': quella arriva dal proof verificato online.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createMcpIdentityProvider, persistIdentityChannel, identityChannelPath,
} = require('../lib/mcp/identity-provider.js');
const { normalizeIdentityContext } = require('../lib/mcp/identity-schema.js');

function mondo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-idprov-'));
  const tokenPath = path.join(home, 'token');
  fs.writeFileSync(tokenPath, 'fixture-token\n', { mode: 0o600 });
  return { home, tokenPath };
}

const PROOF = {
  kind: 'child', cellId: 'Dev', incarnationId: 'ab'.repeat(8), jti: 'c'.repeat(16),
  issuedAt: 1, expiresAt: 61_000, proof: 'd'.repeat(64),
};

test('identity provider: canale assente -> nessun provider, percorso legacy invariato', () => {
  const { tokenPath } = mondo();
  assert.equal(createMcpIdentityProvider({
    config: { port: 4242, tokenPath }, env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
  }), null);
});

test('identity provider: introspezione online costruisce il contesto verified', async () => {
  const { tokenPath } = mondo();
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const calls = [];
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath }, env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    now: () => 30_000,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return {
        ok: true, status: 200,
        json: async () => ({
          status: 'live', identityMode: 'authority', instanceId: 'a'.repeat(32),
          cellId: 'Dev', tmuxSession: 'cloud-Dev', incarnationId: PROOF.incarnationId,
          issuedAt: 1, expiresAt: 61_000,
        }),
      };
    },
  });
  assert.ok(provider, 'canale presente: il provider produttivo deve esistere');
  const raw = await provider({ tool: 'nc_identity' });
  const context = normalizeIdentityContext(raw, { now: () => 30_000 });
  assert.equal(context.cellId, 'Dev');
  assert.equal(context.origin, 'daemon');
  assert.equal(context.kind, 'mcp-v1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/lease\/introspect$/);
  assert.deepEqual(calls[0].body, { proof: PROOF });
  assert.equal(provider.currentProof().jti, PROOF.jti);
});

test('identity provider: introspezione negata o scaduta -> verified false, fail-closed', async () => {
  const { tokenPath } = mondo();
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const liveWithoutInstanceId = {
    status: 'live', identityMode: 'authority', cellId: 'Dev', tmuxSession: 'cloud-Dev',
    incarnationId: PROOF.incarnationId, issuedAt: 1, expiresAt: 61_000,
  };
  for (const json of [
    { status: 'expired' },
    { status: 'denied', reason: 'legacy-registration' },
    liveWithoutInstanceId,
  ]) {
    const provider = createMcpIdentityProvider({
      config: { port: 4242, tokenPath }, env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => json }),
    });
    const raw = await provider({ tool: 'nc_identity' });
    assert.equal(raw.verified, false);
    assert.throws(() => normalizeIdentityContext(raw), /non verificato/);
  }
});

test('identity provider: persist aggiorna il canale e la sessione discordante è rifiutata', () => {
  const { tokenPath } = mondo();
  const first = persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  assert.equal(first, true);
  assert.equal(path.basename(identityChannelPath({ tokenPath, session: 'cloud-Dev' })), 'cloud-Dev.json');
  const hostile = persistIdentityChannel({
    tokenPath, session: 'cloud-Research', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  assert.equal(hostile, false, 'il canale non puo nascere con sessione di un altra cella');
  const rotated = { ...PROOF, jti: 'e'.repeat(16) };
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: rotated, expiresAt: 61_500,
  });
  const onDisk = JSON.parse(fs.readFileSync(identityChannelPath({ tokenPath, session: 'cloud-Dev' }), 'utf8'));
  assert.equal(onDisk.proof.jti, rotated.jti);
  assert.equal((fs.statSync(identityChannelPath({ tokenPath, session: 'cloud-Dev' })).mode & 0o777), 0o600);
});
