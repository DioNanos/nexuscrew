// frontend/src/lib/selection.js — gesto desktop "forza selezione locale" sopra una
// TUI con mouse reporting (tmux/vim/htop). Queste app catturano i drag del mouse:
// la selezione "gialla" diventa server-side e Cmd+C non trova testo locale da
// copiare. Come iTerm (Shift+Control+drag) offriamo un gesto che intercetta i
// mouse event PRIMA di xterm (capture + preventDefault + stopPropagation) e
// seleziona localmente: i mouse event NON raggiungono la TUI.
//
// Pura e testabile in Node (nessun DOM): vuoleShift decide se un evento mouse
// deve avviare la selezione locale forzata.

// Shift (da solo o con Control/Alt) -> forza selezione locale.
//   Shift+Control+drag = gesto iTerm-like esplicito (Mac).
//   Shift+drag         = standard xterm; lo gestiamo noi per coerenza del feedback
//                        perche' tmux interpreta Shift e ruberebbe la selezione.
// Control/Alt da soli NON triggerano (possono essere shortcut TUI).
export function wantsLocalSelection(e) {
  if (!e || typeof e !== 'object') return false;
  return !!e.shiftKey;
}

// Copia shortcut: Cmd+C (Mac) o Ctrl+Shift+C (Linux/Windows standard terminale).
// Ritorna true se l'evento e' un "copy" da intercettare (con una selezione attiva).
export function isCopyShortcut(e) {
  if (!e || typeof e !== 'object') return false;
  const c = String(e.key || '').toLowerCase();
  if (c !== 'c') return false;
  return !!(e.metaKey || (e.ctrlKey && e.shiftKey));
}

// Touch: una pressione ferma attiva la selezione locale; un movimento prima
// della soglia resta invece uno scroll tmux. Valori puri per testare la gesture.
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_MOVE_PX = 8;
export function movedBeyondLongPress(startX, startY, x, y) {
  return Math.abs(Number(x) - Number(startX)) > LONG_PRESS_MOVE_PX
    || Math.abs(Number(y) - Number(startY)) > LONG_PRESS_MOVE_PX;
}
