// Modello puro di settings + first-run wizard (design §5, B2-UI). Nessun React,
// nessun fetch: stati, transizioni e validazione form — importabile nei test node
// (pattern grid-model/deck-model). La validazione RISPECCHIA i contratti server
// (lib/nodes/store.js: NODE_NAME_RE, parseSsh strict, isPort) così la UI rifiuta
// in locale quello che l'API rifiuterebbe comunque, con messaggi i18n; l'API
// resta l'autorità (fail-closed) su tutto ciò che passa.

export const NODE_NAME_RE = /^[a-z0-9-]{1,32}$/;
const SSH_USER_RE = /^[A-Za-z0-9._-]{1,32}$/;
const SSH_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MAX_SSH_LEN = 320;

export function isValidNodeName(n) {
  return typeof n === 'string' && NODE_NAME_RE.test(n);
}

// Label umana (display) vs slug (routing). Mirror frontend di lib/nodes/store.js
// (toSlug/sanitizeLabel/validLabel): la UI deriva lo slug dalla label che l'utente
// scrive liberamente (es. "Home Relay" -> "home-relay"), cosi' il routing usa un segmento
// sicuro senza obbligare l'utente a pensare in slug. Validazione che rispecchia
// il server (fail-closed): l'API resta l'autorita'.
export const LABEL_MAX = 64;
export function isValidLabel(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s.length > 0 && s.length <= LABEL_MAX && !/[\x00-\x1f\x7f]/.test(s);
}
export function toSlug(input) {
  const s = String(input == null ? '' : input)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 32).replace(/-+$/g, '');
  return s || 'node';
}
// Slug univoco: derivato dalla label, disambiguato -2/-3 contro i name esistenti.
export function suggestNodeName(label, existing = []) {
  const used = new Set(Array.isArray(existing) ? existing : []);
  const base = toSlug(label);
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base.slice(0, Math.max(1, 32 - String(i).length - 1))}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

// Target OpenSSH (mirror di lib/nodes/store.js parseSshTarget): accetta sia
// user@host sia un Host alias già governato dall'utente in ~/.ssh/config.
// È sempre un singolo argv: niente whitespace/control e niente leading '-'.
export function isValidSsh(s) {
  if (typeof s !== 'string' || !s || s.length > MAX_SSH_LEN) return false;
  if (s.startsWith('-') || /[\0-\x20\x7f]/.test(s)) return false;
  if (!s.includes('@')) return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(s);
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return false;
  return SSH_USER_RE.test(s.slice(0, at)) && SSH_HOST_RE.test(s.slice(at + 1));
}

// Porta da input form: '' / null / undefined = assente (null). Stringa o numero
// intero 1..65535 = numero. Qualunque altra cosa = undefined (invalida).
export function parsePort(v) {
  if (v === '' || v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^[0-9]{1,5}$/.test(s)) return undefined;
  const n = Number(s);
  return (Number.isInteger(n) && n >= 1 && n <= 65535) ? n : undefined;
}

// Valida il form "aggiungi nodo" (wizard step 2 + settings). Ritorna
// {ok:true, value:{name, ssh, sshPort?, remotePort?}} oppure
// {ok:false, error:<chiave i18n>}. sshPort e' la porta del trasporto SSH;
// remotePort e' la porta HTTP loopback di NexusCrew sul nodo remoto.
export function validateNodeForm({ name, ssh, sshPort, remotePort } = {}) {
  const n = typeof name === 'string' ? name.trim() : name;
  const s = typeof ssh === 'string' ? ssh.trim() : ssh;
  if (!isValidNodeName(n)) return { ok: false, error: 'err-node-name' };
  if (!isValidSsh(s)) return { ok: false, error: 'err-ssh' };
  const parsedSshPort = parsePort(sshPort);
  if (parsedSshPort === undefined) return { ok: false, error: 'err-ssh-port' };
  const parsedRemotePort = parsePort(remotePort);
  if (parsedRemotePort === undefined) return { ok: false, error: 'err-node-port' };
  const value = { name: n, ssh: s };
  if (parsedSshPort !== null) value.sshPort = parsedSshPort;
  if (parsedRemotePort !== null) value.remotePort = parsedRemotePort;
  return { ok: true, value };
}

// --- Stato tunnel per-nodo (da GET /api/nodes) --------------------------------
// tunnel: {status:'up', pid, since(ms)} | {status:'down'}. Ritorna un descrittore
// puro per la UI: {up, label:<chiave i18n>, since:<'3m'|'2h'|null>}.

export function relCompact(epochMs, nowMs) {
  if (!epochMs || !nowMs || nowMs < epochMs) return null;
  const s = Math.floor((nowMs - epochMs) / 1000);
  if (s < 60) return 'ora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}g`;
}

