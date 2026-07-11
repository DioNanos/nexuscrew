'use strict';
// Web Push per il MCP bridge (design §2b). Chiavi VAPID generate LAZY al primo
// uso (mai allo startup: i test che creano il server con path isolati non devono
// scrivere in ~/.nexuscrew) e persistite in <dir>/vapid.json 0600; subscription
// in <dir>/push.json 0600, dedup per endpoint. Su push fallito 404/410 la
// subscription viene rimossa (MA non in READONLY: il cleanup e' una scrittura).
// Il sender e' iniettabile (webpushImpl) cosi' i test non toccano MAI la rete;
// la chiave PRIVATA non esce da questo modulo.
//
// F7 (audit, threat model SSRF): sendNotification fa una richiesta server-side.
// Ogni endpoint e' https-only, viene risolto sia al subscribe sia immediatamente
// prima del send, e la richiesta usa un https.Agent con lookup PINNATO agli IP
// verificati. Cosi' un secondo lookup/DNS rebinding non puo' cambiare destinazione.
// Redirect non seguiti: web-push usa https.request diretto; una risposta 3xx e'
// un errore e non viene mai trasformata in una seconda richiesta.
const path = require('node:path');
const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const { readJsonSafe, atomicWriteJson } = require('./persist.js');

const VAPID_FILE = 'vapid.json';
const SUBS_FILE = 'push.json';
// Subject VAPID richiesto dallo standard (URL o mailto); nessun host interno.
const VAPID_SUBJECT = 'mailto:nexuscrew@example.com';
const MAX_ENDPOINT_LEN = 2048;
const MAX_KEY_LEN = 512;
const DEFAULT_MAX_SUBS = 32;

