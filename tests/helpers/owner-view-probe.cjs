'use strict';
const assert = require('node:assert/strict');
const { ReadableStream } = require('node:stream/web');
const { createEventFeedClient } = require('../../lib/notify/event-feed-client.js');
const ownerId = 'a'.repeat(32);
const ask = { id: 'abcdef01', ownerId, ownerAskTs: 100, ts: 100, question: 'Shared question', options: [], session: 'cloud-reviewer' };
function createProbe() {
  let controller, sequence = 0;
  const frames = [], requests = [], changes = [];
  const snapshot = () => ({ ownerId, cursor: `1:${sequence}`, viewEpoch: 1, asks: [], notifications: [], fleetState: null });
  let response = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(snapshot()) });
  const client = createEventFeedClient({
    loadStore: () => ({ nodeId: 'b'.repeat(32), nodes: [{ nodeId: ownerId, direction: 'outbound', token: 'fixture', localPort: 1, eventsReceive: true }] }),
    minSnapshotIntervalMs: 0, eventsHub: { broadcast: frame => frames.push(frame) },
    onViewChanged: id => changes.push(id),
    fetchImpl: async (url, { signal } = {}) => {
      requests.push(new URL(url).pathname);
      if (url.endsWith('/federation/health')) return { ok: true, json: async () => ({ instanceId: ownerId, eventFeedV1: true }) };
      if (url.endsWith('/event-feed/snapshot')) return response();
      assert.ok(url.includes('/event-feed?after='));
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { controller = c; signal.addEventListener('abort', () => { try { c.close(); } catch {} }, { once: true }); } }) };
    },
  });
  async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    assert.ok(predicate(), 'subscriber must consume the real SSE frame');
  }
  return { client, frames, requests, changes, snapshot,
    setResponse: fn => { response = fn; },
    start: async () => { client.start(); await waitFor(() => controller); },
    emit: async frame => {
      const eventId = `1:${++sequence}`;
      controller.enqueue(Buffer.from(`id: ${eventId}\ndata: ${JSON.stringify({ ownerId, eventId, hop: 1, scope: 'cell', cellId: 'reviewer', frame })}\n\n`));
      await waitFor(() => client.state().views[0].cursor === eventId);
    },
  };
}
module.exports = { createProbe, ownerId, ask };
