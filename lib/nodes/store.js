'use strict';
// lib/nodes/store.js — nodes.json secret store (design §4, §4b(4)).
//
// nodes.json e' un SECRET STORE, non config qualunque: contiene i token dei nodi
// remoti (iniettati dal proxy in B1). Percio' riusa lo stesso hardening di
// lib/fleet/definitions.js e del token file:
//   - permessi 0600, scrittura atomica (tmp stessa dir + rename), rifiuto symlink
//   - schema STRICT validato al load: garbage -> errore esplicito, MAI guess
//   - nessun token in output redatto (redactStore/redactNode)
//
// Modulo PURO al parse: parseStore/parseNode non toccano il filesystem.
// Tutto l'I/O vive in loadStore/loadStoreStrict/initStore/atomicWriteStore/
// migrateLegacyNodes.
// Principio fail-closed: qualunque dato malformato -> null (parse) o throw
// esplicito (mutazioni/write), mai un default silenzioso.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const reversePool = require('./reverse-pool.js');
const identity = require('./identity.js');

const SCHEMA_VERSION = 3;
const PREVIOUS_SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const MAX_NODES = 64;
const MAX_TOKEN_LEN = 4096;
const MAX_KEYPATH_LEN = 4096;
const MAX_SSH_LEN = 320;          // user(<=32) + '@' + host(<=255)

// name: chiave strict usata anche come segmento path/route in B1 -> niente '.',
// '/', maiuscole. Allineato al contratto §4b(2) (^[a-z0-9-]{1,32}$).
const NODE_NAME_RE = /^[a-z0-9-]{1,32}$/;
// nodeId: id stabile per-installazione, hex casuale (crypto.randomBytes(16)).
const NODE_ID_RE = /^[a-f0-9]{16,64}$/;
// user@host: entrambe le parti argv-safe (no spazi, no leading '-' -> mai
// interpretabile come opzione ssh). Host: hostname/FQDN/IPv4 (niente ':' -> IPv6
// va usato via Host alias in ~/.ssh/config, fuori scope B0).
const SSH_USER_RE = /^[A-Za-z0-9._-]{1,32}$/;
const SSH_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

const PORT_MIN = 1;
const PORT_MAX = 65535;

function isPort(n) {
  return Number.isInteger(n) && n >= PORT_MIN && n <= PORT_MAX;
}

// user@host -> {user, host, value} | null. Strict: no whitespace/null, host non
// inizia con '-' (garanzia argv-safe, non diventa mai un flag ssh).
function parseSsh(s) {
  if (typeof s !== 'string' || !s || s.length > MAX_SSH_LEN) return null;
  if (s.includes('\0') || /\s/.test(s)) return null;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return null; // esattamente un '@'
  const user = s.slice(0, at);
  const host = s.slice(at + 1);
  if (!SSH_USER_RE.test(user) || !SSH_HOST_RE.test(host)) return null;
  return { user, host, value: `${user}@${host}` };
}

// OpenSSH target/Host alias. It is passed as one argv item (never through a
// shell), therefore the safety boundary is: non-empty, no whitespace/control
// characters and no leading '-'. user@host remains accepted as a subset.
function parseSshTarget(s) {
  if (typeof s !== 'string' || !s || s.length > MAX_SSH_LEN) return null;
  if (s.startsWith('-') || /[\0-\x20\x7f]/.test(s)) return null;
  if (s.includes('@')) return parseSsh(s);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(s)) return null;
  return { value: s };
}

// keyPath: path assoluto, no null/newline (la chiave potrebbe non esistere ancora
// al momento dell'add: viene generata dopo). L'esistenza si verifica al lancio ssh.
function isAbsPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_KEYPATH_LEN
    && !p.includes('\0') && !/[\n\r]/.test(p) && path.isAbsolute(p);
}

// token remoto: segreto opaco, single-line, cap. Vuoto -> assente (non salvato).
// Charset ristretto a header-safe (VCHAR + spazio/tab): il token viene iniettato
// in `Authorization: Bearer <t>` verso l'upstream; un char fuori range farebbe
// lanciare setHeader in modo sincrono (ERR_INVALID_CHAR). (hardening audit).
function validToken(t) {
  return typeof t === 'string' && t.length > 0 && t.length <= MAX_TOKEN_LEN
    && /^[\x20-\x7e\t]+$/.test(t);
}

// roles per-nodo (default {client:true, node:false}): STRICT, nessuna chiave extra.
function parseRoles(r) {
  if (r === undefined) return { client: true, node: false };
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  for (const k of Object.keys(r)) { if (k !== 'client' && k !== 'node') return null; }
  const client = r.client === undefined ? true : r.client;
  const node = r.node === undefined ? false : r.node;
  if (typeof client !== 'boolean' || typeof node !== 'boolean') return null;
  return { client, node };
}

// label: etichetta umana opzionale per il display (1-64 char visibili, no control).
// NON e' lo slug di routing: puo' contenere maiuscole, spazi, punteggiatura. Il name
// resta l'identita' tecnica (segmento path/route); la label e' solo come l'utente la
// vede. Backward-compatible: record esistenti senza label -> fallback a `name`.
const LABEL_MAX = 64;