// IPv4 non globale: private, loopback, link-local, carrier-grade NAT,
// documentation/benchmark, multicast/reserved. Garbage -> true (fail-closed).
function isNonGlobalV4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6Words(input) {
  let ip = String(input || '').toLowerCase();
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.includes('.')) {
    const cut = ip.lastIndexOf(':');
    const v4 = ip.slice(cut + 1);
    if (net.isIP(v4) !== 4) return null;
    const p = v4.split('.').map(Number);
    ip = `${ip.slice(0, cut)}:${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const raw = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (raw.length !== 8 || raw.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return raw.map((x) => parseInt(x, 16));
}

function isNonGlobalV6(ip) {
  const w = ipv6Words(ip);
  if (!w) return true;
  // unspecified/loopback e tutto lo spazio IPv4-compatible /96.
  if (w.slice(0, 6).every((x) => x === 0)) return true;
  // IPv4-mapped ::ffff:0:0/96: rifiuto dell'intera famiglia per evitare encoding evasivi.
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return true;
  if ((w[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((w[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10 (fe80..febf)
  if ((w[0] & 0xffc0) === 0xfec0) return true; // site-local deprecato fec0::/10
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  // IPv4-in-IPv6/transizione: rifiuto dell'intero prefisso, anche se l'IPv4
  // incorporato appare pubblico, per evitare rappresentazioni evasive.
  if (w[0] === 0x0064 && w[1] === 0xff9b
    && (w.slice(2, 6).every((x) => x === 0) || w[2] === 0x0001)) return true; // NAT64
  if (w[0] === 0x2002) return true; // 6to4
  if (w[4] === 0 && w[5] === 0x5efe) return true; // ISATAP
  if (w[0] === 0x2001 && (w[1] === 0x0000 || w[1] === 0x0db8)) return true; // special/documentation
  return false;
}

function isNonGlobalIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isNonGlobalV4(address);
  if (family === 6) return isNonGlobalV6(address);
  return true;
}

// Host vietati quando espressi come letterali; gli hostname passano poi dal DNS.
function isForbiddenHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === 'localhost.' || h.endsWith('.localhost')) return true;
  const literal = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (net.isIP(literal)) return isNonGlobalIp(literal);
  return false;
}

// Validazione subscription fail-closed. {ok:true} | {ok:false, error}.
function validateSubscription(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'subscription non valida' };
  if (typeof s.endpoint !== 'string' || !s.endpoint) return { ok: false, error: 'endpoint mancante' };
  if (s.endpoint.length > MAX_ENDPOINT_LEN) return { ok: false, error: `endpoint troppo lungo (max ${MAX_ENDPOINT_LEN})` };
  let url;
  try { url = new URL(s.endpoint); } catch (_) { return { ok: false, error: 'endpoint non e\' un URL valido' }; }
  if (url.protocol !== 'https:') return { ok: false, error: 'endpoint deve essere https (i push service usano solo https)' };
  if (url.username || url.password) return { ok: false, error: 'endpoint con credenziali non ammesso' };
  if (isForbiddenHost(url.hostname)) return { ok: false, error: 'endpoint verso host loopback/privato non ammesso' };
  if (!s.keys || typeof s.keys !== 'object' || Array.isArray(s.keys)
    || typeof s.keys.p256dh !== 'string' || !s.keys.p256dh || s.keys.p256dh.length > MAX_KEY_LEN
    || typeof s.keys.auth !== 'string' || !s.keys.auth || s.keys.auth.length > MAX_KEY_LEN) {
    return { ok: false, error: 'subscription.keys non valide (p256dh, auth)' };
  }
  return { ok: true };
}

async function resolvePublicEndpoint(endpoint, lookupImpl = dns.promises.lookup) {
  const url = new URL(endpoint);
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (net.isIP(host)) {
    if (isNonGlobalIp(host)) throw new Error('endpoint verso indirizzo non globale non ammesso');
    return { hostname: host, addresses: [{ address: host, family: net.isIP(host) }] };
  }
  let answers;
  try { answers = await lookupImpl(host, { all: true, verbatim: true }); }
  catch (_) { throw new Error('DNS endpoint non risolvibile'); }
  if (!Array.isArray(answers)) answers = answers ? [answers] : [];
  if (!answers.length || answers.some((a) => !a || isNonGlobalIp(a.address))) {
    throw new Error('DNS endpoint contiene un indirizzo non globale');
  }
  return {
    hostname: host,
    addresses: answers.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) })),
  };
}

function pinnedAgent(resolved) {
  let next = 0;
  return new https.Agent({
    keepAlive: false,
    maxCachedSessions: 0,
    lookup(hostname, options, callback) {
      if (String(hostname).toLowerCase() !== resolved.hostname.toLowerCase()) {
        callback(new Error('DNS hostname inatteso durante il send'));
        return;
      }
      if (options && options.all) {
        callback(null, resolved.addresses.map((a) => ({ ...a })));
        return;
      }
      const answer = resolved.addresses[next++ % resolved.addresses.length];
      callback(null, answer.address, answer.family);
    },
  });
}

function createPushService(opts = {}) {
  if (!opts.dir) throw new Error('createPushService: dir richiesta');
  const vapidPath = path.join(opts.dir, VAPID_FILE);
  const subsPath = path.join(opts.dir, SUBS_FILE);
  // F3: closure iniettata dal server — in READONLY questo modulo non scrive MAI
  // (niente generazione VAPID, niente cleanup subscription).
  const readonly = typeof opts.readonly === 'function' ? opts.readonly : () => false;
  const lookupImpl = opts.lookupImpl || dns.promises.lookup;
  const maxSubs = Number.isInteger(opts.maxSubs) && opts.maxSubs > 0 ? opts.maxSubs : DEFAULT_MAX_SUBS;
  // Seam test: {generateVAPIDKeys, sendNotification}. Default: npm web-push.
  // require LAZY: il modulo nativo si carica solo se il push viene davvero usato.
  let webpush = opts.webpushImpl || null;
  function impl() {
    if (!webpush) webpush = require('web-push');
    return webpush;
  }

  // --- VAPID (lazy) ---------------------------------------------------------
  let vapid = null;
  function loadVapid() {
    if (vapid && vapid.publicKey && vapid.privateKey) return vapid;
    const cur = readJsonSafe(vapidPath); // fail-closed su mode/owner/symlink (F4)
    if (typeof cur.publicKey === 'string' && cur.publicKey
      && typeof cur.privateKey === 'string' && cur.privateKey) {
      vapid = { publicKey: cur.publicKey, privateKey: cur.privateKey };
      return vapid;
    }
    // F3: la generazione e' una SCRITTURA — vietata in READONLY (503 esplicito,
    // niente vapid.json fantasma).
    if (readonly()) {
      const e = new Error('READONLY: chiavi VAPID assenti e non generabili (riavvia senza READONLY per il primo setup push)');
      e.status = 503;
      throw e;
    }
    const keys = impl().generateVAPIDKeys();
    vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    atomicWriteJson(vapidPath, vapid);
    return vapid;
  }

  function vapidPublicKey() { return loadVapid().publicKey; }

  // --- subscription store ----------------------------------------------------
  function readSubs() {
    const cur = readJsonSafe(subsPath);
    return Array.isArray(cur.subscriptions) ? cur.subscriptions : [];
  }
  function writeSubs(list) { atomicWriteJson(subsPath, { subscriptions: list }); }

  // Persiste (dedup per endpoint: la nuova sostituisce la vecchia). Cap duro sul
  // numero: un endpoint NUOVO oltre maxSubs viene rifiutato (reason 'cap').
  async function subscribe(subscription) {
    const v = validateSubscription(subscription);
    if (!v.ok) return { ok: false, error: v.error };
    try { await resolvePublicEndpoint(subscription.endpoint, lookupImpl); }
    catch (e) { return { ok: false, error: e.message }; }
    const cur = readSubs();
    const keep = cur.filter((s) => s.endpoint !== subscription.endpoint);
    if (keep.length === cur.length && cur.length >= maxSubs) {
      return { ok: false, reason: 'cap', error: `troppe subscription push (max ${maxSubs}): rimuovine una prima` };
    }
    keep.push({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } });
    writeSubs(keep);
    return { ok: true, count: keep.length };
  }

  function unsubscribe(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint) return { ok: false, error: 'endpoint mancante' };
    const cur = readSubs();
    const keep = cur.filter((s) => s.endpoint !== endpoint);
    if (keep.length !== cur.length) writeSubs(keep);
    return { ok: true, removed: cur.length - keep.length };
  }

  function count() { return readSubs().length; }

  // Invia il payload a tutte le subscription. 404/410 (endpoint morto) -> la
  // subscription si rimuove, MA NON in READONLY (F3: riscrivere push.json e' una
  // scrittura persistente; la notify viene comunque consegnata alle vive).
  // Nessuna subscription -> {sent:0} senza generare VAPID (resta lazy davvero).
  async function sendToAll(payload) {
    const subs = readSubs();
    if (subs.length === 0) return { sent: 0, removed: 0 };
    const { publicKey, privateKey } = loadVapid();
    const body = JSON.stringify(payload);
    let sent = 0;
    const dead = new Set();
    for (const sub of subs) {
      let agent;
      try {
        const valid = validateSubscription(sub); // anche store legacy/manomesso: fail-closed al send
        if (!valid.ok) throw new Error(valid.error);
        const resolved = await resolvePublicEndpoint(sub.endpoint, lookupImpl);
        agent = pinnedAgent(resolved);
        const response = await impl().sendNotification(sub, body, {
          vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey },
          TTL: 3600,
          agent,
        });
        if (response && Number.isInteger(response.statusCode)
          && (response.statusCode < 200 || response.statusCode > 299)) {
          const e = new Error('redirect/risposta push non ammessa');
          e.statusCode = response.statusCode;
          throw e;
        }
        sent += 1;
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) dead.add(sub.endpoint);
        // altri errori: transitori, la subscription resta (best-effort, mai throw)
      } finally { if (agent) agent.destroy(); }
    }
    if (dead.size && !readonly()) writeSubs(subs.filter((s) => !dead.has(s.endpoint)));
    return { sent, removed: dead.size };
  }

  return { vapidPublicKey, subscribe, unsubscribe, count, sendToAll, validateSubscription };
}

module.exports = {
  createPushService, validateSubscription, isForbiddenHost,
  isNonGlobalIp, resolvePublicEndpoint, pinnedAgent,
};
