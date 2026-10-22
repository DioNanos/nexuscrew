import ToolCardInline from './ToolCardInline.jsx';
import ApprovalCard from './ApprovalCard.jsx';
import { RUN_STATE } from '../../lib/chat-model.js';

function Message({ message }) {
  return (
    <div className={`nc-chat-msg nc-chat-msg-${message.role}`} data-message-id={message.messageId}>
      <p>{message.text}</p>
      {message.streaming ? <span className="nc-chat-caret" aria-hidden="true">▍</span> : null}
    </div>
  );
}

const CONFLICT_LABEL = {
  'seq-payload': 'evento duplicato con contenuto diverso',
  'terminal-conflict': 'terminale in conflitto (mantenuto il primo)',
  'stale-reset': 'reset rifiutato (epoch ritirato o precedente)',
};

function conflictLabel(conflict) {
  return CONFLICT_LABEL[conflict.kind] || conflict.kind;
}

// Renders items in event order. Text is inert data: no HTML, no markdown.
export default function ChatTranscript({ view, viewer, now = Date.now(), demo = true }) {
  const byId = (list, key, id) => list.find((entry) => entry[key] === id);
  return (
    <div className="nc-chat-log" data-testid="chat-transcript">
      {view.conflicts.length > 0 ? (
        <div className="nc-chat-notice nc-chat-notice-warn nc-chat-conflict" role="alert" data-testid="chat-conflicts">
          <strong>conflitto d'integrità</strong>
          <ul>
            {view.conflicts.map((conflict, index) => (
              <li key={`${conflict.kind}:${index}`}>{conflictLabel(conflict)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.gap ? (
        <div className="nc-chat-notice" role="status">
          {view.gap.count ? `${view.gap.count} eventi mancanti` : 'eventi mancanti'} · {view.gap.reason}
        </div>
      ) : null}
      {view.reset ? (
        <div className="nc-chat-notice" role="status">
          vista azzerata · {view.reset.reason}
        </div>
      ) : null}
      {view.items.map((item) => {
        if (item.kind === 'message') {
          const message = byId(view.messages, 'messageId', item.messageId);
          return message ? <Message key={`m:${item.messageId}`} message={message} /> : null;
        }
        if (item.kind === 'tool') {
          const tool = byId(view.tools, 'toolCallId', item.toolCallId);
          return tool ? <ToolCardInline key={`t:${item.toolCallId}`} tool={tool} /> : null;
        }
        if (item.kind === 'approval') {
          return <ApprovalCard key="approval" run={view} approval={view.approval} viewer={viewer} now={now} demo={demo} />;
        }
        return null;
      })}
      {view.state === RUN_STATE.UNKNOWN && !view.terminal ? (
        <div className="nc-chat-notice nc-chat-notice-warn" role="status">
          esito incerto: la sorgente non ha ancora fornito un terminale
        </div>
      ) : null}
    </div>
  );
}