// parseNode(n) -> nodo normalizzato | null (fail-closed). Nessun campo extra
// tollerato oltre a quelli noti (schema chiuso: garbage -> null, non guess).
const NODE_KEYS = new Set([
  'name', 'ssh', 'sshPort', 'remotePort', 'localPort', 'keyPath', 'identityFile',
  'roles', 'rolesKnown', 'token', 'acceptToken', 'nodeId', 'transport', 'autostart', 'visibility', 'selected',
  'direction', 'reversePort', 'shared', 'label', 'reversePool',
  // Quali CELLE di questo nodo il peer puo' vedere. Distinto da `visibility`,
  // che governa il TRANSITO (attraverso chi passa il traffico) e non l'accesso.
  'cellVisibility', 'cells',
  // Se questo peer puo' aprire i PANNELLI delle celle di questo nodo. Distinto
  // da `cellVisibility`, che dice quali celle il peer VEDE: dietro un pannello
  // c'e' un browser con sessioni gia' autenticate, e un accesso di quel tipo non
  // si revoca cambiando una chiave. Il resto del modello tratta un peer pairato
  // come l'operatore stesso; qui no, e di proposito: default NEGATO, si concede
  // per singolo nodo.
  'panelAccess',
  // Identita' crittografica del peer — passo 1 del modello di autorita'. Oggi
  // NON governa niente: si osserva e si registra. `keySource` distingue una
  // chiave legata al pairing (nello stesso atto in cui si e' deciso di fidarsi)
  // da una arrivata dopo su un canale che il peer controlla; al passo 3 un
  // grant potra' pretendere la prima. `keyConflict` conserva una chiave DIVERSA
  // vista dopo il legame, senza sostituire quella legata.
  'publicKey', 'keySource', 'keyBoundAt', 'keyConflict',
]);

// Nome di cella: stessa forma usata da fleet/definitions.js, cells/routes.js e
// mcp/cells.js. E' `cell` la chiave del permesso — unica nel nodo e immutabile —
// non `tmuxSession`, che e' derivata e ammette override non canonici.
const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MAX_CELLS = 128;

// Un conflitto di chiave e' un record chiuso: cosa e' arrivato, quando, da dove.
const KEY_CONFLICT_KEYS = new Set(['seen', 'at', 'source']);

const REVERSE_POOL_SLOT_STATES = new Set(['active', 'ready', 'reserved', 'draining', 'quarantined', 'retired']);
const REVERSE_POOL_VERIFICATIONS = new Set(['verified', 'unverifiable', 'missing', 'invalidated']);
const REVERSE_POOL_PHASES = new Set(['active', 'prepared', 'switched', 'abandoned']);

function parseReversePool(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !['base', 'slots', 'activeSlot', 'activeGeneration', 'verification', 'verifiedSlots', 'rotation', 'lastAutoRotationAt'].includes(key))) return null;
  const ports = reversePool.reversePoolForBase(value.base);
  if (!ports || !Array.isArray(value.slots) || value.slots.length !== ports.length
    || !Number.isInteger(value.activeSlot) || value.activeSlot < 0 || value.activeSlot >= ports.length
    || !Number.isSafeInteger(value.activeGeneration) || value.activeGeneration < 1
    || !REVERSE_POOL_VERIFICATIONS.has(value.verification)) return null;
  if (value.lastAutoRotationAt !== undefined && (!Number.isSafeInteger(value.lastAutoRotationAt) || value.lastAutoRotationAt < 0)) return null;
  const verifiedSlots = value.verifiedSlots === undefined ? [] : value.verifiedSlots;
  if (!Array.isArray(verifiedSlots) || verifiedSlots.length > ports.length
    || new Set(verifiedSlots).size !== verifiedSlots.length
    || verifiedSlots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot >= ports.length)) return null;
  if (value.verification === 'verified' && verifiedSlots.length !== ports.length) return null;
  const slots = value.slots.map((slot, index) => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot) || Object.keys(slot).some((key) => !['port', 'state', 'generation'].includes(key))) return null;
    if (slot.port !== ports[index] || !REVERSE_POOL_SLOT_STATES.has(slot.state)
      || !Number.isSafeInteger(slot.generation) || slot.generation < 1) return null;
    return { port: slot.port, state: slot.state, generation: slot.generation };
  });
  if (slots.some((slot) => !slot) || slots[value.activeSlot].state !== 'active'
    || slots[value.activeSlot].generation !== value.activeGeneration) return null;
  let rotation = { phase: 'active', generation: value.activeGeneration, slot: value.activeSlot };
  if (value.rotation !== undefined) {
    const r = value.rotation;
    if (!r || typeof r !== 'object' || Array.isArray(r)
      || Object.keys(r).some((key) => !['phase', 'generation', 'slot', 'leaseId', 'expiresAt', 'oldSlot', 'oldGeneration', 'graceUntil'].includes(key))
      || !REVERSE_POOL_PHASES.has(r.phase) || !Number.isSafeInteger(r.generation) || r.generation < 1
      || !Number.isInteger(r.slot) || r.slot < 0 || r.slot >= ports.length) return null;
    if (r.phase === 'prepared') {
      if (typeof r.leaseId !== 'string' || !/^[a-f0-9]{32,64}$/.test(r.leaseId)
        || !Number.isSafeInteger(r.expiresAt) || r.expiresAt < 0) return null;
    } else if (r.phase === 'switched') {
      if (!Number.isInteger(r.oldSlot) || r.oldSlot < 0 || r.oldSlot >= ports.length || r.oldSlot === r.slot
        || !Number.isSafeInteger(r.oldGeneration) || r.oldGeneration < 1
        || !Number.isSafeInteger(r.graceUntil) || r.graceUntil < 0
        || r.leaseId !== undefined || r.expiresAt !== undefined) return null;
    } else if (r.leaseId !== undefined || r.expiresAt !== undefined || r.oldSlot !== undefined
      || r.oldGeneration !== undefined || r.graceUntil !== undefined) return null;
    rotation = { phase: r.phase, generation: r.generation, slot: r.slot,
      ...(r.phase === 'prepared' ? { leaseId: r.leaseId, expiresAt: r.expiresAt } : {}),
      ...(r.phase === 'switched' ? { oldSlot: r.oldSlot, oldGeneration: r.oldGeneration, graceUntil: r.graceUntil } : {}) };
  }
  return {
    base: value.base,
    slots,
    activeSlot: value.activeSlot,
    activeGeneration: value.activeGeneration,
    verification: value.verification,
    verifiedSlots: [...verifiedSlots].sort((a, b) => a - b),
    rotation,
    ...(value.lastAutoRotationAt === undefined ? {} : { lastAutoRotationAt: value.lastAutoRotationAt }),
  };
}

