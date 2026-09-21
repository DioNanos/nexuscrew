// Parametri del terminale letti dalla config del SERVER (`terminal` in
// /api/config) e usati dal client. Un valore assente, non numerico o non
// positivo NON entra: resta il default. Cosi' una config sbagliata degrada al
// comportamento noto invece di rompere il terminale.

export const TERMINAL_RUNTIME_DEFAULTS = Object.freeze({
  retryBaseMs: 250,
  retryMaxMs: 5000,
  pingMs: 5000,
  deadMs: 10000,
  queuedInputBytes: 4096,
  overlayDelayMs: 1000,
});

const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function sanitizeTerminalConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, fallback] of Object.entries(TERMINAL_RUNTIME_DEFAULTS)) {
    out[key] = positiveNumber(source[key], fallback);
  }
  return out;
}

let current = sanitizeTerminalConfig(null);

export function setTerminalRuntimeConfig(raw) {
  current = sanitizeTerminalConfig(raw);
  return { ...current };
}

export function terminalRuntimeConfig() {
  return { ...current };
}
