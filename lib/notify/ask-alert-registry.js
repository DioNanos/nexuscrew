'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalAskAlert } = require('./ask-alert-identity.js');
const MAX_ENTRIES = 4096;
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 24 * 60 * 60 * 1000;
// One instance is shared by both ingress paths in a receiver process. An
// unfinished durable claim is uncertain after restart, never a success.
function createAskAlertRegistry({ filePath, now = Date.now, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, ttlMs = TTL_MS } = {}) {
  let entries = {}; let blocked = false;
  try {
    if (fs.statSync(filePath).size > maxBytes) throw new Error('oversized');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.v !== 1 || !data.entries || Array.isArray(data.entries) || Object.keys(data.entries).length > maxEntries) throw new Error('shape');
    for (const [key, r] of Object.entries(data.entries)) {
      if (!/^nc:ask:[a-f0-9]{64}$/.test(key) || !r || !Number.isFinite(r.at)
        || !['ui', 'push'].every(c => r[c] === undefined || ['pending', 'delivered', 'failed', 'uncertain'].includes(r[c]))) throw new Error('shape');
    }
    entries = data.entries;
  } catch (e) { if (e.code !== 'ENOENT') blocked = true; }
  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, r] of Object.entries(entries)) if (r.at <= cutoff) delete entries[key];
  }
  function save() {
    const text = JSON.stringify({ v: 1, entries });
    if (Buffer.byteLength(text) > maxBytes) return false;
    const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, filePath); return true;
    } catch (_) { try { fs.unlinkSync(temp); } catch (_) {} return false; }
  }
  function claim(frame, channel) {
    const id = canonicalAskAlert(frame);
    if (!id) return { allowed: true, reason: 'generic' };
    if (blocked || !['ui', 'push'].includes(channel)) return { allowed: false, reason: 'alert-registry-unavailable' };
    prune(); const prior = entries[id.tag]; const phase = prior && prior[channel];
    if (phase && phase !== 'failed') return { allowed: false, reason: phase === 'delivered' ? 'already-alerted' : 'alert-uncertain' };
    if (!prior && Object.keys(entries).length >= maxEntries) {
      const oldest = Object.entries(entries).filter(([, r]) => r.ui !== 'pending' && r.push !== 'pending').sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) return { allowed: false, reason: 'alert-registry-cap' };
      delete entries[oldest[0]];
    }
    entries[id.tag] = { ...(prior || {}), at: now(), [channel]: 'pending' };
    if (!save()) { blocked = true; return { allowed: false, reason: 'alert-registry-unavailable' }; }
    return { allowed: true, key: id.tag };
  }
  function complete(frame, channel, result) {
    const id = canonicalAskAlert(frame);
    if (!id || blocked || !entries[id.tag] || entries[id.tag][channel] !== 'pending') return false;
    entries[id.tag][channel] = result === 'uncertain' ? 'uncertain' : result > 0 ? 'delivered' : 'failed';
    if (!save()) { blocked = true; return false; } return true;
  }
  return { claim, complete, limits: { maxEntries, maxBytes, ttlMs }, filePath };
}
module.exports = { createAskAlertRegistry, MAX_ENTRIES, MAX_BYTES, TTL_MS };
