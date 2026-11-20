'use strict';

// Process-level ordered shutdown coordinator and CLI signal adapter for `serve`.
// Single shared deadlineMono (default 1500 ms), single idempotent shutdownPromise,
// strict own-generation pidfile cleanup only on proven quiescence,
// and explicit process.exit strictly inside the CLI adapter after bounded drain.

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const pidf = require('./pidfile.js');
const vlNodeCleanupHook = require('./vl-node-cleanup-hook.js');

const DEFAULT_SERVE_SHUTDOWN_BUDGET_MS = 1500;
const ALLOWED_REASONS = new Set(['signal', 'programmatic', 'startup-error', 'exit', 'server-close']);
const RE_SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const RE_RUN_ID = /^[0-9a-f]{32}$/;
const PIDFILE_SIZE_LIMIT = 64 * 1024;

const ACTIVE_SIGNAL_ADAPTERS = new WeakMap();

function nonNegInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitizeClosedCode(code) {
  if (typeof code !== 'string') return null;
  return RE_SAFE_CODE.test(code) ? code : null;
}

function hasCloseOrdered(handle) {
  if (!handle || typeof handle !== 'object') return false;
  if (typeof handle.closeOrdered === 'function') return true;
  return Boolean(handle.shutdownController && typeof handle.shutdownController.closeOrdered === 'function');
}

function disarmServerSync(handle) {
  if (!handle || typeof handle !== 'object') return;
  try {
    if (handle.shutdownController && typeof handle.shutdownController.disarm === 'function') {
      handle.shutdownController.disarm();
    } else if (typeof handle.disarm === 'function') {
      handle.disarm();
    }
  } catch (_) {
    // Disarm on a handle that is partially initialized must never abort shutdown.
  }
}

function readRegularPidfileSnapshot(pidPath, expectedPid, impl = {}) {
  let fd = null;
  try {
    const lst = fs.lstatSync(pidPath);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    fd = fs.openSync(pidPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.dev !== lst.dev || fst.ino !== lst.ino || fst.size > PIDFILE_SIZE_LIMIT) {
      return null;
    }
    const uid = typeof impl.currentUid === 'function' ? impl.currentUid() : pidf.currentUid();
    if (uid !== null && fst.uid !== uid) return null;
    const raw = fs.readFileSync(fd, 'utf8');
    const meta = JSON.parse(raw);
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    if (expectedPid !== undefined && meta.pid !== expectedPid) return null;
    return {
      pidPath,
      dev: fst.dev,
      ino: fst.ino,
      uid,
      meta,
    };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* best-effort */ }
    }
  }
}

function captureNonTermuxPidfileIdentity(pidPath, { generationId, pid = process.pid, impl = {} } = {}) {
  const snap = readRegularPidfileSnapshot(pidPath, pid, impl);
  if (!snap) return null;
  if (typeof generationId === 'string' && generationId && snap.meta.generationId !== generationId) {
    return null;
  }
  return {
    pidPath,
    dev: snap.dev,
    ino: snap.ino,
    uid: snap.uid,
    pid,
    startTs: Number.isFinite(snap.meta.startTs) ? snap.meta.startTs : null,
    processStart: typeof snap.meta.processStart === 'string' && snap.meta.processStart ? snap.meta.processStart : null,
    attestation: typeof snap.meta.attestation === 'string' ? snap.meta.attestation : null,
    generationId: typeof snap.meta.generationId === 'string' && snap.meta.generationId ? snap.meta.generationId : null,
  };
}

function captureTermuxPidfileIdentity(pidPath, { runId, pid = process.pid, impl = {} } = {}) {
  if (typeof runId !== 'string' || !RE_RUN_ID.test(runId)) return null;
  const snap = readRegularPidfileSnapshot(pidPath, pid, impl);
  if (!snap || snap.meta.serviceRunId !== runId) return null;
  return { pidPath, runId, pid, dev: snap.dev, ino: snap.ino, uid: snap.uid };
}

