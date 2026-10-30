'use strict';
// Stop dell'host VL. Il binario eseguito è la copia pinnata,
// la root è quella del record scritto all'up. Il timeout uccide solo il
// CLI di controllo, mai l'host. rc 0 non basta: serve state=none.
//
// D-549 S4b. Lo stop passa dal comando amministrativo
// `vl internal host-stop --server-root <root> --json` quando lo status dichiara
// la capacità `host_stop_v1`; `vl shutdown` resta SOLO per un binario che non la
// dichiara (status valido, capacità assente). La capacità dice che l'azione
// esiste: non autorizza nulla. Pin, env, root e giudizio d'isolamento restano
// quelli di prima, e nessuno stop parte se l'isolamento non è «isolato».

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Tempi. Un probe di status ha il suo limite; lo stop da solo può attendere fino
// a 15 s dentro il client, quindi ha un limite suo, più largo; e dopo lo stop si
// riserva il tempo di rileggere lo status. Il totale che questo modulo accetta
// dal chiamante è più largo dei 15 s di prima.
const PROBE_MS = 5000;
const STOP_MS = 20000;
const BUDGET_MS = 30000;
const POST_PROBE_RESERVE_MS = 2000;
const MARGIN_MS = 200;
const CAPACITA_STOP = 'host_stop_v1';
// Quanto stdout si raccoglie da un CLI di controllo. Oltre il limite il resto
// si scarta (senza crescita di memoria) ma si SEGNALA: un'uscita incompleta non
// e' un'uscita valida, qualunque cosa contenga il prefisso.
const MAX_OUT = 65536;
// La lista chiusa dei `reason` del comando (vl: STOP_REASONS).
const STOP_REASONS = Object.freeze([
  'shutdown_ack', 'usage', 'unsafe_root', 'server_absent', 'unsafe_layout', 'timeout',
  'profile_mismatch', 'connect_error', 'stale_epoch', 'takeover_failed', 'invalid_ack',
  'no_ack', 'shutdown_rejected', 'cleanup_incomplete', 'unexpected_eof', 'protocol_error',
]);
// Stati dello status che dicono «un host può esserci».
const STATI_CON_HOST = ['live', 'lock', 'lock_held_socket_silent'];

// Il tempo dello stop dato quanto resta del budget: il suo limite, meno la
// riserva per il probe finale e il margine. Sotto i 50 ms non si parte.
function tempoStop(restaMs) {
  return Math.min(STOP_MS, restaMs - POST_PROBE_RESERVE_MS - MARGIN_MS);
}

function sha256File(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function slugCoppia(owner, cellId) {
  if (typeof owner !== 'string' || typeof cellId !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(owner) || !/^[A-Za-z0-9_-]{1,64}$/.test(cellId)) return null;
  return `${owner}-${cellId}`;
}

function dirContesto(stateDir) {
  return path.join(stateDir, 'host-context.json');
}

function scriviContesto(stateDir, dato) {
  const file = dirContesto(stateDir);
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(dato));
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return file;
}

function leggiContesto(stateDir) {
  let buf;
  try { buf = fs.readFileSync(dirContesto(stateDir)); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { errore: 'illeggibile' };
  }
  let o;
  try { o = JSON.parse(buf.toString('utf8')); } catch (_) { return { errore: 'corrotto' }; }
  if (!o || typeof o !== 'object') return { errore: 'corrotto' };
  const chiavi = ['launchId', 'vlBin', 'vlBinSha256', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HOME', 'uid', 'serverRoot', 'ts', 'version', 'hostIdentity'];
  if (Object.keys(o).some((k) => !chiavi.includes(k))) return { errore: 'corrotto' };
  if (!/^[a-f0-9]{16}$/.test(o.launchId || '')) return { errore: 'corrotto' };
  if (typeof o.vlBinSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.vlBinSha256)) return { errore: 'corrotto' };
  for (const k of ['vlBin', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'HOME', 'serverRoot']) {
    if (typeof o[k] !== 'string' || !o[k] || o[k].includes('\0')) return { errore: 'corrotto' };
  }
  if (!Number.isSafeInteger(o.uid) || o.uid < 0) return { errore: 'corrotto' };
  if (o.version === undefined && o.hostIdentity === undefined) return o;
  if (o.version !== 2) return { errore: 'versione', launchId: o.launchId };
  if (validaHostIdentity(o.hostIdentity)) return { errore: 'identita', launchId: o.launchId };
  return o;
}

