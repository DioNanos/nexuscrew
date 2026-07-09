'use strict';
const { execFile } = require('node:child_process');

const MAX_LEN = 240;

// Strip ANSI (CSI/OSC) e control char via charCode — niente escape regex nel
// sorgente (v. NOTE in lib/files/store.js sul write-layer).
function sanitizePreview(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  let i = 0;
  while (i < raw.length && out.length < MAX_LEN + 1) {
    const c = raw.charCodeAt(i);
    if (c === 0x1b) {                                   // ESC: salta la sequenza
      const n = raw.charCodeAt(i + 1);
      if (n === 0x5b) {                                 // CSI: fino a byte finale 0x40-0x7e
        i += 2; while (i < raw.length && (raw.charCodeAt(i) < 0x40 || raw.charCodeAt(i) > 0x7e)) i += 1;
        i += 1; continue;
      }
      if (n === 0x5d) {                                 // OSC: fino a BEL o ESC\
        i += 2; while (i < raw.length && raw.charCodeAt(i) !== 0x07 && raw.charCodeAt(i) !== 0x1b) i += 1;
        i += (raw.charCodeAt(i) === 0x1b) ? 2 : 1; continue;
      }
      i += 2; continue;                                 // altre ESC-seq corte
    }
    if (c <= 0x1f || c === 0x7f) { i += 1; continue; }  // control char
    out += raw[i]; i += 1;
  }
  return out.trim().slice(0, MAX_LEN);
}

// Sampler con cache per sessione, concorrenza limitata e timeout: la preview è
// best-effort — errori → null, MAI nel log (audit F7).
function createPreviewSampler(tmuxBin, { ttlMs = 3000, timeoutMs = 1500, maxConcurrent = 4 } = {}) {
  const cache = new Map();        // session -> {at, value}
  let inFlight = 0;
  const waiters = [];

  const acquire = () => new Promise((res) => {
    if (inFlight < maxConcurrent) { inFlight += 1; res(); } else waiters.push(res);
  });
  const release = () => { inFlight -= 1; const w = waiters.shift(); if (w) { inFlight += 1; w(); } };

  function capture(session) {
    return new Promise((resolve) => {
      execFile(tmuxBin, ['capture-pane', '-p', '-t', `=${session}:`], { timeout: timeoutMs, killSignal: 'SIGKILL' },
        (err, stdout) => {
          if (err) return resolve(null);
          const lines = String(stdout).split('\n');
          for (let i = lines.length - 1; i >= 0; i -= 1) {
            const s = sanitizePreview(lines[i]);
            if (s) return resolve(s);
          }
          resolve('');
        });
    });
  }

  async function get(session) {
    const hit = cache.get(session);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    await acquire();
    try {
      const value = await capture(session);
      cache.set(session, { at: Date.now(), value });
      return value;
    } finally { release(); }
  }

  return { get, close: () => cache.clear() };
}

module.exports = { sanitizePreview, createPreviewSampler };
