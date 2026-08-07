'use strict';
// lib/settings/public-peering-routes.js — public peering surface (the one-time
// invite itself is the capability). Extracted verbatim from
// lib/settings/routes.js (behavior-preserving modularization); routes.js
// re-exports publicPeeringRoutes for backward compatibility.
//
// The route exposes no generic API and creates a scoped peer credential, never
// a UI token. Identity proof does not consume the capability and never receives
// invite/token in clear text: it prevents any HTTP listener on the -L port from
// being mistaken for the node contained in the link.
const os = require('node:os');
const express = require('express');

const nodesStore = require('../nodes/store.js');
const peering = require('../nodes/peering.js');
const identity = require('../nodes/identity.js');
const reversePool = require('../nodes/reverse-pool.js');
const { readRoles } = require('../cli/commands.js');
const { configJsonPath } = require('../config.js');

function validPeerName(name) { return typeof name === 'string' && nodesStore.NODE_NAME_RE.test(name); }

function publicPeeringRoutes(deps = {}) {
  const cfg = deps.cfg || {};
  const home = cfg.home || os.homedir();
  const configPath = cfg.configPath || configJsonPath();
  const nodesPath = deps.nodesPath || cfg.nodesPath || nodesStore.defaultNodesPath(home);
  const invitesPath = cfg.invitesPath || peering.defaultInvitesPath(home);
  const pendingPath = cfg.pendingPairingsPath || peering.defaultPendingPath(home);
  const reversePoolLedgerPath = deps.reversePoolLedgerPath || cfg.reversePoolLedgerPath || reversePool.defaultLedgerPath(home);
  // La pubblica di questa installazione, per il passo 1 del modello di
  // autorita'. Si legge PIGRAMENTE e non all'avvio del router: un errore sul
  // file di chiave non deve impedire di montare le route di pairing — il passo
  // 1 non ha effetti, e «non riesco a leggere la mia chiave» non e' una buona
  // ragione per non poter piu' accoppiare un dispositivo.
  const localPublicKey = () => {
    try { return identity.ensureNodeKey({ keyPath: identity.keyPathNextTo(nodesPath) }).publicKey; }
    catch (_) { return null; }
  };
  const r = express.Router();
  const attempts = new Map();
  r.use(express.json({ limit: '8kb' }));
  // Identity proof non consuma la capability e non riceve mai invite/token in
  // chiaro. Serve a impedire che un qualunque listener HTTP sulla porta -L
  // venga scambiato per il nodo contenuto nel link.
  r.post('/identity', (req, res) => {
    const key = `identity:${String(req.socket && req.socket.remoteAddress || 'local')}`;
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((x) => now - x < 60_000);
    recent.push(now); attempts.set(key, recent);
    if (recent.length > 30) return res.status(429).json({ error: 'troppi tentativi' });
    const b = req.body || {};
    const proof = peering.capabilityIdentity({
      invitesPath, pendingPath, capabilityId: b.capabilityId, challenge: b.challenge, now,
    });
    if (!proof) return res.status(404).json({ error: 'capability non valida' });
    const st = nodesStore.loadStore(nodesPath);
    if (!st || !nodesStore.NODE_ID_RE.test(st.nodeId)) return res.status(503).json({ error: 'identita nodo non disponibile' });
    return res.json({ ok: true, instanceId: st.nodeId, proof });
  });
  r.post('/join', async (req, res) => {
    const key = `join:${String(req.socket && req.socket.remoteAddress || 'local')}`;
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((x) => now - x < 60_000);
    recent.push(now); attempts.set(key, recent);
    if (recent.length > 10) return res.status(429).json({ error: 'troppi tentativi di pairing' });
    const b = req.body || {};
    const peerRoles = b.roles === undefined ? null : nodesStore.parseRoles(b.roles);
    if (!nodesStore.validToken(b.invite) || !nodesStore.NODE_ID_RE.test(b.instanceId)
      || !validPeerName(b.name) || !nodesStore.isPort(b.port) || !nodesStore.validToken(b.acceptToken)
      || (b.roles !== undefined && !peerRoles)
      // Pairing is always private. Publishing is a separate authenticated
      // action after the reverse channel is live and health-checked.
      || (b.shared !== undefined && b.shared !== false)) {
      return res.status(400).json({ error: 'pairing request non valida' });
    }
    if (b.label !== undefined && !nodesStore.validLabel(b.label)) {
      return res.status(400).json({ error: 'label non valida' });
    }
    // Validate the one-time capability before conflict checks without burning
    // it: a duplicate/stale peer must not destroy an otherwise reusable invite.
    if (!peering.hasInvite({ invitesPath, invite: b.invite, now })) return res.status(410).json({ error: 'invito scaduto o gia usato' });
    let credential = null;
    try {
      const st = nodesStore.loadStoreStrict(nodesPath);
      const pending = peering.readInvites(pendingPath, now);
      if (st.nodeId === b.instanceId || st.nodes.some((n) => n.nodeId === b.instanceId)
        || pending.some((row) => row.instanceId === b.instanceId)) return res.status(409).json({ error: 'peer duplicato' });
      const reservedNames = new Set(pending.map((row) => row.name).filter(validPeerName));
      // `localhost` e' sintatticamente uno slug valido, ma su Termux non e'
      // un handle di route: piu device espongono lo stesso hostname. Trattalo
      // come conflitto risolvibile anche quando e' il primo, senza consumare
      // l'invite; il client puo' riprovare col suffisso stabile proposto.
      if (b.name === 'localhost' || nodesStore.getNode(st, b.name) || reservedNames.has(b.name)) {
        const usedNames = [...st.nodes.map((node) => node.name), ...reservedNames];
        const suggestedName = nodesStore.deriveNodeHandle(
          b.label || b.name, b.name, b.instanceId, usedNames,
        );
        return res.status(409).json({
          error: `nome peer gia' in uso: ${b.name}`,
          code: 'peer-name-conflict',
          suggestedName,
          hint: `usa l'handle proposto "${suggestedName}" e riprova con lo stesso invito`,
        });
      }
      const name = b.name;
      // The hub owns allocation.  Establish an empty v3 anchor before any
      // allocation event; from here onward each allocated pool is written to
      // the append-only ledger first and the anchor second.  A ledger ahead of
      // its anchor is therefore a safe interrupted write and is reconciled;
      // a missing/behind prefix never becomes a reason to reuse a port.
      let poolStore = st;
      let ledger = reversePool.loadLedger(reversePoolLedgerPath);
      if (poolStore.schemaVersion < nodesStore.SCHEMA_VERSION || poolStore.reversePoolLedgerInitialized !== true) {
        if (ledger) {
          const error = new Error('reverse pool ledger presente senza anchor: nuove assegnazioni bloccate');
          error.code = 'reverse-pool-anchor-missing'; error.status = 503; throw error;
        }
        ledger = reversePool.emptyLedger();
        poolStore = nodesStore.upgradeToReversePoolSchema(poolStore, reversePool.ledgerHead(ledger));
        nodesStore.atomicWriteStore(nodesPath, poolStore);
        reversePool.atomicWriteLedger(reversePoolLedgerPath, ledger);
      } else {
        const anchor = poolStore.reversePoolAnchor;
        if (!ledger) {
          // A zero anchor is the only safe state where an absent ledger can be
          // initialized: no allocation has ever been anchored.  Existing
          // private peers remain usable even when this path refuses new ones.
          const parsed = reversePool.parseAnchor(anchor);
          const empty = parsed && parsed.seq === 0 && parsed.digest === reversePool.genesisDigest(parsed.epoch)
            ? reversePool.emptyLedger(parsed.epoch) : null;
          if (!empty) {
            const error = new Error('reverse pool ledger assente dopo assegnazioni: nuove assegnazioni bloccate');
            error.code = 'reverse-pool-ledger-missing'; error.status = 503; throw error;
          }
          ledger = reversePool.atomicWriteLedger(reversePoolLedgerPath, empty);
        }
        const checked = reversePool.validateLedgerAnchor(ledger, anchor);
        if (!checked.ok) {
          const error = new Error(`reverse pool ledger non sicuro: ${checked.code}`);
          error.code = checked.code; error.status = 503; throw error;
        }
        if (checked.advanceAnchor) {
          poolStore = { ...poolStore, reversePoolAnchor: checked.advanceAnchor };
          poolStore = nodesStore.atomicWriteStore(nodesPath, poolStore);
        }
      }
      const allocation = await reversePool.allocateAvailableReversePool(poolStore.nodes, ledger, {
        canBind: (port) => peering.canBindReversePort(port, deps.createServerImpl),
      });
      ledger = reversePool.appendLedger(ledger, { type: 'allocated', base: allocation.base });
      reversePool.atomicWriteLedger(reversePoolLedgerPath, ledger);
      poolStore = nodesStore.atomicWriteStore(nodesPath, {
        ...poolStore,
        reversePoolAnchor: reversePool.ledgerHead(ledger),
      });
      const reversePort = allocation.base;
      const assignedPool = nodesStore.reversePoolDefault(reversePort);
      credential = peering.createPending({ pendingPath, data: {
        name, remotePort: b.port, reversePort, reversePool: assignedPool, instanceId: b.instanceId, acceptToken: b.acceptToken,
        shared: false,
        label: nodesStore.sanitizeLabel(b.label, name),
        // La pubblica del peer, se la manda. Un peer piu' vecchio non la manda
        // e si accoppia come sempre: il passo 1 osserva, non pretende.
        ...(identity.isPublicKey(b.publicKey) ? { publicKey: b.publicKey } : {}),
        ...(peerRoles ? { roles: { ...peerRoles, node: false }, rolesKnown: true } : { rolesKnown: false }),
      } });
      if (!peering.consumeInvite({ invitesPath, invite: b.invite, now })) {
        peering.consumePending({ pendingPath, credential, now });
        return res.status(410).json({ error: 'invito scaduto o gia usato' });
      }
      const mia = localPublicKey();
      res.json({ paired: true, instanceId: poolStore.nodeId, reversePort,
        reversePool: { base: assignedPool.base, slots: assignedPool.slots.map((slot) => slot.port) },
        credential, roles: readRoles(configPath),
        // Lo scambio e' simmetrico e avviene QUI, dentro l'atto che consuma
        // l'invito monouso: e' il solo momento in cui l'operatore ha deciso,
        // su entrambe le macchine, che questi due nodi si conoscono.
        ...(mia ? { publicKey: mia } : {}) });
    } catch (e) {
      if (credential) try { peering.consumePending({ pendingPath, credential, now }); } catch (_) {}
      res.status(e.status || 500).json({ error: String(e.message || e), ...(e.code ? { code: e.code } : {}) });
    }
  });
  r.post('/confirm', (req, res) => {
    const b = req.body || {};
    if (!nodesStore.validToken(b.credential)) return res.status(400).json({ error: 'confirm non valido' });
    const pending = peering.consumePending({ pendingPath, credential: b.credential });
    if (!pending) {
      const st = nodesStore.loadStore(nodesPath);
      if (st && st.nodes.some((n) => n.acceptToken && peering.safeEqual(n.acceptToken, b.credential))) return res.json({ confirmed: true, idempotent: true });
      return res.status(410).json({ error: 'pairing pending scaduto o gia usato' });
    }
    try {
      let st = nodesStore.loadStoreStrict(nodesPath);
      if (st.nodeId === pending.instanceId || st.nodes.some((n) => n.nodeId === pending.instanceId)) return res.status(409).json({ error: 'peer duplicato' });
      if (st.nodes.some((n) => n.name === pending.name || n.localPort === pending.reversePort)) {
        return res.status(409).json({
          error: 'allocazione pairing non piu disponibile',
          code: 'pairing-allocation-conflict',
          hint: 'ripeti il pairing: verra negoziata una nuova porta reverse',
        });
      }
      st = nodesStore.addNode(st, {
        name: pending.name, remotePort: pending.remotePort, localPort: pending.reversePort,
        direction: 'inbound', transport: 'inbound', autostart: true,
        visibility: 'network', shared: pending.shared === true, nodeId: pending.instanceId,
        token: pending.acceptToken, acceptToken: b.credential,
        // Legata al pairing, non asserita: e' `keySource` a dire la differenza,
        // e al passo 3 un grant potra' pretendere questa e non l'altra.
        ...(identity.isPublicKey(pending.publicKey)
          ? { publicKey: pending.publicKey, keySource: 'pairing', keyBoundAt: new Date().toISOString() }
          : {}),
        ...(pending.roles ? { roles: pending.roles } : {}),
        rolesKnown: pending.rolesKnown === true,
        ...(pending.label ? { label: pending.label } : {}),
        ...(pending.reversePool ? { reversePool: pending.reversePool } : {}),
      });
      nodesStore.atomicWriteStore(nodesPath, st);
      res.json({ confirmed: true });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e), ...(e.code ? { code: e.code } : {}) }); }
  });
  r.post('/cancel', (req, res) => {
    const b = req.body || {};
    if (!nodesStore.NODE_ID_RE.test(b.instanceId) || !nodesStore.validToken(b.credential)) return res.status(400).json({ error: 'cancel non valido' });
    try {
      const pending = peering.consumePending({ pendingPath, credential: b.credential });
      if (!pending || pending.instanceId !== b.instanceId) {
        const st = nodesStore.loadStore(nodesPath);
        const peer = st && st.nodes.find((n) => n.nodeId === b.instanceId && n.acceptToken && peering.safeEqual(n.acceptToken, b.credential));
        if (!peer) return res.status(404).json({ error: 'pair non trovato' });
        nodesStore.atomicWriteStore(nodesPath, nodesStore.removeNode(st, peer.name));
      }
      res.json({ cancelled: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  return r;
}

module.exports = { publicPeeringRoutes };