function parseReversePoolAnchor(value) {
  return reversePool.parseAnchor(value);
}

function reversePoolDefault(base, { verification = 'unverifiable', generation = 1 } = {}) {
  const ports = reversePool.reversePoolForBase(base);
  if (!ports || !REVERSE_POOL_VERIFICATIONS.has(verification) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('reverse pool non valida');
  }
  return {
    base,
    slots: ports.map((port, index) => ({ port, state: index === 0 ? 'active' : 'ready', generation })),
    activeSlot: 0,
    activeGeneration: generation,
    verification,
    verifiedSlots: verification === 'verified' ? ports.map((_, index) => index) : [],
    rotation: { phase: 'active', generation, slot: 0 },
  };
}

function parseNode(n, schemaVersion = SCHEMA_VERSION) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  for (const k of Object.keys(n)) { if (!NODE_KEYS.has(k)) return null; } // schema chiuso
  if (typeof n.name !== 'string' || !NODE_NAME_RE.test(n.name)) return null;
  const direction = n.direction || 'outbound';
  if (!['outbound', 'inbound'].includes(direction)) return null;
  const ssh = n.ssh === undefined && direction === 'inbound' ? null
    : (schemaVersion === LEGACY_SCHEMA_VERSION ? parseSsh(n.ssh) : parseSshTarget(n.ssh));
  if (direction === 'outbound' && !ssh) return null;
  if (n.sshPort !== undefined && !isPort(n.sshPort)) return null;
  if (!isPort(n.remotePort)) return null;
  if (!isPort(n.localPort)) return null;
  const identityFile = n.identityFile || n.keyPath;
  if (identityFile !== undefined && !isAbsPath(identityFile)) return null;
  if (schemaVersion === LEGACY_SCHEMA_VERSION && !identityFile) return null;
  const roles = parseRoles(n.roles);
  if (!roles) return null;
  if (n.rolesKnown !== undefined && typeof n.rolesKnown !== 'boolean') return null;
  // Before 0.8.9 `roles` was filled with a local default and did not describe
  // the remote peer. Only the explicit marker makes role-based health safe.
  const rolesKnown = n.rolesKnown === true;
  // label (display) opzionale ma, se presente, strict: stringa 1..LABEL_MAX, no
  // control char (newline/tab inclusi: una label su piu' righe non ha senso in
  // UI), no solo-spazi. Garbage -> null (schema chiuso), mai guess/truncate.
  let label = null;
  if (n.label !== undefined) {
    if (typeof n.label !== 'string') return null;
    label = n.label.trim();
    if (!label || label.length > LABEL_MAX) return null;
    if (/[\x00-\x1f\x7f]/.test(label)) return null;
  }

  const out = {
    name: n.name,
    ...(ssh ? { ssh: ssh.value } : {}),
    remotePort: n.remotePort,
    localPort: n.localPort,
    roles,
    rolesKnown,
    direction,
    transport: n.transport || (direction === 'inbound' ? 'inbound' : (schemaVersion === LEGACY_SCHEMA_VERSION ? 'ssh' : 'auto')),
    autostart: n.autostart === undefined ? schemaVersion !== LEGACY_SCHEMA_VERSION : n.autostart,
    // A paired device is private by default. `shared` only controls whether the
    // hub may advertise/route this peer and whether the outbound SSH session
    // requests the optional reverse (-R) channel. Old stores therefore migrate
    // safely to private without a schema bump.
    shared: n.shared === undefined ? false : n.shared,
    // Default negato: un record esistente, scritto quando questo campo non
    // c'era, NON acquisisce l'accesso ai pannelli per il fatto di essere gia'
    // pairato. Migrazione silenziosa verso il permesso e' esattamente cio' che
    // non deve succedere.
    panelAccess: n.panelAccess === undefined ? false : n.panelAccess,
    visibility: n.visibility || 'network',
  };
  if (!['auto', 'ssh', 'autossh', 'inbound'].includes(out.transport)) return null;
  if (direction === 'inbound' && out.transport !== 'inbound') return null;
  if (direction === 'outbound' && out.transport === 'inbound') return null;
  if (typeof out.autostart !== 'boolean') return null;
  if (typeof out.shared !== 'boolean') return null;
  if (typeof out.panelAccess !== 'boolean') return null;
  if (!['network', 'relay-only', 'selected'].includes(out.visibility)) return null;
  if (identityFile) out.identityFile = identityFile;
  // Keep the old public field while reading v1 so old callers/tests and a
  // running 0.8.1 service can coexist during the atomic upgrade.
  if (n.keyPath) out.keyPath = n.keyPath;
  if (n.reversePort !== undefined) {
    if (!isPort(n.reversePort)) return null;
    out.reversePort = n.reversePort;
  }
  if (n.reversePool !== undefined) {
    if (schemaVersion < SCHEMA_VERSION) return null;
    const parsedPool = parseReversePool(n.reversePool);
    if (!parsedPool) return null;
    out.reversePool = parsedPool;
  }
  if (n.selected !== undefined) {
    if (!Array.isArray(n.selected) || n.selected.length > MAX_NODES) return null;
    const selected = [...new Set(n.selected)];
    if (selected.some((id) => typeof id !== 'string' || !NODE_ID_RE.test(id))) return null;
    out.selected = selected;
  }
  // Scope celle. Il default e' `all` quando il campo e' ASSENTE: un default
  // fail-closed renderebbe muta l'intera flotta al primo aggiornamento, senza
  // che nessuno abbia deciso nulla. Restringere deve restare un atto esplicito.
  // `selected` con lista vuota significa invece "nessuna cella", ed e' proprio
  // per distinguerlo da "campo assente" che la modalita' e' un campo a parte.
  if (n.cellVisibility !== undefined) {
    if (!['all', 'none', 'selected'].includes(n.cellVisibility)) return null;
    out.cellVisibility = n.cellVisibility;
  } else {
    out.cellVisibility = 'all';
  }
  if (n.cells !== undefined) {
    // Elencare celle senza dichiarare la modalita' e' ambiguo: l'elenco
    // sembrerebbe un permesso mentre non lo e'. Meglio rifiutare che indovinare.
    if (out.cellVisibility !== 'selected') return null;
    if (!Array.isArray(n.cells) || n.cells.length > MAX_CELLS) return null;
    const cells = [...new Set(n.cells)];
    if (cells.some((id) => typeof id !== 'string' || !CELL_ID_RE.test(id))) return null;
    out.cells = cells;
  } else if (out.cellVisibility === 'selected') {
    out.cells = [];
  }
  // Campo opzionale per compatibilita' con gli store 0.8.0: se assente, ssh
  // continua a usare la porta risolta da ~/.ssh/config o il default OpenSSH.
  if (n.sshPort !== undefined) out.sshPort = n.sshPort;
  if (n.token !== undefined) {
    if (!validToken(n.token)) return null;
    out.token = n.token;
  }
  if (n.acceptToken !== undefined) {
    if (!validToken(n.acceptToken)) return null;
    out.acceptToken = n.acceptToken;
  }
  if (n.nodeId !== undefined) {
    if (typeof n.nodeId !== 'string' || !NODE_ID_RE.test(n.nodeId)) return null;
    out.nodeId = n.nodeId;
  }
  // Identita' del peer. Schema chiuso come il resto: una chiave malformata e'
  // un record rifiutato, non una chiave "quasi buona" che qualcuno confrontera'
  // piu' tardi credendola valida.
  if (n.publicKey !== undefined) {
    if (!identity.isPublicKey(n.publicKey)) return null;
    out.publicKey = n.publicKey;
  }
  if (n.keySource !== undefined) {
    // Solo due provenienze, perche' e' la distinzione che serve al passo 3.
    // Un terzo valore inventato passerebbe i confronti e non significherebbe
    // niente.
    if (n.keySource !== 'pairing' && n.keySource !== 'peer-assertion') return null;
    if (out.publicKey === undefined) return null; // provenienza senza chiave: incoerente
    out.keySource = n.keySource;
  }
  if (n.keyBoundAt !== undefined) {
    if (typeof n.keyBoundAt !== 'string' || Number.isNaN(Date.parse(n.keyBoundAt))) return null;
    if (out.publicKey === undefined) return null;
    out.keyBoundAt = n.keyBoundAt;
  }
  if (n.keyConflict !== undefined) {
    const c = n.keyConflict;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    for (const k of Object.keys(c)) { if (!KEY_CONFLICT_KEYS.has(k)) return null; }
    if (!identity.isPublicKey(c.seen)) return null;
    if (typeof c.at !== 'string' || Number.isNaN(Date.parse(c.at))) return null;
    if (c.source !== 'pairing' && c.source !== 'peer-assertion') return null;
    // Un conflitto senza chiave legata non e' un conflitto: e' la prima
    // osservazione, e va scritta come tale.
    if (out.publicKey === undefined) return null;
    out.keyConflict = { seen: c.seen, at: c.at, source: c.source };
  }
  if (label) out.label = label;
  return out;
}

