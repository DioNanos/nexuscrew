'use strict';
// Store degli "ask" (domande cella→operatore) — MCP bridge, design §2c.
// Stato in-memory + persistenza <dir>/asks.json 0600 (sopravvive al restart:
// un ask aperto resta risponibile). Lo store e' PURO stato: il paste tmux e la
// notify li orchestra la route (lib/notify/routes.js), che qui fa il ciclo
// claim -> (paste) -> commit/release (F2: una sola answer puo' vincere).
const path = require('node:path');
const crypto = require('node:crypto');
const { readJsonSafe, atomicWriteJson } = require('./persist.js');

const ASKS_FILE = 'asks.json';
// F5: MAX_OPEN e' un cap DURO sugli ask aperti — al cap il nuovo ask viene
// RIFIUTATO (reason 'cap'), mai droppato uno aperto. MAX_KEEP pota solo gli
// answered piu' vecchi dal file.
const MAX_OPEN = 100;
const MAX_KEEP = 100;          // ask totali persistiti (i piu' vecchi answered si potano)
const MAX_QUESTION = 2000;
const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 200;

function createAsksStore(opts = {}) {
  if (!opts.dir) throw new Error('createAsksStore: dir richiesta');
  const filePath = path.join(opts.dir, ASKS_FILE);
  const now = opts.now || (() => Date.now());

  // Carica lazy al primo accesso (niente I/O in createServer per i path reali).
  let asks = null;
  function load() {
    if (asks) return asks;
    const cur = readJsonSafe(filePath);
    asks = Array.isArray(cur.asks)
      ? cur.asks.filter((a) => a && typeof a === 'object' && typeof a.id === 'string')
      : [];
    return asks;
  }

  function save() {
    // prune: mai piu' di MAX_KEEP; si scartano prima gli answered piu' vecchi.
    const list = load();
    if (list.length > MAX_KEEP) {
      const answered = list.filter((a) => a.answered).sort((a, b) => a.ts - b.ts);
      const excess = list.length - MAX_KEEP;
      const drop = new Set(answered.slice(0, excess).map((a) => a.id));
      asks = list.filter((a) => !drop.has(a.id));
    }
    atomicWriteJson(filePath, { asks: load() });
  }

  // Validazione input fail-closed. Ritorna {ok:false,error} o {ok:true,value}.
  function validate({ question, options }) {
    if (typeof question !== 'string' || !question.trim()) {
      return { ok: false, error: 'question deve essere una stringa non vuota' };
    }
    if (question.length > MAX_QUESTION) {
      return { ok: false, error: `question troppo lunga (max ${MAX_QUESTION})` };
    }
    let opts2;
    if (options !== undefined) {
      if (!Array.isArray(options) || options.length > MAX_OPTIONS
        || options.some((o) => typeof o !== 'string' || !o.trim() || o.length > MAX_OPTION_LEN)) {
        return { ok: false, error: `options deve essere un array di stringhe non vuote (max ${MAX_OPTIONS} x ${MAX_OPTION_LEN} char)` };
      }
      opts2 = options.map((o) => o.trim());
    }
    return { ok: true, value: { question: question.trim(), options: opts2 } };
  }

  function openCount() {
    return load().filter((a) => !a.answered).length;
  }

  function create({ question, options, session }) {
    const v = validate({ question, options });
    if (!v.ok) return { ok: false, reason: 'invalid', error: v.error };
    // F5: cap duro sugli aperti — rifiuto esplicito, MAI drop di ask aperti.
    if (openCount() >= MAX_OPEN) {
      return {
        ok: false,
        reason: 'cap',
        error: `cap ask aperti raggiunto (${MAX_OPEN}): rispondi o attendi prima di crearne altri`,
      };
    }
    const ask = {
      id: crypto.randomBytes(4).toString('hex'),
      question: v.value.question,
      ...(v.value.options ? { options: v.value.options } : {}),
      session: String(session),
      ts: now(),
      answered: false,
    };
    load().push(ask);
    save();
    return { ok: true, ask };
  }

  function get(id) {
    return load().find((a) => a.id === id) || null;
  }

  function list({ open = false } = {}) {
    const all = load();
    return (open ? all.filter((a) => !a.answered) : all.slice())
      .map((a) => ({ ...a, ...(a.options ? { options: a.options.slice() } : {}) }));
  }

  // --- ciclo answer F2 (audit): claim atomico open -> answering ---------------
  // Node e' single-threaded ma il paste e' un await: due answer concorrenti
  // superavano entrambe il check `answered` prima che una marcasse. Il claim
  // sincrono (nessun await tra check e set) fa vincere UNA sola richiesta; le
  // altre vedono 'answering'/'answered'. Il Set e' SOLO in-memory di proposito:
  // un crash a meta' paste riporta l'ask a open al riavvio (ri-risponibile).
  const answering = new Set();

  function claim(id) {
    const ask = get(id);
    if (!ask) return { ok: false, reason: 'unknown' };
    if (ask.answered) return { ok: false, reason: 'answered' };
    if (answering.has(id)) return { ok: false, reason: 'answering' };
    answering.add(id);
    return { ok: true, ask: { ...ask } };
  }

  // Rollback: il paste e' fallito, l'ask torna contendibile.
  function release(id) {
    answering.delete(id);
  }

  // Commit: paste riuscito -> answered persistito, claim rilasciato.
  function commit(id, text) {
    const ask = get(id);
    answering.delete(id);
    if (!ask || ask.answered) return false;
    ask.answered = true;
    ask.answer = String(text);
    ask.answeredTs = now();
    save();
    return true;
  }

  // Retrocompat (usata nei test di store): claim+commit in un colpo.
  function markAnswered(id, text) {
    const c = claim(id);
    if (!c.ok) return false;
    return commit(id, text);
  }

  return { create, get, list, openCount, claim, release, commit, markAnswered, validate, filePath, MAX_OPEN };
}

module.exports = { createAsksStore };
