'use strict';
// lib/notify/event-feed-producers.js — the producer registry.
//
// Every local producer of events is registered here with a CLOSED schema: the
// frame keeps only the allowlisted fields, everything else is dropped BEFORE
// the envelope exists, so a runtime object can never smuggle a credential, a
// proof, a subscription, a config object or an absolute path into a frame.
// A producer type without a schema is a diagnostic error, not a pass-through:
// coverage is proved by tests, never by silent omission.

const crypto = require('node:crypto');

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const FRAME_MAX_BYTES = 16 * 1024;

function cleanStr(v, max) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.slice(0, max);
  return s.length > 0 ? s : undefined;
}

function cleanBool(v) { return v === true ? true : v === false ? false : undefined; }

function cleanLang(v) {
  const s = cleanStr(v, 16);
  return s && /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/i.test(s) ? s : undefined;
}

// One entry per producer: `scope` fixes the envelope scope, `build` projects
// the runtime payload onto the closed frame schema. Anything `build` does not
// recognize is dropped here, at the source — never filtered per peer later,
// because the ring must never have held it in the first place.
const PRODUCERS = {
  // A notify bound to a Fleet cell (session resolved to a cell by the owner).
  notify: {
    scope: 'cell',
    requires: ['cellId'],
    build: (p) => ({
      type: 'notify',
      title: cleanStr(p.title, 200) || '',
      ...(p.body !== undefined ? { body: cleanStr(p.body, 2000) || '' } : {}),
      urgency: p.urgency === 'high' ? 'high' : 'normal',
      ...(cleanLang(p.lang) ? { lang: cleanLang(p.lang) } : {}),
      // Correlazione esplicita ask->notify: viaggia con il frame, cosi' il
      // push importato puo' aprire la card giusta e non solo l'owner.
      ...(cleanStr(p.askId, 32) ? { askId: cleanStr(p.askId, 32) } : {}),
      ts: typeof p.ts === 'number' ? p.ts : undefined,
    }),
  },
  // A notify from a local service without a cell: scope node, never a made-up
  // cell ("not inventing a cell for it to pass").
  'notify-node': {
    scope: 'node',
    requires: [],
    build: (p) => ({
      type: 'notify',
      title: cleanStr(p.title, 200) || '',
      ...(p.body !== undefined ? { body: cleanStr(p.body, 2000) || '' } : {}),
      urgency: p.urgency === 'high' ? 'high' : 'normal',
      ...(cleanLang(p.lang) ? { lang: cleanLang(p.lang) } : {}),
      ts: typeof p.ts === 'number' ? p.ts : undefined,
    }),
  },
  // An ask: the frame carries the ask id and revision so the card and its
  // later closure are the same object on every side.
  ask: {
    scope: 'cell',
    requires: ['cellId'],
    build: (p) => ({
      type: 'ask',
      askId: cleanStr(p.askId, 32) || '',
      revision: typeof p.revision === 'number' ? p.revision : 0,
      question: cleanStr(p.question, 3900) || '',
      ...(Array.isArray(p.options) ? { options: p.options.slice(0, 8).map((o) => cleanStr(o, 200) || '') } : {}),
      session: cleanStr(p.session, 128) || undefined,
      ts: typeof p.ts === 'number' ? p.ts : undefined,
    }),
  },
  // Closure of an ask: askId + cell survive the closure.
  'ask-closed': {
    scope: 'cell',
    requires: ['cellId'],
    build: (p) => ({
      type: 'ask-closed',
      askId: cleanStr(p.askId, 32) || '',
      revision: typeof p.revision === 'number' ? p.revision : 0,
      outcome: p.outcome === 'answered' || p.outcome === 'dismissed' ? p.outcome : 'answered',
      ts: typeof p.ts === 'number' ? p.ts : undefined,
    }),
  },
  // A file notice: name/caption/session only. A file event is an alert — the
  // download is a separate, separately authorized operation.
  'file-notice': {
    scope: 'cell',
    requires: ['cellId'],
    build: (p) => ({
      type: 'file-notice',
      name: cleanStr(p.name, 200) || '',
      ...(p.caption !== undefined ? { caption: cleanStr(p.caption, 300) || '' } : {}),
      session: cleanStr(p.session, 128) || undefined,
      ts: typeof p.ts === 'number' ? p.ts : undefined,
    }),
  },
  // Fleet state: the OWNER projects the cell list per peer visibility BEFORE
  // insertion; this frame only carries the allowlisted per-cell fields.
  'fleet-state': {
    scope: 'node',
    requires: [],
    build: (p) => ({
      type: 'fleet-state',
      cells: Array.isArray(p.cells)
        ? p.cells.slice(0, 128).map((c) => ({
          cell: cleanStr(c && c.cell, 32) || '',
          active: c && c.active === true,
        })).filter((c) => c.cell !== '')
        : [],
      ts: typeof p.ts === 'number' ? p.ts : undefined,
    }),
  },
  // Node-level service state, normalized (no absolute paths, no runtimes).
  'node-state': {
    scope: 'node',
    requires: [],
    build: (p) => ({
      type: 'node-state',
      service: cleanStr(p.service, 64) || '',
      state: p.state === 'up' || p.state === 'down' || p.state === 'degraded' ? p.state : 'unknown',
      ts: typeof p.ts === 'number' ? p.ts : undefined,
    }),
  },
};

const PRODUCER_NAMES = Object.freeze(Object.keys(PRODUCERS));

// Build the v1 envelope. Throws a NAMED error for an unknown producer or a
// cell-scope producer without a resolved cell: silently re-scoping to node
// would let an unresolved cell masquerade as node traffic.
function buildEnvelope({ type, payload, ownerId, cellId = null, now = Date.now }) {
  const producer = PRODUCERS[type];
  if (!producer) {
    const e = new Error(`unregistered event producer: "${type}"`);
    e.reason = 'unregistered-producer';
    throw e;
  }
  for (const req of producer.requires) {
    if (req === 'cellId' && !(typeof cellId === 'string' && CELL_ID_RE.test(cellId))) {
      const e = new Error(`producer "${type}" needs a resolved cell, got none`);
      e.reason = 'cell-not-resolved';
      throw e;
    }
  }
  const frame = producer.build(payload || {});
  if (frame.type === undefined) frame.type = frame.type; // closed schema already sets type
  const envelope = {
    v: 1,
    ownerId: String(ownerId || ''),
    eventId: crypto.randomUUID(),
    scope: producer.scope,
    cellId: producer.scope === 'cell' ? cellId : null,
    hop: 1,
    emittedAt: now(),
    frame,
  };
  // The wire cap is checked HERE too: an envelope that cannot travel must not
  // exist, not merely be dropped per peer.
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > FRAME_MAX_BYTES) {
    const e = new Error(`frame of producer "${type}" exceeds the wire cap`);
    e.reason = 'frame-too-large';
    throw e;
  }
  return envelope;
}

module.exports = { PRODUCERS, PRODUCER_NAMES, buildEnvelope, FRAME_MAX_BYTES };
