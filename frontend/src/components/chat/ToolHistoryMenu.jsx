import { useId, useState } from 'react';
import { toolDuration } from '../../lib/chat-model.js';

function timeLabel(at) {
  if (!Number.isFinite(at)) return '--:--';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function ToolHistoryMenu({ tools = [] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (tools.length === 0) return null;
  return (
    <div className="nc-chat-tools-menu">
      <button
        type="button"
        className="nc-chat-tools-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        {tools.length} tool
        <span className="nc-chat-chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul id={id} className="nc-chat-tools-list">
          {tools.map((tool) => (
            <li key={tool.toolCallId}>
              <span className="nc-chat-tools-time">{timeLabel(tool.startedAt)}</span>
              <span className="nc-chat-tools-name">{tool.name}</span>
              <span className="nc-chat-tools-state">{tool.state}</span>
              <span className="nc-chat-tools-dur">
                {toolDuration(tool) === null ? '—' : `${(toolDuration(tool) / 1000).toFixed(1)} s`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
