const DOUBLE_TAP_MS = 420;
const DOUBLE_TAP_PX = 32;

function editable(element) {
  if (!element || typeof element !== 'object') return false;
  const tag = String(element.tagName || '').toLowerCase();
  return tag === 'textarea' || tag === 'input' || element.isContentEditable === true;
}

// Chiusura best-effort a due livelli: API Chromium quando presente e blur
// portabile dell'editable attivo. Nessun throw deve interrompere il comando PTY.
export function dismissVirtualKeyboard({ documentRef, navigatorRef } = {}) {
  const doc = documentRef || (typeof document !== 'undefined' ? document : null);
  const nav = navigatorRef || (typeof navigator !== 'undefined' ? navigator : null);
  let apiRequested = false;
  try {
    if (nav?.virtualKeyboard && typeof nav.virtualKeyboard.hide === 'function') {
      nav.virtualKeyboard.hide(); apiRequested = true;
    }
  } catch (_) { /* API sperimentale: il blur resta il fallback */ }
  const active = doc && doc.activeElement;
  let blurred = false;
  if (editable(active) && typeof active.blur === 'function') {
    try { active.blur(); blurred = true; } catch (_) { /* best-effort */ }
  }
  return { blurred, apiRequested };
}

export function setTerminalInputMode(term, gesture, unlocked = false) {
  const textarea = term && term.textarea;
  if (!textarea) return null;
  const text = gesture === 'single-tap' || (gesture === 'double-tap' && unlocked);
  const mode = text ? 'text' : 'none';
  textarea.inputMode = mode;
  textarea.setAttribute('inputmode', mode);
  return mode;
}

export function showTerminalVirtualKeyboard(term, navigatorRef) {
  if (!term || !term.textarea) return false;
  setTerminalInputMode(term, 'double-tap', true);
  try { term.focus(); } catch (_) { return false; }
  const nav = navigatorRef || (typeof navigator !== 'undefined' ? navigator : null);
  try {
    if (nav?.virtualKeyboard && typeof nav.virtualKeyboard.show === 'function') nav.virtualKeyboard.show();
  } catch (_) { /* il focus con inputmode=text resta il fallback */ }
  return true;
}

export function terminalTapDecision(gesture, previous, current) {
  if (gesture === 'never') return { open: false, next: null };
  if (gesture === 'single-tap') return { open: true, next: null };
  if (!current || !Number.isFinite(current.at) || !Number.isFinite(current.x) || !Number.isFinite(current.y)) {
    return { open: false, next: null };
  }
  if (previous && current.at >= previous.at && current.at - previous.at <= DOUBLE_TAP_MS
    && Math.hypot(current.x - previous.x, current.y - previous.y) <= DOUBLE_TAP_PX) {
    return { open: true, next: null };
  }
  return { open: false, next: current };
}

export { DOUBLE_TAP_MS, DOUBLE_TAP_PX };
