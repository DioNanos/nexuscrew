export const NOTIFICATION_SPEECH_KEY = 'nc_notification_speech_v1';
export const NOTIFICATION_SPEECH_EVENT = 'nc-notification-speech';
export const NOTIFICATION_SPEECH_PREVIEW_EVENT = 'nc-notification-speech-preview';
export const MAX_NOTIFICATION_SPEECH_CHARS = 320;
export const MAX_NOTIFICATION_SPEECH_PENDING = 2;
export const NOTIFICATION_SPEECH_WATCHDOG_MS = 30000;
export const NOTIFICATION_SPEECH_PREVIEW_TIMEOUT_MS = 10000;
export const NOTIFICATION_SPEECH_DEDUP_MS = 60000;
export const MAX_NOTIFICATION_SPEECH_DEDUP = 64;

export const DEFAULT_NOTIFICATION_SPEECH = Object.freeze({ enabled: false });

const LANG_TAGS = Object.freeze({
  it: 'it-IT',
  en: 'en-US',
  es: 'es-ES',
});
const primedScopes = new WeakSet();

export function normalizeNotificationSpeech(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { enabled: input.enabled === true };
}

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch (_) { return null; }
}

export function loadNotificationSpeech(storage = defaultStorage()) {
  if (!storage) return { ...DEFAULT_NOTIFICATION_SPEECH };
  try {
    return normalizeNotificationSpeech(JSON.parse(storage.getItem(NOTIFICATION_SPEECH_KEY) || 'null'));
  } catch (_) {
    return { ...DEFAULT_NOTIFICATION_SPEECH };
  }
}

export function saveNotificationSpeech(value, storage = defaultStorage()) {
  const next = normalizeNotificationSpeech(value);
  if (storage) {
    try { storage.setItem(NOTIFICATION_SPEECH_KEY, JSON.stringify(next)); }
    catch (_) { /* quota/privacy: resta valido nello stato React corrente */ }
  }
  return next;
}

function browserScope() {
  try { return typeof window !== 'undefined' ? window : null; }
  catch (_) { return null; }
}

export function notificationSpeechSupported(scope = browserScope()) {
  try {
    return !!(scope
      && scope.speechSynthesis
      && typeof scope.speechSynthesis.speak === 'function'
      && typeof scope.SpeechSynthesisUtterance === 'function');
  } catch (_) {
    return false;
  }
}

export function notificationSpeechPrimed(scope = browserScope()) {
  return !!(scope && (typeof scope === 'object' || typeof scope === 'function')
    && primedScopes.has(scope));
}

export function resetNotificationSpeechPriming(scope = browserScope()) {
  if (scope && (typeof scope === 'object' || typeof scope === 'function')) {
    primedScopes.delete(scope);
  }
}

export function notificationSpeechLang(lang) {
  return LANG_TAGS[lang] || LANG_TAGS.en;
}

