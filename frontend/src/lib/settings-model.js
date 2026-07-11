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

// user@host strict (mirror di lib/nodes/store.js parseSsh): esattamente un '@',
// niente whitespace/null, host che non può diventare un flag ssh.
export function isValidSsh(s) {
  if (typeof s !== 'string' || !s || s.length > MAX_SSH_LEN) return false;
  if (s.includes('\0') || /\s/.test(s)) return false;
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

// Valida il form rendezvous (wizard step 3 + toggle ruolo node nei settings).
// hasStored=true → lo store ha già un rendezvous: ssh vuoto è ammesso (riuso).
export function validateRendezvousForm({ ssh, publishedPort } = {}, hasStored = false) {
  const s = typeof ssh === 'string' ? ssh.trim() : ssh;
  const port = parsePort(publishedPort);
  if (port === undefined) return { ok: false, error: 'err-port' };
  if (!s) {
    if (!hasStored) return { ok: false, error: 'err-rendezvous-required' };
    const value = {};
    if (port !== null) value.publishedPort = port;
    return { ok: true, value };
  }
  if (!isValidSsh(s)) return { ok: false, error: 'err-ssh' };
  const value = { rendezvousSsh: s };
  if (port !== null) value.publishedPort = port;
  return { ok: true, value };
}

// --- Wizard: macchina a stati ------------------------------------------------
// Step: roles → node (opzionale, skippabile) → rendezvous (SOLO se ruolo node)
// → done. La sequenza dipende dai ruoli scelti allo step 1.

export function wizardSteps(roles) {
  const steps = ['roles', 'node'];
  if (roles && roles.node === true) steps.push('rendezvous');
  steps.push('done');
  return steps;
}

export function nextStep(current, roles) {
  const steps = wizardSteps(roles);
  const i = steps.indexOf(current);
  if (i < 0) return steps[0];
  return steps[Math.min(i + 1, steps.length - 1)];
}

export function prevStep(current, roles) {
  const steps = wizardSteps(roles);
  const i = steps.indexOf(current);
  if (i <= 0) return steps[0];
  return steps[i - 1];
}

export function initialWizard() {
  // client:true è il default sensato (una installazione che apre la UI è un hub);
  // node:false finché non scelto esplicitamente (richiede rendezvous).
  return { step: 'roles', roles: { client: true, node: false } };
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
  return {
    up,
    label: up ? 'tunnel-up' : 'tunnel-down',
    since: up ? relCompact(tunnel.since, nowMs) : null,
  };
}