// Legacy rendezvous record: read-only migration data from pre-0.8.10. It is
// parsed so an existing store remains loadable, but no new runtime path writes
// or starts it.
const RDV_KEYS = new Set(['ssh', 'publishedPort', 'localPort', 'keyPath']);
function parseRendezvous(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  for (const k of Object.keys(r)) { if (!RDV_KEYS.has(k)) return null; }
  const ssh = parseSsh(r.ssh);
  if (!ssh) return null;
  if (!isPort(r.publishedPort)) return null;
  if (!isPort(r.localPort)) return null;
  if (!isAbsPath(r.keyPath)) return null;
  return { ssh: ssh.value, publishedPort: r.publishedPort, localPort: r.localPort, keyPath: r.keyPath };
}

// parseStore(raw) -> store normalizzato | null. Accetta stringa JSON o oggetto.
function parseStore(raw) {
  try {
    let d;
    if (typeof raw === 'string') {
      try { d = JSON.parse(raw); } catch (_) { return null; }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      d = raw;
    } else {
      return null;
    }

    if (![SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION].includes(d.schemaVersion)) return null;
    const rootKeys = d.schemaVersion === SCHEMA_VERSION
      ? new Set(['schemaVersion', 'nodeId', 'nodes', 'rendezvous', 'reversePoolAnchor', 'reversePoolLedgerInitialized'])
      : new Set(['schemaVersion', 'nodeId', 'nodes', 'rendezvous']);
    if (Object.keys(d).some((key) => !rootKeys.has(key))) return null;
    if (typeof d.nodeId !== 'string' || !NODE_ID_RE.test(d.nodeId)) return null;
    if (!Array.isArray(d.nodes) || d.nodes.length > MAX_NODES) return null;

    const names = new Set();
    const ids = new Set();
    const localPorts = new Set();
    const nodes = [];
    for (const raw2 of d.nodes) {
      const node = parseNode(raw2, d.schemaVersion);
      if (!node) return null;
      if (names.has(node.name)) return null;             // name univoco
      names.add(node.name);
      if (localPorts.has(node.localPort)) return null;   // ogni listener locale ha un solo owner
      localPorts.add(node.localPort);
      if (node.nodeId) {
        if (node.nodeId === d.nodeId) return null;        // self-reference nei dati salvati
        if (ids.has(node.nodeId)) return null;            // nodeId remoto univoco
        ids.add(node.nodeId);
      }
      nodes.push(node);
    }

    const out = { schemaVersion: d.schemaVersion, nodeId: d.nodeId, nodes };

    if (d.rendezvous !== undefined && d.rendezvous !== null) {
      const rdv = parseRendezvous(d.rendezvous);
      if (!rdv) return null;
      out.rendezvous = rdv;
    }
    if (d.schemaVersion === SCHEMA_VERSION) {
      // This marker distinguishes a fresh v3 peer (which may have received a
      // pool from another hub) from a hub that has once owned allocations. If
      // the latter loses its anchor, it must not silently start a new ledger.
      if (d.reversePoolLedgerInitialized !== undefined && d.reversePoolLedgerInitialized !== true) return null;
      if (d.reversePoolLedgerInitialized === true) out.reversePoolLedgerInitialized = true;
      if (d.reversePoolAnchor !== undefined) {
        if (d.reversePoolLedgerInitialized !== true) return null;
        const anchor = parseReversePoolAnchor(d.reversePoolAnchor);
        if (!anchor) return null;
        out.reversePoolAnchor = anchor;
      }
      // The allocator and monotonic ledger live on the hub, which owns inbound
      // peers.  An outbound peer persists the pool negotiated by that hub but
      // must not invent a second local allocation ledger for it.
      if (nodes.some((node) => node.direction === 'inbound' && node.reversePool)
        && (!out.reversePoolAnchor || d.reversePoolLedgerInitialized !== true)) return null;
    }
    return out;
  } catch (_) {
    return null; // fail-closed: qualunque eccezione inattesa -> null, MAI throw
  }
}

