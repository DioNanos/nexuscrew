'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { identityRoutes } = require('../lib/identity/routes.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');

const SERVICE_CREDENTIAL = 'test-service-credential';
const CELL = 'Dev';
const INSTANCE_ID = '36b876f26ed141bae485dd75437704ca';

async function createFixture({
  identityMode = 'authority',
  rateCfg = { max: 5, windowMs: 60_000 },
  startTick = 50_000,
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'id-challenge-test-'));
  const clock = { t: startTick };
  const now = () => clock.t;

  const authority = createIdentityAuthority({
    dir: path.join(home, 'identity'),
    serviceCredential: SERVICE_CREDENTIAL,
    now,
  });

  const leaseMgr = createLeaseManager({ home, log: () => {} }, { now });
  await leaseMgr.track(CELL);
  const reg = leaseMgr.childRegister(CELL, { authority: true });
  const cellProof = reg.proof;

  const fleetP = Promise.resolve({
    available: true,
    lease: leaseMgr,
    identityAuthority: authority,
  });

  const app = express();
  app.use('/api/identity', identityRoutes({
    fleetP,
    identityAuthority: authority,
    identityMode,
    instanceId: INSTANCE_ID,
    serviceCredential: SERVICE_CREDENTIAL,
    rateCfg,
    now,
  }));

  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/api/identity/challenge-proof`;
  return {
    home,
    clock,
    now,
    authority,
    leaseMgr,
    cellProof,
    url,
    close: () => new Promise((res) => {
      leaseMgr.close();
      server.close(() => {
        try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
        res();
      });
    }),
  };
}

function validChallenge({
  version = '1',
  connectionId = 'conn-001',
  daemonBootId = 'boot-001',
  audience = null,
  nonce = 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  issuedAt = '2026-09-06T03:00:00.000Z',
  expiresAt = '2026-09-06T03:00:15.000Z',
} = {}) {
  return {
    version,
    connectionId,
    daemonBootId,
    audience: audience || `daemon/${connectionId}`,
    nonce,
    issuedAt,
    expiresAt,
  };
}

async function postProof(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

test('positivo: challenge-proof emesso con successo e verificabile da verifyChallengeProof', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  try {
    const challenge = validChallenge();
    const res = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge,
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.ok(res.body.proof, 'proof presente nella risposta');

    const emittedProof = res.body.proof;
    assert.equal(emittedProof.kind, 'identity-proof');
    assert.equal(emittedProof.cellId, CELL);
    assert.equal(emittedProof.ownerInstanceId, INSTANCE_ID);
    assert.equal(emittedProof.daemonBootId, challenge.daemonBootId);
    assert.equal(emittedProof.connectionId, challenge.connectionId);
    assert.equal(emittedProof.audience, challenge.audience);
    assert.equal(emittedProof.nonce, challenge.nonce);

    // Verifica tramite la primitiva esistente di verifica dell'authority
    const verified = fix.authority.verifyChallengeProof(emittedProof, {
      audience: challenge.audience,
      daemonBootId: challenge.daemonBootId,
      connectionId: challenge.connectionId,
    });
    assert.equal(verified.ok, true, `verifyChallengeProof fallita: ${JSON.stringify(verified)}`);
    assert.equal(verified.claims.cellId, CELL);
    assert.equal(verified.claims.ownerInstanceId, INSTANCE_ID);
  } finally {
    await fix.close();
  }
});

test('negativo: proof di cella forgiato fallisce con IDENTITY_UNVERIFIED (403)', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  try {
    const forgedCellProof = {
      ...fix.cellProof,
      proof: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    const res = await postProof(fix.url, {
      proof: forgedCellProof,
      challenge: validChallenge(),
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'IDENTITY_UNVERIFIED');
  } finally {
    await fix.close();
  }
});

test('negativo: challenge scaduta fallisce con EXPIRED (410)', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:20.000Z') });
  try {
    // Challenge scadeva alle 03:00:15, clock e' a 03:00:20
    const res = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({ expiresAt: '2026-09-06T03:00:15.000Z' }),
    });

    assert.equal(res.status, 410);
    assert.equal(res.body.code, 'EXPIRED');
  } finally {
    await fix.close();
  }
});

test('negativo: replay dello stesso nonce della challenge fallisce con REPLAY (409)', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  try {
    const challenge = validChallenge({ nonce: 'nonce-one-shot-123456789' });
    const res1 = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge,
    });
    assert.equal(res1.status, 200, 'prima emissione deve avere successo');

    // Secondo tentativo con lo stesso nonce
    const res2 = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge,
    });
    assert.equal(res2.status, 409, 'secondo tentativo deve essere rifiutato per replay');
    assert.equal(res2.body.code, 'REPLAY');
  } finally {
    await fix.close();
  }
});

test('negativo: audience non conforme a daemon/<connectionId> fallisce con AUDIENCE_MISMATCH (400)', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  try {
    const res = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({
        connectionId: 'conn-001',
        audience: 'daemon/other-conn', // DIVERGENTE da connectionId
      }),
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'AUDIENCE_MISMATCH');
  } finally {
    await fix.close();
  }
});

test('negativo: campi identitari spoofati nel body vengono rifiutati o ignorati', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  try {
    // 1. Campo extra al top level -> rifiutato per schema chiuso
    const resExtra = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge(),
      cellId: 'SpoofedCell',
    });
    assert.equal(resExtra.status, 400);
    assert.equal(resExtra.body.code, 'IDENTITY_UNVERIFIED');

    // 2. Proof valido: i claims emessi devono contenere solo il cellId reale ('Dev')
    const resValid = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({ nonce: 'unique-nonce-spoof-test' }),
    });
    assert.equal(resValid.status, 200);
    assert.equal(resValid.body.proof.cellId, CELL);
    assert.equal(resValid.body.proof.ownerInstanceId, INSTANCE_ID);
  } finally {
    await fix.close();
  }
});

test('negativo: rate limit superato per sessione restituisce 429', async () => {
  const fix = await createFixture({
    startTick: Date.parse('2026-09-06T03:00:01.000Z'),
    rateCfg: { max: 2, windowMs: 60_000 },
  });
  try {
    const res1 = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({ nonce: 'nonce-rate-1' }),
    });
    assert.equal(res1.status, 200);

    const res2 = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({ nonce: 'nonce-rate-2' }),
    });
    assert.equal(res2.status, 200);

    // 3a chiamata supera il limite max: 2
    const res3 = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({ nonce: 'nonce-rate-3' }),
    });
    assert.equal(res3.status, 429);
    assert.equal(res3.body.code, 'RATE_LIMIT_EXCEEDED');
  } finally {
    await fix.close();
  }
});

test('negativo: identityMode legacy restituisce AUTHORITY_UNAVAILABLE (503)', async () => {
  const fix = await createFixture({
    identityMode: 'legacy',
    startTick: Date.parse('2026-09-06T03:00:01.000Z'),
  });
  try {
    const res = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge(),
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'AUTHORITY_UNAVAILABLE');
  } finally {
    await fix.close();
  }
});

test('negativo: payload superiore a 8kb viene rifiutato con 413 (body cap)', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  try {
    const hugePadding = 'x'.repeat(9 * 1024);
    const res = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({ nonce: hugePadding }),
    });

    assert.equal(res.status, 413);
  } finally {
    await fix.close();
  }
});

test('negativo: challenge con campi mancanti o versione errata restituisce AUDIENCE_MISMATCH (400)', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  try {
    // 1. Versione sconosciuta
    const badVer = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({ version: '2' }),
    });
    assert.equal(badVer.status, 400);
    assert.equal(badVer.body.code, 'AUDIENCE_MISMATCH');

    // 2. Campo mancante (es. daemonBootId)
    const chal = validChallenge();
    delete chal.daemonBootId;
    const missingField = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: chal,
    });
    assert.equal(missingField.status, 400);
    assert.equal(missingField.body.code, 'AUDIENCE_MISMATCH');

    // 3. Timestamps invertiti (expiresAt <= issuedAt)
    const badTime = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: validChallenge({
        issuedAt: '2026-09-06T03:00:10.000Z',
        expiresAt: '2026-09-06T03:00:05.000Z',
      }),
    });
    assert.equal(badTime.status, 400);
    assert.equal(badTime.body.code, 'AUDIENCE_MISMATCH');
  } finally {
    await fix.close();
  }
});

test('positivo: input proof di tipo identity-proof emette correttamente il nuovo proof', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  try {
    // Genera prima un valido identity-proof
    const chal1 = validChallenge({ nonce: 'nonce-prep-identity-proof-1', connectionId: 'conn-prep-1' });
    const prepRes = await postProof(fix.url, {
      proof: fix.cellProof,
      challenge: chal1,
    });
    assert.equal(prepRes.status, 200);
    const existingIdentityProof = prepRes.body.proof;
    assert.equal(existingIdentityProof.kind, 'identity-proof');

    // Usa l'identity-proof ottenuto come proof di input per una nuova connessione
    const chal2 = validChallenge({ nonce: 'nonce-prep-identity-proof-2', connectionId: 'conn-prep-2' });
    const res = await postProof(fix.url, {
      proof: existingIdentityProof,
      challenge: chal2,
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.proof.cellId, CELL);
    assert.equal(res.body.proof.connectionId, 'conn-prep-2');
  } finally {
    await fix.close();
  }
});

test('architettura: server.js monta /identity sotto requireToken sul router api', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '../lib/server.js'), 'utf8');
  const tokenUse = serverSrc.indexOf('api.use(requireToken(');
  const identityUse = serverSrc.indexOf("api.use('/identity'");
  assert.ok(tokenUse !== -1, 'requireToken deve essere registrato sul router api');
  assert.ok(identityUse !== -1, '/identity deve essere registrato sul router api');
  assert.ok(identityUse > tokenUse, '/identity deve essere registrato DOPO requireToken');
});

test('integrazione requireToken: 401 senza Bearer o token errato, 200 con Bearer valido', async () => {
  const fix = await createFixture({ startTick: Date.parse('2026-09-06T03:00:01.000Z') });
  const { requireToken } = require('../lib/auth/middleware.js');
  const app = express();
  const TOKEN = 'secret-token-12345';
  app.use('/api', requireToken(TOKEN));
  app.use('/api/identity', identityRoutes({
    fleetP: Promise.resolve({ available: true, lease: fix.leaseMgr, identityAuthority: fix.authority }),
    identityAuthority: fix.authority,
    identityMode: 'authority',
    instanceId: INSTANCE_ID,
    serviceCredential: SERVICE_CREDENTIAL,
    now: fix.now,
  }));

  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/api/identity/challenge-proof`;

  try {
    const challenge = validChallenge({ nonce: 'nonce-auth-test' });

    // 1. Senza header authorization -> 401
    const resNoAuth = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proof: fix.cellProof, challenge }),
    });
    assert.equal(resNoAuth.status, 401);

    // 2. Con token errato -> 401
    const resBadToken = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ proof: fix.cellProof, challenge }),
    });
    assert.equal(resBadToken.status, 401);

    // 3. Con Bearer valido -> 200
    const resOk = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ proof: fix.cellProof, challenge }),
    });
    assert.equal(resOk.status, 200);
    const json = await resOk.json();
    assert.equal(json.ok, true);
    assert.equal(json.proof.cellId, CELL);
  } finally {
    await new Promise((res) => server.close(res));
    await fix.close();
  }
});