function cleanPart(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function redactSpeechPart(value) {
  return cleanPart(value)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|hf|zai|xox[baprs]|gh[pousr]|npm)[_-][A-Za-z0-9._-]{8,}\b/gi, '[redacted]')
    .replace(/\b(?:token|password|secret|credential|api[_-]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '[redacted]')
    .replace(/\b[A-Z][A-Z0-9_]{2,}\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/g, '[redacted]')
    .replace(/(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|\/data\/(?:data|user\/\d+)\/[^/\s]+)(?:\/[^\s]*)?/g,
      '[private path]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)?/g, '[private path]');
}

export function notificationSpeechText(frame, maxChars = MAX_NOTIFICATION_SPEECH_CHARS) {
  const title = redactSpeechPart(frame && frame.title);
  const body = redactSpeechPart(frame && frame.body);
  const text = [title, body && body !== title ? body : ''].filter(Boolean).join('. ');
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('').trimEnd()}…`;
}

function documentIsActive(doc) {
  try {
    return !!(doc
      && doc.visibilityState === 'visible'
      && typeof doc.hasFocus === 'function'
      && doc.hasFocus());
  } catch (_) { return false; }
}

export function cancelNotificationSpeech(scope = browserScope()) {
  if (!notificationSpeechSupported(scope)) return false;
  try { scope.speechSynthesis.cancel(); return true; }
  catch (_) { return false; }
}

function announceNotificationSpeechPreview(scope) {
  try {
    if (scope && typeof scope.dispatchEvent === 'function' && typeof scope.Event === 'function') {
      scope.dispatchEvent(new scope.Event(NOTIFICATION_SPEECH_PREVIEW_EVENT));
    }
  } catch (_) { /* il coordinamento locale e' best-effort */ }
}

export function previewNotificationSpeech(text, lang, scope = browserScope(), opts = {}) {
  resetNotificationSpeechPriming(scope);
  if (!notificationSpeechSupported(scope)) return Promise.resolve(false);
  const value = cleanPart(text);
  if (!value) return Promise.resolve(false);
  if (opts.signal?.aborted) return Promise.resolve(false);
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs : NOTIFICATION_SPEECH_PREVIEW_TIMEOUT_MS;
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
  const signal = opts.signal;
  announceNotificationSpeechPreview(scope);

  return new Promise((resolve) => {
    let settled = false;
    let started = false;
    let timer = null;
    let onAbort = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      if (timer !== null) clearTimer(timer);
      if (!ok) {
        try { scope.speechSynthesis.cancel(); } catch (_) {}
      } else {
        primedScopes.add(scope);
      }
      resolve(ok);
    };
    onAbort = () => finish(false);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      scope.speechSynthesis.cancel();
      const utterance = new scope.SpeechSynthesisUtterance(value);
      utterance.lang = notificationSpeechLang(lang);
      utterance.onstart = () => { started = true; };
      utterance.onend = () => finish(started);
      utterance.onerror = () => finish(false);
      timer = setTimer(() => finish(false), timeoutMs);
      scope.speechSynthesis.speak(utterance);
    } catch (_) {
      finish(false);
    }
  });
}

// Una sola coda controllata per pagina. Il browser fornisce una coda propria,
// ma non ha un bound: la gestiamo qui per evitare minuti di parlato arretrato.
// Le notify high interrompono il parlato corrente; le normali conservano solo
// le due piu' recenti. Il documento deve essere visibile e focused: oltre a
// evitare doppia voce fra finestre, mantiene il consenso legato alla PWA attiva.
export function createNotificationSpeaker(opts = {}) {
  const scope = opts.scope || browserScope();
  const doc = opts.document || (scope && scope.document);
  const maxPending = Number.isInteger(opts.maxPending) && opts.maxPending >= 0
    ? opts.maxPending : MAX_NOTIFICATION_SPEECH_PENDING;
  const watchdogMs = Number.isFinite(opts.watchdogMs) && opts.watchdogMs > 0
    ? opts.watchdogMs : NOTIFICATION_SPEECH_WATCHDOG_MS;
  const dedupWindowMs = Number.isFinite(opts.dedupWindowMs) && opts.dedupWindowMs > 0
    ? opts.dedupWindowMs : NOTIFICATION_SPEECH_DEDUP_MS;
  const maxDedup = Number.isInteger(opts.maxDedup) && opts.maxDedup > 0
    ? opts.maxDedup : MAX_NOTIFICATION_SPEECH_DEDUP;
  const now = opts.now || Date.now;
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
  const isPrimed = opts.isPrimed || (() => notificationSpeechPrimed(scope));

  let active = null;
  let watchdog = null;
  let pending = [];
  const recent = new Map();

  const duplicateKey = (frame) => {
    if (frame && typeof frame.id === 'string' && frame.id) return `id:${frame.id}`;
    const ts = Number(frame && frame.ts);
    const title = cleanPart(frame && frame.title);
    return Number.isFinite(ts) && title ? `frame:${ts}:${title}` : '';
  };

  const remember = (key) => {
    if (!key) return true;
    const at = now();
    for (const [candidate, seenAt] of recent) {
      if (at - seenAt >= dedupWindowMs) recent.delete(candidate);
    }
    if (recent.has(key)) return false;
    recent.set(key, at);
    while (recent.size > maxDedup) recent.delete(recent.keys().next().value);
    return true;
  };

  const clearWatchdog = () => {
    if (watchdog !== null) clearTimer(watchdog);
    watchdog = null;
  };

  const cancelActive = () => {
    clearWatchdog();
    if (active) {
      active.onend = null;
      active.onerror = null;
      active = null;
    }
    cancelNotificationSpeech(scope);
  };

  const start = (item) => {
    if (!notificationSpeechSupported(scope)) {
      pending = [];
      return 'unsupported';
    }
    let utterance;
    try {
      utterance = new scope.SpeechSynthesisUtterance(item.text);
      utterance.lang = notificationSpeechLang(item.lang);
    } catch (_) {
      pending = [];
      return 'error';
    }

    active = utterance;
    const finish = () => {
      if (active !== utterance) return;
      clearWatchdog();
      active = null;
      utterance.onend = null;
      utterance.onerror = null;
      const next = pending.shift();
      if (next) start(next);
    };
    utterance.onend = finish;
    utterance.onerror = finish;

    try {
      watchdog = setTimer(() => {
        if (active !== utterance) return;
        active = null;
        utterance.onend = null;
        utterance.onerror = null;
        try { scope.speechSynthesis.cancel(); } catch (_) {}
        clearWatchdog();
        const next = pending.shift();
        if (next) start(next);
      }, watchdogMs);
      scope.speechSynthesis.speak(utterance);
      return 'speaking';
    } catch (_) {
      finish();
      return 'error';
    }
  };

  const enqueue = (frame, lang) => {
    if (!notificationSpeechSupported(scope)) return 'unsupported';
    const text = notificationSpeechText(frame);
    if (!text) return 'empty';
    if (!remember(duplicateKey(frame))) return 'duplicate';
    if (!documentIsActive(doc)) return 'inactive';
    if (!isPrimed()) return 'unprimed';
    const item = { text, lang };

    if (frame && frame.urgency === 'high') {
      pending = [];
      cancelActive();
      return start(item);
    }
    if (!active) return start(item);
    if (maxPending === 0) return 'dropped';
    if (pending.length >= maxPending) pending.shift();
    pending.push(item);
    return 'queued';
  };

  const stop = () => {
    pending = [];
    cancelActive();
  };

  return { enqueue, stop };
}
