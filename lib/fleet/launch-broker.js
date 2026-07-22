'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_PAYLOAD = 512 * 1024;
const REQUEST_LIMIT = 256;

function runtimeDir(cfg = {}) {
  const home = cfg.home || os.homedir();
  return cfg.launchRuntimeDir || path.join(home, '.nexuscrew', 'run');
}

function ensureRuntimeDir(dir) {
  const parent = path.dirname(dir);
  try {
    const parentSt = fs.lstatSync(parent);
    const owned = typeof process.getuid !== 'function' || parentSt.uid === process.getuid();
    if (!parentSt.isSymbolicLink() && parentSt.isDirectory() && owned && (parentSt.mode & 0o077)) {
      fs.chmodSync(parent, 0o700);
    }
    const checked = fs.lstatSync(parent);
    if (checked.isSymbolicLink() || !checked.isDirectory()
      || (typeof process.getuid === 'function' && checked.uid !== process.getuid()) || (checked.mode & 0o077)) {
      throw new Error('unsafe launch broker parent directory');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const grand = fs.lstatSync(path.dirname(parent));
    if (grand.isSymbolicLink() || !grand.isDirectory()
      || (typeof process.getuid === 'function' && grand.uid !== process.getuid()) || (grand.mode & 0o022)) {
      throw new Error('unsafe launch broker parent root');
    }
    fs.mkdirSync(parent, { mode: 0o700 });
  }
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()
      || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o077)) {
      throw new Error('unsafe launch broker directory');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { mode: 0o700 });
  }
}

function encodePayload(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (!body.length || body.length > MAX_PAYLOAD) throw new Error('launch payload too large');
  const head = Buffer.allocUnsafe(4); head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function createLaunchBroker(cfg = {}) {
  const dir = runtimeDir(cfg);
  let server = null;
  let socketPath = '';
  let starting = null;
  let closed = false;
  const pending = new Map();
  const ttlMs = Math.max(1000, Number(cfg.launchTokenTtlMs) || 15000);

  function expire(nonce) {
    const entry = pending.get(nonce);
    if (!entry) return;
    pending.delete(nonce);
    clearTimeout(entry.timer);
  }

  async function start() {
    if (closed) throw new Error('launch broker closed');
    if (server) return socketPath;
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      try {
        ensureRuntimeDir(dir);
        socketPath = path.join(dir, `launch-${process.pid}-${crypto.randomBytes(5).toString('hex')}.sock`);
      } catch (error) { reject(error); return; }
      server = net.createServer((socket) => {
        let raw = '';
        socket.setEncoding('utf8');
        socket.setTimeout(3000, () => socket.destroy());
        socket.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > REQUEST_LIMIT) return socket.destroy();
          const nl = raw.indexOf('\n');
          if (nl === -1) return;
          let nonce = '';
          try { nonce = JSON.parse(raw.slice(0, nl)).nonce; } catch (_) {}
          if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) return socket.destroy();
          const entry = pending.get(nonce);
          if (!entry || entry.expires < Date.now()) { expire(nonce); return socket.destroy(); }
          // Single-use before any bytes leave this process. A second client can
          // never claim the same payload, even while the first socket drains.
          pending.delete(nonce); clearTimeout(entry.timer);
          try { socket.end(entry.encoded); } catch (_) { socket.destroy(); }
        });
      });
      server.once('error', (error) => {
        if (!server?.listening) { server = null; starting = null; reject(error); }
      });
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); } catch (_) {}
        server.unref(); starting = null; resolve(socketPath);
      });
    });
    return starting;
  }

  async function issue(payload) {
    const target = await start();
    const nonce = crypto.randomBytes(32).toString('hex');
    const entry = { encoded: encodePayload(payload), expires: Date.now() + ttlMs, timer: null };
    entry.timer = setTimeout(() => expire(nonce), ttlMs);
    entry.timer.unref?.();
    pending.set(nonce, entry);
    return { socketPath: target, nonce };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const [nonce] of pending) expire(nonce);
    const active = server; server = null;
    if (active) await new Promise((resolve) => active.close(() => resolve()));
    try { if (socketPath) fs.unlinkSync(socketPath); } catch (_) {}
  }

  // Revoca esplicita di un nonce pendente (design §3.3): se il respawn-pane
  // fallisce dopo issue(), il runtime consuma/revoca il ticket subito invece di
  // attenderne il TTL. expire() e' gia' no-op su nonce mancante/scaduto.
  return { issue, close, revoke: expire, pendingCount: () => pending.size };
}

module.exports = { createLaunchBroker, runtimeDir, ensureRuntimeDir, encodePayload, MAX_PAYLOAD };
