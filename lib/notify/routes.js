'use strict';
// Routes of the MCP bridge: notify, web-push, asks. Mounted inside the
// router /api gia' dietro requireToken (server.js) — qui restano solo:
//   - READONLY come FLOOR (da revisione): sono gated 403 TUTTI i mutanti — answer
//     (scrittura PTY via paste), push subscribe/unsubscribe (push.json) e la
//     CREAZIONE di ask (persiste asks.json e genererebbe domande non
//     risponibili dallo stesso server). L'UNICA eccezione dichiarata e' la
//     notify: canale informativo inbound cella→operatore, effimero (broadcast SSE +
//     push senza persistenza; anche il cleanup delle subscription morte e'
//     sospeso in READONLY, vedi lib/notify/push.js). Le GET restano lettura
//     pura: /push/vapid in READONLY non genera chiavi (503 se assenti).
//   - rate-limit (da revisione): il campo `session` e' dichiarato dal chiamante e
//     NON e' un confine di sicurezza — il limite che conta e' GLOBALE per
//     principal/token (un Bearer = un'installazione); il bucket per-sessione
//     resta come fairness tra celle oneste. Stessa coppia di limiti sulla
//     creazione ask (da revisione).
//   - validazione input strict fail-closed (schema chiuso per ogni body).
// Il paste della risposta riusa ESATTAMENTE pasteToSession (bracketed literal,
// niente Invio, control char rifiutati): qui si sanifica il testo PRIMA.
const express = require('express');
const { createAskAnswerService } = require('./ask-answer-service.js');
// Gli insiemi degli esiti vivono nella coda: il fan-out decide COSA accodare con
// la stessa definizione con cui la coda decide cosa ritentare. Due copie della
// stessa regola sono due regole che prima o poi divergono.
const { CLOSURE_DONE_STATUSES, CLOSURE_FINAL_STATUSES } = require('./closure-retry.js');
const { isValidSession } = require('../files/store.js');
const { normalizeNotificationLang } = require('./language.js');
const { HOP_HEADER } = require('../proxy/hop-proof.js');
const { createIdentityBindingGuard, expectedFromSession } = require('../identity/binding-guard.js');

const TARGET_RE = /^[a-f0-9]{32}$/i;

// `url` NON e' ammesso, ne' in locale ne' federato: sw.js fa
// clients.openWindow(url) sul click, quindi accettarlo da un peer sarebbe un
// open-redirect dentro la PWA autenticata. Il solo url legittimo lo genera in
// casa la route degli ask (deep-link /#ask=<id>), che non passa da qui.
const NOTIFY_KEYS = new Set(['title', 'body', 'urgency', 'session', 'lang', 'target']);
// Chiavi accettate SOLO su un ingresso federato provato: le mette il
// dispatcher del nodo di origine, non un chiamante locale.
const FEDERATED_KEYS = new Set(['originCell', 'originNode']);
const ASK_KEYS = new Set(['question', 'options', 'session', 'target']);
// Chiavi accettate SOLO su un ingresso federato provato: le mette il dispatcher
// del nodo di origine, non un chiamante locale (stessa regola di FEDERATED_KEYS).
// `ownerNode`/`originNode` qualificano l'identita', `askId` e' l'id con cui
// l'owner conosce la domanda (serve alla risposta per tornare sul bersaglio).
const FEDERATED_ASK_KEYS = new Set(['askId', 'ownerNode', 'originNode', 'originCell', 'closeOutcome']);
const RATE_MAX = 6;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_BUCKETS = 64;
const MAX_TITLE = 200;
const MAX_BODY = 2000;
// Il paste tmux accetta max 4096 char: prefisso `[human reply · ask#xxxxxxxx] `
// (~32 char) + testo -> cap prudente sul testo.
const MAX_ANSWER = 3900;
const MAX_REPLY_LABEL = 48;

// Sliding window in-memory per chiave. La mappa ha un cap duro (da revisione): entry
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

// Coppia di limiti (da revisione): globale per token (confine di sicurezza) + per
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

