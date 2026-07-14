import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';

export const ROSTER_DRAG_TYPE = 'application/x-nexuscrew-roster';

export function rosterDropHandlers(position, target, onMove) {
  return {
    onDragOver: (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes(ROSTER_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDrop: (event) => {
      const raw = event.dataTransfer?.getData(ROSTER_DRAG_TYPE);
      if (!raw) return;
      event.preventDefault(); event.stopPropagation();
      try {
        const source = JSON.parse(raw);
        if (source.position === position && source.key && source.key !== target) onMove(source.key, target);
      } catch (_) { /* malformed external drag: ignore */ }
    },
  };
}

// Desktop: native drag from a dedicated handle, leaving the card's existing
// session-to-deck drag untouched. Touch: 350ms long press, then crossing another
// card moves immediately. Keyboard ArrowUp/ArrowDown is the accessible fallback.
export default function RosterHandle({ position, itemKey, label, onMove, onStep }) {
  const timer = useRef(null);
  const origin = useRef(null);
  const dragging = useRef(false);
  const lastTarget = useRef(null);
  const suppressClick = useRef(false);
  const [active, setActive] = useState(false);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null; origin.current = null; dragging.current = false;
    lastTarget.current = null; setActive(false);
  };

  const pointerDown = (event) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    origin.current = { x: event.clientX, y: event.clientY, id: event.pointerId, target: event.currentTarget };
    timer.current = setTimeout(() => {
      timer.current = null; dragging.current = true; suppressClick.current = true; setActive(true);
      try { origin.current?.target.setPointerCapture(origin.current.id); } catch (_) {}
    }, 350);
  };
  const pointerMove = (event) => {
    if (!origin.current) return;
    if (!dragging.current) {
      if (Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 8) clear();
      return;
    }
    event.preventDefault();
    const card = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-roster-key][data-position]');
    const target = card?.dataset?.rosterKey;
    if (card?.dataset?.position === position && target && target !== itemKey && target !== lastTarget.current) {
      lastTarget.current = target; onMove(itemKey, target);
    }
  };
  const pointerEnd = () => clear();

  return (
    <button type="button" className={`nc-roster-handle${active ? ' active' : ''}`}
      aria-label={`${t('reorder')} ${label}`} aria-keyshortcuts="ArrowUp ArrowDown"
      title={t('reorder-help')} draggable
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(ROSTER_DRAG_TYPE, JSON.stringify({ position, key: itemKey }));
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (suppressClick.current) { event.preventDefault(); suppressClick.current = false; }
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault(); event.stopPropagation(); onStep(event.key === 'ArrowUp' ? -1 : 1);
      }}
      onPointerDown={pointerDown} onPointerMove={pointerMove}
      onPointerUp={pointerEnd} onPointerCancel={pointerEnd}
    >↕</button>
  );
}
