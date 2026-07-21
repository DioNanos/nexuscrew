'use strict';

// Cause-preserving diagnostics for Fleet up() failures (T4).
//
// The up() path of the built-in fleet crosses five boundaries:
//   1. preflight gates          (command trust, cwd, managed-engine config)
//   2. the secure launch broker (private runtime dir, payload, lifecycle)
//   3. tmux new-session         (session creation / duplicate)
//   4. pane/client early-exit   (readiness / liveness gate)
//   5. the cell client spawn    (ENOENT/EACCES/... surfaced via cell-exec)
//
// When one of them failed, the cause used to be buried in a free-text error
// message.  These bounded enums travel on structured HTTP errors instead, so
// FLEET_ACTION_FAILED can report a closed {status, code, phase} triple that
// NEVER embeds cwd/path, argv, env, prompt, token or credential data — only
// stable enum strings, which are safe to persist and to show.
//
// Add a value here ONLY when a new reachable boundary needs a stable cause.
// Anything not in the enum degrades to UNKNOWN (bounded) at the coercion gate,
// so an untagged/legacy/unexpected error can never leak an unbounded string.

const UNKNOWN = 'UNKNOWN';

// Lifecycle phase of up() where a boundary failed.  Closed enum.
//   preflight      -> pre-launch validation gates
//   launch-broker  -> secure launch broker
//   new-session    -> tmux new-session creation
//   readiness      -> pane/client early-exit liveness gate
//   spawn-client   -> cell client spawn error surfaced via cell-exec
const PHASES = ['preflight', 'launch-broker', 'new-session', 'readiness', 'spawn-client'];
const PHASE_SET = new Set(PHASES);

// Stable failure code per boundary.  Closed enum; free text never enters here.
const CODES = [
  // preflight (pre-launch gates)
  'COMMAND_UNTRUSTED',
  'CWD_INVALID',
  'ENGINE_UNCONFIGURED',
  'SHELL_NOT_AVAILABLE',
  // launch-broker
  'LAUNCH_BROKER_UNSAFE',
  'LAUNCH_BROKER_PAYLOAD',
  'LAUNCH_BROKER_CLOSED',
  'LAUNCH_BROKER_FAILED',
  // new-session
  'NEW_SESSION_FAILED',
  'SESSION_DUPLICATE',
  // readiness (client started but exited immediately)
  'CLIENT_EARLY_EXIT',
  // spawn-client (cell client spawn error: ENOENT/EACCES/...)
  'SPAWN_CLIENT_FAILED',
  // bounded fallback for any untagged / legacy / unexpected error
  UNKNOWN,
];
const CODE_SET = new Set(CODES);

function coerce(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

// Coerce a raw code/phase to the bounded enum, degrading to UNKNOWN.
// Pure + without dependencies: testable directly.
function codeOf(value) { return coerce(value, CODE_SET, UNKNOWN); }
function phaseOf(value) { return coerce(value, PHASE_SET, UNKNOWN); }

module.exports = {
  UNKNOWN, PHASES, CODES, codeOf, phaseOf,
};
