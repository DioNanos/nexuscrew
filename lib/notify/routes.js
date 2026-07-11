'use strict';
// Route del MCP bridge (design §2): notify, web-push, asks. Montate dentro il
// router /api gia' dietro requireToken (server.js) — qui restano solo:
//   - READONLY come FLOOR (F3 audit): sono gated 403 TUTTI i mutanti — answer
//     (scrittura PTY via paste), push subscribe/unsubscribe (push.json) e la
//     CREAZIONE di ask (persiste asks.json e genererebbe domande non
//     risponibili dallo stesso server). L'UNICA eccezione dichiarata e' la
//     notify: canale informativo inbound cella→operatore, effimero (broadcast SSE +
//     push senza persistenza; anche il cleanup delle subscription morte e'
//     sospeso in READONLY, vedi lib/notify/push.js). Le GET restano lettura
//     pura: /push/vapid in READONLY non genera chiavi (503 se assenti).
//   - rate-limit (F1 audit): il campo `session` e' dichiarato dal chiamante e
//     NON e' un confine di sicurezza — il limite che conta e' GLOBALE per
//     principal/token (un Bearer = un'installazione); il bucket per-sessione
//     resta come fairness tra celle oneste. Stessa coppia di limiti sulla
//     creazione ask (F5).
//   - validazione input strict fail-closed (schema chiuso per ogni body).
// Il paste della risposta riusa ESATTAMENTE pasteToSession (bracketed literal,
// niente Invio, control char rifiutati): qui si sanifica il testo PRIMA.
const express = require('express');
const { isValidSession } = require('../files/store.js');

const NOTIFY_KEYS = new Set(['title', 'body', 'urgency', 'session']);
const ASK_KEYS = new Set(['question', 'options', 'session']);
const RATE_MAX = 6;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_BUCKETS = 64;
const MAX_TITLE = 200;
const MAX_BODY = 2000;
// Il paste tmux accetta max 4096 char: prefisso `[human reply · ask#xxxxxxxx] `
// (~32 char) + testo -> cap prudente sul testo.
const MAX_ANSWER = 3900;
const MAX_REPLY_LABEL = 48;

// Sliding window in-memory per chiave. La mappa ha un cap duro (F1): entry
// scadute potate a ogni giro, poi evizione LRU deterministica (ordine di
// iterazione della Map = ordine di ultimo uso, re-insert ad ogni allow).
// NB: l'evizione azzera il conteggio del bucket evitto — per questo il cap
// per-chiave NON e' il confine di sicurezza: quello e' il bucket GLOBALE
// (chiave fissa, mai evitto perche' sempre re-inserito per ultimo).
function createRateLimiter({ max = RATE_MAX, windowMs = RATE_WINDOW_MS, maxBuckets = RATE_MAX_BUCKETS, now = Date.now } = {}) {
  const hits = new Map(); // key -> [timestamps]
  function allow(key) {
    const t = now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    const allowed = list.length < max;
    if (allowed) list.push(t);
    hits.delete(key); hits.set(key, list); // re-insert: la Map resta in ordine LRU
    // prune deterministico: prima le entry con finestra scaduta...
    for (const [k, l] of hits) {
      if (k !== key && (l.length === 0 || t - l[l.length - 1] >= windowMs)) hits.delete(k);
    }
    // ...poi cap duro LRU (la meno recente e' la prima in iterazione).
    while (hits.size > maxBuckets) hits.delete(hits.keys().next().value);
    return allowed;
  }
  return { allow, size: () => hits.size };
}

// Coppia di limiti F1/F5: globale per token (confine di sicurezza) + per
// sessione (fairness). Una richiesta oltre-limite consuma comunque il budget
// globale: anche lo spam rifiutato e' attivita' del principal.
function createSenderLimiter(rateCfg = {}) {
  const perSession = createRateLimiter(rateCfg);
  const global = createRateLimiter({
    max: rateCfg.globalMax || rateCfg.max || RATE_MAX,
    windowMs: rateCfg.windowMs || RATE_WINDOW_MS,
    maxBuckets: 2,
  });
  return (sender) => {
    const g = global.allow('*'); // valutato SEMPRE (niente short-circuit nascosto)
    const s = perSession.allow(sender);
    return g && s;
  };
}

