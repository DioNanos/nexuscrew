#!/usr/bin/env node
// Browser probe for the UI-0 entrypoint.
//
// It serves a production build, opens it in headless Chromium through CDP and
// asserts, before any application code runs, that the page makes no runtime
// network call and never registers a service worker. It also measures the
// mobile geometry (390x844) and the tool toggle hit area.
//
// Usage:
//   node scripts/ui0-browser-probe.mjs --build /tmp/ui0-build-on --expect on
//   node scripts/ui0-browser-probe.mjs --build /tmp/ui0-build-off --expect off
//
// CHROME_BIN overrides the browser path.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, arg, i, all) => {
  if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]]);
  return acc;
}, []));
const buildDir = args.build;
const expect = args.expect || 'on';
if (!buildDir) {
  console.error('missing --build <dir>');
  process.exit(2);
}

const CHROME = process.env.CHROME_BIN
  || `${process.env.HOME}/.cache/ms-playwright/chromium-1246/chrome-linux64/chrome`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function startServer(root) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = normalize(join(root, path === '/' ? '/index.html' : path));
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitForPort(dir) {
  const file = join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100; i += 1) {
    try {
      const text = await readFile(file, 'utf8');
      const [port] = text.split('\n');
      if (port) return Number(port);
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('DevToolsActivePort not written');
}

async function pageSocket(port) {
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await res.json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no page target');
}

function cdpClient(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return {
    ready,
    send(method, params = {}) {
      const callId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(callId, { resolve, reject });
        ws.send(JSON.stringify({ id: callId, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

const INIT = `(() => {
  window.__ui0Net = [];
  const rec = (kind, detail) => window.__ui0Net.push({ kind, detail: String(detail || '').slice(0, 200) });
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = (...a) => { rec('sw', a[0]); return Promise.reject(new Error('blocked')); };
    }
  } catch (_) {}
  window.fetch = (...a) => { rec('fetch', a[0]); return Promise.reject(new Error('blocked')); };
  try {
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...rest) { rec('xhr', u); return open.call(this, m, u, ...rest); };
  } catch (_) {}
  window.WebSocket = class { constructor(u) { rec('ws', u); throw new Error('blocked'); } };
  if (navigator.sendBeacon) navigator.sendBeacon = (u) => { rec('beacon', u); return false; };
  window.EventSource = class { constructor(u) { rec('sse', u); throw new Error('blocked'); } };
  // R2 probe: a runtime override must not enable the demo on an OFF build.
  window.__NC_UI0_CHAT_DEMO__ = true;
})();`;

const MEASURE = `(() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
  const grid = document.querySelector('.nc-ui0-grid');
  const gs = grid ? getComputedStyle(grid) : null;
  return {
    net: window.__ui0Net || [],
    tiles: document.querySelectorAll('.nc-ui0-tile').length,
    headers: document.querySelectorAll('.nc-tile-head').length,
    composers: document.querySelectorAll('textarea').length,
    labels: document.querySelectorAll('.nc-ui0-tile-label').length,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    root: rect(document.getElementById('root')),
    grid: grid ? { ...rect(grid), scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight, overflowY: gs.overflowY } : null,
    tilesGeo: Array.from(document.querySelectorAll('.nc-ui0-tile')).map((tile) => ({
      tile: rect(tile),
      composer: rect(tile.querySelector('.nc-chat-composer')),
      send: rect(tile.querySelector('.nc-chat-send')),
      toggle: rect(tile.querySelector('.nc-chat-tools-toggle')),
      notice: rect(tile.querySelector('[data-testid="chat-demo-notice"]')),
      noticeText: (tile.querySelector('[data-testid="chat-demo-notice"]') || {}).textContent || '',
    })),
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const server = await startServer(buildDir);
  const port = server.address().port;
  const profile = await mkdtemp(join(tmpdir(), 'ui0-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let client;
  try {
    const devtoolsPort = await waitForPort(profile);
    const wsUrl = await pageSocket(devtoolsPort);
    client = cdpClient(wsUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    });
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/?ui0=1` });
    await sleep(2500);

    const evaluated = await client.send('Runtime.evaluate', { expression: MEASURE, returnByValue: true });
    const data = evaluated.result.value;

    const failures = [];
    if (expect === 'on') {
      // The demo must be hermetic. On the OFF build the normal app is allowed
      // to make its own calls: there we only prove the demo did not render.
      if (data.net.length > 0) failures.push(`runtime network calls: ${JSON.stringify(data.net)}`);
      if (data.tiles !== 2) failures.push(`expected 2 demo tiles, got ${data.tiles}`);
      if (data.headers !== 2) failures.push(`expected 2 headers, got ${data.headers}`);
      if (data.composers !== 2) failures.push(`expected 2 composers, got ${data.composers}`);
      if (data.labels !== 0) failures.push(`absolute labels still present: ${data.labels}`);
      for (const [index, geo] of data.tilesGeo.entries()) {
        if (!geo.composer) { failures.push(`tile ${index}: no composer`); continue; }
        if (geo.composer.bottom > data.viewport.height + 1) {
          failures.push(`tile ${index}: composer below the viewport (${geo.composer.bottom} > ${data.viewport.height})`);
        }
        if (geo.toggle && geo.toggle.height < 44 - 0.5) {
          failures.push(`tile ${index}: tool toggle height ${geo.toggle.height} < 44`);
        }
        if (!geo.notice) {
          failures.push(`tile ${index}: demo approval notice missing`);
        } else {
          if (!geo.noticeText.includes('semantica non qualificata')) {
            failures.push(`tile ${index}: notice text unexpected`);
          }
          if (geo.notice.bottom > data.viewport.height + 1) {
            failures.push(`tile ${index}: notice below the viewport`);
          }
        }
        if (geo.send && geo.composer
            && (geo.send.bottom > geo.composer.bottom + 0.5 || geo.send.top < geo.composer.top - 0.5)) {
          failures.push(`tile ${index}: send button outside the composer`);
        }
      }
    } else {
      if (data.tiles !== 0) failures.push(`expected 0 demo tiles on the OFF build, got ${data.tiles}`);
    }

    console.log(JSON.stringify({ expect, ok: failures.length === 0, failures, data }, null, 2));
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    try { client?.close(); } catch { /* ignore */ }
    try { chrome.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise((r) => server.close(r));
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error && error.stack || error) }));
  process.exit(1);
});
