'use strict';

/**
 * Format the standard NexusCrew cell message envelope.
 *
 * [NexusCrew message <id> from <label>]
 * <text>
 * [End NexusCrew message]
 */
function formatCellEnvelope({ id, label, text }) {
  return `[NexusCrew message ${id} from ${label}]\n${text}\n[End NexusCrew message]`;
}

/**
 * Deliver a message to a target cell's tmux session using the submit function.
 */
async function deliverCellMessage(submit, target, { id, label, text }) {
  if (typeof submit !== 'function') {
    throw new Error('cell submit function required');
  }
  const envelope = formatCellEnvelope({ id, label, text });
  return await submit(target.tmuxSession, envelope, { engine: target.engine });
}

module.exports = {
  formatCellEnvelope,
  deliverCellMessage,
};