// Destinatari di una domanda: il `target` esplicito se c'e', altrimenti TUTTI i
// peer autorizzati di questo nodo. L'enumerazione sta qui e non nel dispatcher
// perche' il dispatcher conosce solo il target esatto: una wildcard implicita
// sarebbe un modo per parlare a chi non si e' scelto.
async function resolveFanTargets(peerTargets, target, self) {
  if (target !== undefined) return target === self ? [] : [String(target)];
  if (!peerTargets) return [];
  let list;
  try { list = await peerTargets(); } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = raw && typeof raw === 'object' ? (raw.nodeId || raw.instanceId) : raw;
    const clean = String(id || '');
    if (!TARGET_RE.test(clean)) continue;
    if (self && clean === self) continue;
    if (seen.has(clean)) continue;
    seen.add(clean); out.push(clean);
  }
  return out;
}

// La CHIUSURA di un ask segue la stessa strada dell'andata: chi ha ricevuto la
// domanda deve sapere che e' stata chiusa, altrimenti il suo alias resta aperto
// e ricompare a ogni reload. Vive come funzione a se' — non su una rotta —
// perche' deve partire dal punto in cui la transizione e' AUTOREVOLE (il
// servizio: risposta o scarto, locale o federata) e non da una delle sue porte:
// legarla alle due route locali lasciava fuori la via federata, che e' il caso
// normale quando a rispondere e' un altro nodo.
function createClosureFanout({
  dispatcher = null, peerTargets = null, localNodeId = () => null, log = () => {},
  // Recapito RECUPERABILE: un peer spento in questo istante non e' una chiusura
  // persa. La consegna fallita entra nella coda di ritentativi (lato owner,
  // l'unico lato che puo' riprovare: il ricevente non ha rotta verso l'owner).
  retry = null,
} = {}) {
  async function dispatch({ askId, outcome, session, retryOnFailure = true, targets = null }) {
    if (!dispatcher) return [];
    const self = localNodeId();
    // `targets` esplicito = ritentativo: si va SOLO verso i pendenti, non di
    // nuovo verso tutti. Senza, si enumerano i peer autorizzati come sempre.
    const targets2 = Array.isArray(targets) && targets.length
      ? targets
      : await resolveFanTargets(peerTargets, undefined, self);
    const out = [];
    for (const target of targets2) {
      try {
        const r = await dispatcher.dispatch({
          resource: '/asks',
          target,
          origin: { node: self, cell: session || 'unknown' },
          payload: { askId, closeOutcome: outcome, ownerNode: self },
        });
        out.push({ target, status: r && r.status, ...(r && r.reason ? { reason: r.reason } : {}) });
      } catch (e) {
        out.push({ target, status: 'unknown', reason: 'dispatch-threw' });
        try { log(`chiusura ask ${askId} verso ${target} fallita: ${String(e && e.message || e)}`); } catch (_) {}
      }
    }
    // Si accoda ogni chiusura con recapito PARZIALE, con i SOLI target pendenti.
    // Prima si accodava solo se NESSUNO aveva ricevuto: bastava che un peer
    // rispondesse perche' il peer spento sparisse dalla coda — e la sua copia
    // restava aperta per sempre, perche' da quel lato non c'e' modo di
    // rimediare (il ricevente non ha rotta verso l'owner).
    // Il tentativo nato DALLA coda non si riaccoda (sarebbe autoalimentata): la
    // coda aggiorna da se' il proprio insieme con gli esiti che riceve.
    if (retryOnFailure && retry && out.length) {
      const pendenti = out
        .filter((r) => !CLOSURE_DONE_STATUSES.has(r.status) && !CLOSURE_FINAL_STATUSES.has(r.status))
        .map((r) => r.target);
      try { retry.enqueue({ askId, outcome, session, targets: pendenti }); } catch (_) {}
    }
    return out;
  }
  return { dispatch };
}

