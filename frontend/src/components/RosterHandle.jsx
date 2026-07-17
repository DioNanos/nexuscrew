import { useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';

const EDGE_PX = 52;
const EDGE_STEP = 14;

// Dedicated Pointer Events reorder handle. It works identically with mouse,
// touch and pen, never competes with the card's native session-to-deck drag,
// and commits only on pointerup so cancel/Escape leaves the saved order intact.
export default function RosterHandle({
  position, itemKey, label, onMove, onStep, canMove = () => true, scope = 'roster',
}) {
  const state = useRef(null);
  const frame = useRef(0);
  const [active, setActive] = useState(false);

  const clearTarget = () => {
    const current = state.current;
    current?.over?.classList?.remove('nc-roster-over');
    current?.source?.classList?.remove('nc-roster-dragging');
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  };

  const finish = (commit = false) => {
    const current = state.current;
    if (!current) return;
    const target = current.target;
    clearTarget(); state.current = null; setActive(false);
    try { current.handle.releasePointerCapture(current.pointerId); } catch (_) {}
    if (commit && target && target !== itemKey && canMove(itemKey, target)) onMove(itemKey, target);
  };

  const updateTarget = (x, y) => {
    const current = state.current;
    if (!current) return;
    current.x = x; current.y = y;
    const selector = scope === 'node' ? '[data-node-order-key]' : '[data-roster-key][data-position]';
    const card = document.elementFromPoint(x, y)?.closest?.(selector);
    const target = scope === 'node' ? card?.dataset?.nodeOrderKey : card?.dataset?.rosterKey;
    const samePosition = scope === 'node' || card?.dataset?.position === position;
    const valid = samePosition && target && target !== itemKey && canMove(itemKey, target);
    if (current.over !== (valid ? card : null)) {
      current.over?.classList?.remove('nc-roster-over');
      current.over = valid ? card : null;
      current.over?.classList?.add('nc-roster-over');
    }
    current.target = valid ? target : null;
  };

  const autoScroll = () => {
    const current = state.current;
    if (!current) { frame.current = 0; return; }
    const container = current.container;
    if (container) {
      const rect = container.getBoundingClientRect();
      const delta = current.y < rect.top + EDGE_PX ? -EDGE_STEP
        : current.y > rect.bottom - EDGE_PX ? EDGE_STEP : 0;
      if (delta) {
        container.scrollTop += delta;
        updateTarget(current.x, current.y);
      }
    }
    frame.current = requestAnimationFrame(autoScroll);
  };

  useEffect(() => {
    const key = (event) => { if (event.key === 'Escape' && state.current) { event.preventDefault(); finish(false); } };
    const blur = () => finish(false);
    window.addEventListener('keydown', key); window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', key); window.removeEventListener('blur', blur);
      clearTarget(); state.current = null;
    };
  }, [itemKey, position, scope]);

  const pointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    const selector = scope === 'node' ? '[data-node-order-key]' : '[data-roster-key][data-position]';
    const source = event.currentTarget.closest(selector);
    const container = event.currentTarget.closest('.nc-side-scroll, .nc-home-scroll');
    state.current = {
      pointerId: event.pointerId, handle: event.currentTarget, source, container,
      target: null, over: null, x: event.clientX, y: event.clientY,
    };
    source?.classList?.add('nc-roster-dragging');
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) {}
    setActive(true); frame.current = requestAnimationFrame(autoScroll);
  };

  return (
    <button type="button" className={`nc-roster-handle${active ? ' active' : ''}`}
      aria-label={`${t('reorder')} ${label}`} aria-keyshortcuts="ArrowUp ArrowDown"
      title={t('reorder-help')}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDragStart={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault(); event.stopPropagation(); onStep(event.key === 'ArrowUp' ? -1 : 1);
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
    >↕</button>
  );
}