export function tunnelInfo(tunnel, nowMs) {
  const up = !!(tunnel && tunnel.status === 'up');
  const passive = !!(tunnel && tunnel.status === 'passive');
  return {
    up,
    ...(passive ? { passive: true } : {}),
    label: up ? 'tunnel-up' : passive ? 'node-passive' : 'tunnel-down',
    since: up ? relCompact(tunnel.since, nowMs) : null,
  };
}

// --- Pairing link v1/v2 (singolo link) --------------------------------------
// UNA funzione pura frontend decodifica v1 e v2 ed è usata da Settings, Wizard,
// paste, QR e initialPair (#pair deep-link). Mirror frontend di
// lib/nodes/peering.js decodePairing: allowlist rigorosa per versione, NESSUN
// campo segreto oltre l'invite one-time.
//   v1: {v,instanceId,port,label,invite}            -> compila solo la label
//   v2: + name?(slug), ssh?(target/alias), sshPort? -> compila label/slug/ssh/sshPort
// Ritorna {ok, version, label?, name?, ssh?, sshPort?, invite, instanceId, port}
// oppure {ok:false} su URL/payload malformato, versione ignota o campi non ammessi.
const PAIRING_V1_KEYS_FE = new Set(['v', 'instanceId', 'port', 'label', 'invite']);
const PAIRING_V2_KEYS_FE = new Set(['v', 'instanceId', 'port', 'label', 'invite', 'name', 'ssh', 'sshPort']);

function b64urlToJson(b64url) {
  const b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = typeof atob === 'function'
    ? atob(padded)
    : Buffer.from(padded, 'base64').toString('binary');
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return typeof TextDecoder !== 'undefined'
    ? new TextDecoder().decode(bytes)
    : Buffer.from(bytes).toString('utf8');
}

export function decodePairingForm(value) {
  let pair = '';
  try {
    const u = new URL(String(value));
    pair = new URLSearchParams(u.hash.replace(/^#/, '')).get('pair') || '';
  } catch (_) { return { ok: false }; }
  if (!pair) return { ok: false };
  let x;
  try { x = JSON.parse(b64urlToJson(pair)); }
  catch (_) { return { ok: false }; }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false };
  const allowed = x.v === 1 ? PAIRING_V1_KEYS_FE : x.v === 2 ? PAIRING_V2_KEYS_FE : null;
  if (!allowed) return { ok: false };
  for (const k of Object.keys(x)) if (!allowed.has(k)) return { ok: false };
  if (!/^[a-f0-9]{16,64}$/.test(String(x.instanceId))) return { ok: false };
  const port = Number(x.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false };
  if (typeof x.label !== 'string') return { ok: false };
  if (typeof x.invite !== 'string' || !x.invite) return { ok: false };
  const out = { ok: true, version: x.v, label: x.label, invite: x.invite, instanceId: x.instanceId, port };
  if (x.v === 2) {
    if (x.name !== undefined) {
      if (typeof x.name !== 'string' || !NODE_NAME_RE.test(x.name)) return { ok: false };
      out.name = x.name;
    }
    if (x.ssh !== undefined) {
      // user@host o alias; argv-safe (no whitespace, no leading '-').
      if (!isValidSsh(x.ssh)) return { ok: false };
      out.ssh = String(x.ssh).trim();
    }
    if (x.sshPort !== undefined) {
      const sp = Number(x.sshPort);
      if (!Number.isInteger(sp) || sp < 1 || sp > 65535) return { ok: false };
      out.sshPort = sp;
    }
  }
  return out;
}

// mergePairingIntoForm(form, decoded, touched): applica i campi del link decodificato
// SOLO dove l'utente non ha ancora editato a mano (touched = Set dei campi toccati).
// v2 compila label/slug(name)/ssh/sshPort; v1 solo label. Mantiene le modifiche
// manuali successive. Ritorna un nuovo form (puro, non muta l'input).
export function mergePairingIntoForm(form, decoded, touched = new Set()) {
  if (!decoded || !decoded.ok) return form;
  const next = { ...form };
  const apply = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    if (touched.has(key)) return; // conserva modifiche manuali
    next[key] = value;
  };
  apply('label', decoded.label); // etichetta remota (come vedo il peer)
  if (decoded.version === 2) {
    // I primi link v2 sperimentali potevano avere ssh ma non name: ricava uno
    // slug dalla label, così anche quei link restano davvero monoincolla.
    apply('name', decoded.name || (decoded.ssh ? toSlug(decoded.label) : ''));
    apply('ssh', decoded.ssh);
    if (decoded.sshPort !== undefined) apply('sshPort', String(decoded.sshPort));
  }
  return next;
}
