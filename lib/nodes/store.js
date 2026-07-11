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
// Tutto l'I/O vive in loadStore/atomicWriteStore/loadOrInitStore/migrateLegacyNodes.
// Principio fail-closed: qualunque dato malformato -> null (parse) o throw
// esplicito (mutazioni/write), mai un default silenzioso.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
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

// parseNode(n) -> nodo normalizzato | null (fail-closed). Nessun campo extra
// tollerato oltre a quelli noti (schema chiuso: garbage -> null, non guess).
const NODE_KEYS = new Set(['name', 'ssh', 'remotePort', 'localPort', 'keyPath', 'roles', 'token', 'nodeId']);
function parseNode(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
  for (const k of Object.keys(n)) { if (!NODE_KEYS.has(k)) return null; } // schema chiuso
  if (typeof n.name !== 'string' || !NODE_NAME_RE.test(n.name)) return null;
  const ssh = parseSsh(n.ssh);
  if (!ssh) return null;
  if (!isPort(n.remotePort)) return null;
  if (!isPort(n.localPort)) return null;
  if (!isAbsPath(n.keyPath)) return null;
  const roles = parseRoles(n.roles);
  if (!roles) return null;

  const out = {
    name: n.name,
    ssh: ssh.value,
    remotePort: n.remotePort,
    localPort: n.localPort,
    keyPath: n.keyPath,
    roles,
  };
  if (n.token !== undefined) {
    if (!validToken(n.token)) return null;
    out.token = n.token;
  }
  if (n.nodeId !== undefined) {
    if (typeof n.nodeId !== 'string' || !NODE_ID_RE.test(n.nodeId)) return null;
    out.nodeId = n.nodeId;
  }
  return out;
}

// rendezvous (ruolo node/reverse): dove questa installazione si pubblica.
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

    if (d.schemaVersion !== SCHEMA_VERSION) return null;
    if (typeof d.nodeId !== 'string' || !NODE_ID_RE.test(d.nodeId)) return null;
    if (!Array.isArray(d.nodes) || d.nodes.length > MAX_NODES) return null;

    const names = new Set();
    const ids = new Set();
    const nodes = [];
    for (const raw2 of d.nodes) {
      const node = parseNode(raw2);
      if (!node) return null;
      if (names.has(node.name)) return null;             // name univoco
      names.add(node.name);
      if (node.nodeId) {
        if (node.nodeId === d.nodeId) return null;        // self-reference nei dati salvati
        if (ids.has(node.nodeId)) return null;            // nodeId remoto univoco
        ids.add(node.nodeId);
      }
      nodes.push(node);
    }

    const out = { schemaVersion: SCHEMA_VERSION, nodeId: d.nodeId, nodes };

    if (d.rendezvous !== undefined && d.rendezvous !== null) {
      const rdv = parseRendezvous(d.rendezvous);
      if (!rdv) return null;
      out.rendezvous = rdv;
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

// loadOrInitStore(p): store esistente, oppure ne crea uno vuoto (nodeId fresco,
// STABILE una volta scritto). Se il file esiste ma e' invalido -> throw esplicito
// (mai sovrascrivere/mascherare corruzione o un file altrui).
function loadOrInitStore(p) {
  let st;
  try { st = fs.lstatSync(p); }
  catch (e) {
    if (e.code === 'ENOENT') return atomicWriteStore(p, emptyStore());
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error('nodes.json e\' un symlink (rifiutato)');
  const parsed = loadStore(p);
  if (!parsed) throw new Error('nodes.json presente ma invalido (schema strict): correggi o rimuovi il file');
  return parsed;
}

// --- Mutazioni pure (ritornano un nuovo store; il caller lo scrive) ---------

function getNode(store, name) {
  return store.nodes.find((n) => n.name === name) || null;
}

function addNode(store, entry) {
  const node = parseNode(entry);
  if (!node) throw new Error('nodo non valido (schema strict): controlla name/ssh/remotePort/localPort/keyPath');
  if (store.nodes.some((n) => n.name === node.name)) {
    throw new Error(`nodo duplicato: name "${node.name}" gia' presente`);
  }
  if (node.nodeId) {
    if (node.nodeId === store.nodeId) throw new Error('self-reference: il nodeId coincide con questa installazione');
    if (store.nodes.some((n) => n.nodeId === node.nodeId)) {
      throw new Error(`nodo duplicato: nodeId "${node.nodeId}" gia' presente`);
    }
  }
  return { ...store, nodes: store.nodes.concat([node]) };
}

function removeNode(store, name) {
  const idx = store.nodes.findIndex((n) => n.name === name);
  if (idx < 0) throw new Error(`nodo sconosciuto: "${name}"`);
  const nodes = store.nodes.slice();
  nodes.splice(idx, 1);
  return { ...store, nodes };
}

function setNodeToken(store, name, token) {
  const idx = store.nodes.findIndex((n) => n.name === name);
  if (idx < 0) throw new Error(`nodo sconosciuto: "${name}"`);
  if (!validToken(token)) throw new Error('token non valido (vuoto, multilinea o troppo lungo)');
  const nodes = store.nodes.slice();
  nodes[idx] = { ...nodes[idx], token };
  return { ...store, nodes };
}

function setRendezvous(store, rdv) {
  const parsed = parseRendezvous(rdv);
  if (!parsed) throw new Error('rendezvous non valido: controlla ssh/publishedPort/localPort/keyPath');
  return { ...store, rendezvous: parsed };
}

function clearRendezvous(store) {
  const out = { ...store };
  delete out.rendezvous;
  return out;
}

// --- Redazione (view sicura per status/list: MAI il token) ------------------

function redactNode(n) {
  const out = {
    name: n.name,
    ssh: n.ssh,
    remotePort: n.remotePort,
    localPort: n.localPort,
    keyPath: n.keyPath,
    roles: n.roles,
    hasToken: !!n.token, // presenza, non il valore
  };
  if (n.nodeId) out.nodeId = n.nodeId;
  return out;
}

function redactStore(store) {
  const out = {
    schemaVersion: store.schemaVersion,
    nodeId: store.nodeId,
    nodes: store.nodes.map(redactNode),
  };
  // rendezvous non contiene token: sicuro da esporre integralmente.
  if (store.rendezvous) out.rendezvous = { ...store.rendezvous };
  return out;
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
  const store = loadOrInitStore(nodesPath);
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

module.exports = {
  // parse/validate
  parseStore, parseNode, parseRendezvous, parseSsh, isPort, isAbsPath, validToken,
  // I/O
  defaultNodesPath, loadStore, atomicWriteStore, loadOrInitStore, emptyStore, newNodeId,
  // mutazioni
  getNode, addNode, removeNode, setNodeToken, setRendezvous, clearRendezvous,
  // redazione
  redactNode, redactStore,
  // migrazione
  migrateLegacyNodes,
  // costanti
  SCHEMA_VERSION, MAX_NODES, MAX_TOKEN_LEN, NODE_NAME_RE, NODE_ID_RE,
};
