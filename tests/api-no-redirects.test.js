'use strict';
// tests/api-no-redirects.test.js — the web app no longer follows redirects on calls that go through a peer
// (/api/route/*, /node/*; see frontend/src/lib/api.js). That is safe only while no API of this server answers with
// a redirect. This test pins the premise: if a route ever needs one, the change is a decision, not an accident.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
// The proxies forward a peer's answer (and refuse its redirects when the peer is host-only): they are the only code
// allowed to handle a Location header or a 3xx status.
const ALLOWED = new Set(['proxy/federation.js', 'proxy/node-proxy.js', 'proxy/panel-proxy.js']);

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

test('no API route of this server redirects (outside the proxies)', () => {
  const patterns = [
    /\.redirect\(/, /\.status\(\s*30\d\s*\)/, /statusCode\s*=\s*30\d/, /writeHead\(\s*30\d/,
    /setHeader\(\s*['"]location['"]/i, /\.location\(/, /['"]location['"]\s*:/i,
  ];
  const hits = [];
  for (const f of files(LIB)) {
    const rel = path.relative(LIB, f).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const text = fs.readFileSync(f, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (patterns.some((re) => re.test(line))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], `a route now redirects: the web app does not follow redirects through peers\n${hits.join('\n')}`);
});
