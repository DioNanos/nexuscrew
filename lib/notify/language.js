'use strict';

// Notification speech currently ships one stable browser locale per supported
// base language. The wire accepts ordinary BCP-47 subtags so callers can pass
// either `it` or `it-IT`, while keeping the public protocol deliberately small.
const SUPPORTED_NOTIFICATION_LANGS = new Set(['it', 'en', 'es']);
const NOTIFICATION_LANG_RE = /^(it|en|es)(?:-[a-z0-9]{2,8})*$/i;

function canonicalSubtag(part, index) {
  if (index === 0) return part.toLowerCase();
  if (/^[a-z]{2}$/i.test(part)) return part.toUpperCase();
  if (/^[a-z]{4}$/i.test(part)) {
    return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
  }
  return part.toLowerCase();
}

function normalizeNotificationLang(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!NOTIFICATION_LANG_RE.test(trimmed)) return null;
  const parts = trimmed.split('-');
  if (!SUPPORTED_NOTIFICATION_LANGS.has(parts[0].toLowerCase())) return null;
  return parts.map(canonicalSubtag).join('-');
}

module.exports = {
  NOTIFICATION_LANG_RE,
  SUPPORTED_NOTIFICATION_LANGS,
  normalizeNotificationLang,
};
