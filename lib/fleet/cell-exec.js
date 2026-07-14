#!/usr/bin/env node
'use strict';

// Tiny launch helper. It receives only a local socket path and a random,
// single-use nonce in argv. Provider values arrive over the private Unix
// socket, stay in memory and are passed directly to the child process.
const net = require('node:net');
const { spawn } = require('node:child_process');
const { MAX_PAYLOAD } = require('./launch-broker.js');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--socket') out.socketPath = argv[i + 1];
    else if (argv[i] === '--nonce') out.nonce = argv[i + 1];
    else return null;
  }
  if (typeof out.socketPath !== 'string' || !out.socketPath
    || typeof out.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(out.nonce)) return null;
  return out;
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.command !== 'string' || !payload.command || !Array.isArray(payload.args)) return false;
  if (!payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) return false;
  return payload.args.every((v) => typeof v === 'string')
    && Object.entries(payload.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string');
}

function receivePayload(socketPath, nonce, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0); let expected = null; let done = false;
    const finish = (error, payload) => {
      if (done) return; done = true; socket.destroy();
      if (error) reject(error); else resolve(payload);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('launch broker timed out')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ nonce })}\n`));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (expected === null && data.length >= 4) {
        expected = data.readUInt32BE(0); data = data.subarray(4);
        if (!expected || expected > MAX_PAYLOAD) return finish(new Error('invalid launch payload length'));
      }
      if (expected !== null && data.length >= expected) {
        try {
          const payload = JSON.parse(data.subarray(0, expected).toString('utf8'));
          if (!validPayload(payload)) return finish(new Error('invalid launch payload'));
          finish(null, payload);
        } catch (error) { finish(error); }
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => { if (!done) finish(new Error('launch broker closed early')); });
  });
}

async function main(argv = process.argv.slice(2), seams = {}) {
  const parsed = parseArgs(argv);
  if (!parsed) throw new Error('usage: cell-exec --socket <path> --nonce <hex>');
  const payload = await (seams.receivePayload || receivePayload)(parsed.socketPath, parsed.nonce);
  const spawnImpl = seams.spawn || spawn;
  const child = spawnImpl(payload.command, payload.args, { env: payload.env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, () => { try { child.kill(signal); } catch (_) {} });
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 128 : (code == null ? 1 : code)));
  });
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`nexuscrew cell launch failed: ${error.message}\n`); process.exitCode = 1;
  });
}

module.exports = { parseArgs, validPayload, receivePayload, main };