// --- I/O -------------------------------------------------------------------

function defaultNodesPath(home) {
  return path.join(home || os.homedir(), '.nexuscrew', 'nodes.json');
}

// loadStore(p): legge rifiutando i symlink; parse strict. null se assente/invalido.
function loadStore(p) {
  try {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return null; } // missing -> null
    if (st.isSymbolicLink()) return null;                    // no symlink
    if (!st.isFile()) return null;
    return parseStore(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

// atomicWriteStore(p, data): valida PRIMA di scrivere (fail-closed). Rifiuta di
// scrivere attraverso un symlink. tmp stessa dir -> chmod 0600 -> rename atomico.
function atomicWriteStore(p, data) {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) {
      throw new Error('refuse to write: nodes.json target e\' un symlink');
    }
  } catch (e) {
    if (e.code === 'ENOENT') { /* nuovo file, ok */ }
    else throw e; // inclusi i nostri 'refuse to write'
  }

  const parsed = parseStore(data);
  if (!parsed) throw new Error('nodes.json non valido: validazione fallita (schema strict)');

  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // forza 0600 a prescindere da umask
    fs.renameSync(tmp, p);    // atomico sullo stesso filesystem
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* cleanup best-effort */ }
    throw e;
  }
  return parsed;
}

function newNodeId() { return crypto.randomBytes(16).toString('hex'); }

