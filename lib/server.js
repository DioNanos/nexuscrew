'use strict';
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { defaults, loadConfig, assertLoopback, configJsonPath } = require('./config.js');
const { writeConfigAtomic } = require('./cli/init.js');
const { listSessions, attachedClients, setSessionVisibility } = require('./tmux/list.js');
const { runAction, pasteToSession, submitToSession } = require('./tmux/actions.js');
const { createSession, killSession, isProtectedSession } = require('./tmux/lifecycle.js');
const { createPreviewSampler } = require('./tmux/preview.js');
const { requireSharedTmuxProtection } = require('./tmux/shared-server.js');
const { openAttach } = require('./pty/attach.js');
const { bindWs } = require('./ws/bridge.js');
const { loadOrCreateToken, verify } = require('./auth/token.js');
const { requireToken, bearerFrom } = require('./auth/middleware.js');
const { filesRoutes } = require('./files/routes.js');
const { createOutboxWatcher } = require('./files/watcher.js');
const { leggiTelemetria } = require('./files/telemetry.js');
const VERSION = require('../package.json').version;
const { transcribe } = require('./voice/transcribe.js');
const { selectProvider } = require('./fleet/provider.js');
const { fleetRoutes } = require('./fleet/routes.js');
const { leaseRoutes } = require('./fleet/lease-routes.js');
const { cellsRoutes } = require('./cells/routes.js');
const { liveHostRoutes } = require('./live-host/routes.js');
const { createLiveHostStore, liveHostPath } = require('./live-host/store.js');
const { createLiveBridge } = require('./live-host/bridge.js');
const { fsRoutes } = require('./fs/routes.js');
const nodesStore = require('./nodes/store.js');
const nodesTunnel = require('./nodes/tunnel.js');
const nodesHealth = require('./nodes/health.js');
const { recordPeerTransition } = require('./nodes/peer-transitions.js');
const nodesInventory = require('./nodes/inventory.js');
const { createReverseSlotListeners } = require('./nodes/reverse-slot-listeners.js');
const reverseRotation = require('./nodes/reverse-rotation.js');
const topologyCache = require('./nodes/topology-cache.js');
const { createNodeProxy, handleNodeUpgrade } = require('./proxy/node-proxy.js');
const { createPanelProxy, handlePanelUpgrade } = require('./proxy/panel-proxy.js');
const { createPanelAuth } = require('./proxy/panel-auth.js');
const federation = require('./proxy/federation.js');
const { audioRoutes } = require('./audio/routes.js');
const { isConsent: isAudioConsent } = require('./audio/consent.js');
const { createOriginResolver } = require('./audio/origin.js');
const { createAudioAcl } = require('./audio/acl.js');
const { createDispatcher } = require('./audio/dispatch.js');
const { createCellScopeGuard } = require('./cells/scope-guard.js');
const { createCellScope } = require('./cells/scope.js');
const { cellIdFromTmuxSession } = require('./fleet/definitions.js');
// Budget a tre finestre, riusato dalle notifiche federate: e' gia' scritto per
// limitare il danno di un nodo che mente sulla propria cella (il tetto per
// target si calcola sul NODO, che la catena visited verifica).
const { createSpeakRateLimiter } = require('./audio/rate-limit.js');
const { createSpeakQueue } = require('./audio/queue.js');
const { createReceiptStore } = require('./audio/receipt.js');
const audioAdapters = require('./audio/adapters.js');
const audioGroups = require('./audio/groups.js');
const { bridgeSecretPath, loadOrCreateBridgeSecret, createNonceCache } = require('./audio/bridge-auth.js');
const { createHopSecret, verifyHop, HOP_HEADER } = require('./proxy/hop-proof.js');
const { parseVisitedChain } = require('./audio/origin.js');
const { settingsRoutes, publicPeeringRoutes } = require('./settings/routes.js');
const decksStore = require('./decks/store.js');
const { decksRoutes } = require('./decks/routes.js');
const { createEventsHub } = require('./notify/events.js');
const { createPushService } = require('./notify/push.js');
const { createAsksStore } = require('./notify/asks.js');
const { createNotifier } = require('./notify/notifier.js');
const { notifyRoutes } = require('./notify/routes.js');
const { createNpmUpdater } = require('./update/manager.js');
const { createDiagnostics } = require('./diagnostics/store.js');
const { diagnosticsRoutes } = require('./diagnostics/routes.js');
const vlNodeStore = require('./vl-nodes/store.js');
const { createBroker: createVlNodeBroker } = require('./vl-nodes/broker.js');
const { publicRoutes: vlNodePublicRoutes, apiRoutes: vlNodeApiRoutes } = require('./vl-nodes/routes.js');

