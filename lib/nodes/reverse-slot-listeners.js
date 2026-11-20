'use strict';
// Per-slot loopback listeners owned by this NexusCrew process.  They run the
// same Express application as the primary listener, but expose a distinct TCP
// destination to every -R.  That physical distinction is what makes an
// old-port -> new-port relay unable to obtain a slot MAC.
const http = require('node:http');
const proof = require('./reverse-slot-proof.js');

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve(server.address());
    });
    server.listen(options);
  });
}

function close(server) {
  return new Promise((resolve) => {
    try {
      if (typeof server.closeIdleConnections === 'function') {
        try { server.closeIdleConnections(); } catch (_) {}
      }
      server.close((err) => {
        const isRealError = Boolean(err && err.code !== 'ERR_SERVER_NOT_RUNNING');
        resolve({ error: isRealError });
      });
    } catch (err) {
      const isRealError = Boolean(err && err.code !== 'ERR_SERVER_NOT_RUNNING');
      resolve({ error: isRealError });
    }
  });
}

function createReverseSlotListeners({ app, createServerImpl = http.createServer, diagnostics, attachUpgrade } = {}) {
  if (typeof app !== 'function') throw new Error('reverse slot listeners richiede app HTTP');
  // Fail-closed: servire `app` non basta: il routing degli upgrade WS vive
  // sull'istanza `server`, non sull'app Express. Un listener senza handler di
  // upgrade e' HTTP-only e degrada in silenzio (la SPA risponde 200 a un
  // upgrade). Obbligare la dipendenza rende impossibile ricreare il difetto
  // per dimenticanza, invece di affidarsi a un test che enumera gli ingressi.
  if (typeof attachUpgrade !== 'function') {
    throw new Error('reverse slot listeners richiede attachUpgrade');
  }
  const listeners = new Map(); // local target port -> owned server + immutable expected tuple
  const inFlightOpens = new Set(); // active open() calls before registration
  const inFlightCloses = new Map(); // localPort -> { server, promise }
  let persistentCloseErrors = 0;

  async function open({ nodeName, remotePort, generation, instanceId, secret }) {
    if (typeof nodeName !== 'string' || !proof.newProbe({ remotePort, generation, instanceId }, () => Buffer.alloc(24))) {
      throw new Error('reverse slot listener spec non valida');
    }
    if (typeof secret !== 'string' || !secret) throw new Error('reverse slot listener credential mancante');
    const server = createServerImpl(app);
    attachUpgrade(server);
    const openEntry = { server, promise: null };
    const openPromise = (async () => {
      try {
        let address;
        try { address = await listen(server, { host: '127.0.0.1', port: 0, exclusive: true }); }
        catch (error) { try { server.close(); } catch (_) {} throw error; }
        const localPort = address && address.port;
        if (!Number.isInteger(localPort)) {
          const closeRes = await close(server);
          if (closeRes && closeRes.error) persistentCloseErrors += 1;
          throw new Error('reverse slot listener non ha una porta locale');
        }
        listeners.set(localPort, {
          server, nodeName, secret,
          expected: { remotePort, generation, instanceId },
        });
        diagnostics?.record?.('info', 'reverse-pool', 'REVERSE_SLOT_LISTENER_READY', 'Reverse slot listener ready', {
          node: nodeName, remotePort, generation,
        });
        return { localPort, remotePort, generation };
      } finally {
        inFlightOpens.delete(openEntry);
      }
    })();
    openEntry.promise = openPromise;
    inFlightOpens.add(openEntry);
    return openPromise;
  }

  function closePortInternal(localPort) {
    const existing = inFlightCloses.get(localPort);
    if (existing) {
      return existing.promise.then((res) => ({ existed: true, error: Boolean(res && res.error) }));
    }
    const entry = listeners.get(localPort);
    if (!entry) return Promise.resolve({ existed: false, error: false });
    listeners.delete(localPort);
    const closeP = close(entry.server).then((res) => {
      const hasErr = Boolean(res && res.error);
      if (hasErr) persistentCloseErrors += 1;
      return { existed: true, error: hasErr };
    }).finally(() => {
      const cur = inFlightCloses.get(localPort);
      if (cur && cur.promise === closeP) {
        inFlightCloses.delete(localPort);
      }
    });
    inFlightCloses.set(localPort, { server: entry.server, promise: closeP });
    return closeP;
  }

  async function closePort(localPort) {
    const res = await closePortInternal(localPort);
    return res.existed;
  }

  async function closeAll() {
    while (inFlightOpens.size > 0 || listeners.size > 0 || inFlightCloses.size > 0) {
      const pendingOpens = [...inFlightOpens].map((entry) => entry.promise.catch(() => {}));
      const preExistingInFlight = [...inFlightCloses.values()].map((active) => active.promise);
      const ops = [...preExistingInFlight];
      for (const port of [...listeners.keys()]) {
        ops.push(closePortInternal(port));
      }
      await Promise.all([...pendingOpens, ...ops]);
    }
    return {
      errorCount: persistentCloseErrors,
      hadError: persistentCloseErrors > 0,
    };
  }

  function forceCloseAllConnections() {
    let count = 0;
    for (const activeOpen of inFlightOpens) {
      if (activeOpen && activeOpen.server && typeof activeOpen.server.closeAllConnections === 'function') {
        count += 1;
        try { activeOpen.server.closeAllConnections(); } catch (_) {}
      }
    }
    for (const entry of listeners.values()) {
      if (entry && entry.server && typeof entry.server.closeAllConnections === 'function') {
        count += 1;
        try { entry.server.closeAllConnections(); } catch (_) {}
      }
    }
    for (const active of inFlightCloses.values()) {
      if (active && active.server && typeof active.server.closeAllConnections === 'function') {
        count += 1;
        try { active.server.closeAllConnections(); } catch (_) {}
      }
    }
    return count;
  }

  function respond(req, res) {
    const localPort = req && req.socket && req.socket.localPort;
    const entry = listeners.get(localPort);
    if (!entry) return false;
    const body = req.body || {};
    const response = proof.respondSlotProof({ secret: entry.secret, expected: entry.expected, request: body });
    if (!response.ok) {
      res.status(409).json({ error: 'reverse slot proof non valida', code: response.code });
    } else {
      res.json(response);
    }
    return true;
  }

  // A request that arrived on one of these listeners comes from a peer's channel,
  // never from this machine's own browser: callers use it to tell the two apart.
  const isSlotPort = (localPort) => listeners.has(localPort);
  const getAckState = () => ({
    persistentCloseErrors,
    hadError: persistentCloseErrors > 0,
    inFlightOpens: inFlightOpens.size,
    inFlightCloses: inFlightCloses.size,
    openListeners: listeners.size,
  });
  return { open, closePort, closeAll, forceCloseAllConnections, getAckState, respond, isSlotPort, size: () => listeners.size };
}

module.exports = { createReverseSlotListeners };