function emptyStore(nodeId) {
  return { schemaVersion: SCHEMA_VERSION, nodeId: nodeId || newNodeId(), nodes: [] };
}

function storeUnavailable(code, message) {
  const e = new Error(message);
  e.status = 503;
  e.code = code;
  return e;
}

// Runtime strict: nodes.json e' identita' + credential store. Se sparisce non
// deve MAI essere rigenerato implicitamente da una route/command: un nuovo
// nodeId farebbe apparire l'installazione come un altro dispositivo e
// maschererebbe una perdita di stato. Solo `nexuscrew init` usa initStore().
function loadStoreStrict(p) {
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) {
    if (e.code === 'ENOENT') {
      throw storeUnavailable('NODES_STORE_MISSING',
        `nodes.json assente (${p}): esegui \`nexuscrew init\` per inizializzare esplicitamente lo store`);
    }
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw storeUnavailable('NODES_STORE_INVALID', 'nodes.json e\' un symlink (rifiutato)');
  }
  if (!st.isFile()) {
    throw storeUnavailable('NODES_STORE_INVALID', 'nodes.json non e\' un file regolare');
  }
  const parsed = loadStore(p);
  if (!parsed) {
    throw storeUnavailable('NODES_STORE_INVALID',
      'nodes.json presente ma invalido (schema strict): ripristina un backup valido; non viene sovrascritto');
  }
  return parsed;
}

// Init esplicito e idempotente. E' l'unico percorso autorizzato a creare uno
// store mancante; un file presente ma invalido resta fail-closed.
function initStore(p) {
  try { fs.lstatSync(p); }
  catch (e) {
    if (e.code === 'ENOENT') return atomicWriteStore(p, emptyStore());
    throw e;
  }
  return loadStoreStrict(p);
}

// Compatibilita' API interna: il vecchio nome non inizializza piu' a runtime.
// Tenerlo strict impedisce che un call-site dimenticato reintroduca F1.
function loadOrInitStore(p) { return loadStoreStrict(p); }

// --- Mutazioni pure (ritornano un nuovo store; il caller lo scrive) ---------

function getNode(store, name) {
  return store.nodes.find((n) => n.name === name) || null;
}

function mutationSchemaVersion(store) {
  return store && store.schemaVersion === SCHEMA_VERSION ? SCHEMA_VERSION : PREVIOUS_SCHEMA_VERSION;
}

function addNode(store, entry) {
  const node = parseNode(entry, mutationSchemaVersion(store));
  if (!node) throw new Error('nodo non valido (schema strict): controlla name/ssh/remotePort/localPort');
  if (store.nodes.some((n) => n.name === node.name)) {
    throw new Error(`nodo duplicato: name "${node.name}" gia' presente`);
  }
  if (store.nodes.some((n) => n.localPort === node.localPort)) {
    throw new Error(`nodo duplicato: localPort ${node.localPort} gia' assegnata`);
  }
  if (node.nodeId) {
    if (node.nodeId === store.nodeId) throw new Error('self-reference: il nodeId coincide con questa installazione');
    if (store.nodes.some((n) => n.nodeId === node.nodeId)) {
      throw new Error(`nodo duplicato: nodeId "${node.nodeId}" gia' presente`);
    }
  }
  return { ...store, schemaVersion: mutationSchemaVersion(store), nodes: store.nodes.concat([node]) };
}

function removeNode(store, name) {
  const idx = store.nodes.findIndex((n) => n.name === name);
  if (idx < 0) throw new Error(`nodo sconosciuto: "${name}"`);
  const nodes = store.nodes.slice();
  nodes.splice(idx, 1);
  return { ...store, schemaVersion: mutationSchemaVersion(store), nodes };
}

function setNodeToken(store, name, token) {
  const idx = store.nodes.findIndex((n) => n.name === name);
  if (idx < 0) throw new Error(`nodo sconosciuto: "${name}"`);
  if (!validToken(token)) throw new Error('token non valido (vuoto, multilinea o troppo lungo)');
  const nodes = store.nodes.slice();
  nodes[idx] = { ...nodes[idx], token };
  return { ...store, schemaVersion: mutationSchemaVersion(store), nodes };
}

function updateNode(store, name, patch) {
  const idx = store.nodes.findIndex((n) => n.name === name);
  if (idx < 0) throw new Error(`nodo sconosciuto: "${name}"`);
  const parsed = parseNode({ ...store.nodes[idx], ...patch }, mutationSchemaVersion(store));
  if (!parsed) throw new Error('aggiornamento nodo non valido');
  const nodes = store.nodes.slice();
  nodes[idx] = parsed;
  return { ...store, schemaVersion: mutationSchemaVersion(store), nodes };
}

// The upgrade is explicit: normal legacy pairing remains schema v2 and keeps
// working with a previous NexusCrew binary.  Enabling rotation is the only
// path that writes the v3 anchor and therefore requires both peers to support
// the capability.
function upgradeToReversePoolSchema(store, anchor = undefined) {
  const current = parseStore(store);
  if (!current) throw new Error('nodes store non valido');
  const parsedAnchor = anchor === undefined ? null : parseReversePoolAnchor(anchor);
  if (anchor !== undefined && !parsedAnchor) throw new Error('reverse pool anchor non valida');
  const next = {
    ...current,
    schemaVersion: SCHEMA_VERSION,
    ...(parsedAnchor ? { reversePoolLedgerInitialized: true, reversePoolAnchor: parsedAnchor } : {}),
  };
  const parsed = parseStore(next);
  if (!parsed) throw new Error('upgrade reverse pool non valido');
  return parsed;
}

