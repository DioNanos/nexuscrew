'use strict';
// Reverse-port pool and append-only ledger.  The ledger is deliberately
// separate from nodes.json: a node store is rewritten often, whereas reusing a
// released SSH permitlisten is unsafe until an operator changes that policy.
// Its anchor lives in nodes.json (validated by the caller) so a deleted or
// truncated ledger can never make a retired pool allocatable again.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REVERSE_PORT_BASE = 44001;
const REVERSE_POOL_SIZE = 3;
const REVERSE_POOL_STRIDE = 100;
const LEDGER_VERSION = 1;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const EPOCH_RE = /^[a-f0-9]{32,64}$/;
const ENTRY_TYPES = new Set(['allocated', 'retired', 'quarantined']);

function isPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function reversePoolForBase(base) {
  if (!isPort(base)) return null;
  const slots = Array.from({ length: REVERSE_POOL_SIZE }, (_, index) => base + (index * REVERSE_POOL_STRIDE));
  return slots.every(isPort) ? slots : null;
}

function validReversePoolBase(base) {
  return Array.isArray(reversePoolForBase(base));
}

function defaultLedgerPath(home = os.homedir()) {
  return path.join(home, '.nexuscrew', 'reverse-pool-ledger.json');
}

function genesisDigest(epoch) {
  return crypto.createHash('sha256').update(`nexuscrew-reverse-pool-ledger/v${LEDGER_VERSION}\0${epoch}`).digest('hex');
}

function digestEntry(entry) {
  return crypto.createHash('sha256').update(JSON.stringify({
    seq: entry.seq,
    type: entry.type,
    base: entry.base,
    at: entry.at,
    prevDigest: entry.prevDigest,
  })).digest('hex');
}

function parseEntry(entry, previous, expectedSeq) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const keys = Object.keys(entry);
  if (keys.length !== 6 || keys.some((key) => !['seq', 'type', 'base', 'at', 'prevDigest', 'digest'].includes(key))) return null;
  if (!Number.isSafeInteger(entry.seq) || entry.seq !== expectedSeq || !ENTRY_TYPES.has(entry.type)
    || !validReversePoolBase(entry.base) || !Number.isSafeInteger(entry.at) || entry.at < 0
    || !DIGEST_RE.test(String(entry.prevDigest || '')) || !DIGEST_RE.test(String(entry.digest || ''))
    || entry.prevDigest !== previous || digestEntry(entry) !== entry.digest) return null;
  return { seq: entry.seq, type: entry.type, base: entry.base, at: entry.at, prevDigest: entry.prevDigest, digest: entry.digest };
}

function parseLedger(raw) {
  try {
    const source = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const keys = Object.keys(source);
    if (keys.length !== 3 || keys.some((key) => !['version', 'epoch', 'entries'].includes(key))) return null;
    if (source.version !== LEDGER_VERSION || !EPOCH_RE.test(String(source.epoch || ''))
      || !Array.isArray(source.entries) || source.entries.length > 65535) return null;
    let previous = genesisDigest(source.epoch);
    const entries = [];
    for (let index = 0; index < source.entries.length; index += 1) {
      const entry = parseEntry(source.entries[index], previous, index + 1);
      if (!entry) return null;
      previous = entry.digest;
      entries.push(entry);
    }
    return { version: LEDGER_VERSION, epoch: source.epoch, entries };
  } catch (_) { return null; }
}

function emptyLedger(epoch = crypto.randomBytes(16).toString('hex')) {
  if (!EPOCH_RE.test(epoch)) throw new Error('ledger epoch non valido');
  return { version: LEDGER_VERSION, epoch, entries: [] };
}

function ledgerHead(ledger) {
  const parsed = parseLedger(ledger);
  if (!parsed) return null;
  const last = parsed.entries.at(-1);
  return {
    epoch: parsed.epoch,
    seq: last ? last.seq : 0,
    digest: last ? last.digest : genesisDigest(parsed.epoch),
  };
}

function appendLedger(ledger, { type, base, at = Date.now() } = {}) {
  const parsed = parseLedger(ledger);
  if (!parsed) throw new Error('reverse pool ledger non valido');
  if (!ENTRY_TYPES.has(type) || !validReversePoolBase(base) || !Number.isSafeInteger(at) || at < 0) {
    throw new Error('entry reverse pool ledger non valida');
  }
  const head = ledgerHead(parsed);
  const entry = { seq: head.seq + 1, type, base, at, prevDigest: head.digest };
  entry.digest = digestEntry(entry);
  return { ...parsed, entries: [...parsed.entries, entry] };
}

function parseAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
  if (Object.keys(anchor).length !== 3 || !EPOCH_RE.test(String(anchor.epoch || ''))
    || !Number.isSafeInteger(anchor.seq) || anchor.seq < 0 || !DIGEST_RE.test(String(anchor.digest || ''))) return null;
  return { epoch: anchor.epoch, seq: anchor.seq, digest: anchor.digest };
}

// A ledger can legitimately be ahead of the anchor after an interruption
// between its atomic write and nodes.json's atomic anchor update.  That is
// conservative and is reconciled by returning advanceAnchor.  Any missing
// prefix is unsafe and blocks only fresh pool allocation; existing tunnels are
// intentionally not affected.
function validateLedgerAnchor(ledger, anchor) {
  const parsed = parseLedger(ledger);
  const expected = parseAnchor(anchor);
  if (!parsed) return { ok: false, code: 'reverse-pool-ledger-invalid', allocationBlocked: true };
  if (!expected) return { ok: false, code: 'reverse-pool-anchor-missing', allocationBlocked: true };
  if (parsed.epoch !== expected.epoch) return { ok: false, code: 'reverse-pool-anchor-epoch-mismatch', allocationBlocked: true };
  const head = ledgerHead(parsed);
  if (head.seq < expected.seq) return { ok: false, code: 'reverse-pool-ledger-behind-anchor', allocationBlocked: true };
  const prefix = expected.seq === 0
    ? { epoch: parsed.epoch, seq: 0, digest: genesisDigest(parsed.epoch) }
    : parsed.entries[expected.seq - 1];
  if (!prefix || prefix.digest !== expected.digest) return { ok: false, code: 'reverse-pool-anchor-prefix-mismatch', allocationBlocked: true };
  if (head.seq > expected.seq) return { ok: true, code: 'reverse-pool-anchor-advance', allocationBlocked: false, advanceAnchor: head };
  return { ok: true, code: 'reverse-pool-anchor-current', allocationBlocked: false, anchor: head };
}

function loadLedger(ledgerPath) {
  try {
    const st = fs.lstatSync(ledgerPath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return parseLedger(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (_) { return null; }
}

function atomicWriteLedger(ledgerPath, ledger) {
  const parsed = parseLedger(ledger);
  if (!parsed) throw new Error('reverse pool ledger non valido');
  try {
    if (fs.lstatSync(ledgerPath).isSymbolicLink()) throw new Error('reverse pool ledger target e\' un symlink');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const dir = path.dirname(ledgerPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(ledgerPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, ledgerPath);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
  return parsed;
}

function usedPorts(nodes = [], ledger = null) {
  const ports = new Set();
  for (const node of nodes || []) {
    if (isPort(node && node.localPort)) ports.add(node.localPort);
    if (isPort(node && node.reversePort)) ports.add(node.reversePort);
    const pool = node && node.reversePool;
    if (pool && validReversePoolBase(pool.base)) for (const port of reversePoolForBase(pool.base)) ports.add(port);
  }
  const parsed = parseLedger(ledger);
  for (const entry of (parsed && parsed.entries) || []) {
    // An allocation is permanent for this ledger's epoch.  Keeping every
    // allocated base reserved is what prevents a removed peer's old SSH key
    // from binding a newly assigned pool.
    if (entry.type === 'allocated' && validReversePoolBase(entry.base)) {
      for (const port of reversePoolForBase(entry.base)) ports.add(port);
    }
  }
  return ports;
}

function nextReversePool(nodes = [], ledger = null, { start = REVERSE_PORT_BASE } = {}) {
  const occupied = usedPorts(nodes, ledger);
  for (let base = start; validReversePoolBase(base); base += 1) {
    const slots = reversePoolForBase(base);
    if (slots.every((port) => !occupied.has(port))) return { base, slots };
  }
  throw new Error('nessun reverse port pool disponibile');
}

async function allocateAvailableReversePool(nodes = [], ledger = null, {
  start = REVERSE_PORT_BASE,
  canBind = async () => true,
} = {}) {
  const occupied = usedPorts(nodes, ledger);
  for (let base = start; validReversePoolBase(base); base += 1) {
    const slots = reversePoolForBase(base);
    if (!slots.every((port) => !occupied.has(port))) continue;
    let available = true;
    for (const port of slots) {
      if (!(await canBind(port))) { available = false; break; }
    }
    if (available) return { base, slots };
  }
  throw new Error('nessun reverse port pool disponibile');
}

module.exports = {
  REVERSE_PORT_BASE, REVERSE_POOL_SIZE, REVERSE_POOL_STRIDE, LEDGER_VERSION,
  reversePoolForBase, validReversePoolBase, defaultLedgerPath,
  genesisDigest, digestEntry, parseLedger, emptyLedger, ledgerHead, appendLedger,
  parseAnchor, validateLedgerAnchor, loadLedger, atomicWriteLedger,
  usedPorts, nextReversePool, allocateAvailableReversePool,
};
