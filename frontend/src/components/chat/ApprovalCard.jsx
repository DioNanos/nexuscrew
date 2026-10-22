import { canApprove } from '../../lib/chat-model.js';

function secondsLeft(expiresAt, now) {
  if (!Number.isFinite(expiresAt)) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function mmss(total) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// One card, two readers. The command and the review fields exist only for a
// viewer allowed to approve; everyone else sees a bounded state. Buttons are
// "Approva una volta" / "Nega" — never "sempre per la sessione".
export default function ApprovalCard({ run, approval, viewer = { canApprove: false }, now = Date.now(), demo = true }) {
  if (!approval) return null;
  const left = secondsLeft(approval.expiresAt, now);
  const expired = left === 0;
  const resolved = Boolean(approval.resolved);
  const actionable = canApprove(run, approval, viewer) && !expired && !resolved;
  const canReview = viewer.canApprove === true && Boolean(approval.review);
  const status = resolved ? `risolta: ${approval.resolved}` : expired ? 'scaduta' : `scade ${mmss(left)}`;

  return (
    <section className="nc-chat-approval" data-state={resolved ? 'resolved' : expired ? 'expired' : 'pending'} aria-label="Richiesta di approvazione">
      <header className="nc-chat-approval-head">
        <span className="nc-chat-approval-title">Comando distruttivo</span>
        <span className="nc-chat-approval-status">{status}</span>
      </header>
      {canReview ? (
        <>
          <pre className="nc-chat-approval-command">{approval.review.displayCommand}</pre>
          <dl className="nc-chat-approval-meta">
            {approval.review.cwd ? <div><dt>cwd</dt><dd>{approval.review.cwd}</dd></div> : null}
            {Array.isArray(approval.review.targets) && approval.review.targets.length > 0
              ? <div><dt>target</dt><dd>{approval.review.targets.join(', ')}</dd></div> : null}
            {approval.review.effectiveUser ? <div><dt>utente</dt><dd>{approval.review.effectiveUser}</dd></div> : null}
            {approval.summary?.coverage ? <div><dt>copertura</dt><dd>{approval.summary.coverage}</dd></div> : null}
          </dl>
        </>
      ) : (
        <p className="nc-chat-approval-redacted">Dettaglio non disponibile a questo lettore.</p>
      )}
      <div className="nc-chat-approval-actions">
        <button type="button" className="nc-chat-btn" disabled={!actionable} data-demo={demo ? '1' : undefined}>
          Nega
        </button>
        <button type="button" className="nc-chat-btn nc-chat-btn-primary" disabled={!actionable} data-demo={demo ? '1' : undefined}>
          Approva una volta
        </button>
      </div>
      {approval.invalidated ? (
        <small className="nc-chat-demo-hint" data-testid="approval-invalidated">
          richiesta non più valida: {approval.invalidated}
        </small>
      ) : null}
      {demo && actionable ? <small className="nc-chat-demo-hint">demo: nessuna azione</small> : null}
    </section>
  );
}
