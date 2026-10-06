'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalAskAlert } = require('./ask-alert-identity.js');
const { askFingerprint } = require('./asks.js');
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
    if (data.v !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries) || Object.keys(data.entries).length > maxEntries) throw new Error('shape');
    for (const [key, r] of Object.entries(data.entries)) {
      if (!/^nc:ask:[a-f0-9]{64}$/.test(key) || !r || !Number.isFinite(r.at)
        || (r.priorTag !== undefined && !/^nc:ask:[a-f0-9]{64}$/.test(r.priorTag))
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
  function storedKey(tag) {
    return entries[tag] ? tag : Object.keys(entries).find(key => entries[key].priorTag === tag) || tag;
  }
  // Called only with a complete owner-authoritative ASK and its generation.
  // Rename one record rather than adding an unbounded alias collection.
  function adopt(ownerId, ask, authoritativeTs) {
    if (blocked || !Number.isSafeInteger(authoritativeTs) || authoritativeTs <= 0 || !ask) return false;
    const askId = ask.ownerAskId || ask.id;
    const old = canonicalAskAlert({ ownerId, askId, ownerAskFingerprint: askFingerprint(ask) });
    const known = canonicalAskAlert({ ownerId, askId, ownerAskTs: authoritativeTs });
    if (!old || !known) return false;
    prune(); const source = entries[old.tag];
    const existing = entries[known.tag];
    if (!source && !existing) return false;
    // A known fan-out can precede an older feed notification with no generation.
    // Bind that historical namespace before its first claim, not after alerting.
    if (!source) {
      if (existing.priorTag === old.tag) return true;
      const previous = existing;
      entries[known.tag] = { ...existing, priorTag: old.tag };
      if (!save()) { entries[known.tag] = previous; blocked = true; return false; }
      return true;
    }
    const previous = JSON.parse(JSON.stringify(entries));
    const rank = { failed: 1, pending: 2, uncertain: 3, delivered: 4 };
    const target = entries[known.tag] || {};
    const adopted = { at: Math.max(source.at, target.at || 0), priorTag: old.tag };
    for (const c of ['ui', 'push']) {
      const a = source[c], b = target[c];
      if (a || b) adopted[c] = (rank[a] || 0) > (rank[b] || 0) ? a : b;
    }
    delete entries[old.tag]; entries[known.tag] = adopted;
    if (!save()) { entries = previous; blocked = true; return false; } return true;
  }
  function claim(frame, channel) {
    const id = canonicalAskAlert(frame);
    if (!id) return { allowed: true, reason: 'generic' };
    if (blocked || !['ui', 'push'].includes(channel)) return { allowed: false, reason: 'alert-registry-unavailable' };
    prune(); const key = storedKey(id.tag); const prior = entries[key]; const phase = prior && prior[channel];
    if (phase && phase !== 'failed') return { allowed: false, reason: phase === 'delivered' ? 'already-alerted' : 'alert-uncertain' };
    if (!prior && Object.keys(entries).length >= maxEntries) {
      const oldest = Object.entries(entries).filter(([, r]) => r.ui !== 'pending' && r.push !== 'pending').sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) return { allowed: false, reason: 'alert-registry-cap' };
      delete entries[oldest[0]];
    }
    entries[key] = { ...(prior || {}), at: now(), [channel]: 'pending' };
    if (!save()) { blocked = true; return { allowed: false, reason: 'alert-registry-unavailable' }; }
    return { allowed: true, key };
  }
  function complete(frame, channel, result) {
    const id = canonicalAskAlert(frame);
    const key = id && storedKey(id.tag);
    if (!id || blocked || !entries[key] || entries[key][channel] !== 'pending') return false;
    entries[key][channel] = result === 'uncertain' ? 'uncertain' : result > 0 ? 'delivered' : 'failed';
    if (!save()) { blocked = true; return false; } return true;
  }
  return { claim, complete, adopt, limits: { maxEntries, maxBytes, ttlMs }, filePath };
}
module.exports = { createAskAlertRegistry, MAX_ENTRIES, MAX_BYTES, TTL_MS };