/**
 * Remove a non-Termux pidfile only when filesystem object identity and process generation
 * still match the snapshot recorded when this process created the file.
 * Threat model: because Node has no portable unlinkat-by-fd, identity verification followed by
 * unlink(path) narrows replacement races to a small non-atomic window; active same-uid
 * local attackers racing the directory during shutdown are outside this threat model.
 */
function removeOwnNonTermuxPidfile(snapshot, impl = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (typeof snapshot.pidPath !== 'string' || !snapshot.pidPath) return false;
  if (!Number.isSafeInteger(snapshot.dev) || !Number.isSafeInteger(snapshot.ino)) return false;
  if (!Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;

  const snap = readRegularPidfileSnapshot(snapshot.pidPath, snapshot.pid, impl);
  if (!snap) return false;
  if (snap.dev !== snapshot.dev || snap.ino !== snapshot.ino) return false;
  if (snapshot.uid !== null && snapshot.uid !== undefined && snap.uid !== snapshot.uid) return false;

  const { meta } = snap;
  if (snapshot.generationId) {
    if (meta.generationId !== snapshot.generationId) return false;
    if (snapshot.startTs !== null && snapshot.startTs !== undefined && meta.startTs !== snapshot.startTs) return false;
  }

  if (snapshot.processStart) {
    if (meta.processStart !== snapshot.processStart) return false;
    const readStart = impl.readProcessStartImpl || pidf.readProcessStart;
    const liveStart = readStart(snapshot.pid);
    if (typeof liveStart === 'string' && liveStart) {
      if (liveStart !== snapshot.processStart) return false;
    } else if (!snapshot.generationId) {
      return false;
    }
  } else if (!snapshot.generationId) {
    // An indeterminate or unattested snapshot without an origin generation token cannot prove ownership.
    return false;
  }

  try {
    const unlinkFn = typeof impl.unlinkSync === 'function' ? impl.unlinkSync : fs.unlinkSync;
    unlinkFn(snapshot.pidPath);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Remove a Termux service pidfile only when it is a regular non-symlink owned file matching
 * both serviceRunId and the device/inode identity captured at creation.
 * Same non-atomic check-to-unlink window and same-uid threat model as removeOwnNonTermuxPidfile.
 */
function removeOwnTermuxPidfile(snapshot, impl = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (typeof snapshot.pidPath !== 'string' || !RE_RUN_ID.test(String(snapshot.runId || ''))) return false;
  if (!Number.isSafeInteger(snapshot.dev) || !Number.isSafeInteger(snapshot.ino)) return false;
  if (!Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;

  const snap = readRegularPidfileSnapshot(snapshot.pidPath, snapshot.pid, impl);
  if (!snap) return false;
  if (snap.dev !== snapshot.dev || snap.ino !== snapshot.ino) return false;
  if (snap.meta.serviceRunId !== snapshot.runId) return false;

  try {
    const unlinkFn = typeof impl.unlinkSync === 'function' ? impl.unlinkSync : fs.unlinkSync;
    unlinkFn(snapshot.pidPath);
    return true;
  } catch (_) {
    return false;
  }
}

function formatIncompleteShutdownLine(outcome) {
  const status = outcome && typeof outcome.status === 'string' ? outcome.status : 'completed_with_residues';
  const reason = outcome && typeof outcome.reason === 'string' ? outcome.reason : 'programmatic';
  const counts = (outcome && outcome.counts) || {};
  const skipped = nonNegInt(counts.skipped);
  const residues = nonNegInt(counts.residues);
  const activeOps = nonNegInt(counts.activeOpsRemaining);
  const activeClaims = nonNegInt(counts.activeClaimConsumers);
  const elapsedMs = nonNegInt(outcome && outcome.elapsedMs);
  const sue = outcome && typeof outcome.startupErrorCode === 'string' ? outcome.startupErrorCode : '';
  const sud = outcome && typeof outcome.startupErrorDetail === 'string' ? outcome.startupErrorDetail : '';
  const startup = sue ? `, startupError=${sue}${sud ? ` (${sud})` : ''}` : '';
  return `nexuscrew: ordered shutdown incomplete (status=${status}, reason=${reason}, skipped=${skipped}, residues=${residues}, activeOps=${activeOps}, activeClaims=${activeClaims}, elapsedMs=${elapsedMs}${startup})`;
}

/**
 * Create a single-run shutdown coordinator for `serve`, sharing one deadline and promise across
 * duplicate signals and guarding own pidfile removal behind proven quiescence.
 */
function createServeShutdownCoordinator({
  budgetMs = DEFAULT_SERVE_SHUTDOWN_BUDGET_MS,
  nowMono = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  writeLine = (line) => process.stderr.write(`${line}\n`),
  exitImpl = (code) => process.exit(code),
  proc = process,
  processOwner = null,
} = {}) {
  const effectiveBudgetMs = Number.isFinite(budgetMs) && budgetMs >= 0
    ? Math.round(budgetMs)
    : DEFAULT_SERVE_SHUTDOWN_BUDGET_MS;

  let state = 'running';
  let disarmed = false;
  let shutdownPromise = null;
  let startMono = null;
  let deadlineMono = null;
  let quiescent = false;
  let completed = false;
  let startupError = false;
  let startupExitCode = 0;
  let startupErrorCode = null;
  let startupErrorDetail = null;
  // Owned cleanup wiring of the process owner (CLI serve dispatch only): a
  // binding that could not be installed before the server began closing
  // stays here as a conservative failure of THIS coordinator.
  let ownedBindingFailure = null;

  let serverRegistered = false;
  let serverHandle = null;
  let serverPendingPromise = null;
  let serverMissingOrInvalid = false;

  let pidCleanupFn = null;
  let pidCleanupDone = false;
  let pidfileRemoved = false;
  let pidfileStatus = 'not_requested';
  let warningEmitted = false;
  let exitRequested = false;
  let exitCalled = false;
  let syncExitRan = false;
  let finalOutcome = null;
  let unsubscribeServerClose = null;
  const asyncFailureListeners = new Set();

  function clearServerCloseSubscription() {
    if (typeof unsubscribeServerClose === 'function') {
      try { unsubscribeServerClose(); } catch (_) {}
      unsubscribeServerClose = null;
    }
  }

  function subscribeServerCloseStart(handle) {
    clearServerCloseSubscription();
    if (!handle || typeof handle !== 'object') return;
    if (handle.shutdownController && typeof handle.shutdownController.onCloseStart === 'function') {
      unsubscribeServerClose = handle.shutdownController.onCloseStart((serverDeadlineMono) => {
        void startShutdown({
          reason: 'server-close',
          exitOnFinish: false,
          deadlineMonoOverride: Number.isFinite(serverDeadlineMono) ? serverDeadlineMono : null,
        });
      });
      return;
    }
    // `shutdownController.onCloseStart` is the only supported contract for converging on
    // the server's original close deadline; the plain EventEmitter `close` fallback is
    // conservative by construction and never reads arbitrary fields or `state()`.
    if (typeof handle.once === 'function') {
      const onClose = () => {
        void startShutdown({
          reason: 'server-close',
          exitOnFinish: false,
          deadlineUnattested: true,
        });
      };
      handle.once('close', onClose);
      unsubscribeServerClose = () => {
        if (typeof handle.removeListener === 'function') {
          handle.removeListener('close', onClose);
        }
      };
    }
  }

  function onAsyncStartupFailure(fn) {
    if (typeof fn !== 'function') return () => {};
    asyncFailureListeners.add(fn);
    return () => {
      asyncFailureListeners.delete(fn);
    };
  }

  function disarmLocalSync() {
    disarmed = true;
    // The owner closes the census admission fence in its own synchronous
    // disarm, before every wait: a late producer can never be admitted past
    // this point. The seal OUTCOME is observed: a refused seal is itself a
    // conservative failure of this coordinator's own judgement, even when
    // the server path would stay green on its own.
    if (processOwner !== null) {
      const seal = vlNodeCleanupHook.sealAdmissionFor(processOwner);
      if (!seal || seal.ok !== true) ownedBindingFailure = 'seal-refused';
    }
    disarmServerSync(serverHandle);
  }

  // Register the owned cleanup hook for the server's shutdownController
  // identity BEFORE any closeOrdered can begin. With an owner present, a
  // missing or invalid controller, an handle already closing or closed and
  // a refused binding are all conservative failures of THIS coordinator's
  // own outcome (CLEANUP_REFUSED, never quiescent, pidfile conserved): the
  // owned mode is never downgraded to the legacy closeOrdered-only
  // contract. That legacy contract remains ONLY for a coordinator without
  // an owner.
  function installOwnedBinding(handle) {
    if (processOwner === null) return;
    const controller = handle && typeof handle === 'object'
      ? (handle.shutdownController || null)
      : null;
    if (!controller || typeof controller !== 'object') {
      ownedBindingFailure = 'controller-missing';
      return;
    }
    let alreadyClosing = false;
    try {
      const st = typeof controller.state === 'function' ? controller.state() : null;
      alreadyClosing = Boolean(st && (st.closing === true || st.closed === true));
    } catch (_) {
      alreadyClosing = true;
    }
    if (alreadyClosing) {
      ownedBindingFailure = 'handle-closing';
      return;
    }
    const res = vlNodeCleanupHook.bindOwnedHook(controller, processOwner);
    if (!res.ok) ownedBindingFailure = res.reason;
  }

  function safeWriteWarningOnce(outcome) {
    if (warningEmitted) return;
    warningEmitted = true;
    try {
      if (typeof writeLine === 'function') {
        writeLine(formatIncompleteShutdownLine(outcome));
      }
    } catch (_) {
      // Warning emission failure must never extend the shutdown budget or block exit.
    }
  }

  function invokeExitOnce(code) {
    if (exitCalled) return;
    exitCalled = true;
    if (typeof exitImpl === 'function') {
      exitImpl(code);
    }
  }

  function tryPidCleanupOnce() {
    if (pidCleanupDone) return pidfileRemoved;
    pidCleanupDone = true;
    if (typeof pidCleanupFn !== 'function') {
      pidfileRemoved = false;
      return false;
    }
    try {
      pidfileRemoved = pidCleanupFn() === true;
    } catch (_) {
      pidfileRemoved = false;
    }
    return pidfileRemoved;
  }

  function raceUntilDeadline(promise, dlMono) {
    const tracked = Promise.resolve().then(() => promise);
    tracked.catch(() => {});
    const remMs = Math.max(0, dlMono - nowMono());
    if (remMs <= 0) {
      return Promise.resolve({ timedOut: true, value: null, rejected: false });
    }
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (res) => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        resolve(res);
      };
      tracked.then(
        (value) => done({ timedOut: nowMono() >= dlMono, value, rejected: false }),
        () => done({ timedOut: nowMono() >= dlMono, value: null, rejected: true }),
      );
      timer = setTimer(() => done({ timedOut: true, value: null, rejected: false }), remMs);
    });
  }

  function registerPidCleanup(fn) {
    pidCleanupFn = typeof fn === 'function' ? fn : null;
  }

  function registerStartupFailure(err) {
    startupError = true;
    const errExit = err && Number.isInteger(err.exitCode) && err.exitCode > 0 ? err.exitCode : 1;
    startupExitCode = Math.max(startupExitCode || 1, errExit);
    // First failure wins: later registrations are cascades of the disarm, not
    // the cause. Both fields stay bounded on purpose (the shutdown line is a
    // single stderr write, and the guard message already carries the rejected
    // ancestor path and its octal mode).
    if (startupErrorCode === null && err && typeof err.code === 'string' && err.code) {
      startupErrorCode = err.code.slice(0, 64);
    }
    if (startupErrorDetail === null && err && err.message != null) {
      const detail = String(err.message).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (detail) startupErrorDetail = detail;
    }
    disarmLocalSync();
    if (!finalOutcome) {
      state = 'startup_failed';
      quiescent = false;
    }
  }

  function registerServer(started) {
    serverRegistered = true;
    if (started && typeof started.then === 'function') {
      serverMissingOrInvalid = false;
      serverPendingPromise = Promise.resolve(started).then(
        (resolved) => {
          serverHandle = resolved || null;
          if (!hasCloseOrdered(resolved)) {
            serverMissingOrInvalid = true;
          }
          if (disarmed) disarmServerSync(resolved);
          subscribeServerCloseStart(resolved);
          installOwnedBinding(resolved);
          return resolved;
        },
        (err) => {
          registerStartupFailure(err);
          for (const listener of [...asyncFailureListeners]) {
            try {
              listener(err);
            } catch (_) {
              // Async startup failure subscribers must not abort shutdown accounting.
            }
          }
          return null;
        },
      );
      return;
    }
    serverPendingPromise = null;
    if (hasCloseOrdered(started)) {
      serverHandle = started;
      serverMissingOrInvalid = false;
      if (disarmed) disarmServerSync(started);
      subscribeServerCloseStart(started);
      installOwnedBinding(started);
      return;
    }
    serverHandle = started || null;
    serverMissingOrInvalid = true;
    if (disarmed) disarmServerSync(started);
    subscribeServerCloseStart(started);
    installOwnedBinding(started);
  }

  function startShutdown({
    reason = 'programmatic',
    exitOnFinish = false,
    deadlineMonoOverride = null,
    deadlineUnattested = false,
  } = {}) {
    if (exitOnFinish) exitRequested = true;
    if (shutdownPromise) {
      if (finalOutcome && exitRequested && !exitCalled) {
        invokeExitOnce(finalOutcome.exitCode);
      }
      return shutdownPromise;
    }

    clearServerCloseSubscription();
    const normReason = ALLOWED_REASONS.has(reason) ? reason : 'programmatic';
    const unattestedCloseDeadline = deadlineUnattested === true;
    startMono = nowMono();
    deadlineMono = Number.isFinite(deadlineMonoOverride)
      ? deadlineMonoOverride
      : (startMono + effectiveBudgetMs);
    state = 'disarming';
    disarmLocalSync();

    shutdownPromise = (async () => {
      // Allow synchronous serve() startup in the current frame to finish registerServer() before
      // concluding that startup failed to register a handle.
      await Promise.resolve();

      let serverPendingTimedOut = false;
      let serverCloseTimedOut = false;
      let serverCloseError = false;
      let serverOutcome = null;

      if (serverPendingPromise) {
        const waitStart = await raceUntilDeadline(serverPendingPromise, deadlineMono);
        if (waitStart.timedOut) {
          serverPendingTimedOut = true;
        }
      }

      const target = serverHandle;
      const closeOrderedFn = (target && typeof target.closeOrdered === 'function')
        ? (args) => target.closeOrdered(args)
        : (target && target.shutdownController && typeof target.shutdownController.closeOrdered === 'function')
          ? (args) => target.shutdownController.closeOrdered(args)
          : null;

      const codes = [];
      if (!serverPendingTimedOut && closeOrderedFn) {
        state = 'stopping_network';
        const waitClose = await raceUntilDeadline(
          Promise.resolve().then(() => closeOrderedFn({ reason: normReason, deadlineMono })),
          deadlineMono,
        );
        if (waitClose.rejected) {
          serverCloseError = true;
          codes.push('SERVER_CLOSE_ERROR');
          if (waitClose.timedOut) {
            serverCloseTimedOut = true;
            codes.push('SERVER_CLOSE_TIMEOUT');
          }
        } else if (waitClose.timedOut) {
          serverCloseTimedOut = true;
          codes.push('SERVER_CLOSE_TIMEOUT');
        } else {
          serverOutcome = waitClose.value || null;
          if (serverOutcome && serverOutcome.fleet && serverOutcome.fleet.status === 'draining') {
            state = 'draining_fleet';
          }
        }
      } else if (serverPendingTimedOut) {
        codes.push('SERVER_PENDING_TIMEOUT');
      } else if (!startupError) {
        if (!serverRegistered) codes.push('STARTUP_INCOMPLETE');
        else if (serverMissingOrInvalid) codes.push('SERVER_CLOSE_UNAVAILABLE');
      }

      if (startupError) codes.push('STARTUP_FAILED');
      if (unattestedCloseDeadline) codes.push('SERVER_CLOSE_DEADLINE_UNATTESTED');
      if (ownedBindingFailure !== null) codes.push('CLEANUP_REFUSED');
      // With an owner present the owned cleanup result is REQUIRED and must
      // be attested by both a coherent normalized done summary AND the private
      // terminal record actually produced by this owner's hook: a green-looking
      // result carrying no attested done cleanup — missing, malformed,
      // inconsistent or produced without executing the bound hook — is a
      // conservative refusal of THIS coordinator's own judgement, never a
      // quiescent shutdown. A server result that already failed on its own
      // keeps its own residue: the missing attestation is counted once, here,
      // only in this case. The delivered result is never rewritten.
      const ownedCleanupCheck = processOwner !== null && serverOutcome !== null
        ? vlNodeCleanupHook.verifyAttestedOwnedDone(processOwner, serverOutcome.cleanup)
        : { attested: processOwner === null, code: 'CLEANUP_REFUSED' };
      const ownedCleanupMissing = processOwner !== null
        && serverOutcome !== null
        && serverOutcome.ok === true
        && serverOutcome.quiescent === true
        && !ownedCleanupCheck.attested;
      if (ownedCleanupMissing) codes.push(ownedCleanupCheck.code);
      if (serverOutcome && Array.isArray(serverOutcome.codes)) {
        for (const rawCode of serverOutcome.codes) {
          const safe = sanitizeClosedCode(rawCode);
          if (safe) codes.push(safe);
        }
      }

      const endMono = nowMono();
      const elapsedMs = Math.max(0, Math.round(endMono - startMono));
      const deadlineExpired = endMono >= deadlineMono;
      const serverTimedOut = Boolean(serverOutcome && serverOutcome.timedOut === true);

      const serverAttestedQuiescent = Boolean(
        !startupError
        && !unattestedCloseDeadline
        && !serverPendingTimedOut
        && !serverCloseTimedOut
        && !serverCloseError
        && !serverMissingOrInvalid
        && ownedBindingFailure === null
        && !ownedCleanupMissing
        && ownedCleanupCheck.attested
        && serverRegistered
        && closeOrderedFn
        && serverOutcome
        && serverOutcome.ok === true
        && serverOutcome.quiescent === true
        && !serverTimedOut
        && nonNegInt(serverOutcome.counts && serverOutcome.counts.residues) === 0
      );

      quiescent = Boolean(serverAttestedQuiescent && !deadlineExpired);
      const timedOut = Boolean(serverPendingTimedOut || serverCloseTimedOut || serverTimedOut || deadlineExpired);
      if (deadlineExpired) {
        codes.push('SHUTDOWN_BUDGET_EXHAUSTED');
      }

      const activeOpsRemaining = nonNegInt(serverOutcome && serverOutcome.counts && serverOutcome.counts.activeOps);
      const activeClaimConsumers = nonNegInt(serverOutcome && serverOutcome.counts && serverOutcome.counts.activeClaims);
      const rawUnattested = serverOutcome && serverOutcome.counts && serverOutcome.counts.unattestedClaimConsumers;
      const unattestedClaimConsumers = Number.isSafeInteger(rawUnattested)
        ? nonNegInt(rawUnattested)
        : (codes.includes('CONSUMER_UNATTESTED') ? Math.max(1, activeClaimConsumers) : 0);

      const skipped = (serverPendingTimedOut ? 1 : 0)
        + (serverCloseTimedOut ? 1 : 0)
        + (!serverPendingTimedOut && !closeOrderedFn ? 1 : 0)
        + (serverCloseError ? 1 : 0)
        + (serverOutcome && serverOutcome.fleet && serverOutcome.fleet.skipped && !serverOutcome.quiescent ? 1 : 0);

      const pidCleanupRequested = typeof pidCleanupFn === 'function';
      let pidfileCleanupResidues = 0;
      if (!pidCleanupRequested) {
        pidfileRemoved = false;
        pidfileStatus = 'not_requested';
      } else if (quiescent) {
        const cleaned = tryPidCleanupOnce();
        if (cleaned) {
          pidfileStatus = 'removed';
        } else {
          pidfileStatus = 'failed';
          pidfileCleanupResidues = 1;
          codes.push('PIDFILE_CLEANUP_FAILED');
        }
      } else {
        pidfileRemoved = false;
        pidfileStatus = 'skipped';
        codes.push('PIDFILE_CLEANUP_SKIPPED');
      }

      const rawResidues = nonNegInt(serverOutcome && serverOutcome.counts && serverOutcome.counts.residues)
        + (startupError ? 1 : 0)
        + (unattestedCloseDeadline ? 1 : 0)
        + (serverPendingTimedOut ? 1 : 0)
        + (serverCloseTimedOut ? 1 : 0)
        + (!serverPendingTimedOut && !closeOrderedFn && !startupError ? 1 : 0)
        + (serverCloseError ? 1 : 0)
        // One single logical residue of the required owned cleanup that the
        // server outcome never attested — never the number of its files.
        + (ownedCleanupMissing ? 1 : 0)
        + pidfileCleanupResidues;
      const residues = (quiescent && pidfileCleanupResidues === 0) ? 0 : Math.max(1, rawResidues);

      const procExitCode = (proc && Number.isInteger(proc.exitCode) && proc.exitCode > 0) ? proc.exitCode : 0;
      const exitCode = startupError
        ? (startupExitCode || 1)
        : (procExitCode > 0 ? procExitCode : 0);

      const status = startupError
        ? 'startup_failed'
        : (quiescent && pidfileCleanupResidues === 0 ? 'completed' : 'completed_with_residues');
      // The coordinator closes its own finalization state in the owner
      // BEFORE publishing completed/terminal state and BEFORE calling
      // writeLine or any outcome delivery callback: a re-entrant or delayed
      // entry of the owned cleanup callback can never start a new round.
      // One-way and idempotent; the single promise, deadline, exit policy,
      // pidfile and replay stay unchanged.
      if (processOwner !== null) {
        try {
          vlNodeCleanupHook.markCoordinatorFinalized(processOwner);
        } catch (_) {
          // The fence is closed on a best-effort basis only: it never
          // blocks the delivery of the final outcome.
        }
      }
      state = status;
      completed = true;

      const outcome = {
        status,
        reason: normReason,
        quiescent,
        timedOut,
        elapsedMs,
        budgetMs: effectiveBudgetMs,
        exitCode,
        counts: {
          activeOpsRemaining,
          activeClaimConsumers,
          unattestedClaimConsumers,
          skipped,
          residues,
        },
        codes: [...new Set(codes)],
        ...(startupErrorCode ? { startupErrorCode, startupErrorDetail } : {}),
        pidfileRemoved,
        pidfileStatus,
        warningEmitted: false,
      };

      if (!quiescent || timedOut || residues > 0 || skipped > 0) {
        safeWriteWarningOnce(outcome);
        outcome.warningEmitted = true;
      }

      finalOutcome = outcome;

      if (exitRequested) {
        invokeExitOnce(outcome.exitCode);
      }

      return outcome;
    })();

    return shutdownPromise;
  }

  function shutdown({ reason = 'programmatic', exitOnFinish = false } = {}) {
    return startShutdown({ reason, exitOnFinish });
  }

  function syncExitFallback() {
    if (syncExitRan) return;
    syncExitRan = true;
    // Only idempotent cleanup on already-proven quiescence; bare OS 'exit' never removes pidfiles.
    if (completed && quiescent && !startupError && pidCleanupFn && !pidCleanupDone) {
      tryPidCleanupOnce();
    }
  }

  function getState() {
    return {
      state,
      disarmed,
      quiescent,
      completed,
      startupError,
      pidfileRemoved,
      pidfileStatus,
      warningEmitted,
      deadlineMono,
      budgetMs: effectiveBudgetMs,
      outcome: finalOutcome,
    };
  }

  return {
    registerServer,
    registerPidCleanup,
    registerStartupFailure,
    onAsyncStartupFailure,
    shutdown,
    syncExitFallback,
    isDisarmed: () => disarmed,
    getState,
  };
}

/**
 * Install single-shot SIGINT, SIGTERM, and 'exit' listeners for a CLI `serve` coordinator.
 * Never attaches fatal global error handlers (uncaughtException / unhandledRejection).
 */
function installServeSignalAdapter(coordinator, { proc = process, exitOnSignal = true } = {}) {
  const existing = ACTIVE_SIGNAL_ADAPTERS.get(proc);
  if (existing) {
    if (existing.coordinator === coordinator) {
      return { dispose: existing.dispose };
    }
    existing.dispose();
  }

  let disposed = false;
  const onSigInt = () => {
    void coordinator.shutdown({ reason: 'signal', exitOnFinish: exitOnSignal });
  };
  const onSigTerm = () => {
    void coordinator.shutdown({ reason: 'signal', exitOnFinish: exitOnSignal });
  };
  const onExit = () => {
    coordinator.syncExitFallback();
  };

  proc.on('SIGINT', onSigInt);
  proc.on('SIGTERM', onSigTerm);
  proc.on('exit', onExit);

  let unsubscribeFailure = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeFailure();
    if (typeof proc.off === 'function') {
      proc.off('SIGINT', onSigInt);
      proc.off('SIGTERM', onSigTerm);
      proc.off('exit', onExit);
    } else {
      proc.removeListener('SIGINT', onSigInt);
      proc.removeListener('SIGTERM', onSigTerm);
      proc.removeListener('exit', onExit);
    }
    const current = ACTIVE_SIGNAL_ADAPTERS.get(proc);
    if (current && current.dispose === dispose) {
      ACTIVE_SIGNAL_ADAPTERS.delete(proc);
    }
  };

  if (typeof coordinator.onAsyncStartupFailure === 'function') {
    unsubscribeFailure = coordinator.onAsyncStartupFailure(() => {
      if (disposed) return;
      const st = typeof coordinator.getState === 'function' ? coordinator.getState() : null;
      if (st && st.completed) {
        dispose();
        return;
      }
      void coordinator.shutdown({ reason: 'startup-error', exitOnFinish: exitOnSignal })
        .finally(() => dispose());
    });
  }

  ACTIVE_SIGNAL_ADAPTERS.set(proc, { coordinator, dispose });
  return { dispose };
}

module.exports = {
  DEFAULT_SERVE_SHUTDOWN_BUDGET_MS,
  createServeShutdownCoordinator,
  installServeSignalAdapter,
  captureNonTermuxPidfileIdentity,
  captureTermuxPidfileIdentity,
  removeOwnNonTermuxPidfile,
  removeOwnTermuxPidfile,
  formatIncompleteShutdownLine,
};
