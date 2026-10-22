import { useEffect, useMemo, useState } from 'react';
import { applyEvents, createView, RUN_STATE } from '../../lib/chat-model.js';
import RunStatusBar from './RunStatusBar.jsx';
import ToolHistoryMenu from './ToolHistoryMenu.jsx';
import ChatTranscript from './ChatTranscript.jsx';
import ChatStatusLine from './ChatStatusLine.jsx';
import ChatComposerPreview from './ChatComposerPreview.jsx';
import './ChatTile.css';

const RUNNING_STATES = new Set([RUN_STATE.RUNNING, RUN_STATE.CANCEL_REQUESTED, RUN_STATE.AWAITING_APPROVAL]);

function hasPendingApproval(events) {
  return (events || []).some((frame) => (frame?.event?.type || frame?.type) === 'approval_requested');
}

// The tile body: status strip, transcript, status line, one composer.
// It renders no header: the tile (GridTile / SingleView / demo shell) owns
// the single header, so a chat tile never shows two titles.
export default function ChatTileView({
  target,
  events = [],
  viewer = { canApprove: false },
  now,
  label = '',
  capabilities = null,
  demo = true,
  cancelRequested = false,
  reviews = {},
}) {
  const [anchor] = useState(() => (Number.isFinite(now) ? now : Date.now()));
  const pending = useMemo(() => hasPendingApproval(events), [events]);
  const [clock, setClock] = useState(anchor);

  useEffect(() => {
    if (Number.isFinite(now) || !pending) return undefined;
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [now, pending]);

  const view = useMemo(() => {
    // The cancel fence is a reducer action, not a post-hoc prop: append it as
    // a local frame so later frames in a fixture can prove they cannot reopen
    // the run.
    const frames = cancelRequested ? [...events, { type: 'cancel_requested' }] : events;
    return applyEvents(createView({ target, viewer, now: anchor, reviews }), frames);
  }, [target, viewer, events, anchor, cancelRequested, reviews]);

  return (
    <div className="nc-chat" data-state={view.state} data-target-kind={target?.kind || 'unknown'}>
      <div className="nc-chat-top">
        <RunStatusBar state={view.state} terminal={view.terminal} />
        <ToolHistoryMenu tools={view.tools} />
      </div>
      {demo ? (
        <p className="nc-chat-demo-notice" role="status" data-testid="chat-demo-notice">
          approvazioni dimostrative, semantica non qualificata
        </p>
      ) : null}
      <ChatTranscript view={view} viewer={viewer} now={Number.isFinite(now) ? now : clock} demo={demo} />
      <ChatStatusLine context={view.context} capabilities={capabilities} />
      <ChatComposerPreview label={label} running={RUNNING_STATES.has(view.state)} demo={demo} />
    </div>
  );
}
