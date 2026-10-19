import { RUN_STATE_LABEL } from '../../lib/chat-model.js';

// One run, one label. The label describes the observed state, never a
// promise: "inviato" is transport, not admission.
export default function RunStatusBar({ state, terminal = null }) {
  const label = RUN_STATE_LABEL[state] || state;
  return (
    <span className="nc-chat-state" data-state={state} role="status" aria-live="polite">
      {label}
      {terminal?.stopReason ? <small className="nc-chat-stop"> · {terminal.stopReason}</small> : null}
    </span>
  );
}
