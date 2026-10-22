import { toolDuration } from '../../lib/chat-model.js';

const STATE_LABEL = { ok: 'ok', error: 'errore', running: 'in corso' };

function durationLabel(tool) {
  const ms = toolDuration(tool);
  // The source may not carry both times (replay): say unknown, never invent.
  if (ms === null) return 'durata sconosciuta';
  return `${(ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} s`;
}

// Only the tool name, the outcome and a duration reference. No argv, no
// command, no raw output: those need an explicit authorized read.
export default function ToolCardInline({ tool }) {
  return (
    <article className="nc-chat-tool" data-state={tool.state} data-tool-call-id={tool.toolCallId}>
      <span className="nc-chat-tool-dot" aria-hidden="true" />
      <span className="nc-chat-tool-name">{tool.name}</span>
      <span className="nc-chat-tool-result">{STATE_LABEL[tool.state] || tool.state}</span>
      <span className="nc-chat-tool-dur">{durationLabel(tool)}</span>
    </article>
  );
}
