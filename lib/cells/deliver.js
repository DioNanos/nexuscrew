'use strict';

const BS = String.fromCharCode(0x5c); // backslash
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const OPEN_BRACKET = String.fromCharCode(0x5b);

// A body line that starts with a delimiter marker can CLOSE the envelope and
// make the rest of the text look like a message from another sender. The
// marker is matched on the text that follows the leading '[': the two forms
// of the contract are "[NexusCrew message ..." and "[End NexusCrew message]".
const MARKER_RE = /^(?:End )?NexusCrew message/i;

/**
 * Normalize the line endings of a message body: CRLF and a lone CR both
 * become LF. A lone CR is a line break for a terminal (it rewrites the line
 * it lands on), so it must not survive into the envelope: after the
 * normalization every body line is a line of its own, and the escape below
 * sees exactly what the reader will see.
 */
function normalizeEnvelopeText(text) {
  if (typeof text !== 'string') return '';
  return text.split(CR + LF).join(LF).split(CR).join(LF);
}

/**
 * Escape one body line: a line that starts with a delimiter marker gets a
 * backslash before the '['. The line no longer starts with the marker, so it
 * cannot close the envelope nor fake a sender, and the escape survives a
 * reader that trims the line before matching it.
 *
 * What counts as "starts with" is the whitespace of JavaScript: a reader
 * that trims the head of the line removes the Unicode spaces and the byte
 * order mark too, so a marker behind one of them is a marker for that
 * reader. The rule is the one of trimStart(), not a hand-made list of
 * characters: a marker that such a reader would recognize is escaped.
 *
 * The boundary of the contract: the line endings normalized here and the
 * whitespace a reader trims. A reader that rewrites the text (a
 * compatibility normalization, for instance) may still see a marker that is
 * not a marker here.
 */
function escapeEnvelopeLine(line) {
  const trimmed = line.trimStart();
  if (trimmed.charAt(0) !== OPEN_BRACKET) return line;
  if (!MARKER_RE.test(trimmed.slice(1))) return line;
  // The head that trimStart() removed is the head to keep: the escape goes
  // right before the bracket, so a reader that trims still sees it.
  const head = line.slice(0, line.length - trimmed.length);
  return head + BS + trimmed;
}

/**
 * The body of a cell message, safe to be wrapped in the envelope: line
 * endings are normalized and no body line can be read as a delimiter.
 */
function escapeEnvelopeText(text) {
  return normalizeEnvelopeText(text).split(LF).map(escapeEnvelopeLine).join(LF);
}

/**
 * Format the standard NexusCrew cell message envelope.
 *
 * [NexusCrew message <id> from <label>]
 * <text>
 * [End NexusCrew message]
 *
 * The contract is ONE for every path that delivers a cell message (the
 * /cells/send route and the VL node outbox): the body never contains a line
 * that starts with a delimiter marker, so a message can neither close its own
 * envelope nor fake another sender.
 */
function formatCellEnvelope({ id, label, text }) {
  return `[NexusCrew message ${id} from ${label}]\n${escapeEnvelopeText(text)}\n[End NexusCrew message]`;
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
  escapeEnvelopeText,
  normalizeEnvelopeText,
  deliverCellMessage,
};
