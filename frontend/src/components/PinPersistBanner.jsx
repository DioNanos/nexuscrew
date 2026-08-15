// Banner condiviso (desktop Sidebar + mobile SessionList) per un fallimento di
// persistenza del pin dopo un clear server riuscito. Il contratto (rev6 §2.1)
// chiede che l'errore sia SEGNALATO e RITENTABILE: questo e' UI, non console.
// pinError = null -> non renderizza nulla.
export default function PinPersistBanner({ pinError, onRetry, onDismiss }) {
  if (!pinError) return null;
  return (
    <div className="nc-pin-error" role="alert">
      <span className="nc-pin-error-text">★ preferenza non salvata</span>
      <button type="button" className="nc-pin-error-retry" onClick={onRetry}>riprova</button>
      <button type="button" className="nc-pin-error-close" onClick={onDismiss} aria-label="chiudi avviso">×</button>
    </div>
  );
}
