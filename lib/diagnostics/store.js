'use strict';

const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 4096;
const ALLOWED_DURATIONS = new Set([300, 900, 1800, 3600]);
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const META_KEYS = new Set([
  'port', 'platform', 'reason', 'durationSeconds', 'count', 'errno', 'client',
  'cell', 'engine', 'action', 'state', 'transport', 'phase', 'version', 'status', 'node',
]);
const DENIED_KEY = /(authorization|cookie|token|secret|credential|password|prompt|terminal|argv|command|env|content|payload|file|path|endpoint|url)/i;

function redactText(value, max = 160) {
  let text = String(value == null ? '' : value).normalize('NFC');
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  text = text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|xox[baprs]|gh[pousr]|npm)_[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:token|password|secret|api[_-]?key)\s*[=:]\s*\S+/gi, '[redacted]')
    .replace(/(?:\/home\/[^/\s]+|\/data\/(?:data|user\/\d+)\/[^/\s]+)(?:\/[^\s]*)?/g, '[path]')
    .replace(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/g, '[env]');
  return text.slice(0, max);
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!META_KEYS.has(key) || DENIED_KEY.test(key)) continue;
    if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string') out[key] = redactText(value, 96);
  }
  return out;
}

function createDiagnostics(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const maxRecords = opts.maxRecords || DEFAULT_MAX_RECORDS;
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const maxEntryBytes = opts.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES;
  let entries = [];
  let bytes = 0;
  let seq = 0;
  let enabledUntil = 0;
  let expiryRecorded = false;

  function push(level, component, code, message, meta = {}) {
    const record = {
      seq: ++seq,
      ts: new Date(now()).toISOString(),
      level,
      component: redactText(component, 48) || 'runtime',
      code: /^[A-Z][A-Z0-9_]{0,63}$/.test(String(code || '')) ? String(code) : 'DIAGNOSTIC_EVENT',
      message: redactText(message, 240) || 'Diagnostic event',
      meta: sanitizeMeta(meta),
    };
    let size = Buffer.byteLength(JSON.stringify(record));
    if (size > maxEntryBytes) {
      record.meta = {};
      record.message = record.message.slice(0, 96);
      size = Buffer.byteLength(JSON.stringify(record));
    }
    if (size > maxEntryBytes) return null;
    entries.push({ record, size }); bytes += size;
    while (entries.length > maxRecords || bytes > maxBytes) {
      const removed = entries.shift(); bytes -= removed.size;
    }
    return record;
  }

  function refreshExpiry() {
    if (enabledUntil > 0 && now() >= enabledUntil) {
      enabledUntil = 0;
      if (!expiryRecorded) {
        expiryRecorded = true;
        push('info', 'diagnostics', 'VERBOSE_EXPIRED', 'Verbose diagnostics expired', { reason: 'timeout' });
      }
    }
  }

  function record(level, component, code, message, meta = {}) {
    if (!LEVELS.has(level)) return null;
    refreshExpiry();
    if ((level === 'debug' || level === 'info') && enabledUntil === 0) return null;
    return push(level, component, code, message, meta);
  }

  function setVerbose(enabled, durationSeconds = 900) {
    if (typeof enabled !== 'boolean') throw new Error('enabled deve essere boolean');
    if (enabled) {
      if (!ALLOWED_DURATIONS.has(durationSeconds)) throw new Error('durationSeconds deve essere 300, 900, 1800 o 3600');
      enabledUntil = now() + durationSeconds * 1000;
      expiryRecorded = false;
      push('info', 'diagnostics', 'VERBOSE_ENABLED', 'Verbose diagnostics enabled', { durationSeconds });
    } else {
      enabledUntil = 0;
      expiryRecorded = true;
      push('info', 'diagnostics', 'VERBOSE_DISABLED', 'Verbose diagnostics disabled', { reason: 'manual' });
    }
    return status();
  }

  function clear() {
    refreshExpiry();
    const count = entries.length;
    entries = []; bytes = 0;
    push('info', 'diagnostics', 'LOGS_CLEARED', 'Diagnostic buffer cleared', { count });
    return { cleared: count, ...status() };
  }

  function status() {
    refreshExpiry();
    return {
      verbose: enabledUntil > 0,
      expiresAt: enabledUntil > 0 ? new Date(enabledUntil).toISOString() : null,
      nextSeq: seq + 1,
      retained: entries.length,
      bytes,
      limits: { records: maxRecords, bytes: maxBytes, entryBytes: maxEntryBytes },
    };
  }

  function logs({ after = 0, limit = 200 } = {}) {
    refreshExpiry();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after non valido');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit non valido (1..200)');
    const records = entries.map((item) => item.record).filter((entry) => entry.seq > after).slice(0, limit);
    return { records, cursor: records.length ? records[records.length - 1].seq : after, ...status() };
  }

  return { record, setVerbose, clear, status, logs };
}

module.exports = {
  DEFAULT_MAX_RECORDS, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRY_BYTES,
  ALLOWED_DURATIONS, redactText, sanitizeMeta, createDiagnostics,
};