function setNodeReversePool(store, name, value) {
  const current = store && getNode(store, name);
  if (!store || store.schemaVersion !== SCHEMA_VERSION || !current) {
    throw new Error('reverse pool richiede schema v3');
  }
  if (current.direction === 'inbound' && !parseReversePoolAnchor(store.reversePoolAnchor)) {
    throw new Error('reverse pool inbound richiede anchor valida');
  }
  return updateNode(store, name, { reversePool: value });
}

// --- Redazione (view sicura per status/list: MAI il token) ------------------

function redactNode(n) {
  const out = {
    name: n.name,
    ...(n.label ? { label: n.label } : {}),
    ...(n.ssh ? { ssh: n.ssh } : {}),
    remotePort: n.remotePort,
    localPort: n.localPort,
    direction: n.direction || 'outbound',
    roles: { ...n.roles },
    rolesKnown: n.rolesKnown === true,
    transport: n.transport || 'ssh',
    autostart: !!n.autostart,
    shared: n.shared === true,
    panelAccess: n.panelAccess === true,
    visibility: n.visibility || 'network',
    hasToken: !!n.token, // presenza, non il valore
    paired: !!(n.token && n.acceptToken),
  };
  if (n.identityFile || n.keyPath) out.hasIdentity = true;
  if (n.visibility === 'selected') out.selected = [...(n.selected || [])];
  // Lo scope celle non e' un segreto: e' una decisione dell'operatore e va
  // mostrata, come `selected`. La Settings UI deve poterla leggere per dirla.
  out.cellVisibility = n.cellVisibility || 'all';
  if (out.cellVisibility === 'selected') out.cells = [...(n.cells || [])];
  if (n.sshPort !== undefined) out.sshPort = n.sshPort;
  if (n.nodeId) out.nodeId = n.nodeId;
  // La pubblica di un peer NON e' un segreto: e' quella la cosa che va
  // confrontata, e nasconderla renderebbe impossibile accorgersi di un
  // conflitto guardando. Il conflitto viaggia con lei per la stessa ragione:
  // se si vede la chiave ma non che ne e' arrivata un'altra, la vista
  // rassicura invece di informare.
  if (n.publicKey) {
    out.publicKey = n.publicKey;
    out.keySource = n.keySource || 'peer-assertion';
    if (n.keyBoundAt) out.keyBoundAt = n.keyBoundAt;
    if (n.keyConflict) out.keyConflict = { ...n.keyConflict };
  }
  if (n.reversePool) {
    out.reversePool = {
      base: n.reversePool.base,
      slots: n.reversePool.slots.map((slot) => ({ ...slot })),
      activeSlot: n.reversePool.activeSlot,
      activeGeneration: n.reversePool.activeGeneration,
      verification: n.reversePool.verification,
      verifiedSlots: [...n.reversePool.verifiedSlots],
      rotation: { ...n.reversePool.rotation },
      ...(n.reversePool.lastAutoRotationAt === undefined ? {} : { lastAutoRotationAt: n.reversePool.lastAutoRotationAt }),
    };
  }
  return out;
}

function redactStore(store) {
  const out = {
    schemaVersion: store.schemaVersion,
    nodeId: store.nodeId,
    nodes: store.nodes.map(redactNode),
  };
  return out;
}

// A peer with both scoped credentials has completed pairing. Its advertised
// HTTP port is part of the established SSH/federation contract; silently
// moving that port would strand the peer even though the local PWA still works.
function hasPairedPeers(store) {
  return !!(store && Array.isArray(store.nodes)
    && store.nodes.some((node) => validToken(node.token) && validToken(node.acceptToken)));
}

// --- Migrazione esplicita da config.json (guarded, no-op se assente) ---------
// Se config.json contiene un array `nodes` legacy (vecchio formato pre-B0),
// lo importa in nodes.json. Guarded: no-op se config.json non ha `nodes`, o se
// nodes.json ha gia' dei nodi (mai overwrite). Strict: un nodo legacy malformato
// -> throw esplicito (non importa silenziosamente spazzatura).
function migrateLegacyNodes(configPath, nodesPath) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (_) { return { migrated: false, count: 0, reason: 'config.json assente/illeggibile' }; }
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.nodes) || cfg.nodes.length === 0) {
    return { migrated: false, count: 0, reason: 'nessun campo nodes legacy in config.json' };
  }
  const store = initStore(nodesPath);
  if (store.nodes.length > 0) {
    return { migrated: false, count: 0, reason: 'nodes.json gia\' popolato (no overwrite)' };
  }
  let next = store;
  for (const legacy of cfg.nodes) {
    next = addNode(next, legacy); // strict: garbage legacy -> throw esplicito
  }
  const written = atomicWriteStore(nodesPath, next);
  return { migrated: true, count: written.nodes.length, reason: 'migrato da config.json' };
}

