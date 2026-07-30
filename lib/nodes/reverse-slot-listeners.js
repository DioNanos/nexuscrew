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
    try { server.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function createReverseSlotListeners({ app, createServerImpl = http.createServer, diagnostics } = {}) {
  if (typeof app !== 'function') throw new Error('reverse slot listeners richiede app HTTP');
  const listeners = new Map(); // local target port -> owned server + immutable expected tuple

  async function open({ nodeName, remotePort, generation, instanceId, secret }) {
    if (typeof nodeName !== 'string' || !proof.newProbe({ remotePort, generation, instanceId }, () => Buffer.alloc(24))) {
      throw new Error('reverse slot listener spec non valida');
    }
    if (typeof secret !== 'string' || !secret) throw new Error('reverse slot listener credential mancante');
    const server = createServerImpl(app);
    let address;
    try { address = await listen(server, { host: '127.0.0.1', port: 0, exclusive: true }); }
    catch (error) { try { server.close(); } catch (_) {} throw error; }
    const localPort = address && address.port;
    if (!Number.isInteger(localPort)) { await close(server); throw new Error('reverse slot listener non ha una porta locale'); }
    listeners.set(localPort, {
      server, nodeName, secret,
      expected: { remotePort, generation, instanceId },
    });
    diagnostics?.record?.('info', 'reverse-pool', 'REVERSE_SLOT_LISTENER_READY', 'Reverse slot listener ready', {
      node: nodeName, remotePort, generation,
    });
    return { localPort, remotePort, generation };
  }

  async function closePort(localPort) {
    const entry = listeners.get(localPort);
    if (!entry) return false;
    listeners.delete(localPort);
    await close(entry.server);
    return true;
  }

  async function closeAll() {
    await Promise.all([...listeners.keys()].map(closePort));
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

  return { open, closePort, closeAll, respond, size: () => listeners.size };
}

module.exports = { createReverseSlotListeners };
