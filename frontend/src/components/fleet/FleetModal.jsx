import { useEffect, useRef } from 'react';
import { t } from '../../lib/i18n.js';

// FleetTab's shared dialog shell: owns keyboard focus (initial focus, Tab trap,
// Escape close, restore previous focus) and surfaces the active error inside
// the dialog. Extracted verbatim from FleetTab.jsx; behaviour is unchanged.
export default function FleetModal({ children, onClose, label, error = '' }) {
  const dialogRef = useRef(null);
  const errorRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) || []).filter((element) => element.offsetParent !== null);
    const frame = requestAnimationFrame(() => (focusable()[0] || dialog)?.focus({ preventScroll: true }));
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current?.(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog?.focus(); return; }
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey);
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!error) return;
    requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: 'nearest' }));
  }, [error]);
  return (
    <div className="nc-fleet-modal" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="nc-fleet-modal-dialog" role="dialog" aria-modal="true" aria-label={label || t('settings')} tabIndex={-1}>
        {children}
        {error && <div ref={errorRef} className="nc-err nc-fleet-modal-error" role="alert" aria-live="assertive">{error}</div>}
      </div>
    </div>
  );
}