const RE_HEX32 = /^[a-f0-9]{32}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_DEC = /^[0-9]+$/;
const CHIAVI_LIVE = ['state', 'source', 'instanceId', 'pid', 'uid', 'bootId', 'pidNamespaceInode', 'startTicks', 'pgid', 'sid'];

function validaHostIdentity(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return 'assente';
  if (h.state === 'pending' || h.state === 'none') {
    return Object.keys(h).length === 1 ? null : 'chiavi';
  }
  if (h.state !== 'live') return 'stato';
  if (Object.keys(h).length !== CHIAVI_LIVE.length || CHIAVI_LIVE.some((k) => !Object.prototype.hasOwnProperty.call(h, k))) {
    return 'chiavi';
  }
  if (h.source !== 'kernel-peer-v1') return 'fonte';
  if (!RE_HEX32.test(h.instanceId || '')) return 'instance';
  for (const k of ['pid', 'pgid', 'sid']) {
    if (!Number.isSafeInteger(h[k]) || h[k] <= 0) return k;
  }
  if (!Number.isSafeInteger(h.uid) || h.uid < 0) return 'uid';
  if (!RE_UUID.test(h.bootId || '')) return 'boot';
  if (!RE_DEC.test(h.pidNamespaceInode || '') || !RE_DEC.test(h.startTicks || '')) return 'vita';
  return null;
}

function contestoIniziale(base) {
  return { ...base, version: 2, hostIdentity: { state: 'pending' } };
}

function completaIdentita(record, identity) {
  if (!record || record.version !== 2 || !record.hostIdentity || record.hostIdentity.state !== 'pending') return null;
  const h = {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId: identity && identity.instanceId,
    pid: identity && identity.pid,
    uid: identity && identity.uid,
    bootId: identity && identity.bootId,
    pidNamespaceInode: identity && identity.pidNamespaceInode,
    startTicks: identity && identity.startTicks,
    pgid: identity && identity.pgid,
    sid: identity && identity.sid,
  };
  if (validaHostIdentity(h)) return null;
  return { ...record, hostIdentity: h };
}

function giudicaIsolamento({ registrata, osservata, coordinatore, nodo } = {}) {
  if (!registrata || registrata.state !== 'live' || !osservata || osservata.state !== 'live') return 'ignoto';
  if (validaHostIdentity(registrata) || validaHostIdentity(osservata)) return 'ignoto';
  for (const c of ['source', 'instanceId', 'pid', 'uid', 'bootId', 'pidNamespaceInode', 'startTicks', 'pgid', 'sid']) {
    if (registrata[c] !== osservata[c]) return 'ignoto';
  }
  if (!nodo || nodo.bootId !== osservata.bootId || String(nodo.pidNamespaceInode) !== String(osservata.pidNamespaceInode)) {
    return 'ignoto';
  }
  if (!coordinatore || !Number.isSafeInteger(coordinatore.pgid) || !Number.isSafeInteger(coordinatore.sid)) return 'ignoto';
  if (!(osservata.pid === osservata.pgid && osservata.pgid === osservata.sid)) return 'ignoto';
  if (osservata.pgid === coordinatore.pgid) return 'nel-gruppo';
  if (osservata.sid === coordinatore.sid) return 'ignoto';
  return 'isolato';
}

// D-558 FIX2b (F1): l'osservazione KERNEL del peer. Il pid che lo status
// dichiara (e che VL legge dal lock della root) e' solo un puntatore
// diagnostico: identita' non se ne ricava. La prova viene da /proc, letta dal
// kernel — gruppo, sessione, nascita, uid, namespace e boot del processo
// puntato. Se una lettura manca, l'osservazione non esiste: fail-closed,
// mai una tuple parziale.
function bootIdKernel(fsImpl = fs) {
  try {
    const b = fsImpl.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return RE_UUID.test(b) ? b : null;
  } catch (_) { return null; }
}

