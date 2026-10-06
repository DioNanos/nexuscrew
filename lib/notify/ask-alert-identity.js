'use strict';
const crypto = require('node:crypto');
// Alert identity is independent of aliases and notification emission time.
function canonicalAskAlert(frame) {
  const ownerId = frame && frame.ownerId;
  const askId = frame && (frame.ownerAskId || frame.askId);
  if (typeof ownerId !== 'string' || !/^[a-f0-9]{32}$/i.test(ownerId)
    || typeof askId !== 'string' || !/^[a-f0-9]{8}$/i.test(askId)) return null;
  const ownerAskTs = frame.ownerAskTs;
  const fingerprint = frame.ownerAskFingerprint;
  const generation = Number.isSafeInteger(ownerAskTs) && ownerAskTs > 0 ? String(ownerAskTs)
    : typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint) ? `unknown:${fingerprint}` : null;
  if (!generation) return null;
  const key = JSON.stringify([ownerId, askId, generation]);
  return { ownerId, askId, ...(generation.startsWith('unknown:') ? { ownerAskFingerprint: fingerprint } : { ownerAskTs }),
    tag: `nc:ask:${crypto.createHash('sha256').update(key).digest('hex')}`, key };
}
function alertFields(frame) {
  const identity = canonicalAskAlert(frame);
  if (!identity) return {};
  const { key, ...fields } = identity;
  return fields;
}
module.exports = { canonicalAskAlert, alertFields };