// --- Label / slug helpers (display vs routing identity) ---------------------
// nodeLabel: etichetta umana di un nodo (display). Mai vuota: fallback a `name`.
function nodeLabel(n) {
  if (n && typeof n.label === 'string' && n.label.trim()) return n.label.trim();
  return (n && n.name) || '';
}

// validLabel: true se `v` e' una label display accettabile (stringa 1..LABEL_MAX,
// no control char, no solo-spazi). Riutilizzi la stessa logica strict di parseNode
// per validare input esterno (form UI, payload pairing) senza ricostruire un nodo.
function validLabel(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!t || t.length > LABEL_MAX) return false;
  return !/[\x00-\x1f\x7f]/.test(t);
}

// sanitizeLabel: normalizza un input libero in una label display valida. Trim,
// collapse spazi, tronca a LABEL_MAX. Mai throw, mai ritorna vuoto (fallback
// `fallback`). Usata dove si vuole proporre una label senza fallire.
function sanitizeLabel(v, fallback = 'NexusCrew') {
  const t = String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  return t || fallback;
}

// toSlug: deriva uno slug routing-safe (^[a-z0-9-]{1,32}$) da un input libero.
// Normalizza (NFKD + strip segni diacritici), lowercase, sostituisce run non
// alfanumerici con '-', trim dei bordi. Mai solleva: input povero -> 'node'.
// Usata dal form "Nuovo nodo" per suggerire lo slug dalla label umana senza
// obbligare l'utente a scrivere a mano caratteri tecnici.
function toSlug(input) {
  const s = String(input == null ? '' : input)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // segni diacritici staccati (combining) -> ASCII
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, ''); // trim finale dopo il slice
  return s || 'node';
}

// Handle tecnico locale proposto durante il pairing. L'identita' resta il
// nodeId; questo slug e' soltanto il segmento route leggibile visto dai peer.
// Il suffisso deriva dal nodeId stabile, quindi due Termux con hostname
// "localhost" ottengono handle diversi e ogni retry dello stesso device
// ripropone esattamente lo stesso valore (nessun random per tentativo).
function deriveNodeHandle(label, hostname, nodeId, existing = []) {
  const id = String(nodeId || '').toLowerCase();
  if (!NODE_ID_RE.test(id)) throw new Error('nodeId non valido per derivare il route handle');
  const used = new Set(Array.isArray(existing) ? existing.filter((x) => typeof x === 'string') : []);
  const readable = String(label || hostname || 'NexusCrew').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  let base = toSlug(readable);
  if (base === 'localhost' || base === 'node') base = 'nexuscrew';

  // Se il chiamante ripropone un handle gia' suffissato (es. dopo un 409),
  // evita di produrre asus-5bd6-5bd6 quando rigeneriamo un suffisso piu lungo.
  for (const length of [32, 24, 16, 12, 8, 6, 4]) {
    const suffix = `-${id.slice(0, length)}`;
    if (base.endsWith(suffix) && base.length > suffix.length) {
      base = base.slice(0, -suffix.length).replace(/-+$/g, '') || 'nexuscrew';
      break;
    }
  }

  const candidate = (suffix) => {
    const room = Math.max(1, 32 - suffix.length - 1);
    const prefix = base.slice(0, room).replace(/-+$/g, '') || 'n';
    return `${prefix}-${suffix}`;
  };
  for (const length of [4, 6, 8, 12, 16, 24]) {
    const value = candidate(id.slice(0, length));
    if (!used.has(value)) return value;
  }
  for (let n = 2; n < 100; n += 1) {
    const value = candidate(`${id.slice(0, 8)}-${n}`);
    if (!used.has(value)) return value;
  }
  throw new Error('nessun route handle univoco disponibile per nodeId');
}

// suggestNodeName: slug univoco dato un input libero e l'elenco dei name gia'
// usati. Disambigua con suffisso -2/-3/... Rende la creazione di un nodo non
// fallibile per collisione di slug (l'utente scrive "Home Relay" e ottiene
// "home-relay", oppure "home-relay-2" se esiste gia').
function suggestNodeName(input, existing = []) {
  const used = new Set(Array.isArray(existing) ? existing : []);
  const base = toSlug(input);
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base.slice(0, Math.max(1, 32 - String(i).length - 1))}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return base; // fallback estremo
}

module.exports = {
  // parse/validate
  parseStore, parseNode, parseRendezvous, parseRoles, parseSsh, parseSshTarget, isPort, isAbsPath, validToken,
  parseReversePool, parseReversePoolAnchor, reversePoolDefault,
  // I/O
  defaultNodesPath, loadStore, loadStoreStrict, initStore, atomicWriteStore, loadOrInitStore, emptyStore, newNodeId,
  // mutazioni
  getNode, addNode, removeNode, setNodeToken, updateNode, upgradeToReversePoolSchema, setNodeReversePool,
  // redazione
  redactNode, redactStore, hasPairedPeers,
  // migrazione
  migrateLegacyNodes,
  // label / slug
  nodeLabel, validLabel, sanitizeLabel, toSlug, deriveNodeHandle, suggestNodeName, LABEL_MAX,
  // costanti
  SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION, MAX_NODES, MAX_TOKEN_LEN, NODE_NAME_RE, NODE_ID_RE,
};