function sessionExists(tmuxBin, name) {
  if (typeof name !== 'string' || !/^[\w.@%:+-]{1,128}$/.test(name)) return false;
  try { execFileSync(tmuxBin, ['has-session', '-t', `=${name}`], { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}

function uiBuildVersion(distDir) {
  try {
    const x = JSON.parse(require('node:fs').readFileSync(path.join(distDir, 'version.json'), 'utf8'));
    return typeof x.version === 'string' ? x.version : null;
  } catch (_) { return null; }
}

function createServer(opts = {}) {
  const cfg = loadConfig(opts);
  assertLoopback(cfg.bind);
  // Token holder LIVE (audit F7 / §4b(3)): requireToken/verify leggono tokenStore.get()
  // ad ogni richiesta, cosi' una rotazione via Settings API invalida il VECCHIO token
  // (401) e attiva il NUOVO (200) SENZA restart. Prima il token era catturato una volta
  // allo startup e restava valido fino al restart manuale.
  const tokenHolder = { value: loadOrCreateToken(cfg.tokenPath) };
  const tokenStore = {
    get: () => tokenHolder.value,
    reload: () => { tokenHolder.value = loadOrCreateToken(cfg.tokenPath); return tokenHolder.value; },
  };
  const proxySockets = new Set();
  // wss viene creato piu' sotto; closeSessions lo raggiunge a request-time (mai durante
  // createServer) per chiudere le sessioni WS attive sulla rotazione token (§4b(3)).
  let wss = null;
  const closeSessions = () => {
    if (wss) {
      for (const ws of wss.clients) { try { ws.close(4001, 'token rotated'); } catch (_) { /* best-effort */ } }
    }
    for (const socket of proxySockets) { try { socket.destroy(); } catch (_) {} }
    proxySockets.clear();
  };
  const watcher = createOutboxWatcher({ root: cfg.filesRoot });
  // server e' creato piu' sotto (http.createServer); lo dichiariamo qui perche' le
  // closure localPort/localCredential dei router federation lo riferiscono lazy, al
  // request time. localPort DEVE leggere la porta effettiva (server.address().port)
  // e non cfg.port: in test (listen(0) su porta random) o dopo fallback EADDRINUSE,
  // cfg.port non coincide con la porta reale e il proxy federation locale puntava
  // alla porta sbagliata (bug reale: 401/"unauthorized" dal servizio su cfg.port).
  let server = null;
  const previews = createPreviewSampler(cfg.tmuxBin);
  // Seam di test per l'esistenza di una sessione: senza, un test sullo scope
  // dell'attach non discrimina, perche' ogni sessione risulta assente e il
  // rifiuto arriverebbe comunque — un verde che non prova nulla.
  const sessionExistsImpl = cfg.sessionExistsSeam || ((name) => sessionExists(cfg.tmuxBin, name));
  // MCP bridge (notify/ask/push): lo stato vive accanto al token (dirname del
  // tokenPath = ~/.nexuscrew di default) cosi' le istanze isolate via opts/env
  // nei test NON scrivono mai nella home reale. Tutto lazy: vapid.json/asks.json
  // nascono al primo uso, non allo startup.
  const notifyDir = cfg.notifyDir || path.dirname(cfg.tokenPath);
  // READONLY come floor anche dentro il push service (F3): niente generazione
  // VAPID ne' cleanup subscription quando il server e' readonly.
  const bridgeReadonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');
  const eventsHub = createEventsHub();
  const pushSvc = createPushService({
    dir: notifyDir, webpushImpl: cfg.webpushImpl,
    readonly: bridgeReadonly, maxSubs: cfg.pushMaxSubs, lookupImpl: cfg.pushLookupImpl,
  });
  const asksStore = createAsksStore({ dir: notifyDir });
  const notifier = createNotifier({ hub: eventsHub, push: pushSvc });
  const diagnostics = opts.diagnostics || createDiagnostics();
  const updater = opts.updateManager || createNpmUpdater({
    currentVersion: VERSION,
    home: cfg.home || os.homedir(),
    enabled: cfg.autoUpdate !== false,
    readonly: bridgeReadonly(),
    diagnostics,
    ...(cfg.updateSeams || {}),
  });
  const attachedWs = new Map(); // ws -> session (per il push dei frame files)
  const ensureTmuxProtection = () => requireSharedTmuxProtection(cfg.tmuxBin, {
    enabled: cfg.protectSharedTmuxServer !== false,
    home: cfg.home || os.homedir(),
  });
  // selectProvider sceglie UNA volta (startup) builtin|disabled e ritorna
  // {mode,reason,fleet}; routes consumano il .fleet,
  // quindi fleetP resta una Promise<Fleet> (createServer non diventa async).
  const fleetP = selectProvider({ ...cfg, ensureTmuxProtection }).then((p) => p.fleet);

  // Multi-node (B1): nodes.json e' la fonte dati (B0). Il proxy risolve <name>
  // -> {localPort, token} leggendo lo store ad ogni richiesta (fresh: rotazione
  // token / add-remove nodi visibili senza restart). token MAI redatto qui: e'
  // il valore che il proxy inietta upstream, non esce mai verso il browser.
  const nodesPath = cfg.nodesPath || nodesStore.defaultNodesPath(cfg.home || os.homedir());
  const vlNodesPath = cfg.vlNodesPath || vlNodeStore.defaultPath(cfg.home || os.homedir());
  const vlNodeBroker = opts.vlNodeBroker || createVlNodeBroker();
  const vlOwnerId = () => (nodesStore.loadStore(nodesPath) || {}).nodeId || null;
  // fetch usata dai probe di salute federati (iniettabile nei test); default globale.
  const healthFetch = cfg.fetchImpl || fetch;
  const topologyCachePath = cfg.topologyCachePath || topologyCache.defaultPath(cfg.home || os.homedir());
  const decksPath = cfg.decksPath || decksStore.defaultDecksPath(cfg.home || os.homedir());
  const proxyReadonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');
  const audioHome = cfg.home || os.homedir();
  // Stato audio ancorato alla directory del token (come notifyDir): server,
  // Settings e bridge MCP devono guardare gli stessi file anche quando un test
  // isola l'istanza fuori dalla home reale.
  const audioCfg = {
    home: audioHome,
    tokenPath: cfg.tokenPath,
    audioConsentPath: cfg.audioConsentPath,
    audioGroupsPath: cfg.audioGroupsPath,
    audioBridgeSecretPath: cfg.audioBridgeSecretPath || path.join(notifyDir, 'audio-bridge.key'),
  };
  // Segreto per-processo della prova di hop federata: vive solo in memoria, non
  // e' su disco e nessuna API lo espone. Serve a distinguere l'ultimo hop di una
  // route federata da un POST diretto di chi possiede il token della UI.
  const hopSecret = createHopSecret();
  const audioNonceCache = createNonceCache();
  let reverseSlotListeners = null;
  const rotatableReverse = new Map(); // node -> Map("port:generation", tracked listener/supervisor)
  const reverseWatchers = new Map();
  const reverseRotationInFlight = new Set();
  function resolveNode(name) {
    const st = nodesStore.loadStore(nodesPath);
    if (!st) return null;
    const node = nodesStore.getNode(st, name);
    if (!node) return null;
    return { localPort: node.localPort, token: node.token || null };
  }

  const runtimePort = () => (server && server.address() ? server.address().port : cfg.port);
  let tunnelsStarted = false;
  function reverseKey(remotePort, generation) { return `${remotePort}:${generation}`; }
  function nodeReverseEntries(name) { return rotatableReverse.get(name) || new Map(); }
  async function startRotatableReverse(node, { slot = node?.reversePool?.activeSlot, generation = null } = {}) {
    if (!reverseSlotListeners || node.shared !== true || !node.reversePool || !node.acceptToken || !node.nodeId) return null;
    const active = node.reversePool.slots[slot];
    const expectedGeneration = generation === null ? active?.generation : generation;
    if (!active || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new Error('reverse pool slot non valida');
    const entries = nodeReverseEntries(node.name);
    const key = reverseKey(active.port, expectedGeneration);
    const existing = entries.get(key);
    if (existing) return existing;
    // Il listener prova la PROPRIA identita' a chi compone la sfida, e l'altro
    // capo la costruisce con l'id di QUESTA installazione (probeReverseOwner usa
    // `peer.nodeId`, cioe' noi visti da lui). `node.nodeId` e' invece l'id del
    // nodo REMOTO — lo store lo impone, rifiutando come self-reference una voce
    // il cui nodeId eguagli il proprio. Registrarlo faceva firmare due tuple
    // diverse ai due capi: la prova non tornava mai e Share si spegneva con un
    // errore definitivo, non ritentabile.
    const localInstanceId = (nodesStore.loadStore(nodesPath) || {}).nodeId || null;
    // Fail-closed: senza identita' locale il listener nascerebbe con una prova
    // che nessuno puo' validare. Meglio non aprirlo che aprirlo indimostrabile.
    if (!localInstanceId) return null;
    const listener = await reverseSlotListeners.open({
      nodeName: node.name, remotePort: active.port, generation: expectedGeneration,
      instanceId: localInstanceId, secret: node.acceptToken,
    });
    let launched = nodesTunnel.startReverseForward({
      home: cfg.home || os.homedir(), node, remotePort: active.port, generation: expectedGeneration,
      targetPort: listener.localPort, spawnImpl: cfg.tunnelSpawnImpl, spawnSyncImpl: cfg.tunnelSpawnSyncImpl,
      sshBin: cfg.sshBin, logFd: cfg.tunnelLogFd,
    });
    if (!launched.started && launched.reason === 'already running') {
      const stopped = nodesTunnel.stopTunnel({ home: cfg.home || os.homedir(), name: nodesTunnel.reverseTunnelName(node.name, active.port, expectedGeneration) });
      if (!stopped.stopped) {
        await reverseSlotListeners.closePort(listener.localPort);
        throw new Error(stopped.reason || 'supervisor reverse preesistente non attribuibile');
      }
      launched = nodesTunnel.startReverseForward({
        home: cfg.home || os.homedir(), node, remotePort: active.port, generation: expectedGeneration,
        targetPort: listener.localPort, spawnImpl: cfg.tunnelSpawnImpl, spawnSyncImpl: cfg.tunnelSpawnSyncImpl,
        sshBin: cfg.sshBin, logFd: cfg.tunnelLogFd,
      });
    }
    if (!launched.started && launched.reason !== 'already running') {
      await reverseSlotListeners.closePort(listener.localPort);
      throw new Error(launched.reason || 'reverse slot supervisor non avviato');
    }
    const tracked = { ...listener, remotePort: active.port, generation: expectedGeneration };
    entries.set(key, tracked);
    rotatableReverse.set(node.name, entries);
    if (slot === node.reversePool.activeSlot && node.reversePool.verification === 'verified') ensureReverseWatcher(node.name);
    return tracked;
  }
  async function stopRotatableReverse(name, { remotePort = null, generation = null } = {}) {
    const entries = rotatableReverse.get(name);
    if (!entries) {
      if (!Number.isInteger(remotePort) || !Number.isSafeInteger(generation)) return false;
      const result = nodesTunnel.stopTunnel({ home: cfg.home || os.homedir(), name: nodesTunnel.reverseTunnelName(name, remotePort, generation) });
      return result.stopped || ['no pidfile', 'stale (pid dead)'].includes(result.reason);
    }
    const selected = [...entries.values()].filter((entry) => (remotePort === null || entry.remotePort === remotePort)
      && (generation === null || entry.generation === generation));
    // Il valore di ritorno significa "TUTTE le entry selezionate sono spente in
    // modo dimostrabile". Durante la grace di una rotazione ne coesistono due:
    // dichiarare successo perche' UNA e' stata chiusa lascerebbe l'altra viva
    // mentre chi chiama registra il canale come privato.
    const outcomes = [];
    for (const existing of selected) {
      const result = nodesTunnel.stopTunnel({ home: cfg.home || os.homedir(), name: nodesTunnel.reverseTunnelName(name, existing.remotePort, existing.generation) });
      outcomes.push(result);
      // If we cannot prove ownership we neither signal nor close the listener:
      // the channel is quarantined for diagnostics rather than broken by us.
      if (!reverseRotation.stopWasDemonstrated(result)) continue;
      entries.delete(reverseKey(existing.remotePort, existing.generation));
      await reverseSlotListeners?.closePort(existing.localPort);
    }
    if (!entries.size) rotatableReverse.delete(name);
    if (remotePort === null && generation === null) {
      const watcher = reverseWatchers.get(name);
      if (watcher) clearInterval(watcher);
      reverseWatchers.delete(name);
    }
    // La decisione vive in `summarizeStops` (funzione pura, testabile senza
    // processi): successo solo se qualcosa e' stato spento E niente e' rimasto
    // in quarantena. Il caso "nessuna entry" resta false come prima: non si
    // puo' dimostrare nulla.
    return reverseRotation.summarizeStops(outcomes).allClosed;
  }
  async function verifyRotatablePool(node) {
    const pool = node?.reversePool;
    if (!pool || !node.shared || !node.token || !node.nodeId) return { verified: false, code: 'reverse-pool-not-ready' };
    // Fermarsi al primo slot che non si prova nasconde quali altri fossero
    // sani: l'esito e' identico (servono tutti per 'verified'), ma la diagnosi
    // no. Chi guarda deve poter distinguere "un solo slot non risponde" da
    // "non risponde nessuno", perche' sono due guasti diversi.
    const proven = [];
    for (let slot = 0; slot < pool.slots.length; slot += 1) {
      const candidate = pool.slots[slot];
      let temporary = false;
      try {
        await startRotatableReverse(node, { slot, generation: candidate.generation });
        temporary = slot !== pool.activeSlot;
        await federation.verifyHubPoolSlot({ node, slot, generation: candidate.generation, fetchImpl: healthFetch });
        proven.push({ slot, proven: true });
      } catch (error) {
        proven.push({ slot, proven: false, code: error && error.code });
      } finally {
        if (temporary) await stopRotatableReverse(node.name, { remotePort: candidate.port, generation: candidate.generation });
      }
    }
    const current = nodesStore.loadStoreStrict(nodesPath);
    const fresh = nodesStore.getNode(current, node.name);
    if (!fresh?.reversePool) return { verified: false, code: 'reverse-pool-missing' };
    const outcome = reverseRotation.summarizePoolVerification(proven, fresh.reversePool.slots.length);
    const { verifiedSlots, verification, failures } = outcome;
    const updatedPool = { ...fresh.reversePool, verifiedSlots, verification };
    nodesStore.atomicWriteStore(nodesPath, nodesStore.setNodeReversePool(current, fresh.name, updatedPool));
    diagnostics.record(verification === 'verified' ? 'info' : 'warn', 'reverse-pool',
      verification === 'verified' ? 'REVERSE_POOL_VERIFIED' : 'REVERSE_POOL_UNVERIFIABLE',
      verification === 'verified' ? 'Reverse pool verified' : 'Reverse pool could not be fully verified',
      { node: fresh.name, verifiedSlots: verifiedSlots.length, slots: fresh.reversePool.slots.length,
        ...(failures.length ? { failedSlots: failures } : {}) });
    // Un pool non verificato non e' solo un'etichetta: la rotazione automatica
    // RIFIUTA di partire senza tutti gli slot provati (scelta deliberata, vedi
    // rotateRotatableReverse) e il watcher non viene nemmeno armato. Detto
    // altrimenti: l'autoriparazione del canale reverse resta SPENTA, e finora
    // nessuno lo diceva. Va dichiarato, non dedotto da un aggettivo.
    if (verification !== 'verified') {
      diagnostics.record('warn', 'reverse-pool', 'REVERSE_POOL_ROTATION_INACTIVE',
        'Automatic reverse rotation is not active: the pool is not fully verified',
        { node: fresh.name, verifiedSlots: verifiedSlots.length, slots: fresh.reversePool.slots.length });
    }
    if (verification === 'verified') ensureReverseWatcher(fresh.name);
    return { verified: verification === 'verified', verification, verifiedSlots, ...(failures.length ? { failures } : {}) };
  }
  async function settleRotatableGrace(name, generation) {
    const current = nodesStore.loadStoreStrict(nodesPath);
    const node = nodesStore.getNode(current, name);
    const pool = node?.reversePool;
    if (!pool || pool.rotation?.phase !== 'switched' || pool.activeGeneration !== generation) return;
    const old = pool.slots[pool.rotation.oldSlot];
    const stopped = await stopRotatableReverse(name, { remotePort: old.port, generation: pool.rotation.oldGeneration });
    if (!stopped) {
      diagnostics.record('warn', 'reverse-pool', 'REVERSE_POOL_OLD_QUARANTINED', 'Old reverse slot was not attributable for shutdown', { node: name, slot: pool.rotation.oldSlot });
      return;
    }
    try {
      await federation.settleHubPoolSlot({ node, generation, fetchImpl: healthFetch });
      const freshStore = nodesStore.loadStoreStrict(nodesPath);
      const fresh = nodesStore.getNode(freshStore, name);
      const settled = fresh?.reversePool && reverseRotation.settleGrace(fresh.reversePool, { now: Date.now() + 1 });
      if (settled) nodesStore.atomicWriteStore(nodesPath, nodesStore.setNodeReversePool(freshStore, name, settled));
    } catch (_) {
      diagnostics.record('warn', 'reverse-pool', 'REVERSE_POOL_GRACE_PENDING', 'Reverse pool grace settlement pending', { node: name });
    }
  }
  async function reconcileRotatablePool(node) {
    if (!node?.reversePool || node.shared !== true) return node;
    try {
      const result = await federation.getHubPoolStatus({ node, fetchImpl: healthFetch });
      const remote = nodesStore.parseReversePool(result && result.pool);
      if (!remote || remote.base !== node.reversePool.base) throw new Error('stato pool remoto non valido');
      const current = nodesStore.loadStoreStrict(nodesPath);
      const fresh = nodesStore.getNode(current, node.name);
      if (!fresh?.reversePool) return node;
      if (JSON.stringify(fresh.reversePool) === JSON.stringify(remote)) return fresh;
      const updated = nodesStore.setNodeReversePool(current, fresh.name, remote);
      nodesStore.atomicWriteStore(nodesPath, updated);
      diagnostics.record('info', 'reverse-pool', 'REVERSE_POOL_RECONCILED', 'Reverse pool reconciled from hub generation', {
        node: fresh.name, slot: remote.activeSlot, generation: remote.activeGeneration,
      });
      return nodesStore.getNode(updated, fresh.name);
    } catch (_) {
      // The saved local generation remains authoritative while the private
      // path is down. This is a retryable reconciliation, never a reason to
      // stop a healthy existing slot or invent a new one.
      return node;
    }
  }
  async function rotateRotatableReverse(name) {
    if (reverseRotationInFlight.has(name)) return { status: 'already-running' };
    reverseRotationInFlight.add(name);
    try {
      const now = Date.now();
      let current = nodesStore.loadStoreStrict(nodesPath);
      let node = nodesStore.getNode(current, name);
      const pool = node?.reversePool;
      if (!node || node.shared !== true || !pool || pool.verification !== 'verified'
        || !Array.isArray(pool.verifiedSlots) || pool.verifiedSlots.length !== pool.slots.length) {
        return { status: 'skipped', reason: 'pool-not-verified' };
      }
      if (Number.isSafeInteger(pool.lastAutoRotationAt) && now - pool.lastAutoRotationAt < 10 * 60 * 1000) {
        return { status: 'skipped', reason: 'rate-limited' };
      }
      const slot = reverseRotation.nextReadySlot(pool);
      if (!Number.isInteger(slot)) {
        diagnostics.record('error', 'reverse-pool', 'REVERSE_POOL_EXHAUSTED', 'No verified reverse slot remains', { node: name });
        return { status: 'skipped', reason: 'pool-exhausted' };
      }
      const lease = await federation.reserveHubPoolSlot({ node, slot, fetchImpl: healthFetch });
      if (lease.slot !== slot || !Number.isSafeInteger(lease.generation) || typeof lease.leaseId !== 'string') {
        throw new Error('hub reverse lease non valida');
      }
      const prepared = reverseRotation.prepareRotation(pool, {
        slot, now, leaseId: lease.leaseId,
        leaseMs: Math.max(1, Math.min(60_000, Number(lease.expiresAt) - now)),
      });
      if (!prepared || prepared.rotation.generation !== lease.generation) throw new Error('lease reverse non coerente con il pool locale');
      prepared.lastAutoRotationAt = now;
      current = nodesStore.updateNode(current, name, { reversePool: prepared });
      nodesStore.atomicWriteStore(nodesPath, current);
      node = nodesStore.getNode(current, name);
      const candidate = node.reversePool.slots[slot];
      try {
        await startRotatableReverse(node, { slot, generation: candidate.generation });
        const committedRemote = await federation.commitHubPoolSlot({ node, leaseId: lease.leaseId, fetchImpl: healthFetch });
        const committed = reverseRotation.commitRotation(node.reversePool, { leaseId: lease.leaseId, now, graceMs: Math.max(0, Number(committedRemote.graceUntil) - now) });
        if (!committed || committed.activeGeneration !== committedRemote.generation) throw new Error('commit reverse non coerente');
        committed.lastAutoRotationAt = now;
        const afterStore = nodesStore.loadStoreStrict(nodesPath);
        nodesStore.atomicWriteStore(nodesPath, nodesStore.setNodeReversePool(afterStore, name, committed));
        const delay = Math.max(0, committed.rotation.graceUntil - Date.now()) + 50;
        const timer = setTimeout(() => { void settleRotatableGrace(name, committed.activeGeneration); }, delay);
        timer.unref?.();
        diagnostics.record('warn', 'reverse-pool', 'REVERSE_POOL_SWITCHED', 'Reverse pool switched after verified conflict', { node: name, slot, generation: committed.activeGeneration });
        return { status: 'switched', slot, generation: committed.activeGeneration };
      } catch (error) {
        await federation.abortHubPoolSlot({ node, leaseId: lease.leaseId, fetchImpl: healthFetch }).catch(() => {});
        await stopRotatableReverse(name, { remotePort: candidate.port, generation: candidate.generation });
        const failedStore = nodesStore.loadStoreStrict(nodesPath);
        const failedNode = nodesStore.getNode(failedStore, name);
        const quarantined = failedNode?.reversePool && reverseRotation.quarantineSlot(failedNode.reversePool, { slot });
        if (quarantined) {
          quarantined.verification = 'invalidated'; quarantined.verifiedSlots = []; quarantined.lastAutoRotationAt = now;
          nodesStore.atomicWriteStore(nodesPath, nodesStore.setNodeReversePool(failedStore, name, quarantined));
        }
        diagnostics.record('error', 'reverse-pool', 'REVERSE_POOL_CANDIDATE_FAILED', 'Reverse candidate failed; pool invalidated', { node: name, slot });
        throw error;
      }
    } finally { reverseRotationInFlight.delete(name); }
  }
  function ensureReverseWatcher(name) {
    if (reverseWatchers.has(name)) return;
    const timer = setInterval(() => {
      if (reverseRotationInFlight.has(name)) return;
      const current = nodesStore.loadStore(nodesPath);
      const node = current && nodesStore.getNode(current, name);
      const pool = node?.reversePool;
      if (!node || node.shared !== true || !pool || pool.verification !== 'verified') return;
      const active = pool.slots[pool.activeSlot];
      const state = nodesTunnel.readTunnelState(cfg.home || os.homedir(), nodesTunnel.reverseTunnelName(name, active.port, pool.activeGeneration));
      if (state.phase === 'degraded') {
        void rotateRotatableReverse(name).catch(() => {});
      }
    }, 5000);
    timer.unref?.();
    reverseWatchers.set(name, timer);
  }
  function startManagedTunnels() {
    if (tunnelsStarted) return;
    tunnelsStarted = true;
    const st = nodesStore.loadStore(nodesPath);
    const configured = ((st && st.nodes) || [])
      .filter((node) => node.direction !== 'inbound')
      .map((node) => node.name);
    const reconcile = cfg.reconcileTunnelSupervisorsImpl || nodesTunnel.reconcileTunnelSupervisors;
    const recovered = reconcile({ home: cfg.home || os.homedir(), configuredNames: configured });
    for (const failure of recovered.failed || []) {
      process.stderr.write(`[nexuscrew] orphan tunnel cleanup failed for ${failure.name}: ${failure.reason}\n`);
      diagnostics.record('warn', 'tunnel', 'TUNNEL_CLEANUP_FAILED', 'Tunnel cleanup failed', {
        node: failure.name, state: 'cleanup-failed',
      });
    }
    // Exactly one connection per configured hub. Legacy `roles.node` /
    // rendezvous data is migration-only and never starts a second hidden SSH
    // process. Publishing this device is the optional -R on its outbound link.
    for (const node of (st && st.nodes) || []) {
      if (node.direction !== 'inbound' && node.autostart === true) {
        const tr = nodesTunnel.startForward({
          home: cfg.home || os.homedir(), node, localAppPort: runtimePort(),
          spawnImpl: cfg.tunnelSpawnImpl, spawnSyncImpl: cfg.tunnelSpawnSyncImpl,
          sshBin: cfg.sshBin, logFd: cfg.tunnelLogFd,
        });
        if (!tr.started && tr.reason !== 'already running') {
          process.stderr.write(`[nexuscrew] peer ${node.name} autostart failed: ${tr.reason || 'unknown'}\n`);
          diagnostics.record('warn', 'tunnel', 'TUNNEL_AUTOSTART_FAILED', 'Tunnel autostart failed', {
            node: node.name, state: 'failed', transport: node.transport || 'auto',
          });
        } else {
          diagnostics.record('info', 'tunnel', 'TUNNEL_READY', 'Tunnel is ready', {
            node: node.name, state: tr.reason === 'already running' ? 'existing' : 'started', transport: node.transport || 'auto',
          });
          if (!(node.token && node.acceptToken && node.nodeId)) continue;
          // `shared` in nodes.json e' lo stato desiderato. Una riconciliazione
          // asincrona chiude la finestra di crash tra write locale e ACK hub
          // senza ritardare il listen del server.
          const reconcileShare = cfg.reconcilePeerShareImpl || federation.reconcilePeerShare;
          if (node.shared === true) {
            Promise.resolve(node.reversePool ? reconcileRotatablePool(node) : node).then((effectiveNode) => {
              if (effectiveNode?.reversePool?.rotation?.phase === 'switched') {
                const delay = Math.max(0, effectiveNode.reversePool.rotation.graceUntil - Date.now()) + 50;
                const timer = setTimeout(() => { void settleRotatableGrace(effectiveNode.name, effectiveNode.reversePool.activeGeneration); }, delay);
                timer.unref?.();
              }
              return effectiveNode?.reversePool ? startRotatableReverse(effectiveNode) : null;
            }).then(() => reconcileShare({
              node, shared: true, fetchImpl: healthFetch,
              healthAttempts: 3, notifyAttempts: 3, delayMs: 200,
            })).catch((e) => {
              process.stderr.write(`[nexuscrew] peer ${node.name} Share reconcile pending: ${String(e && e.message || e).replace(/Bearer\s+\S+/gi, 'Bearer ***')}\n`);
            });
          } else {
            const runRevoke = cfg.runShareRevokeBootImpl || federation.runShareRevokeBoot;
            Promise.resolve(runRevoke({
              node, nodesPath, fetchImpl: healthFetch, diagnostics,
              reconcileImpl: reconcileShare,
              healthAttempts: 3, notifyAttempts: 3, delayMs: 200,
              ...(Array.isArray(cfg.shareRevokeBackoff) ? { backoff: cfg.shareRevokeBackoff } : {}),
              ...(typeof cfg.shareRevokeDelay === 'function' ? { delay: cfg.shareRevokeDelay } : {}),
            })).catch(() => {
              // The production runner contains failures and records the stable
              // transitions itself. This protects only an injected/custom runner.
              diagnostics.record('error', 'share', 'SHARE_REVOKE_EXHAUSTED',
                'Share OFF reconciliation exhausted', { node: node.name, state: 'exhausted' });
            });
          }
        }
      }
    }
  }

  const app = express();
  // CSP frame-ancestors (P0 sicurezza 2026-08-16, rimedio 4 del report): la
  // pagina dell'app non deve poter essere incorporata in un iframe altrui —
  // clickjacking sul control plane. Ortogonale alla porta pannello: quello
  // difende CHI E' NEL FRAME, questo difende l'app dall'ESSERE il frame.
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });
  reverseSlotListeners = createReverseSlotListeners({
    app, diagnostics, createServerImpl: cfg.reverseSlotCreateServerImpl,
    // `routeUpgrade` e' hoisted: qui si cattura solo il riferimento, la
    // chiamata avviene quando arriva un upgrade, a server avviato.
    attachUpgrade: (slotServer) => slotServer.on('upgrade', routeUpgrade),
  });
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  // no-store on everything (HTML+assets+API): this is a local, token-adjacent tool.
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Il panelServer nasce piu' avanti nella stessa funzione: il pairing legge
  // la sua porta VIVA tramite questo ref, risolto a ogni join (pattern dello
  // stesso tipo dell'hoisting di routeUpgrade qui sopra).
  const panelListenerRef = { server: null };
  app.use('/pair', publicPeeringRoutes({
    cfg, nodesPath,
    panelPort: () => {
      const srv = panelListenerRef.server;
      if (!srv || !srv.listening) return null;
      const addr = srv.address();
      return addr && Number.isInteger(addr.port) && addr.port > 0 ? addr.port : null;
    },
  }));
  // VL micro-device nodes use a separate, scoped credential surface.  These
  // routes never accept the NexusCrew UI bearer and expose only pair, poll and
  // self-unpair.  Operator management remains behind /api + federation ACL.
  app.use('/vl-node/v1', vlNodePublicRoutes({
    storePath: vlNodesPath, broker: vlNodeBroker, ownerId: vlOwnerId,
  }));
  // This route is deliberately outside the bearer-authenticated federation
  // router.  It emits a MAC only on a listener owned by the expected slot and
  // never accepts/sends a bearer to a suspicious loopback listener.
  app.post('/reverse-slot-proof', express.json({ limit: '2kb' }), (req, res) => {
    if (!reverseSlotListeners.respond(req, res)) res.status(404).json({ error: 'reverse slot non disponibile' });
  });

  // Pannello per-cella (D8): inoltra il traffico verso il `panelUrl` di UNA cella
  // LOCALE. La destinazione non arriva mai dal chiamante — si risolve dallo stato
  // della cella — e il token di NexusCrew non prosegue verso il pannello, che e'
  // un servizio terzo e non un nodo. Local-only come /api/live-host: il pass-through
  // /node/<name>/ NON deve portarci un peer qualsiasi (vedi LOCAL_ONLY_PREFIXES in
  // proxy/node-proxy.js). L'attraversamento verso i nodi del proprietario passera'
  // dalla via allowlistata della federazione, dietro il gate di proprieta'.
  async function resolveCellPanel(cellId) {
    const fleet = await fleetP;
    if (!fleet || fleet.available !== true) return null;          // fleet non interrogabile
    const statusFn = typeof fleet.status === 'function' ? fleet.status : fleet.cellStatus;
    if (typeof statusFn !== 'function') return null;
    const st = await statusFn.call(fleet);
    const cells = Array.isArray(st && st.cells) ? st.cells : [];
    // La chiave e' `cell`, non `id`: e' cio' che cellStatus PRODUCE
    // (fleet/runtime.js scrive `cell: c.id`, dove `id` e' il nome interno della
    // definizione). Cercare `c.id` qui non trovava MAI nulla, quindi ogni cella
    // con un pannello configurato rispondeva «pannello non disponibile» — e la
    // UI mostrava una causa col nome sbagliato. Tutti gli altri consumatori di
    // cellStatus usano gia' `c.cell` (cells/routes.js, live-host/bridge.js,
    // live-host/routes.js): questo era l'unico fuori posto.
    const cell = cells.find((c) => c && c.cell === cellId);
    if (!cell) return undefined;                                   // cella sconosciuta
    return typeof cell.panelUrl === 'string' ? cell.panelUrl.trim() : '';
  }
  // Tutte le altre /api dietro Bearer: sul loopback il gate vero è il tunnel,
  // ma il token chiude anche altri processi locali della stessa macchina.
  const api = express.Router();
  // L'INGRESSO al pannello sta PRIMA del requireToken generale: un <iframe> e'
  // una navigazione del browser e non porta header, quindi l'autenticazione
  // qui e' dedicata — Bearer per la PWA, ticket monouso + cookie di visione
  // per l'iframe (proxy/panel-auth.js, misura 2026-08-15). Il cookie vale
  // SOLO sul path della cella che lo ha emesso: non e' e non diventa
  // un'autenticazione dell'origine.
  const panelAuth = createPanelAuth({
    verifyToken: (t) => verify(tokenHolder.value, t),
    resolveCellPanel,
    // Senza questo segreto il pannello non saprebbe distinguere la PWA
    // dall'ultimo hop di una route federata — che entra qui col Bearer che il
    // proxy si e' iniettato da se'. E' lo stesso segreto per-processo che
    // firma gli hop di sotto: due valori diversi renderebbero ogni federata
    // 'sospetta', cioe' chiuderebbero il pannello remoto invece di proteggerlo.
    hopSecret: () => hopSecret,
    log: (entry) => diagnostics.record('panel-auth', 'info', entry.outcome, {
      cell: entry.cell, reason: entry.reason, state: entry.outcome,
    }),
  });
  api.use('/panel', panelAuth.panelAuthMiddleware, createPanelProxy({
    resolveCellPanel,
    log: (entry) => diagnostics.record('panel-proxy', 'info', entry.outcome, {
      cell: entry.cell, reason: entry.reason, state: entry.outcome,
    }),
  }));
  // Porta pannello dedicata (P0 sicurezza 2026-08-16): un iframe
  // same-origin senza sandbox legge il localStorage del padre — il JS di un
  // pannello ostile puo' prendersi il token e agire come l'operatore. La
  // porta fa parte dell'origin: spostando SOLO il consumo (ticket in query,
  // cookie di visione) su una porta sua, il browser vede un'origin diversa e
  // non c'e' piu' nulla da rubare. Nessuna API di controllo qui, nessun
  // Bearer verificato: l'emissione del ticket resta sopra, dietro
  // requireToken — e' l'unica operazione che richiede provare CHI chiede.
  const panelApp = express();
  panelApp.use('/panel', panelAuth.consumeMiddleware, createPanelProxy({
    resolveCellPanel,
    log: (entry) => diagnostics.record('panel-proxy', 'info', entry.outcome, {
      cell: entry.cell, reason: entry.reason, state: entry.outcome,
    }),
  }));
  // Qualunque altra cosa (niente /api, niente SPA): 404 secco. Questa porta
  // non ha nient'altro da offrire, e non deve mai imparare a offrirlo per
  // errore — un catch-all che rispondesse con l'app sarebbe esattamente il
  // difetto che questa porta esiste per chiudere.
  panelApp.use((_req, res) => res.status(404).json({ error: 'not found' }));
  const panelServer = http.createServer(panelApp);
  const panelServerV6 = http.createServer(panelApp);
  panelListenerRef.server = panelServer;
  function routePanelUpgrade(req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
    catch (_) { try { socket.destroy(); } catch (_e) {} return; }
    if (!pathname.startsWith('/panel/')) { try { socket.destroy(); } catch (_) {} return; }
    handlePanelUpgrade({
      req, socket, head, resolveCellPanel,
      verifyToken: (t) => verify(tokenHolder.value, t),
      authorize: panelAuth.authorizeUpgrade,
      log: (entry) => diagnostics.record('panel-proxy', 'info', entry.outcome, {
        cell: entry.cell, reason: entry.reason, state: entry.outcome,
      }),
    });
  }
  panelServer.on('upgrade', routePanelUpgrade);
  panelServerV6.on('upgrade', routePanelUpgrade);
  panelServer.on('close', () => { try { panelServerV6.close(); } catch (_) {} });
  // L'ingresso ai pannelli REMOTI ha la stessa malattia dell'iframe locale: la
  // via federata /api/route/<nodi>/_/panel/... sta per finire sotto requireToken
  // e una navigazione del browser non porta header. QUI il ticket non si può
  // validare — è del nodo che lo ha emesso — quindi per le panel-resource
  // federate il requireToken NON si applica: decide il nodo proprietario (gate
  // panelAccess + panelAuth col ticket/cookie, e l'ultimo hop lo riconosce
  // dalla prova di hop: di là il Bearer non apre più il pannello, altrimenti
  // il contenuto uscirebbe per ogni peer con panelAccess senza che nessuno
  // abbia mai preso un ticket). Resta della PWA autenticata l'EMISSIONE: il POST
  // .../panel/<cella>/ticket transita di sotto, col Bearer, come ogni altra /api.
  const panelFederatoRouter = federation.localRouter({
    nodesPath, localPort: () => (server && server.address() ? server.address().port : cfg.port), localCredential: () => tokenHolder.value, readonly: proxyReadonly,
    hopSecret: () => hopSecret,
  });
  api.use('/route', (req, res, next) => {
    const i = req.url.indexOf('/_/');
    if (i === -1) return next();
    const resource = req.url.slice(i + 2);
    if (!/^\/panel\/[A-Za-z0-9._-]{1,32}(?:\/.*)?$/.test(resource)) return next();
    if (req.method === 'POST' && /^\/panel\/[A-Za-z0-9._-]{1,32}\/ticket\/?$/.test(resource)) return next();
    panelFederatoRouter(req, res, next);
  });
  api.use(requireToken(tokenStore));
  // Origine per lo scope celle: stessa prova di hop usata da audio e notify.
  // requireCell:false perche' qui interessa QUALE NODO parla, non quale cella
  // dichiari — la cella e' solo attestata e non deve decidere un permesso.
  const cellScopeOrigin = createOriginResolver({
    localNodeId: () => (nodesStore.loadStore(nodesPath) || {}).nodeId || null,
    hopSecret: () => hopSecret,
  });
  const cellScoper = createCellScope({
    nodesPath,
    cellForSession: (session) => cellIdFromTmuxSession(session),
  });
  // Variante SINCRONA per l'upgrade WebSocket: verifica la prova di hop e la
  // catena senza passare dal resolver async. Un upgrade non federato — o con
  // una prova che non regge — resta senza restrizioni, esattamente come una
  // richiesta locale: la prova la costruisce il proxy, un peer non puo' ne'
  // toglierla ne' falsificarla.
  const wsCellScope = (req) => {
    try {
      const headers = (req && req.headers) || {};
      const proof = headers[HOP_HEADER];
      if (!proof) return cellScoper.resolve({ trust: 'local-bridge' });
      const self = (nodesStore.loadStore(nodesPath) || {}).nodeId || null;
      const visited = parseVisitedChain(headers['x-nexuscrew-visited'], self);
      if (!visited) return cellScoper.resolve({ trust: 'federated', visited: [] });
      const ok = verifyHop(hopSecret, {
        method: req.method || 'GET', path: '/ws', visited,
      }, proof);
      if (!ok) return cellScoper.resolve({ trust: 'federated', visited: [] });
      return cellScoper.resolve({ trust: 'federated', visited });
    } catch (_) {
      // Fail-closed: se non si riesce a stabilire l'origine, nessuna sessione.
      return cellScoper.resolve({ trust: 'federated', visited: [] });
    }
  };
  // Scope celle (NC-E): un punto solo decide cosa un peer federato vede e puo'
  // toccare. Sta qui, prima di ogni route, perche' i canali da cui una cella
  // trapela sono molti e crescono: filtrarli uno per uno significa dimenticarne
  // uno, e un permesso che vale su quasi tutti i canali non e' un permesso.
  // Le richieste locali non lo attraversano: il proprietario della macchina non
  // si limita da solo.
  api.use(createCellScopeGuard({
    nodesPath,
    cellForSession: (session) => cellIdFromTmuxSession(session),
    resolveOrigin: (req) => cellScopeOrigin.resolve(req, { requireCell: false }),
  }));
  api.get('/sessions', async (_req, res) => {
    try {
      const sessions = await listSessions(cfg.tmuxBin);
      const sum = watcher.getSummary();
      const enriched = await Promise.all(sessions.map(async (s) => {
        const sample = await previews.getState(s.name);
        // Pi keeps a static "π - ..." terminal title, so only that client uses
        // the capture fallback. This prevents a quoted "• Working (...)" line
        // inside another agent's transcript from becoming a false positive.
        const piTitle = /^(?:π|pi)(?:\s+-|$)/iu.test(s.paneTitle);
        const working = s.working === true || (piTitle && sample?.working === true);
        return {
          ...s,
          working,
          status: working ? (s.status || sample?.status || '') : '',
          outbox: sum[s.name] || { count: 0, latest: 0 },
          preview: sample?.preview ?? null,
          // Contesto libero e tier usati, dove la cella li pubblica (celle
          // Claude via statusline). Null per tutte le altre — assenza
          // legittima, non un trattino: la riga resta com'era.
          telemetry: leggiTelemetria(cfg.filesRoot, s.name),
        };
      }));
      res.json({ sessions: enriched });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  api.post('/sessions', express.json({ limit: '4kb' }), async (req, res) => {
    if (proxyReadonly()) return res.status(403).json({ error: 'READONLY: creazione sessione bloccata' });
    try {
      const { name, cwd, preset } = req.body || {};
      await createSession(cfg.tmuxBin, { name, cwd, preset },
        {
          home: os.homedir(), presets: cfg.sessionPresets, ensureProtection: ensureTmuxProtection,
          alternateScreen: cfg.alternateScreen, log: cfg.log,
        });
      res.status(201).json({ created: true, name });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  api.delete('/sessions/:name', async (req, res) => {
    if (proxyReadonly()) return res.status(403).json({ error: 'READONLY: eliminazione sessione bloccata' });
    const name = String(req.params.name || '');
    try {
      const fleet = await fleetP;
      if (isProtectedSession(name, fleet.isCellSession)) {
        return res.status(409).json({ error: 'sessione di cella: usa fleet down' });
      }
      const killed = await killSession(cfg.tmuxBin, name, { ensureProtection: ensureTmuxProtection });
      if (!killed) return res.status(404).json({ error: 'sessione inesistente' });
      res.json({ killed: true });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  api.patch('/sessions/:name/visibility', express.json({ limit: '1kb' }), async (req, res) => {
    if (proxyReadonly()) return res.status(403).json({ error: 'READONLY: classificazione sessione bloccata' });
    const name = String(req.params.name || '');
    try {
      const fleet = await fleetP;
      if (isProtectedSession(name, fleet.isCellSession)) {
        return res.status(409).json({ error: 'sessione di cella: la visibilità tecnica vale solo per sessioni tmux non gestite' });
      }
      res.json(await setSessionVisibility(cfg.tmuxBin, name, req.body?.technical === true));
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  // Mappa nome-nodo -> porta pannello inoltrata sul NOSTRO loopback (coppia
  // panel negoziata nel pairing). E' la fonte con cui il frontend mette il
  // frame di una cella REMOTA su un'origin diversa: la lettura e' questa, non
  // /api/nodes, perche' qui non c'e' nessun probe di health federato — la
  // mappa costa quanto la lettura dello store. Un nodo assente dalla mappa e
  // un peer accoppiato prima di questa negoziazione: via storica.
  const nodePanelPorts = () => {
    const st = nodesStore.loadStore(nodesPath);
    const out = {};
    if (st) for (const n of st.nodes) {
      if (n.panelLocalPort !== undefined) out[n.name] = n.panelLocalPort;
    }
    return out;
  };
  api.get('/config', (_req, res) => res.json({
    readonlyDefault: cfg.readonlyDefault, version: VERSION, uiVersion: uiBuildVersion(distDir),
    bind: cfg.bind, port: cfg.port, panelPort: cfg.panelPort,
    protectSharedTmuxServer: cfg.protectSharedTmuxServer !== false,
    instanceId: (nodesStore.loadStore(nodesPath) || {}).nodeId || null,
    nodePanelPorts: nodePanelPorts(),
    presets: ['shell', 'claude', 'codex-vl', 'pi', ...Object.keys(cfg.sessionPresets || {})],
  }));
  api.use('/files', filesRoutes({
    cfg,
    sessionExists: (name) => sessionExists(cfg.tmuxBin, name),
    paste: (session, text) => pasteToSession(cfg.tmuxBin, session, text),
    notifier,
    readonly: proxyReadonly,
  }));
  // MCP bridge (design §2): /notify, /push/*, /asks — dietro lo stesso Bearer
  // del router /api; gate READONLY sui mutanti dentro notifyRoutes.
  // Identita' e instradamento condivisi con l'audio: stessa fonte (node store),
  // stesso segreto di hop, stessa inventory. Due modelli di provenienza
  // divergenti sarebbero un bug latente.
  const federatedNodeId = () => (nodesStore.loadStore(nodesPath) || {}).nodeId || null;
  const federatedPeers = async () => {
    const st = nodesStore.loadStore(nodesPath);
    if (!st) return [];
    const topology = await federation.collectLocalTopology({ nodesPath, cachePath: topologyCachePath, fetchImpl: healthFetch });
    return nodesInventory.buildInventory({
      direct: nodesStore.redactStore(st).nodes,
      topology: topology && Array.isArray(topology.nodes) ? topology.nodes : [],
    });
  };
  api.use(notifyRoutes({
    cfg,
    notifier,
    push: pushSvc,
    asks: asksStore,
    paste: (session, text) => pasteToSession(cfg.tmuxBin, session, text),
    sessionExists: (name) => sessionExists(cfg.tmuxBin, name),
    localNodeId: federatedNodeId,
    // requireCell resta true: una notifica federata porta sempre una cella
    // attestata, che serve ad attribuirla e a calcolarne il budget.
    originResolver: createOriginResolver({
      localNodeId: federatedNodeId,
      hopSecret: () => hopSecret,
    }),
    acl: createAudioAcl({ nodesPath }),
    dispatcher: createDispatcher({
      localNodeId: federatedNodeId,
      peers: federatedPeers,
      localPort: () => (server && server.address() ? server.address().port : cfg.port),
      localToken: () => tokenHolder.value,
      // 'no-delivery' (R31-A3): esito legittimo del target — richiesta accettata
      // ma nessun canale raggiunto (0 UI, 0 push). Senza questa voce forward()
      // lo degraderebbe a 'unknown/unreadable-endpoint-result', nascondendo
      // proprio il silenzio che l'esito esiste per rivelare.
      statuses: new Set(['delivered', 'no-delivery', 'refused', 'unreachable', 'unknown']),
    }),
    federatedRate: createSpeakRateLimiter(),
  }));
  api.use('/fleet', fleetRoutes(fleetP, { ...cfg, diagnostics }));
  // Fetta 2b (D3): superficie child del lease Live via canale nativo del
  // bridge (HTTP loopback + Bearer). La cella e' derivata dalla sessione; il
  // proof firmato dal verifier per-installazione autorizza refresh/recovery.
  api.use('/lease', leaseRoutes({ fleetP, readonly: proxyReadonly }));
  // Audio Share. L'identita' del nodo NON e' un campo di cfg: si legge dal node
  // store, la stessa fonte usata da /api/cells e /api/peers. Lo stato Fleet e'
  // asincrono e va atteso: leggerlo come se fosse sincrono lascerebbe la
  // risoluzione dell'origine sempre vuota e la feature morta senza che un test
  // sul router se ne accorga.
  const audioNodeId = () => (nodesStore.loadStore(nodesPath) || {}).nodeId || null;
  // Seam di test per l'adapter: permette di esercitare il percorso completo
  // (route -> gate -> coda -> receipt) sul server REALE senza emettere suono.
  // In produzione resta il probe locale.
  const audioAdapter = cfg.audioAdapterSeam
    || audioAdapters.createAdapter(audioAdapters.detectAdapter({ env: cfg.env || process.env }));
  const audioReceipts = createReceiptStore();
  const audioQueue = createSpeakQueue({
    adapter: audioAdapter,
    // La coda e' l'unica a sapere com'e' finito davvero un enunciato: e' lei ad
    // aggiornare il receipt da `accepted` a spoken/refused/unknown.
    onStatus: (utteranceId, status, reason) => { try { audioReceipts.update(utteranceId, status, reason); } catch (_) {} },
  });
  api.use('/audio', audioRoutes({
    readonly: proxyReadonly,
    localNodeId: audioNodeId,
    receiptStore: audioReceipts,
    adapter: audioAdapter,
    queue: audioQueue,
    acl: createAudioAcl({ nodesPath }),
    consent: () => { try { return isAudioConsent(audioCfg, audioHome); } catch (_) { return false; } },
    originResolver: createOriginResolver({
      localNodeId: audioNodeId,
      // Celle Fleet ATTIVE in questo momento, attese davvero.
      activeCells: async () => {
        const fleet = await fleetP;
        if (!fleet || fleet.available !== true || typeof fleet.status !== 'function') return [];
        const st = await fleet.status();
        return Array.isArray(st && st.cells) ? st.cells.map((c) => ({
          cell: c && c.cell, tmuxSession: c && c.tmuxSession,
          active: c && c.active === true && c.tmux !== false,
        })) : [];
      },
      bridgeSecret: () => { try { return loadOrCreateBridgeSecret(bridgeSecretPath(audioCfg, audioHome)); } catch (_) { return null; } },
      hopSecret: () => hopSecret,
      nonceCache: audioNonceCache,
    }),
    dispatcher: createDispatcher({
      localNodeId: audioNodeId,
      peers: async () => {
        const st = nodesStore.loadStore(nodesPath);
        if (!st) return [];
        const topology = await federation.collectLocalTopology({ nodesPath, cachePath: topologyCachePath, fetchImpl: healthFetch });
        return nodesInventory.buildInventory({
          direct: nodesStore.redactStore(st).nodes,
          topology: topology && Array.isArray(topology.nodes) ? topology.nodes : [],
        });
      },
      localPort: () => (server && server.address() ? server.address().port : cfg.port),
      localToken: () => tokenHolder.value,
    }),
    getGroup: (name) => audioGroups.getGroup(audioCfg, name, audioHome),
  }));
  api.use('/cells', cellsRoutes({
    fleetP,
    instanceId: () => (nodesStore.loadStore(nodesPath) || {}).nodeId || null,
    submit: opts.cellSubmit || ((session, text, meta) => submitToSession(cfg.tmuxBin, session, text, {
      engine: meta && meta.engine,
    })),
    readonly: proxyReadonly,
  }));
  // Cella ospite Live (contratto rev6 §2): hostCell unico per nodo con CAS. Lo store
  // vive accanto al token (stessa dir isolata nei test); il proxy nega /api/live-host
  // via /node (local-only), ma la via /api/route la instrada (0.9.1) dietro un
  // permesso per-peer negato di default (liveHostAccess, v. lib/proxy/federation.js).
  // Fetta 3: il ponte risolve il puntamento all'avvio di una Live (POST /bridge
  // nello stesso gruppo, stessa auth, stesso local-only). Isolabile da cfg
  // (rev5 MC0): spento non crea connessioni e la Live resta standard.
  api.use('/live-host', liveHostRoutes({
    fleetP,
    store: createLiveHostStore({ filePath: liveHostPath(cfg) }),
    readonly: proxyReadonly,
    bridge: createLiveBridge({
      cfg,
      fleetP,
      tokenGet: () => tokenHolder.value,
      filesRoot: cfg.filesRoot,
      log: opts.log || console.log,
    }),
  }));
  // Pannello per-cella: montato con il suo ingresso dedicato (ticket+cookie)
  // PRIMA del requireToken generale — vedi il blocco sopra, dove nascono
  // `panelAuth` e `resolveCellPanel`.
  api.use('/vl-nodes', vlNodeApiRoutes({
    storePath: vlNodesPath, broker: vlNodeBroker, ownerId: vlOwnerId, readonly: proxyReadonly,
  }));
  api.use('/decks', decksRoutes({ cfg, decksPath }));
  api.use('/fs', fsRoutes({ home: os.homedir() }));  // folder-picker del dialog new session
  // /nodes (read-only, per la settings UI B2): stesso formato di `nodes list --json`
  // (token SEMPRE redatti via redactStore) + health federato per-nodo. Il campo
  // `tunnel` resta per retro-compatibilita' col frontend (derivato dal health).
  //   health = { transport, auth, reachability, status, detail, managed, at }
  // inbound: non probeable -> health unknown (NON "up" fittizio). outbound: probe
  // reale /federation/health (cache TTL) -> distingue tcp down / 401 / 200.
  api.get('/nodes', async (_req, res) => {
    try {
      const st = nodesStore.loadStore(nodesPath);
      if (!st) return res.json({ nodeId: null, nodes: [] });
      const view = nodesStore.redactStore(st);
      const healths = await nodesHealth.nodesHealth({
        nodes: st.nodes, home: cfg.home || os.homedir(), fetchImpl: healthFetch, now: Date.now(),
      });
      const nodes = view.nodes.map((n, i) => {
        const h = healths[i] || null;
        // La sonda gia' avviene per servire questa risposta: qui si registra
        // SOLO se il risultato e' diverso dall'ultimo noto per questo peer
        // (lib/nodes/peer-transitions.js) — nessun probe in piu', nessun
        // record se il peer resta invariato.
        recordPeerTransition(n.name, h, diagnostics);
        return { ...n, tunnel: nodesHealth.tunnelFromHealth(h), health: h };
      });
      res.json({ nodeId: view.nodeId, nodes });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // Canonical management inventory: direct hubs/clients plus routed peers.  The
  // latter are deliberately inspect-only because they have no local nodes.json
  // record to mutate.  UI and CLI consume the same action matrix.
  api.get('/peers', async (_req, res) => {
    try {
      const st = nodesStore.loadStore(nodesPath);
      if (!st) return res.json({ nodeId: null, peers: [] });
      const direct = nodesStore.redactStore(st).nodes;
      const healths = await nodesHealth.nodesHealth({
        nodes: st.nodes, home: cfg.home || os.homedir(), fetchImpl: healthFetch, now: Date.now(),
      });
      const extras = new Map(direct.map((node, index) => {
        const health = healths[index] || null;
        // Stessa registrazione di /nodes: la Map di stato di
        // peer-transitions.js e' condivisa per nome peer, quindi una
        // transizione gia' vista da /nodes non produce un secondo record qui.
        recordPeerTransition(node.name, health, diagnostics);
        return [node.name, { health, tunnel: nodesHealth.tunnelFromHealth(health) }];
      }));
      const topology = await federation.collectLocalTopology({
        nodesPath, cachePath: topologyCachePath, fetchImpl: healthFetch,
      });
      const peers = nodesInventory.buildInventory({
        direct,
        topology: topology && Array.isArray(topology.nodes) ? topology.nodes : [],
        extras,
      });
      res.json({ nodeId: st.nodeId, peers });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  // Settings API B2 (design §4b(6)): read-only GET + mutanti lista chiusa per il
  // wizard/settings UI. Dietro lo stesso requireToken del router /api; il gate
  // READONLY route-level e la redazione token vivono dentro settingsRoutes.
  api.use('/settings', settingsRoutes({
    cfg, nodesPath, tokenStore, closeSessions, updater, runtimePort,
    // Stesso adapter/coda dell'API Audio: Settings puo' fare solo la prova
    // locale a frase fissa e lo stop sovrano, mai una seconda sintesi parallela.
    audio: { adapter: audioAdapter, queue: audioQueue },
    reverseSlots: { ensure: startRotatableReverse, close: stopRotatableReverse, verify: verifyRotatablePool },
  }));
  api.use('/diagnostics', diagnosticsRoutes({ diagnostics, readonly: proxyReadonly }));
  api.get('/topology', async (_req, res) => {
    try { res.json(await federation.collectLocalTopology({ nodesPath, cachePath: topologyCachePath })); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  api.use('/route', federation.localRouter({
    nodesPath, localPort: () => (server && server.address() ? server.address().port : cfg.port), localCredential: () => tokenHolder.value, readonly: proxyReadonly,
    hopSecret: () => hopSecret,
  }));
  api.get('/voice/status', (_req, res) => res.json({ serverSttConfigured: !!cfg.voiceUrl }));
  api.post('/voice/transcribe',
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      try {
        const out = await transcribe(cfg, req.body, { language: String(req.query.language || 'it') });
        res.json({ text: out.text || '' });
      } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
    });
  // SSE eventi UI (notify/ask, MCP bridge §2a): EventSource non puo' settare
  // header -> il token e' accettato anche in query, SOLO perche' il bind e'
  // loopback-only (stesso pattern dell'upgrade WS del proxy /node). Montata
  // PRIMA del router /api (che e' Bearer-only) e sempre sul token live.
  app.get('/api/events', (req, res) => {
    const given = bearerFrom(req) || String(req.query.token || '');
    if (!verify(tokenHolder.value, given)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    eventsHub.handle(req, res);
  });

  app.use('/api', api);
  app.use('/federation', federation.peerRouter({
    nodesPath, localPort: () => (server && server.address() ? server.address().port : cfg.port), localCredential: () => tokenHolder.value, readonly: proxyReadonly, version: VERSION,
    fetchImpl: healthFetch, hopSecret: () => hopSecret,
    roles: () => require('./cli/commands.js').readRoles(cfg.configPath || configJsonPath()),
    diagnostics,
  }));

  // Reverse-proxy single-origin /node/<name>/… (design §4b(2)). Auth locale PRIMA
  // di risolvere <name>: requireToken(token) davanti al router, nessuna route
  // proxy montata prima del middleware auth. Montato PRIMA dello static/catch-all.
  app.use('/node', requireToken(tokenStore), createNodeProxy({ resolveNode, readonly: proxyReadonly }));

  app.use(express.static(distDir));
  // Deck multi-finestra (§5b): /deck/<name> serve la STESSA SPA (stesso origin,
  // stesso token via fragment). <name> e' una chiave strict client-side, mai usata
  // per costruire path: validazione ^[a-z0-9-]{1,32}$, nome invalido → 404 secco
  // (niente traversal, niente fallback silenzioso alla SPA su nomi sporchi).
  const DECK_NAME_RE = /^[a-z0-9-]{1,32}$/;
  const DECK_OWNER_RE = /^[a-f0-9]{16,64}$/;
  // Cattura TUTTO cio' che sta sotto /deck/ (anche slash/segmenti extra o encoded)
  // e valida il remainder: qualunque cosa non sia un nome deck strict → 404,
  // senza mai cadere nel catch-all SPA con un nome sporco.
  app.get(/^\/deck\/(.*)$/, (req, res) => {
    // parita' col client: deckFromPath accetta UN trailing slash (/deck/main/),
    // il server deve fare lo stesso; piu' di uno resta 404 (regex strict).
    const value = req.params[0].replace(/\/$/, '');
    const parts = value.split('/');
    const valid = (parts.length === 1 && DECK_NAME_RE.test(parts[0]))
      || (parts.length === 2 && DECK_OWNER_RE.test(parts[0]) && DECK_NAME_RE.test(parts[1]));
    if (!valid) {
      return res.status(404).type('text/plain').send('invalid deck name');
    }
    return res.sendFile(path.join(distDir, 'index.html'));
  });
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

  server = http.createServer(app);
  // Close the watcher when the HTTP server closes. Registered HERE (inside
  // createServer) — not in start() — so every createServer consumer is covered,
  // not only the start() path. watcher.close() is idempotent.
  server.on('listening', () => {
    diagnostics.record('info', 'server', 'SERVER_STARTED', 'NexusCrew server started', {
      port: runtimePort(), platform: cfg.platform || process.platform,
    });
    updater.start(); startManagedTunnels();
  });
  server.on('close', () => {
    diagnostics.record('info', 'server', 'SERVER_STOPPED', 'NexusCrew server stopped', { reason: 'close' });
    watcher.close(); previews.close(); eventsHub.closeAll(); updater.close();
    for (const timer of reverseWatchers.values()) clearInterval(timer);
    reverseWatchers.clear(); rotatableReverse.clear(); void reverseSlotListeners?.closeAll();
    // Il pannello non sopravvive al control plane: senza requireToken sopra,
    // non c'e' un secondo lifecycle da tenere in vita da soli. panelServerV6
    // si chiude a cascata dal listener 'close' gia' registrato su panelServer.
    try { panelServer.close(); } catch (_) {}
  });
  // noServer: gestiamo l'upgrade a mano per instradare /ws (locale) e /node/*
  // (proxy). Il WS locale resta identico; il proxy WS applica gli STESSI check
  // dell'HTTP (auth locale -> name strict -> inject token) prima del piping.
  wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  // Browser/mobile/tunnel possono lasciare TCP half-open senza un close event.
  // Il ping applicativo fa emergere il guasto; terminate genera un close 1006
  // lato browser, che il client riconnette senza richiedere refresh pagina.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) { try { client.terminate(); } catch (_) {} continue; }
      client.isAlive = false;
      try { client.ping(); } catch (_) { try { client.terminate(); } catch (_e) {} }
    }
  }, opts.wsHeartbeatMs || 30000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  // Routing dell'upgrade WS. Dichiarata come funzione (hoisted nello scope di
  // createServer) perche' i listener per-slot nascono PRIMA di questo punto e
  // devono ricevere lo STESSO routing: un listener che serve `app` senza
  // handler di upgrade fa cadere l'upgrade su Express, che non ha una rotta
  // HTTP `/ws` e risponde con la SPA (200) invece di 101 -> terminale nero su
  // ogni peer raggiunto via reverse pool.
  function routeUpgrade(req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; }
    catch (_) { try { socket.destroy(); } catch (_e) {} return; }
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    if (pathname.startsWith('/api/route/')) {
      let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return socket.destroy(); }
      const given = bearerFrom(req) || u.searchParams.get('token') || '';
      // Le WebSocket di un pannello REMOTO partono dalla pagina nel frame e
      // portano solo il cookie di visione: il token qui non c'è e non deve
      // esserci. L'HUB non può validarle (il cookie è del nodo che lo ha
      // emesso): transita e decide il proprietario, gate panelAccess compreso
      // — stessa forma del bypass HTTP sulle panel-resource federate.
      const panelFederato = /^\/api\/route\/[^?#]*\/_\/panel\/[A-Za-z0-9._-]{1,32}(?:\/.*)?$/.test(pathname)
        && /(?:^|;\s*)npanel=/.test(String(req.headers.cookie || ''));
      if (!panelFederato && !verify(tokenHolder.value, given)) return socket.destroy();
      federation.forwardUpgrade({ req, socket, head, nodesPath, localPort: runtimePort, localCredential: () => tokenHolder.value, ingress: null, readonly: proxyReadonly, activeSockets: proxySockets, hopSecret: () => hopSecret });
      return;
    }
    if (pathname.startsWith('/federation/route/')) {
      const ingress = federation.peerFromToken(nodesPath, bearerFrom(req));
      if (!ingress) return socket.destroy();
      federation.forwardUpgrade({ req, socket, head, nodesPath, localPort: runtimePort, localCredential: () => tokenHolder.value, ingress, readonly: proxyReadonly, activeSockets: proxySockets, hopSecret: () => hopSecret });
      return;
    }
    if (pathname.startsWith('/api/panel/')) {
      handlePanelUpgrade({
        req, socket, head, resolveCellPanel,
        verifyToken: (t) => verify(tokenHolder.value, t),
        // Il cookie di visione apre le WS del pannello (la pagina nel frame
        // non puo' mettere header); Bearer e ?token= restano validi come prima.
        authorize: panelAuth.authorizeUpgrade,
        log: (entry) => diagnostics.record('panel-proxy', 'info', entry.outcome, {
          cell: entry.cell, reason: entry.reason, state: entry.outcome,
        }),
      });
      return;
    }
    if (pathname === '/node' || pathname.startsWith('/node/')) {
      handleNodeUpgrade({
        req, socket, head, resolveNode,
        verifyToken: (t) => verify(tokenHolder.value, t),
        readonly: proxyReadonly,
        activeSockets: proxySockets,
      });
      return;
    }
    try { socket.destroy(); } catch (_) {}
  }
  server.on('upgrade', routeUpgrade);
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Preauth via header (B2 attach remoto): quando l'upgrade arriva dal proxy
    // /node/<name> di un hub, il proxy ha gia' iniettato `Authorization: Bearer
    // <token di QUESTO nodo>` (§4b(2)#3) mentre il frame attach porta il token
    // del hub. Un Bearer valido sull'upgrade vale come auth: e' lo STESSO
    // verify dello stesso token locale, solo su un canale diverso. I browser
    // non possono settare header sui WS -> il flusso locale resta identico
    // (token nel frame attach, mai in URL).
    const preauth = req ? verify(tokenHolder.value, bearerFrom(req)) : false;
    // Scope celle sull'ATTACH. Calcolato in modo sincrono di proposito: rendere
    // async questo handler rischierebbe di perdere i frame che arrivano prima
    // di bindWs. `/ws` attacca per NOME DI SESSIONE e senza questo gate ogni
    // filtro sugli elenchi sarebbe decorativo — basterebbe indovinare
    // `cloud-X`.
    const wsScope = wsCellScope(req);
    bindWs(ws, {
      openAttach,
      verifyToken: (t) => preauth || verify(tokenHolder.value, t),
      // Una sessione fuori scope viene trattata come inesistente: il client
      // riceve 4404, lo stesso codice di una sessione che non c'e'. Dire "esiste
      // ma non puoi" rivelerebbe proprio cio' che lo scope nasconde.
      isValidSession: (name) => sessionExistsImpl(name) && wsScope.allowsSession(name),
      runAction: (sess, action) => runAction(cfg.tmuxBin, sess, action),
      countClients: (sess) => attachedClients(cfg.tmuxBin, sess),
      defaults: { readonlyDefault: cfg.readonlyDefault, tmuxBin: cfg.tmuxBin },
      onAttach: (sess) => attachedWs.set(ws, sess),
    });
    ws.on('close', () => attachedWs.delete(ws));
  });

  watcher.on('change', (session, files) => {
    for (const [client, sess] of attachedWs) {
      if (sess === session && client.readyState === 1) {
        try { client.send(JSON.stringify({ type: 'files', session, files })); } catch (_) {}
      }
    }
  });

  server.on('close', () => {
    fleetP.then((fleet) => (typeof fleet.close === 'function' ? fleet.close() : null)).catch(() => {});
  });

  return {
    app, server, wss, cfg, token: tokenHolder.value, tokenStore, watcher, fleetP, updater, diagnostics,
    panelApp, panelServer, panelServerV6,
  };
}

function start(opts = {}) {
  const { server, cfg, panelServer, panelServerV6 } = createServer({ ...opts, cellLeaseEnabled: true });
  const log = opts.log || console.log;
  const requestedPort = cfg.port;
  const nodesPath = opts.nodesPath || nodesStore.defaultNodesPath(cfg.home || os.homedir());
  const pairedPeers = nodesStore.hasPairedPeers(nodesStore.loadStore(nodesPath));
  const listenError = (error) => {
    if (typeof opts.onListenError === 'function') return opts.onListenError(error);
    throw error;
  };
  // Porta pannello (P0 sicurezza 2026-08-16): scelta libera con lo STESSO
  // meccanismo di fallback della principale, ma piu' leggero — nessun peer
  // dipende ancora da un valore stabile persistito (a differenza di cfg.port,
  // che i tunnel pairati referenziano), quindi niente scrittura su
  // config.json: il frontend la scopre da /api/config a ogni avvio. Un
  // fallimento qui non deve MAI abbattere il control plane: e' un log, non
  // un throw — il pannello resta un'estensione, non un requisito di avvio.
  const startPanelV6 = () => {
    panelServerV6.once('error', (error) => {
      log(`panel: IPv6 loopback listener not available (${(error && error.code) || error}); IPv4 still serves the panel.`);
    });
    panelServerV6.listen(cfg.panelPort, '::1');
  };
  const startPanelServer = () => {
    const requestedPanelPort = cfg.panelPort;
    const tryPanelFallback = (candidate, remaining) => {
      panelServer.once('error', (error) => {
        if (error && error.code === 'EADDRINUSE' && remaining > 1) {
          tryPanelFallback(candidate >= 65535 ? 41821 : candidate + 1, remaining - 1);
          return;
        }
        log(`panel: preferred port ${requestedPanelPort} busy and no fallback available (${(error && error.code) || error}); panel disabled this run.`);
      });
      panelServer.listen(candidate, cfg.bind, () => {
        cfg.panelPort = panelServer.address().port;
        log(`panel port ${requestedPanelPort} busy; selected ${cfg.panelPort}`);
        startPanelV6();
      });
    };
    panelServer.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') { tryPanelFallback(requestedPanelPort >= 65535 ? 41821 : requestedPanelPort + 1, 200); return; }
      log(`panel: failed to start (${(error && error.code) || error}); panel disabled this run.`);
    });
    panelServer.listen(requestedPanelPort, cfg.bind, () => {
      cfg.panelPort = panelServer.address().port;
      startPanelV6();
    });
  };
  const onListening = () => {
    cfg.port = server.address().port;
    // Il token NON si stampa allo startup: finirebbe nei log del servizio
    // (journalctl/logfile). L'apertura autenticata passa da `nexuscrew show`.
    log(`nexuscrew on http://${cfg.bind}:${cfg.port}  (open with \`nexuscrew show\`)`);
    log('localhost-only — reach it via a user-controlled SSH or VPN channel.');
    startPanelServer();
  };
  const persistFallback = () => {
    const selected = server.address().port;
    const configPath = opts.configPath || configJsonPath();
    let current = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
    } catch (_) {}
    writeConfigAtomic(configPath, { ...current, port: selected });
    log(`preferred port ${requestedPort} busy; selected ${selected}`);
    onListening();
  };
  const tryFallback = (candidate, remaining) => {
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE' && remaining > 1) {
        tryFallback(candidate >= 65535 ? 41820 : candidate + 1, remaining - 1);
        return;
      }
      throw error;
    });
    server.listen(candidate, cfg.bind, persistFallback);
  };
  server.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE' && requestedPort !== 0 && opts.autoPort !== false) {
      if (pairedPeers) {
        const refused = new Error(`preferred port ${requestedPort} is busy; paired peers exist, refusing automatic port change`);
        refused.code = 'EADDRINUSE_PAIRED';
        refused.cause = error;
        listenError(refused);
        return;
      }
      tryFallback(requestedPort >= 65535 ? 41820 : requestedPort + 1, 200);
      return;
    }
    listenError(error);
  });
  server.listen(requestedPort, cfg.bind, onListening);
  return server;
}

module.exports = { createServer, start };
