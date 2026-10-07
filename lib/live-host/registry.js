'use strict';
// lib/live-host/registry.js — registro persistito dei thread Live.
//
// One entry per host cell: the thread the Live bridge started on the app-server
// and the reference that thread declares when it calls NexusCrew tools. It lives
// next to live-host.json so it survives a server restart: the thread itself
// lives in the daemon, and a restart must not make it look absent.
//
// The file is the truth. Every call reads it, so two instances over the same
// path agree; writes are synchronous read-modify-write (one event loop, no
// interleaving) and atomic on disk. A damaged file reads as empty and a damaged
// entry is skipped, never promoted.

const path = require('node:path');
const os = require('node:os');
const { readJsonSafe, atomicWriteJson } = require('../notify/persist.js');

const CELL_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
const REF_RE = /^[a-f0-9]{32}$/;
const MAX_THREAD_ID = 128;
// One entry per host cell, and never more than this many: the oldest go first.
const MAX_ENTRIES = 64;

function liveThreadsPath(cfg = {}, home = (cfg.home || os.homedir())) {
  if (cfg.liveThreadsPath) return cfg.liveThreadsPath;
  if (cfg.tokenPath) return path.join(path.dirname(cfg.tokenPath), 'live-threads.json');
  return path.join(home, '.nexuscrew', 'live-threads.json');
}

function validEntry(cell, raw) {
  if (!CELL_ID_RE.test(String(cell || '')) || !raw || typeof raw !== 'object') return null;
  if (typeof raw.threadId !== 'string' || !raw.threadId || raw.threadId.length > MAX_THREAD_ID) return null;
  if (typeof raw.ref !== 'string' || !REF_RE.test(raw.ref)) return null;
  const out = { threadId: raw.threadId, ref: raw.ref };
  if (typeof raw.tmuxSession === 'string' && raw.tmuxSession) out.tmuxSession = raw.tmuxSession;
  out.startedAt = Number.isFinite(raw.startedAt) ? raw.startedAt : 0;
  return out;
}

function createLiveThreadRegistry({ filePath, now = () => Date.now() } = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('createLiveThreadRegistry: filePath richiesto');
  }

  function readAll() {
    // Fail closed: a file that cannot be read safely (symlink, permissions wider
    // than 0600) is treated as empty, never trusted. An empty registry means no
    // thread is vouched for, which is the safe answer.
    let raw;
    try { raw = readJsonSafe(filePath); } catch (_) { return {}; }
    const threads = raw && typeof raw.threads === 'object' && raw.threads && !Array.isArray(raw.threads)
      ? raw.threads : {};
    const out = {};
    for (const [cell, value] of Object.entries(threads)) {
      const entry = validEntry(cell, value);
      if (entry) out[cell] = entry;
    }
    return out;
  }

  function writeAll(threads) {
    atomicWriteJson(filePath, { version: 1, threads });
  }

  function get(cell) {
    return readAll()[cell] || null;
  }

  function set(cell, entry) {
    const next = validEntry(cell, { ...entry, startedAt: now() });
    if (!next) throw new Error('voce del registro Live non valida');
    const all = readAll();
    all[cell] = next;
    const cells = Object.keys(all);
    if (cells.length > MAX_ENTRIES) {
      cells.filter((name) => name !== cell)
        .sort((a, b) => all[a].startedAt - all[b].startedAt)
        .slice(0, cells.length - MAX_ENTRIES)
        .forEach((name) => { delete all[name]; });
    }
    writeAll(all);
    return next;
  }

  // With `expectedThreadId` the entry is removed only if it still names that
  // thread: a slow read about an old thread must not remove a newer Live that
  // replaced the entry in the meantime.
  function remove(cell, expectedThreadId) {
    const all = readAll();
    if (!(cell in all)) return false;
    if (expectedThreadId !== undefined && all[cell].threadId !== expectedThreadId) return false;
    delete all[cell];
    writeAll(all);
    return true;
  }

  function entries() {
    return Object.entries(readAll()).map(([cell, entry]) => ({ cell, ...entry }));
  }

  function findByRef(ref) {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return null;
    return entries().find((entry) => entry.ref === ref) || null;
  }

  return { get, set, remove, entries, findByRef, filePath };
}

createLiveThreadRegistry.MAX_ENTRIES = MAX_ENTRIES;

module.exports = { createLiveThreadRegistry, liveThreadsPath, REF_RE };
