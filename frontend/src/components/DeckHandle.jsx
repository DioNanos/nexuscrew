import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';

const EDGE_PX = 52;
const EDGE_STEP = 18;

// Pointer Events, non HTML5 drag: mouse, touch e pen seguono lo stesso path.
// Il riordino resta confinato all'owner del deck; non cambia mai nodo/ownership.
export default function DeckHandle({ ownerKey, deckId, label, onMove, onStep }) {
  const state = useRef(null);
  const frame = useRef(0);
  const [active, setActive] = useState(false);

  const clearTarget = () => {
    const current = state.current;
    current?.over?.classList?.remove('nc-deck-over');
    current?.source?.classList?.remove('nc-deck-dragging');
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  };

  const finish = (commit = false) => {
    const current = state.current;
    if (!current) return;
    const target = current.target;
    clearTarget(); state.current = null; setActive(false);
    try { current.handle.releasePointerCapture(current.pointerId); } catch (_) {}
    if (commit && target && target !== deckId) onMove(deckId, target);
  };

  const updateTarget = (x, y) => {
    const current = state.current;
    if (!current) return;
    current.x = x; current.y = y;
    const chip = document.elementFromPoint(x, y)?.closest?.('[data-deck-id][data-owner-key]');
    const target = chip?.dataset?.deckId;
    const valid = chip?.dataset?.ownerKey === ownerKey && target && target !== deckId;
    if (current.over !== (valid ? chip : null)) {
      current.over?.classList?.remove('nc-deck-over');
      current.over = valid ? chip : null;
      current.over?.classList?.add('nc-deck-over');
    }
    current.target = valid ? target : null;
  };

  const autoScroll = () => {
    const current = state.current;
    if (!current) { frame.current = 0; return; }
    const rect = current.container?.getBoundingClientRect?.();
    if (rect) {
      const delta = current.x < rect.left + EDGE_PX ? -EDGE_STEP
        : current.x > rect.right - EDGE_PX ? EDGE_STEP : 0;
      if (delta) {
        current.container.scrollLeft += delta;
        updateTarget(current.x, current.y);
      }
    }
    frame.current = requestAnimationFrame(autoScroll);
  };

  useEffect(() => {
    const key = (event) => {
      if (event.key === 'Escape' && state.current) { event.preventDefault(); finish(false); }
    };
    const blur = () => finish(false);
    window.addEventListener('keydown', key); window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', key); window.removeEventListener('blur', blur);
      clearTarget(); state.current = null;
    };
  }, [deckId, ownerKey]);

  const pointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    const source = event.currentTarget.closest('[data-deck-id][data-owner-key]');
    const container = event.currentTarget.closest('.nc-deckbar');
    state.current = {
      pointerId: event.pointerId, handle: event.currentTarget, source, container,
      target: null, over: null, x: event.clientX, y: event.clientY,
    };
    source?.classList?.add('nc-deck-dragging');
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) {}
    setActive(true); frame.current = requestAnimationFrame(autoScroll);
  };

  return (
    <button type="button" className={`nc-deck-handle${active ? ' active' : ''}`}
      aria-label={`${t('reorder')} ${label}`} aria-keyshortcuts="ArrowLeft ArrowRight"
      title={t('reorder-deck-help')}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); event.stopPropagation(); onStep(event.key === 'ArrowLeft' ? -1 : 1);
      }}
      onPointerDown={pointerDown}
      onPointerMove={(event) => {
        if (!state.current || event.pointerId !== state.current.pointerId) return;
        event.preventDefault(); event.stopPropagation(); updateTarget(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        if (!state.current || event.pointerId !== state.current.pointerId) return;
        event.preventDefault(); event.stopPropagation(); finish(true);
      }}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => { if (state.current) finish(false); }}
    >↔</button>
  );
}