function osservaPeerKernel(pid, instanceId, fsImpl = fs) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let stat;
  try { stat = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (_) { return null; }
  const fine = stat.lastIndexOf(')');
  if (fine < 0) return null;
  const campi = stat.slice(fine + 2).trim().split(/\s+/);
  const pgid = Number(campi[2]);
  const sid = Number(campi[3]);
  const startTicks = Number(campi[19]);
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return null;
  if (!Number.isSafeInteger(sid) || sid <= 0) return null;
  if (!Number.isSafeInteger(startTicks) || startTicks < 0) return null;
  let uid = null;
  try {
    const riga = fsImpl.readFileSync(`/proc/${pid}/status`, 'utf8')
      .split('\n').find((r) => r.startsWith('Uid:'));
    const parti = riga ? riga.trim().split(/\s+/) : [];
    uid = Number(parti[2]); // uid effective
  } catch (_) { return null; }
  if (!Number.isSafeInteger(uid) || uid < 0) return null;
  let ino = null;
  try { ino = fsImpl.statSync(`/proc/${pid}/ns/pid`).ino; } catch (_) { return null; }
  if (!Number.isSafeInteger(ino) || ino <= 0) return null;
  const bootId = bootIdKernel(fsImpl);
  if (!bootId) return null;
  const h = {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId,
    pid,
    uid,
    bootId,
    pidNamespaceInode: String(ino),
    startTicks: String(startTicks),
    pgid,
    sid,
  };
  return validaHostIdentity(h) ? null : h;
}

// Il nodo che osserva: stesso boot e stesso pid-namespace del peer, o nulla.
function identitaNodoKernel(fsImpl = fs) {
  const bootId = bootIdKernel(fsImpl);
  if (!bootId) return null;
  try {
    const ino = fsImpl.statSync('/proc/self/ns/pid').ino;
    if (!Number.isSafeInteger(ino) || ino <= 0) return null;
    return { bootId, pidNamespaceInode: String(ino) };
  } catch (_) { return null; }
}

// Il coordinatore (questo runtime): il gruppo e la sessione da tenere fuori
// dallo stop. Senza /proc non c'e' giudizio.
function identitaCoordinatoreKernel(fsImpl = fs) {
  try {
    const stat = fsImpl.readFileSync('/proc/self/stat', 'utf8');
    const fine = stat.lastIndexOf(')');
    if (fine < 0) return null;
    const campi = stat.slice(fine + 2).trim().split(/\s+/);
    const pgid = Number(campi[2]);
    const sid = Number(campi[3]);
    if (!Number.isSafeInteger(pgid) || pgid <= 0) return null;
    if (!Number.isSafeInteger(sid) || sid <= 0) return null;
    return { pgid, sid };
  } catch (_) { return null; }
}

