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

// --- C8-ter: fonte verified-env con precedenza assoluta e fail-closed -------

const OWNER = 'a'.repeat(32);

function verifiedEnv(overrides = {}) {
  return {
    NEXUSCREW_VERIFIED_ENV_VERSION: '1',
    NEXUSCREW_VERIFIED_OWNER_INSTANCE_ID: OWNER,
    NEXUSCREW_VERIFIED_CELL_ID: 'Dev',
    NEXUSCREW_VERIFIED_INCARNATION_ID: PROOF.incarnationId,
    NEXUSCREW_VERIFIED_BINDING_ID: 'binding-x',
    NEXUSCREW_VERIFIED_ORIGIN: 'local_tui',
    ...overrides,
  };
}

function liveOut(overrides = {}) {
  return {
    status: 'live', identityMode: 'authority', instanceId: OWNER,
    cellId: 'Dev', tmuxSession: 'cloud-Dev', incarnationId: PROOF.incarnationId,
    issuedAt: 1, expiresAt: 61_000, ...overrides,
  };
}

function fetchOk(out) {
  return async () => ({ ok: true, status: 200, json: async () => out });
}

test('verified-env: metadati coerenti -> contesto verified con incarnation del binding', async () => {
  const { tokenPath } = mondo();
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv(), now: () => 30_000, fetchImpl: fetchOk(liveOut()),
  });
  assert.ok(provider, 'metadati verified presenti: il provider deve esistere');
  assert.equal(provider.identitySource, 'verified-env');
  const raw = await provider({ tool: 'nc_identity' });
  const context = normalizeIdentityContext(raw, { now: () => 30_000 });
  assert.equal(context.cellId, 'Dev');
  assert.equal(context.verified, true);
  assert.equal(provider.currentProof().incarnationId, PROOF.incarnationId);
});

test('verified-env: version != 1 -> VERIFIED_ENV_INVALID, MAI la sessione legacy', async () => {
  const { tokenPath } = mondo();
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv({ NEXUSCREW_VERIFIED_ENV_VERSION: '2', NEXUSCREW_MCP_SESSION: 'cloud-Dev' }),
    now: () => 30_000, fetchImpl: fetchOk(liveOut()),
  });
  await assert.rejects(() => provider(), (e) => e.code === 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID');
});

test('verified-env: owner diverso dall istanza locale -> fail-closed', async () => {
  const { tokenPath } = mondo();
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv({ NEXUSCREW_VERIFIED_OWNER_INSTANCE_ID: 'b'.repeat(32) }),
    now: () => 30_000, fetchImpl: fetchOk(liveOut()),
  });
  await assert.rejects(() => provider(), (e) => e.code === 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID');
});

test('verified-env: cella non mappabile a nessuna sessione -> fail-closed', async () => {
  const { tokenPath } = mondo();
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv({ NEXUSCREW_VERIFIED_CELL_ID: 'no space allowed' }),
    now: () => 30_000, fetchImpl: fetchOk(liveOut()),
  });
  assert.ok(provider, 'metadati presenti: il provider resta in piedi per fallire closed');
  await assert.rejects(() => provider(), (e) => e.code === 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID');
});

test('verified-env: canale della sessione derivata assente -> fail-closed', async () => {
  const { tokenPath } = mondo(); // nessun canale persistito
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv(), now: () => 30_000, fetchImpl: fetchOk(liveOut()),
  });
  await assert.rejects(() => provider(), (e) => e.code === 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID');
});

test('verified-env: introspezione con incarnation mismatch -> fail-closed', async () => {
  const { tokenPath } = mondo();
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv(), now: () => 30_000,
    fetchImpl: fetchOk(liveOut({ incarnationId: 'f'.repeat(16) })),
  });
  await assert.rejects(() => provider(), (e) => e.code === 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID');
});

test('verified-env: introspezione non live (stale) -> fail-closed', async () => {
  const { tokenPath } = mondo();
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv(), now: () => 30_000,
    fetchImpl: fetchOk(liveOut({ status: 'registered' })),
  });
  await assert.rejects(() => provider(), (e) => e.code === 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID');
});

test('verified-env: authority irraggiungibile -> AUTHORITY_UNAVAILABLE (codice C9)', async () => {
  const { tokenPath } = mondo();
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv(), now: () => 30_000,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => provider(), (e) => e.code === 'NEXUSCREW_MCP_IDENTITY_AUTHORITY_UNAVAILABLE');
});

test('verified-env: NEXUSCREW_MCP_SESSION valido presente MAI usato come fallback', async () => {
  const { tokenPath } = mondo();
  // canale presente SOLO per la sessione legacy: se il codice provasse il
  // fallback, l'introspezione live su quella sessione costruirebbe il contesto.
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv({
      NEXUSCREW_VERIFIED_CELL_ID: 'Other',
      NEXUSCREW_VERIFIED_INCARNATION_ID: 'e'.repeat(16),
      NEXUSCREW_MCP_SESSION: 'cloud-Dev',
    }),
    now: () => 30_000, fetchImpl: fetchOk(liveOut()),
  });
  await assert.rejects(() => provider(), (e) => e.code === 'NEXUSCREW_MCP_IDENTITY_VERIFIED_ENV_INVALID');
});

test('verified-env: canale per la sessione derivata dalla cella, non dalla legacy', async () => {
  const { tokenPath } = mondo();
  // Due canali: quello della sessione legacy (cloud-Other) e quello della
  // cella derivata dai metadati (cloud-Dev). L'introspezione deve usare il
  // proof della sessione derivata, MAI quello della sessione legacy.
  persistIdentityChannel({
    tokenPath, session: 'cloud-Other', cellId: 'Other',
    proof: { ...PROOF, cellId: 'Other', incarnationId: '9'.repeat(16) }, expiresAt: 61_000,
  });
  persistIdentityChannel({
    tokenPath, session: 'cloud-Dev', cellId: 'Dev', proof: PROOF, expiresAt: 61_000,
  });
  const seenProofs = [];
  const fetchImpl = async (url, init = {}) => {
    seenProofs.push(JSON.parse(init.body).proof);
    return { ok: true, status: 200, json: async () => liveOut() };
  };
  const provider = createMcpIdentityProvider({
    config: { port: 4242, tokenPath, identityOwnerInstanceId: OWNER },
    env: verifiedEnv({ NEXUSCREW_MCP_SESSION: 'cloud-Other' }),
    now: () => 30_000, fetchImpl,
  });
  assert.ok(provider);
  const raw = await provider({ tool: 'nc_identity' });
  const context = normalizeIdentityContext(raw, { now: () => 30_000 });
  assert.equal(context.verified, true);
  assert.deepEqual(seenProofs, [PROOF], 'esattamente il proof del canale derivato dalla cella');
});
