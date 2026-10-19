// Only available fields. Missing data is declared with an em dash, never
// filled with a plausible value.
export default function ChatStatusLine({ context, capabilities }) {
  const cwd = context?.cwd || capabilities?.cwd || '—';
  const policy = capabilities?.permissionPolicy || context?.policy || '—';
  const ctx = Number.isFinite(context?.contextPct ?? capabilities?.contextPct)
    ? `${context?.contextPct ?? capabilities?.contextPct}%`
    : '—';
  const ram = capabilities?.ram || '—';
  return (
    <div className="nc-chat-statusline" data-testid="chat-statusline">
      <span title="working directory">{cwd}</span>
      <span aria-hidden="true">·</span>
      <span title="policy">{policy}</span>
      <span aria-hidden="true">·</span>
      <span title="context">{`ctx ${ctx}`}</span>
      <span aria-hidden="true">·</span>
      <span title="RAM">{`RAM ${ram}`}</span>
    </div>
  );
}
