'use strict';

// Cause-preserving diagnostics for Fleet up failures.
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
  'MCP_CELL_FILE_UNWRITABLE',
  'CAPABILITY_PROFILE_UNWRITABLE',
  'CAPABILITY_UNKNOWN_NAME',
  // preflight lifecycle registry: no durable location accepted the current
  // launch identity, or a registry copy was unreadable/invalid so the
  // revision order could not be established — either way the launch is
  // refused (a stale registry record must never become authoritative again
  // after a runtime restart)
  'LAUNCH_REGISTRY_UNWRITABLE',
  // preflight vl: pausa minima fra due lanci della stessa cella non trascorsa /
  // marcatore «sessione nuova» non consumabile in sicurezza (albero ostile) /
  // launcher non compatibile con la capacita dichiarata
  'VL_LAUNCH_COOLDOWN',
  'VL_NEW_SESSION_UNSAFE',
  'LAUNCHER_UNSUPPORTED',
  // preflight vl: the pinned binary's own status does not declare both peer
  // identity/stop capabilities with peer observation support — the launch is
  // refused before the spawn (a binary that cannot attest the host process
  // it would have to stop is never spawned against)
  'VL_PEER_STOP_UNSUPPORTED',
  // post-spawn vl gate: the live host's peer identity could not be acquired
  // as `verified` from the pinned binary and persisted into the launch
  // context — the launch fails visibly instead of being declared up on a
  // record that cannot be attested (no isolation is deduced from declared_pid)
  'VL_PEER_UNATTESTED',
  // VL root claim: exclusive ownership/lease under the held lock
  'VL_ROOT_COLLISION',
  'LOCK_UNAVAILABLE',
  'CLAIM_UNCERTAIN',
  'HOST_STOP_FAILED',
  'HOST_IN_GROUP',
  'HOST_IDENTITY_CHANGED',
  'HOST_UNRESOLVABLE',
  // teardown vl: the protected stop refused — the peer on the verified
  // connection is not the one registered at up (peer_mismatch), the identity
  // could not be proven (peer_unknown) or the expected tuple did not parse
  // (expected_invalid). Nothing was sent to the host: the refusal is the
  // answer, and it is shown to the operator like the other vl outcomes.
  'HOST_PEER_MISMATCH',
  'HOST_PEER_UNKNOWN',
  'HOST_EXPECTED_INVALID',
  // launch-broker
  'LAUNCH_BROKER_UNSAFE',
  'LAUNCH_BROKER_PAYLOAD',
  'LAUNCH_BROKER_CLOSED',
  'LAUNCH_BROKER_FAILED',
  // new-session
  'NEW_SESSION_FAILED',
  'SESSION_DUPLICATE',
  // launch target record: the durable proof of WHAT this runtime created
  // ($session id, %pane id, server identity). Without it a launch would be
  // orphaned — a later stop could never demonstrate what to tear down.
  'LAUNCH_TARGET_UNWRITABLE',
  // the supervisor identity could not be re-captured on the owned channel
  // after a successful respawn: the record still names the placeholder, so
  // the launch fails instead of reporting success on a stale pid
  'POST_RESPAWN_IDENTITY_UNKNOWN',
  // teardown: the stop acts only on owned ids, never on a session name
  'IDENTITY_UNVERIFIED',
  // the in-group coordinator channel is gone: no group outcome is provable
  'IDENTITY_LOST',
  'KILL_SESSION_FAILED',
  'STOP_INCOMPLETE',
  // the owned control connection was lost mid-teardown: no outcome is
  // declarable (a replacement server may already own the socket path)
  'STOP_UNKNOWN',
  // kill(0) from the coordinator was refused; no numeric signal follows
  'EPERM',
  // readiness (client started but exited immediately)
  'CLIENT_EARLY_EXIT',
  'SHELL_COMMAND_FAILED',
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