// Control char (0x00-0x1f, 0x7f) -> spazio: il paste li rifiuta a monte, e una
// risposta multiriga della UI deve comunque arrivare come UNA riga senza Invio.
function sanitizePasteText(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    out += (c <= 0x1f || c === 0x7f) ? ' ' : text[i];
  }
  return out.trim();
}

function replyLabel(cfg) {
  const clean = sanitizePasteText(String((cfg && cfg.replyLabel) || 'human')).slice(0, MAX_REPLY_LABEL).trim();
  return clean || 'human';
}

function notifyRoutes({ cfg, notifier, push, asks, paste, sessionExists }) {
  const r = express.Router();
  const json = express.json({ limit: '16kb' });

  const readonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');
  const mutGate = (_req, res, next) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: mutazione bloccata' });
    next();
  };
  const allowNotify = createSenderLimiter(cfg.notifyRate || {});
  const allowAsk = createSenderLimiter(cfg.askRate || cfg.notifyRate || {});

  // --- POST /notify — broadcast UI + web-push -------------------------------
  r.post('/notify', json, async (req, res) => {
    try {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return res.status(400).json({ error: 'body deve essere un oggetto JSON' });
      }
      for (const k of Object.keys(b)) {
        if (!NOTIFY_KEYS.has(k)) return res.status(400).json({ error: `chiave non ammessa: "${k}" (schema: title, body?, urgency?, session?)` });
      }
      if (typeof b.title !== 'string' || !b.title.trim()) {
        return res.status(400).json({ error: 'title deve essere una stringa non vuota' });
      }
      if (b.title.length > MAX_TITLE) return res.status(400).json({ error: `title troppo lungo (max ${MAX_TITLE})` });
      if (b.body !== undefined && (typeof b.body !== 'string' || b.body.length > MAX_BODY)) {
        return res.status(400).json({ error: `body deve essere una stringa (max ${MAX_BODY})` });
      }
      if (b.urgency !== undefined && b.urgency !== 'normal' && b.urgency !== 'high') {
        return res.status(400).json({ error: 'urgency deve essere "normal" o "high"' });
      }
      if (b.session !== undefined && !isValidSession(b.session)) {
        return res.status(400).json({ error: 'session non valida' });
      }
      const sender = b.session || 'unknown';
      if (!allowNotify(sender)) {
        return res.status(429).json({ error: 'rate limit notify superato (limite globale per token + per sessione)' });
      }
      const delivered = await notifier.emit({
        title: b.title.trim(), body: b.body, urgency: b.urgency, session: b.session,
      });
      res.json({ delivered });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // --- web-push --------------------------------------------------------------
  // GET lettura pura; in READONLY push.vapidPublicKey() NON genera chiavi e
  // segnala 503 (e.status) se assenti — F3.
  r.get('/push/vapid', (_req, res) => {
    try { res.json({ publicKey: push.vapidPublicKey() }); }
    catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });

  r.post('/push/subscribe', mutGate, json, async (req, res) => {
    try {
      const sub = req.body && req.body.subscription;
      const out = await push.subscribe(sub);
      // F7: cap sul numero di subscription -> 429 (quota), input invalido -> 400.
      if (!out.ok) return res.status(out.reason === 'cap' ? 429 : 400).json({ error: out.error });
      res.json({ subscribed: true, count: out.count });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  r.delete('/push/subscribe', mutGate, json, (req, res) => {
    try {
      const out = push.unsubscribe(req.body && req.body.endpoint);
      if (!out.ok) return res.status(400).json({ error: out.error });
      res.json({ removed: out.removed });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // --- asks ------------------------------------------------------------------
  // F3: gated READONLY (mutGate) — crea stato durevole (asks.json) e domande
  // che lo stesso server vieterebbe di rispondere. F5: rate-limit creazione
  // (globale per token + per sessione) + cap duro dello store -> 429.
  r.post('/asks', mutGate, json, async (req, res) => {
    try {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return res.status(400).json({ error: 'body deve essere un oggetto JSON' });
      }
      for (const k of Object.keys(b)) {
        if (!ASK_KEYS.has(k)) return res.status(400).json({ error: `chiave non ammessa: "${k}" (schema: question, options?, session)` });
      }
      // session obbligatoria E viva: la risposta va incollata li' — un ask senza
      // recapito verificabile e' fail-closed subito, non al momento dell'answer.
      if (!isValidSession(b.session)) return res.status(400).json({ error: 'session non valida' });
      if (!sessionExists(b.session)) return res.status(404).json({ error: 'sessione tmux inesistente' });
      // Validazione del contenuto PRIMA del rate check: gli input invalidi (400)
      // non consumano budget; il rate scatta solo su richieste ben formate.
      const v = asks.validate({ question: b.question, options: b.options });
      if (!v.ok) return res.status(400).json({ error: v.error });
      if (!allowAsk(b.session)) {
        return res.status(429).json({ error: 'rate limit ask superato (limite globale per token + per sessione)' });
      }
      const out = asks.create({ question: b.question, options: b.options, session: b.session });
      if (!out.ok) return res.status(out.reason === 'cap' ? 429 : 400).json({ error: out.error });
      const ask = out.ask;
      // Frame dedicato per le UI aperte (card/badge live, senza aspettare il poll)…
      notifier.emitRaw({ type: 'ask', ask });
      // …e ogni ask emette anche notify (UI+push, urgency high) con deep-link.
      await notifier.emit({
        title: `domanda da ${ask.session}`,
        body: ask.question,
        urgency: 'high',
        session: ask.session,
        url: `/#ask=${ask.id}`,
      });
      res.status(201).json({ id: ask.id });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  r.get('/asks', (req, res) => {
    try { res.json({ asks: asks.list({ open: String(req.query.open || '') === '1' }) }); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Answer: READONLY floor (il paste e' una scrittura PTY). F2 (audit): il
  // ciclo e' claim atomico (open -> answering, sincrono, PRIMA dell'await del
  // paste) -> paste -> commit su successo / release su fallimento. Una sola
  // richiesta concorrente vince; le altre vedono 409. Paste fallito -> 502 e
  // l'ask torna open (ri-risponibile dopo il resurrect della cella).
  r.post('/asks/:id/answer', mutGate, json, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      // Validazione del testo PRIMA del claim: nessun claim da rilasciare su 400.
      const raw = req.body && req.body.text;
      if (typeof raw !== 'string') return res.status(400).json({ error: 'text deve essere una stringa' });
      const text = sanitizePasteText(raw).slice(0, MAX_ANSWER);
      if (!text && asks.get(id)) return res.status(400).json({ error: 'text vuoto dopo la sanificazione' });
      const claim = asks.claim(id);
      if (!claim.ok) {
        if (claim.reason === 'unknown') return res.status(404).json({ error: 'ask inesistente' });
        if (claim.reason === 'answering') return res.status(409).json({ error: 'risposta gia\' in corso da un\'altra richiesta' });
        return res.status(409).json({ error: 'ask gia\' risposto' });
      }
      let pasted = false;
      try {
        pasted = await paste(claim.ask.session, `[${replyLabel(cfg)} reply · ask#${id}] ${text}`);
      } catch (_) { pasted = false; }
      if (!pasted) {
        asks.release(id); // rollback: l'ask resta open e contendibile
        return res.status(502).json({ error: `paste fallito: sessione "${claim.ask.session}" non raggiungibile` });
      }
      asks.commit(id, text);
      // Le altre UI aperte tolgono la card/badge senza aspettare il poll.
      notifier.emitRaw({ type: 'ask-answered', id });
      res.json({ answered: true, id });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Body JSON malformato (express.json) -> 400 con causa, mai stack trace.
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'body JSON non valido' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'body troppo grande (limite 16kb)' });
    }
    res.status((err && err.status) || 500).json({ error: String((err && err.message) || err) });
  });

  return r;
}

module.exports = { notifyRoutes, createRateLimiter, sanitizePasteText, replyLabel };