// D-558 FIX2b (F1): la qualifica che il RUNTIME esegue prima di fermare
// l'host di un lancio. Un solo probe di stato (lo stesso comando che
// fermerebbe l'host, riusato poi da fermaHost dentro lo stesso budget
// monotono); se un host c'e', si osserva il peer dichiarato nel kernel e:
//   - identita' non ancora registrata nel contesto v2 → la tuple kernel
//     viene PERSISTITA (primo sguardo del lancio: da qui il confronto ha
//     una base durevole);
//   - identita' gia' registrata → confronto tuple: qualunque differenza
//     (sostituzione, pid riusato, namespace/boot diversi) e' «ignoto».
// Poi il giudizio ternario (isolato / nel-gruppo / ignoto) con nodo e
// coordinatore. Esito: { isolamento, motivo, record, residuoMs, probe }.
// `motivo` e' bounded: none | budget | probe | pid-assente | osservazione |
// identita | persistenza | isolato | nel-gruppo | ignoto.
async function qualificaIsolamentoHost({
  stateDir, record, bin, instanceId, budgetMs, monoNow,
  spawnImpl, osservaPeer, identitaNodo, identitaCoordinatore, log,
}) {
  const inizio = monoNow();
  const effettivoMs = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : BUDGET_MS;
  const limite = inizio + Math.min(effettivoMs, BUDGET_MS);
  const resta = () => limite - monoNow();
  const male = (motivo, probe) => ({
    isolamento: 'ignoto', motivo, record, residuoMs: Math.max(0, resta()), probe,
  });
  // Il probe della qualifica lascia a fermaHost la riserva del probe finale.
  const probeMs = Math.min(PROBE_MS, resta() - POST_PROBE_RESERVE_MS - MARGIN_MS);
  if (probeMs < 50) return male('budget');
  const r = await lancia(bin, ['host', 'status', '--json', '--server-root', record.serverRoot],
    envDalRecord(record), probeMs, spawnImpl);
  const probe = { r, stato: null };
  if (!sondaConclusa(r)) return male('probe', probe);
  const stato = leggiStato(r.stdout);
  probe.stato = stato;
  if (!stato) return male('probe', probe);
  if (stato.state === 'none') {
    // Nessun host: l'isolamento non serve, fermaHost dichiarera' lo stato.
    return { isolamento: undefined, motivo: 'none', record, residuoMs: Math.max(0, resta()), probe };
  }
  const pid = Number(stato.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return male('pid-assente', probe);
  const osserva = typeof osservaPeer === 'function' ? osservaPeer : osservaPeerKernel;
  const osservata = osserva(pid, instanceId);
  if (!osservata || validaHostIdentity(osservata)) return male('osservazione', probe);
  let vivo = record;
  let registrata = record.hostIdentity && record.hostIdentity.state === 'live'
    && !validaHostIdentity(record.hostIdentity) ? record.hostIdentity : null;
  if (!registrata) {
    const completo = completaIdentita(record, osservata);
    if (!completo) return male('identita', probe);
    try { scriviContesto(stateDir, completo); } catch (_) { return male('persistenza', probe); }
    if (typeof log === 'function') log('host-identity-registered');
    vivo = completo;
    registrata = completo.hostIdentity;
  }
  const nodo = (typeof identitaNodo === 'function' ? identitaNodo : identitaNodoKernel)();
  const coordinatore = (typeof identitaCoordinatore === 'function' ? identitaCoordinatore : identitaCoordinatoreKernel)();
  const isolamento = giudicaIsolamento({ registrata, osservata, coordinatore, nodo });
  return { isolamento, motivo: isolamento, record: vivo, residuoMs: Math.max(0, resta()), probe };
}

function dirPin(home, owner, cellId, sha) {
  const coppia = slugCoppia(owner, cellId);
  if (!coppia) return null;
  return path.join(home, '.nexuscrew', 'vl-control-pin', coppia, sha);
}

function pinBinario({ source, home, owner, cellId, log }) {
  let hash;
  try { hash = sha256File(source); } catch (_) { return { ok: false, code: 'ASSENTE' }; }
  const dir = dirPin(home, owner, cellId, hash);
  if (!dir) return { ok: false, code: 'NOME' };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const finale = path.join(dir, 'vl');
  if (fs.existsSync(finale)) {
    let ora = '';
    try { ora = sha256File(finale); } catch (_) { ora = ''; }
    if (ora === hash) return { ok: true, path: finale, sha256: hash };
    const quarantena = `${finale}.corrupt-${Date.now()}`;
    try { fs.renameSync(finale, quarantena); } catch (_) { return { ok: false, code: 'QUARANTINE' }; }
    if (typeof log === 'function') log('pin-cache-corrupt');
  }
  const tmp = `${finale}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const buf = fs.readFileSync(source);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) return { ok: false, code: 'HASH' };
  const fd = fs.openSync(tmp, 'wx', 0o500);
  try {
    fs.writeFileSync(fd, buf);
    fs.fchmodSync(fd, 0o500);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const diNuovo = sha256File(tmp);
  if (diNuovo !== hash) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, code: 'REREAD' };
  }
  if (fs.existsSync(finale)) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, code: 'EXISTS' };
  }
  fs.renameSync(tmp, finale);
  const altri = path.dirname(dir);
  for (const nome of fs.readdirSync(altri)) {
    if (nome === hash) continue;
    fs.rmSync(path.join(altri, nome), { recursive: true, force: true });
  }
  return { ok: true, path: finale, sha256: hash };
}

function verificaPin(pinPath, sha) {
  try {
    if (sha256File(pinPath) !== sha) return { ok: false };
    return { ok: true, path: pinPath };
  } catch (_) {
    return { ok: false };
  }
}

function envDalRecord(record) {
  return {
    HOME: record.HOME,
    XDG_STATE_HOME: record.XDG_STATE_HOME,
    XDG_DATA_HOME: record.XDG_DATA_HOME,
    XDG_CONFIG_HOME: record.XDG_CONFIG_HOME,
    PATH: '/usr/bin:/bin',
  };
}

function lancia(bin, args, env, timeoutMs, spawnImpl) {
  const lanciaProc = spawnImpl || spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = lanciaProc(bin, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', errore: e, ucciso: false });
      return;
    }
    const out = [];
    let n = 0;
    let troncato = false;
    child.stdout.on('data', (b) => {
      if (troncato) return;
      // Fino al limite compreso si tiene tutto; il primo byte oltre lo chiude:
      // da li' in poi si scarta e basta, e l'uscita e' dichiarata troncata.
      if (n + b.length > MAX_OUT) { troncato = true; return; }
      n += b.length;
      out.push(b);
    });
    child.stderr.on('data', () => {});
    let ucciso = false;
    const killer = setTimeout(() => {
      ucciso = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    child.once('error', () => {});
    child.once('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), ucciso, troncato, child });
    });
  });
}

function leggiStato(stdout) {
  const riga = String(stdout || '').split('\n').find((r) => r.trim().startsWith('{'));
  if (!riga) return null;
  try {
    const o = JSON.parse(riga);
    if (!o || typeof o.state !== 'string') return null;
    if (o.state !== 'none' && !STATI_CON_HOST.includes(o.state)) return null;
    // `capabilities` assente (un binario che non la conosce) o un elenco: si
    // legge. Qualunque altra forma è uno status che non si sa leggere.
    if (o.capabilities !== undefined && !Array.isArray(o.capabilities)) return null;
    return o;
  } catch (_) { return null; }
}

function dichiaraStop(stato) {
  return !!stato && Array.isArray(stato.capabilities) && stato.capabilities.includes(CAPACITA_STOP);
}

// La riga del comando interno, letta in modo stretto: una sola riga con il suo
// a capo, un oggetto con ESATTAMENTE `ok` (booleano) e `reason` (della lista
// chiusa), `ok` vero solo per shutdown_ack, e l'exit coerente (0 se e solo se
// ok), senza timeout né errore di avvio. Non si estrae un pezzo di JSON da testo
// qualsiasi e il successo non si ricava dalla sola presenza di una riga.
function leggiEsitoStop(r) {
  if (!r || r.errore || r.ucciso === true || r.troncato === true || typeof r.code !== 'number') return null;
  const testo = String(r.stdout || '');
  if (!testo.startsWith('{') || !testo.endsWith('}\n') || testo.indexOf('\n') !== testo.length - 1) return null;
  let o;
  try { o = JSON.parse(testo); } catch (_) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const chiavi = Object.keys(o).sort();
  if (chiavi.length !== 2 || chiavi[0] !== 'ok' || chiavi[1] !== 'reason') return null;
  if (typeof o.ok !== 'boolean' || typeof o.reason !== 'string') return null;
  if (!STOP_REASONS.includes(o.reason)) return null;
  if (o.ok !== (o.reason === 'shutdown_ack')) return null;
  if ((r.code === 0) !== o.ok) return null;
  return { ok: o.ok, reason: o.reason };
}

function sondaConclusa(r) {
  // Un'uscita troncata non e' una sonda conclusa: da un prefisso non si ricava
  // ne' una capacita' ne' un `none`.
  return !!r && r.code === 0 && r.ucciso !== true && r.troncato !== true && !r.errore;
}

async function fermaHost({ record, bin, budgetMs, monoNow, spawnImpl, isolamento, probeIniziale }) {
  const inizio = monoNow();
  const effettivoMs = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : BUDGET_MS;
  const limite = inizio + Math.min(effettivoMs, BUDGET_MS);
  const resta = () => limite - monoNow();
  // Il giudizio ternario e' gia' stato calcolato. Non e' un booleano
  // opzionale: l'assenza non autorizza lo shutdown.
  if (isolamento === 'nel-gruppo') {
    return { outcome: 'host-stop-failed', code: 'HOST_IN_GROUP', spawned: 0 };
  }
  const env = envDalRecord(record);
  const root = record.serverRoot;
  let spawned = 0;
  const stato = async () => {
    const ms = Math.min(PROBE_MS, Math.max(1, resta()));
    spawned += 1;
    const r = await lancia(bin, ['host', 'status', '--json', '--server-root', root], env, ms, spawnImpl);
    return { r, stato: leggiStato(r.stdout) };
  };
  if (resta() < 50) return { outcome: 'host-stop-failed', code: 'BUDGET', spawned };
  // D-558 FIX2b: il chiamante (qualificaIsolamentoHost) puo' consegnare il
  // probe di stato gia' fatto, nello stesso budget monotono: si riusa quella
  // lettura invece di ripeterla. Il conteggio spawned resta del chiamante.
  const primo = probeIniziale && probeIniziale.r && typeof probeIniziale.r === 'object'
    ? { r: probeIniziale.r, stato: probeIniziale.stato || null }
    : await stato();
  if (sondaConclusa(primo.r) && primo.stato && primo.stato.state === 'none') {
    return { outcome: 'host-already-stopped', spawned };
  }
  // Stato vivo, lock, pid diagnostico o JSON senza attestazione del peer:
  // nessuno shutdown. L'isolamento non si deduce da questo probe.
  if (isolamento !== 'isolato') {
    return { outcome: 'host-stop-failed', code: 'IDENTITY_UNKNOWN', spawned };
  }
  // Senza uno status concluso e leggibile, che dice che un host puo' esserci,
  // non si sceglie nessun comando: ne' il nuovo ne' il vecchio. Uno stato di
  // errore (root non sicura, probe fallito) non e' ne' none ne' live.
  if (!sondaConclusa(primo.r) || !primo.stato || !STATI_CON_HOST.includes(primo.stato.state)) {
    return { outcome: 'host-stop-failed', code: 'STATUS_UNUSABLE', spawned };
  }
  if (resta() < 50) return { outcome: 'host-stop-failed', code: 'BUDGET', spawned };
  const fermo = tempoStop(resta());
  if (fermo < 50) return { outcome: 'host-stop-failed', code: 'BUDGET', spawned };
  // La capacita' dice quale comando; non autorizza lo stop (l'isolamento l'ha
  // gia' fatto sopra). Il vecchio comando e' solo per chi non la dichiara.
  const interno = dichiaraStop(primo.stato);
  const via = interno ? 'internal' : 'legacy';
  const argv = interno
    ? ['internal', 'host-stop', '--server-root', root, '--json']
    : ['shutdown', '--server-root', root];
  spawned += 1;
  const shut = await lancia(bin, argv, env, fermo, spawnImpl);
  // Il timeout uccide solo il CLI di controllo: l'host non si tocca e nessun
  // altro comando prende il posto di quello che non ha risposto.
  if (shut.ucciso) return { outcome: 'host-stop-failed', code: 'TIMEOUT', spawned, via };
  let ragione = null;
  if (interno) {
    const esito = leggiEsitoStop(shut);
    // Una riga che non si sa attestare non e' un esito, ne' la prova di un
    // binario vecchio: nessun ripiego sul vecchio comando.
    if (!esito) return { outcome: 'host-stop-failed', code: 'STOP_UNATTESTED', spawned, via };
    ragione = esito.reason;
    // Un rifiuto dichiarato e' un fallimento, con la sua parola. Fa eccezione
    // server_absent: l'host puo' essere sparito tra i due probe, e lo dice lo
    // status che segue, senza inventare un ack.
    if (!esito.ok && esito.reason !== 'server_absent') {
      return { outcome: 'host-stop-failed', code: 'STOP_FAILED', reason: esito.reason, spawned, via };
    }
  }
  if (resta() < 50) return { outcome: 'host-stop-failed', code: 'BUDGET', spawned, via };
  const secondo = await stato();
  if (sondaConclusa(secondo.r) && secondo.stato && secondo.stato.state === 'none') {
    if (ragione === 'server_absent') return { outcome: 'host-already-stopped', spawned, via, race: true };
    return { outcome: 'host-stopped-clean', spawned, via };
  }
  return { outcome: 'host-stop-failed', code: 'BARRIER', spawned, via, ...(ragione ? { reason: ragione } : {}) };
}

module.exports = {
  scriviContesto, leggiContesto, pinBinario, verificaPin, fermaHost, sha256File, dirPin, envDalRecord,
  validaHostIdentity, contestoIniziale, completaIdentita, giudicaIsolamento,
  qualificaIsolamentoHost, osservaPeerKernel, identitaNodoKernel, identitaCoordinatoreKernel,
  // D-549 S4b: esposti per i test.
  leggiEsitoStop, leggiStato, dichiaraStop, tempoStop, STOP_REASONS,
  PROBE_MS, STOP_MS, BUDGET_MS, POST_PROBE_RESERVE_MS, MARGIN_MS, MAX_OUT,
};