function notifyRoutes({
  cfg, notifier, push, asks, paste, sessionExists,
  fleetP = null, instanceId = null, identityMode = 'legacy',
  // Federazione delle notifiche. Assenti (test unitari, montaggi parziali) la
  // route resta esattamente quella locale di prima: nessun percorso nuovo si
  // apre per omissione.
  localNodeId = () => null, originResolver = null, acl = null, dispatcher = null,
  // Elenco dei peer autorizzati di questo nodo, per il fan-out di default.
  peerTargets = null,
  federatedRate = null,
  answerService = null, receipts = null, log = () => {},
  // Recapito della chiusura: iniettato dal server perche' e' lo STESSO oggetto
  // che il servizio usa nell'hook di transizione (una sola implementazione).
  closureFanout: closureFanoutDep = null,
  // Riconciliazione degli alias importati, iniettata dal server: chiede
  // all'owner lo stato delle domande ancora aperte per questa copia.
  reconcileImported = null,
  // Coda dei recapiti di chiusura non riusciti (lato owner). Iniettata dal
  // server: la stessa che il fan-out alimenta.
  closureRetry = null,
}) {
  // The shared answer cycle is built from the local deps when the caller does
  // not inject one: the local route and the federated surface must never drift
  // into two different implementations.
  const askService = answerService || createAskAnswerService({
    asks, paste,
    labelPrefix: replyLabel(cfg),
    onClosure: (kind, info) => { try { notifier.emitRaw({ type: kind, id: info.askId }); } catch (_) {} },
  });
  const r = express.Router();
  const json = express.json({ limit: '16kb' });
  const bindingGuard = createIdentityBindingGuard({
    fleetP, instanceId, now: () => Date.now(), sharedRequired: identityMode === 'authority',
  });

  async function guardBinding(req, session = null) {
    try {
      const expected = expectedFromSession(session, instanceId);
      return await bindingGuard.verify(req, { expected, localOnly: true });
    } catch (e) {
      return e;
    }
  }

  function bindingRejected(res, error) {
    return res.status(403).json({ error: error.message, code: error.code });
  }

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
      // Un ingresso e' federato solo se porta la prova di hop. Si stabilisce
      // PRIMA di guardare il body: quali chiavi sono lecite dipende da come la
      // richiesta e' arrivata, non da cosa dichiara.
      const federated = !!(originResolver && req.headers && req.headers[HOP_HEADER]);
      for (const k of Object.keys(b)) {
        if (NOTIFY_KEYS.has(k)) continue;
        if (federated && FEDERATED_KEYS.has(k)) continue;
        return res.status(400).json({ error: `chiave non ammessa: "${k}" (schema: title, body?, urgency?, session?, lang?, target?)` });
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
      const lang = b.lang === undefined ? undefined : normalizeNotificationLang(b.lang);
      if (b.lang !== undefined && !lang) {
        return res.status(400).json({ error: 'lang deve essere it, en, es o un locale BCP-47 con una di queste lingue base' });
      }
      if (b.session !== undefined && !isValidSession(b.session)) {
        return res.status(400).json({ error: 'session non valida' });
      }
      if (b.target !== undefined && !TARGET_RE.test(String(b.target))) {
        return res.status(400).json({ error: 'target deve essere un instanceId di nodo' });
      }
      const self = localNodeId();

      // --- ingresso FEDERATO: la notifica arriva da un altro nodo -----------
      if (federated) {
        const resolved = await originResolver.resolve(req, { requireCell: true });
        if (!resolved.ok) return res.status(403).json({ status: 'refused', reason: resolved.reason });
        // Il target e' esatto e va confermato QUI: una route puo' consegnare a
        // un nodo diverso da quello che il mittente credeva.
        if (!self || b.target !== self) {
          return res.status(404).json({ status: 'refused', reason: 'wrong-target' });
        }
        const verdict = acl ? acl.allows(resolved) : { allowed: false, reason: 'acl-unavailable' };
        if (!verdict.allowed) return res.status(403).json({ status: 'refused', reason: verdict.reason });
        // Budget SEPARATO da quello locale: senza, un peer rumoroso non solo
        // spamma ma affama le notifiche delle celle di casa, che condividono
        // lo stesso bucket da 6/60s.
        if (federatedRate) {
          const quota = federatedRate.check({ origin: resolved.origin, target: self, urgency: b.urgency });
          if (!quota.allowed) {
            return res.status(429).json({ status: 'refused', reason: `rate-${quota.bucket}` });
          }
        }
        // Delivery ONLY: a federated notify is delivered to this node's UI
        // and never re-enters the event publisher (no loop, no re-export).
        const delivered = await notifier.deliverOnly({
          title: b.title.trim(), body: b.body, urgency: b.urgency, lang,
          // Il mittente NON e' `b.session`: quel campo lo dichiara il chiamante.
          // Qui vale solo cio' che la catena ha provato, piu' la cella che il
          // nodo di origine attesta.
          originNode: resolved.origin.node,
          originCell: resolved.origin.cell,
        });
        // : lo status e' DERIVATO dai conteggi, non dichiarato a parte.
        // `emit` e' best-effort — push fallito → 0, `ui` conta i write SSE
        // riusciti — e il dispatcher propaga SOLO l'etichetta (i conteggi
        // muoiono in forward(), rilievo da revisione): per la cella mittente e'
        // tutta l'informazione. Non puo' affermare una consegna che i conteggi
        // smentiscono: zero canali raggiunti → 'no-delivery'.
        const status = delivered.ui + delivered.push > 0 ? 'delivered' : 'no-delivery';
        return res.json({ status, delivered });
      }

      // --- target remoto: instrada, non consegnare qui -----------------------
      if (b.target !== undefined && dispatcher && self && b.target !== self) {
        const out = await dispatcher.dispatch({
          resource: '/notify',
          target: b.target,
          // La cella di origine e' quella DICHIARATA dal chiamante locale: viene
          // trasmessa come attestazione, e il target la trattera' come tale.
          origin: { node: self, cell: b.session || 'unknown' },
          payload: { title: b.title.trim(), ...(b.body ? { body: b.body } : {}), ...(b.urgency ? { urgency: b.urgency } : {}), ...(lang ? { lang } : {}) },
        });
        return res.json(out);
      }

      const binding = await guardBinding(req, b.session);
      if (binding instanceof Error) return bindingRejected(res, binding);
      const sender = b.session || 'unknown';
      if (!allowNotify(sender)) {
        return res.status(429).json({ error: 'rate limit notify superato (limite globale per token + per sessione)' });
      }
      const delivered = await notifier.emit({
        title: b.title.trim(), body: b.body, urgency: b.urgency, session: b.session, lang,
      });
      res.json({ delivered });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // --- web-push --------------------------------------------------------------
  // GET lettura pura; in READONLY push.vapidPublicKey() NON genera chiavi e
  // segnala 503 (e.status) se assenti — da revisione.
  r.get('/push/vapid', (_req, res) => {
    try { res.json({ publicKey: push.vapidPublicKey() }); }
    catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });

  r.post('/push/subscribe', mutGate, json, async (req, res) => {
    try {
      const sub = req.body && req.body.subscription;
      const out = await push.subscribe(sub);
      // da revisione: cap sul numero di subscription -> 429 (quota), input invalido -> 400.
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
  // Destinatari di una domanda (nessun `target` = tutti i nodi dell'owner): il
  // `target` esplicito se
  // c'e', altrimenti TUTTI i peer autorizzati di questo nodo — una domanda e'
  // per l'utente, ovunque sia. L'enumerazione sta QUI e non nel dispatcher
  // perche' il dispatcher non conosce i broadcast: target esatto soltanto, e
  // deve restare cosi' (una wildcard implicita e' un modo per parlare a chi non
  // si e' scelto).
  const askFanTargets = (target, self) => resolveFanTargets(peerTargets, target, self);
  const closureFanout = closureFanoutDep || createClosureFanout({ dispatcher, peerTargets, localNodeId, log, retry: closureRetry });

  // da revisione: gated READONLY (mutGate) — crea stato durevole (asks.json) e domande
  // che lo stesso server vieterebbe di rispondere. da revisione: rate-limit creazione
  // (globale per token + per sessione) + cap duro dello store -> 429.
  r.post('/asks', mutGate, json, async (req, res) => {
    try {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return res.status(400).json({ error: 'body deve essere un oggetto JSON' });
      }
      // Come per /notify: un ingresso e' federato solo se porta la prova di hop,
      // e si stabilisce PRIMA di guardare il body — quali chiavi sono lecite
      // dipende da come la richiesta e' arrivata, non da cosa dichiara.
      const federated = !!(originResolver && req.headers && req.headers[HOP_HEADER]);
      for (const k of Object.keys(b)) {
        if (ASK_KEYS.has(k)) continue;
        if (federated && FEDERATED_ASK_KEYS.has(k)) continue;
        return res.status(400).json({ error: `chiave non ammessa: "${k}" (schema: question, options?, session, target?)` });
      }
      if (b.target !== undefined && !TARGET_RE.test(String(b.target))) {
        return res.status(400).json({ error: 'target deve essere un instanceId di nodo' });
      }
      // Validazione del contenuto PRIMA del rate check: gli input invalidi (400)
      // non consumano budget; il rate scatta solo su richieste ben formate.
      // Una CHIUSURA non porta domanda: non c'e' contenuto da validare.
      const isClosure = b.closeOutcome === 'dismissed' || b.closeOutcome === 'answered';
      if (!isClosure) {
        const v = asks.validate({ question: b.question, options: b.options });
        if (!v.ok) return res.status(400).json({ error: v.error });
      }
      const self = localNodeId();

      // --- ingresso FEDERATO: la domanda arriva da un altro nodo -------------
      if (federated) {
        const resolved = await originResolver.resolve(req, { requireCell: true });
        if (!resolved.ok) return res.status(403).json({ status: 'refused', reason: resolved.reason });
        // Il target e' esatto e va confermato QUI: una route puo' consegnare a
        // un nodo diverso da quello che il mittente credeva.
        if (!self || b.target !== self) {
          return res.status(404).json({ status: 'refused', reason: 'wrong-target' });
        }
        const verdict = acl ? acl.allows(resolved) : { allowed: false, reason: 'acl-unavailable' };
        if (!verdict.allowed) return res.status(403).json({ status: 'refused', reason: verdict.reason });
        // Budget SEPARATO da quello locale: senza, un peer rumoroso affamerebbe
        // le domande delle celle di casa, che condividono lo stesso bucket.
        // Una CHIUSURA non consuma quella quota: non e' una domanda nuova, e
        // far pagare anche a lei il budget di creazione significa che un burst
        // di domande legittimo (6 in un minuto, ammesso dal prodotto) lascia
        // gli alias aperti sui peer — il successo locale nasconderebbe lo stato
        // falso. Le chiusure sono limitate dal proprio percorso di recapito.
        if (federatedRate && !isClosure) {
          const quota = federatedRate.check({ origin: resolved.origin, target: self, urgency: 'high' });
          if (!quota.allowed) {
            return res.status(429).json({ status: 'refused', reason: `rate-${quota.bucket}` });
          }
        }
        // --- chiusura di un ask importato: l'owner ha risposto o scartato ---
        // L'alias locale va chiuso DUREVOLMENTE: senza, la domanda resta aperta
        // qui e ricompare a ogni reload, e resterebbe pure risponibile su una
        // cella che non e' la sua.
        if (isClosure) {
          const owner = resolved.origin.node;
          const closed = asks.closeImported({
            ownerId: owner, ownerAskId: b.askId, outcome: b.closeOutcome,
          });
          if (closed.changed && closed.ask) {
            // Il frame porta l'id LOCALE: e' quello con cui questa UI identifica
            // la card, e senza di esso la card resterebbe a schermo.
            notifier.deliverOnlyRaw({
              type: b.closeOutcome === 'dismissed' ? 'ask-dismissed' : 'ask-answered',
              id: closed.ask.id,
              ownerId: owner,
            });
          }
          return res.json({ status: 'delivered', closed: closed.changed });
        }
        // La `session` dichiarata NON e' verificabile qui — la cella vive sul
        // nodo di origine, e `sessionExists` guarderebbe il tmux di QUESTO nodo.
        // Non si pretende quindi una sessione locale: si registra per
        // attribuzione, e il paste avverra' sulla cella dell'owner via ask-relay.
        const owner = resolved.origin.node;
        const out = asks.create({
          question: b.question,
          options: b.options,
          session: b.session || resolved.origin.cell || 'unknown',
          // L'ask e' di un ALTRO nodo: `ownerId` e' quello che fa instradare la
          // risposta al proprietario invece di incollarla qui.
          ownerId: owner,
          // L'id con cui l'OWNER conosce la domanda: e' quello che la risposta
          // deve citare. Il nostro `id` locale resta nostro.
          ownerAskId: b.askId,
          originNode: owner,
          originCell: resolved.origin.cell,
        });
        if (!out.ok) {
          return res.status(out.reason === 'cap' ? 429 : 400).json({ status: 'refused', reason: out.reason, error: out.error });
        }
        const ask = out.ask;
        // deliverOnly: consegna locale alla UI, NIENTE pubblicazione sul feed e
        // niente ri-esportazione. E' l'invariante che uccide il loop A->B->A per
        // costruzione — un ask importato non torna mai indietro, esattamente
        // come una notify federata.
        notifier.deliverOnlyRaw({ type: 'ask', ask });
        await notifier.deliverOnly({
          title: `domanda da ${ask.session}`,
          body: ask.question,
          urgency: 'high',
          session: ask.session,
          lang: 'it',
          askId: ask.id,
          url: `/#ask=${ask.id}`,
        });
        return res.json({ status: 'delivered', id: ask.id, ownerId: ask.ownerId });
      }

      // --- domanda locale ----------------------------------------------------
      // session obbligatoria E viva: la risposta va incollata li' — un ask senza
      // recapito verificabile e' fail-closed subito, non al momento dell'answer.
      if (!isValidSession(b.session)) return res.status(400).json({ error: 'session non valida' });
      if (!sessionExists(b.session)) return res.status(404).json({ error: 'sessione tmux inesistente' });
      const binding = await guardBinding(req, b.session);
      if (binding instanceof Error) return bindingRejected(res, binding);
      if (!allowAsk(b.session)) {
        return res.status(429).json({ error: 'rate limit ask superato (limite globale per token + per sessione)' });
      }
      // NB: un ask LOCALE non porta `ownerId`. Il campo significa «questa
      // domanda appartiene a un altro nodo», ed e' quello che fa scegliere alla
      // UI il ritorno federato (ask-relay) invece del paste locale: metterlo
      // anche qui manderebbe la risposta di casa a cercare un owner inesistente.
      const out = asks.create({ question: b.question, options: b.options, session: b.session });
      if (!out.ok) return res.status(out.reason === 'cap' ? 429 : 400).json({ error: out.error });
      const ask = out.ask;
      // FAN-OUT **prima** dell'emissione locale. Un peer irraggiungibile e'
      // un esito da riportare, mai un blocco: la domanda deve nascere su questo
      // nodo comunque, e il chiamante vede chi ha accettato e chi no.
      const targets = dispatcher ? await askFanTargets(b.target, self) : [];
      const fanout = [];
      for (const target of targets) {
        try {
          const r = await dispatcher.dispatch({
            resource: '/asks',
            target,
            // La cella di origine e' quella DICHIARATA dal chiamante locale:
            // viaggia come attestazione, e il target la trattera' come tale.
            origin: { node: self, cell: b.session },
            payload: {
              question: ask.question,
              ...(ask.options ? { options: ask.options } : {}),
              session: ask.session,
              askId: ask.id,
              ownerNode: self,
            },
          });
          fanout.push({ target, status: r && r.status, ...(r && r.reason ? { reason: r.reason } : {}) });
        } catch (e) {
          fanout.push({ target, status: 'unknown', reason: 'dispatch-threw' });
          try { log(`ask fan-out verso ${target} fallito: ${String(e && e.message || e)}`); } catch (_) {}
        }
      }
      if (fanout.length) {
        try {
          log(`ask ${ask.id}: fan-out verso ${fanout.length} peer → ${fanout.map((f) => `${f.target.slice(0, 8)}:${f.status}`).join(', ')}`);
        } catch (_) {}
      }
      // Frame dedicato per le UI aperte (card/badge live, senza aspettare il poll)…
      notifier.emitRaw({ type: 'ask', ask });
      // …e ogni ask emette anche notify (UI+push, urgency high) con deep-link.
      await notifier.emit({
        title: `domanda da ${ask.session}`,
        body: ask.question,
        urgency: 'high',
        session: ask.session,
        lang: 'it',
        askId: ask.id,
        url: `/#ask=${ask.id}`,
      });
      res.status(201).json({ id: ask.id, ...(fanout.length ? { fanout } : {}) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  r.get('/asks', async (req, res) => {
    try {
      // Riconciliazione del ricevente: prima di servire l'elenco si chiede
      // all'owner lo stato degli alias aperti. E' il percorso che recupera una
      // chiusura mai recapitata (peer spento mentre l'owner chiudeva): senza,
      // l'alias resta aperto per sempre e la card mente. Best-effort: un owner
      // irraggiungibile non chiude nulla e non fa fallire la lettura.
      if (reconcileImported) { try { await reconcileImported(); } catch (_) {} }
      // Recapito recuperabile, lato OWNER: i peer che erano spenti quando la
      // chiusura e' partita vengono ritentati ADESSO. Chi legge lo stato sta
      // guardando le card, ed e' esattamente il momento in cui una card
      // rimasta aperta per un recapito fallito va rimessa in pari. Best-effort:
      // un peer ancora irraggiungibile resta in coda, non fa fallire la lettura.
      if (closureRetry) { try { await closureRetry.drain('read'); } catch (_) {} }
      res.json({ asks: asks.list({ open: String(req.query.open || '') === '1' }) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Dismiss (scarta domanda): NON cancella la riga, la marca `dismissed` (lo
  // storico serve). Stesso mutGate degli altri mutanti (da revisione: scrittura durevole).
  // Idempotente; 404 se id inesistente; 409 se answering (claim attivo: non si
  // scarta una risposta in corso). Emette il frame per le UI aperte come fa
  // POST /asks con emitRaw: la card sparisce senza aspettare il poll.
  r.delete('/asks/:id', mutGate, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const ask = asks.get(id);
      const binding = await guardBinding(req, ask && ask.session);
      if (binding instanceof Error) return bindingRejected(res, binding);
      // Same service as the federated path: one authoritative state, so the
      // pending/unknown constraint cannot be bypassed from here.
      const out = askService.dismiss(id);
      if (!out.ok) {
        if (out.reason === 'unknown') return res.status(404).json({ error: 'ask inesistente' });
        if (out.reason === 'delivery-unknown-block') return res.status(409).json({ error: out.error, reason: out.reason });
        if (out.reason === 'answering') return res.status(409).json({ error: 'risposta in corso: non si scarta un ask in answering' });
        return res.status(500).json({ error: 'dismiss non riuscito' });
      }
      notifier.emitRaw({ type: 'ask-dismissed', id });
      // La chiusura nasce nel SERVIZIO (punto comune di transizione); qui si
      // aspetta il suo recapito, cosi' la risposta non precede la chiusura sui
      // peer e un burst di scarti non lascia alias aperti.
      if (out.closure) { try { await out.closure; } catch (_) {} }
      res.json({ dismissed: true, id });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Answer: READONLY floor (il paste e' una scrittura PTY). da revisione: il
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
      // Oltre il tetto si RIFIUTA, non si tronca. I due tetti vicini in casa
      // (title/body della notifica, nc_send_cell) rifiutano da sempre; qui invece
      // la textarea non ha limite, la route troncava a MAX_ANSWER e rispondeva
      // {answered:true}: l'operatore incollava una config e la cella riceveva la
      // meta' senza marcatore. Il tetto si misura DOPO la sanificazione: conta
      // il testo che arriva alla cella, non quello digitato.
      const sanitized = sanitizePasteText(raw);
      // La lunghezza misurata ENTRA nel messaggio: la route la conosce, e senza
      // di essa chi ha incollato 12000 caratteri sa che c'e' un tetto ma non di
      // quanto deve tagliare. Dirti che hai sbagliato senza dirti di quanto e'
      // La stessa meta' di difetto che corregge altrove.
      if (sanitized.length > MAX_ANSWER) {
        return res.status(400).json({ error: `text troppo lungo: ${sanitized.length} caratteri, il massimo e' ${MAX_ANSWER}` });
      }
      const text = sanitized;
      if (!text && asks.get(id)) return res.status(400).json({ error: 'text vuoto dopo la sanificazione' });
      const ask = asks.get(id);
      const binding = await guardBinding(req, ask && ask.session);
      if (binding instanceof Error) return bindingRejected(res, binding);
      // ONE answer cycle for local and federated: the service owns the
      // claim -> paste -> commit flow AND the delivery-unknown lock. The
      // closure event is emitted by the service, not here.
      const out = await askService.answerLocal({ askId: id, text });
      if (!out.ok) return res.status(out.code || 500).json({ error: out.error });
      // Come per il dismiss: la chiusura nasce nel servizio, qui si aspetta.
      if (out.closure) { try { await out.closure; } catch (_) {} }
      res.json({ answered: true, id });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // Explicit reconciliation: local and authenticated only, NEVER
  // federata (la route non e' in allowlist). Decide l'esito dei tentativi
  // delivery-unknown e sblocca l'ask; CAS facoltativa sulla revisione.
  r.post('/asks/:id/reconcile', mutGate, json, (req, res) => {
    try {
      const id = String(req.params.id || '');
      const ask = asks.get(id);
      if (!ask) return res.status(404).json({ error: 'ask inesistente' });
      const body = req.body || {};
      const decision = body.decision;
      if (decision !== 'mark-delivered' && decision !== 'allow-new-attempt') {
        return res.status(400).json({ error: 'decision deve essere mark-delivered|allow-new-attempt' });
      }
      const out = askService.reconcile({ askId: id, decision, expectedRevision: body.expectedRevision });
      if (!out.ok) {
        if (out.reason === 'revision-required' || out.reason === 'bad-decision') {
          return res.status(400).json({ error: out.error, reason: out.reason });
        }
        if (out.reason === 'revision-conflict') return res.status(409).json({ error: out.error, reason: out.reason });
        if (out.reason === 'unknown') return res.status(404).json({ error: out.error, reason: out.reason });
        if (out.reason === 'persist-failed') {
          return res.status(500).json({ error: 'reconcile non persistito: ask ancora bloccato', reason: out.reason });
        }
        // Il servizio dichiara il proprio codice: il rifiuto di una
        // riconciliazione su un paste VIVO (answering) o senza alcun esito
        // incerto da riconciliare (nothing-to-reconcile, generation-changed)
        // e' una decisione dell'operatore rifiutata, non un errore interno.
        if (out.code === 409) {
          return res.status(409).json({ error: out.error, reason: out.reason });
        }
        return res.status(500).json({ error: out.error || 'reconcile non riuscito', reason: out.reason });
      }
      res.json({ reconciled: true, askId: id, decision, attempts: out.changed, revision: out.revision });
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

module.exports = { notifyRoutes, createRateLimiter, sanitizePasteText, replyLabel, createClosureFanout, resolveFanTargets };
