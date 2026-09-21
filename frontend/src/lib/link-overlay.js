// resa della riconnessione: regole PURE, così sono verificabili senza
// montare xterm. Il componente le usa e resta sottile.

// L'overlay non è un riflesso: sotto questa soglia la caduta è un blip e
// mostrarlo farebbe lampeggiare il terminale a ogni jitter.
export const LINK_OVERLAY_DELAY_MS = 1000;

// `droppedAtMs` è l'istante della caduta (null/undefined = nessuna caduta).
export function overlayAfterDrop(droppedAtMs, nowMs, delayMs = LINK_OVERLAY_DELAY_MS) {
  if (droppedAtMs === null || droppedAtMs === undefined) return false;
  const since = Number(nowMs) - Number(droppedAtMs);
  if (!Number.isFinite(since)) return false;
  return since >= Math.max(0, Number(delayMs) || 0);
}

// Dopo un repaint il contenuto cambia: chi stava leggendo indietro non deve
// essere strappato in fondo. `before` è lo stato xterm prima del repaint
// ({viewportY, baseY}), `after` quello dopo ({baseY}).
export function scrollRestorePlan(before = {}, after = {}) {
  const viewportY = Number(before.viewportY) || 0;
  const baseY = Number(before.baseY) || 0;
  const newBaseY = Math.max(0, Number(after.baseY) || 0);
  const atBottom = viewportY >= baseY;
  if (atBottom) return { atBottom: true, line: null };
  // Una riga che non esiste più nella nuova coda viene agganciata alla coda:
  // mai uno scroll fuori range.
  return { atBottom: false, line: Math.min(viewportY, newBaseY) };
}

// Riga di confine discreta al ritorno, SOLO se l'overlay era stato mostrato:
// chi non ha visto nulla non deve trovare una riga in più nel buffer.
export function boundaryNoticeLine(wasOverlayVisible) {
  return wasOverlayVisible ? '\r\n\x1b[2m── riconnesso ──\x1b[0m\r\n' : '';
}
