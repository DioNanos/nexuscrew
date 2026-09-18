import { describe, expect, it } from 'vitest';
import {
  LIVE_HOST_NATIVE, LIVE_HOST_TMUX, liveHostIndicatorKeys, liveHostMode, liveHostView,
} from './live-host-view.js';

// The Live host as the UI must describe it: which cell, which mode the bridge
// will use, what the node measured, and whether it belongs to another node.
//
// The mode is not a setting: the bridge opens a native thread only for codex-vl
// engines (lib/live-host/bridge.js, resolveForLive) and works through the tmux
// session for every other engine. The UI has the engine from the roster, so it
// can say which one it will be BEFORE someone starts a Live on it.
describe('liveHostMode', () => {
  it('is native for the codex-vl engines and tmux for everything else', () => {
    expect(liveHostMode('codex-vl.native')).toBe(LIVE_HOST_NATIVE);
    expect(liveHostMode('codex-vl.ollama-cloud')).toBe(LIVE_HOST_NATIVE);
    expect(liveHostMode('claude.native')).toBe(LIVE_HOST_TMUX);
    expect(liveHostMode('shell.local')).toBe(LIVE_HOST_TMUX);
  });

  it('is null when the engine is unknown (no cell, no claim)', () => {
    expect(liveHostMode(null)).toBeNull();
    expect(liveHostMode('')).toBeNull();
    expect(liveHostMode(undefined)).toBeNull();
  });
});

const cells = [
  { cell: 'cell-one', engine: 'claude.native' },
  { cell: 'cell-two', engine: 'codex-vl.ollama-cloud' },
];

describe('liveHostView', () => {
  it('(1) no designation: none, and nothing to describe', () => {
    const view = liveHostView({ liveHost: { hostCell: null, revision: 3 }, cells });
    expect(view.state).toBe('none');
    expect(view.cell).toBeNull();
    expect(view.mode).toBeNull();
  });

  it('(2) designated on a tmux engine', () => {
    const view = liveHostView({ liveHost: { hostCell: 'cell-one', threadStatus: 'absent' }, cells });
    expect(view.cell).toBe('cell-one');
    expect(view.engine).toBe('claude.native');
    expect(view.mode).toBe(LIVE_HOST_TMUX);
    expect(view.state).toBe('designated');
  });

  it('(3) designated on a native engine, no thread yet', () => {
    const view = liveHostView({ liveHost: { hostCell: 'cell-two', threadStatus: 'absent' }, cells });
    expect(view.mode).toBe(LIVE_HOST_NATIVE);
    expect(view.state).toBe('designated');
  });

  it('(4) thread active on the designated cell', () => {
    const view = liveHostView({ liveHost: { hostCell: 'cell-two', threadStatus: 'active' }, cells });
    expect(view.state).toBe('thread-active');
  });

  it('(5) a host that belongs to another node', () => {
    const view = liveHostView({
      liveHost: { hostCell: 'cell-one', threadStatus: 'present' },
      cells,
      localNodeId: 'a'.repeat(32),
      ownerId: 'b'.repeat(32),
    });
    expect(view.remote).toBe(true);
    expect(view.state).toBe('thread-present');
  });

  it('a designation whose cell left the roster is still a designation', () => {
    const view = liveHostView({ liveHost: { hostCell: 'Gone', threadStatus: 'absent' }, cells });
    expect(view.state).toBe('designated');
    expect(view.known).toBe(false);
    expect(view.mode).toBeNull();
  });
});

describe('liveHostIndicatorKeys', () => {
  it('names the mode and the state for the three shapes that matter', () => {
    expect(liveHostIndicatorKeys(liveHostView({ liveHost: { hostCell: null }, cells })).stateKey).toBe('live-host-state-none');
    expect(liveHostIndicatorKeys(liveHostView({ liveHost: { hostCell: 'cell-one', threadStatus: 'absent' }, cells })).modeKey)
      .toBe('live-host-mode-tmux');
    expect(liveHostIndicatorKeys(liveHostView({ liveHost: { hostCell: 'cell-two', threadStatus: 'active' }, cells })).stateKey)
      .toBe('live-host-state-thread-active');
  });
});
