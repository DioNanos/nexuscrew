'use strict';
// lib/live-host/entry.js — la voce `<instanceId>:Live` della directory delle celle.
//
// La Live compare solo quando c'e' qualcosa di vivo da nominare: un thread
// nativo presente o attivo, oppure la modalita' tmux con l'ospite attivo. Non
// ha una sessione tmux propria e non nomina la cella ospite: chi legge la
// directory non deve poter confondere le due. canReceive resta false finche'
// non esiste una consegna dedicata alla Live; il motivo dice perche'.

const { isReservedLiveName } = require('./reserved.js');

const NATIVE_ALIVE = new Set(['present', 'active']);

async function buildLiveEntry({ store, bridge, fleetP, instanceId, now = Date.now }) {
  try {
    const snap = store.snapshot();
    if (!snap || snap.hostCell == null || snap.ownerId) return null;
    const fleet = await fleetP;
    const statusFn = fleet && (typeof fleet.status === 'function' ? fleet.status : fleet.cellStatus);
    if (!fleet || fleet.available !== true || typeof statusFn !== 'function') return null;
    const status = await statusFn.call(fleet);
    const cells = Array.isArray(status && status.cells) ? status.cells : [];
    const host = cells.find((c) => c && c.cell === snap.hostCell && !isReservedLiveName(c.cell));
    if (!host) return null;
    // The Live works through its host cell (identity, tools, files): with the
    // host off there is no Live to name, whatever the daemon still holds.
    if (host.active !== true || host.tmux === false) return null;
    const base = {
      id: `${instanceId}:Live`,
      instanceId,
      cell: 'Live',
      kind: 'live',
      label: 'Live',
      active: true,
      canReceive: false,
      lastSeen: now(),
    };
    if (String(host.engine || '').startsWith('codex-vl')) {
      const thread = await bridge.threadStatus(snap.hostCell);
      if (!NATIVE_ALIVE.has(thread)) return null;
      return { ...base, mode: 'native', state: thread, reason: 'live-not-addressable' };
    }
    return { ...base, mode: 'tmux', state: 'tmux', reason: 'tmux-mode' };
  } catch (_) {
    return null;
  }
}

module.exports = { buildLiveEntry };
