'use strict';
// Stop dell'host VL. Il binario eseguito è la copia pinnata,
// la root è quella del record scritto all'up. Il timeout uccide solo il
// CLI di controllo, mai l'host. rc 0 non basta: serve state=none.
//
// Host stop path. The stop goes through the administrative command
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
// La lista chiusa dei `reason` del comando (vl: STOP_REASONS). I tre esiti del
// rifiuto protetto — peer_mismatch, peer_unknown, expected_invalid — valgono
// solo per `vl internal host-stop --expected` e sono un NO senza ripiego.
const STOP_REASONS = Object.freeze([
  'shutdown_ack', 'usage', 'unsafe_root', 'server_absent', 'unsafe_layout', 'timeout',
  'profile_mismatch', 'connect_error', 'stale_epoch', 'takeover_failed', 'invalid_ack',
  'no_ack', 'shutdown_rejected', 'cleanup_incomplete', 'unexpected_eof', 'protocol_error',
  'peer_mismatch', 'peer_unknown', 'expected_invalid',
]);
// I rifiuti protetti dello stop expected, con il loro codice di esito: un peer
// diverso da quello registrato, un'identita' non provata e una tuple malformita
// sono tutti «nulla di fatto», e il codice viaggia fino all'operatore.
const ESITI_STOP_ATTESO = Object.freeze({
  peer_mismatch: 'HOST_PEER_MISMATCH',
  peer_unknown: 'HOST_PEER_UNKNOWN',
  expected_invalid: 'HOST_EXPECTED_INVALID',
});

// La tuple attesa dallo stop protetto, nella forma a una riga del contratto
// (`pid:uid:starttime:boot_id:pidns:pgid:sid`): e' la tuple REGISTRATA NEL
// CONTESTO ALL'UP, non una lettura fatta al volo al down. Un record senza
// tuple valida non ne produce una: non si promuove nulla qui.
function tuplaAttesaDaRecord(record) {
  const h = record && record.hostIdentity;
  if (!h || h.state !== 'live' || validaHostIdentity(h)) return null;
  return `${h.pid}:${h.uid}:${h.startTicks}:${h.bootId}:${h.pidNamespaceInode}:${h.pgid}:${h.sid}`;
}
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

function erroreCatena(code, messaggio) {
  return Object.assign(new Error(messaggio), { code });
}

function identitaDaNome(impl, dir) {
  try {
    return impl.lstatSync(dir);
  } catch (e) {
    throw erroreCatena((e && e.code) || 'EIO', 'chain ring not readable');
  }
}

// fsync of a directory: the rename and the creation of an entry live in the
// metadata of the directory, not in the file. Without this step a crash can roll
// the rename back (or a directory just born) and with it the whole launch
// context. fsImpl is a seam for the tests (simulated EIO).
//
// The sync goes through a descriptor qualified as an object: the name is
// resolved once, without following a link, and the descriptor must be the
// directory qualified a moment before, or the sync would attest an object we do
// not control. Node has no *at(2) primitives, so comparing identities detects a
// substitution before the sync; a swap restored between the two reads stays
// indistinguishable, and nothing here promises otherwise.
function fsyncDirQualificato(impl, dir, identita) {
  const C = impl.constants || fs.constants;
  const attesa = (identita && typeof identita.get === 'function' ? identita.get(dir) : null)
    || identitaDaNome(impl, dir);
  let fd = null;
  try {
    fd = impl.openSync(dir, C.O_RDONLY | (C.O_DIRECTORY || 0) | (C.O_NOFOLLOW || 0));
  } catch (e) {
    if (e && (e.code === 'ELOOP' || e.code === 'ENOTDIR')) {
      throw erroreCatena('ESTALE', 'chain ring replaced before the sync');
    }
    throw e;
  }
  try {
    const st = impl.fstatSync(fd);
    if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()
      || st.dev !== attesa.dev || st.ino !== attesa.ino) {
      throw erroreCatena('ESTALE', 'descriptor is not the qualified ring');
    }
    impl.fsyncSync(fd);
  } finally {
    try { impl.closeSync(fd); } catch (_) { /* best effort */ }
  }
}

// Il confine ESPLICITO della catena privata NC: l'antenato `.nexuscrew` del
// contesto. La qualifica non risale oltre quel confine — sopra inizia la home
// dell'operatore, la cui durabilita' non e' affare di questo lancio. Entro il
// confine la catena e privata di NexusCrew e si qualifica PER INTERO, dal
// confine fino allo stateDir.
function confineCatenaNc(dirAssoluta) {
  const segs = dirAssoluta.split(path.sep);
  for (let i = segs.length - 1; i >= 1; i -= 1) {
    if (segs[i] === '.nexuscrew') return segs.slice(0, i + 1).join(path.sep);
  }
  return null;
}

// The host platform is read in exactly one place: the Android exception below
// is the only rule that depends on it, and the tests replace this value instead
// of the module gaining a public parameter for it.
function piattaformaOspite() {
  return process.platform;
}

// Android's system identity owns the shared rings above an application's data
// directory (/data, /data/data). On a device the application never runs under
// that identity, and those rings may legitimately be writable by their own
// group; write for others is still refused, sticky bit or not.
const UID_SISTEMA_ANDROID = 1000;

function anelloSistemaAndroid(st) {
  return piattaformaOspite() === 'android'
    && st.uid === UID_SISTEMA_ANDROID && st.gid === UID_SISTEMA_ANDROID;
}

// From / down to the target: the rings really traversed, outermost first.
function percorsiCatena(dirAssoluta) {
  const anelli = [dirAssoluta];
  for (;;) {
    const parent = path.dirname(anelli[anelli.length - 1]);
    if (parent === anelli[anelli.length - 1]) break;
    anelli.push(parent);
  }
  return anelli.reverse();
}

// One decision for the whole chain, shared by the preparer and by the read-only
// reader, and stated from the top down so a descendant is never accepted before
// the ring that protects it.
//
// External stretch (above the anchor): root is accepted and, when it is writable
// by group or other, only with the sticky bit (/tmp); one of our own rings is
// accepted while it is not writable by group or other, and the first one at
// exactly 0700 becomes the anchor; a ring of another user is refused, except on
// Android where the system identity is shared infrastructure and may only be
// writable by its own group.
// Private stretch (the anchor and below): every ring is ours; the anchor
// protects the subtree from pathname traversal by other UIDs and promises
// nothing against the same UID, against root or against descriptors already
// handed out. The Android exception does not reach below the anchor, and the
// store format (0700, files 0600) is checked separately by the store owner.
//
// The rings are qualified as OBJECTS, never as names: lstat without following
// links, real type. A ring this call has to create has no identity yet; one that
// exists already is qualified for identity and owner and is never chmodded,
// because tightening something pre-existing is not ours to do. Adopting a
// symbolic ring would mean syncing a tree we do not control.
//
// It only reads — one lstat per ring, no creation, no chmod, no sync — so the
// reader makes the same decision as the preparer. A refusal is returned as
// {ok:false, code}, never thrown.
function qualificaCatenaDirectory(fsImpl, dirAssoluta) {
  const impl = fsImpl || fs;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const anelli = percorsiCatena(path.resolve(dirAssoluta));
  const preesistenti = new Set();
  const identita = new Map();
  const rifiuta = (code) => ({ ok: false, code });
  let protetto = false;
  for (const anello of anelli) {
    let st;
    try {
      st = impl.lstatSync(anello);
    } catch (e) {
      // A missing ring is one this call has to create: it has no identity yet.
      if (e && e.code === 'ENOENT') continue;
      return rifiuta((e && e.code) || 'EIO');
    }
    if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()
      || (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink())) {
      return rifiuta('ENOTDIR');
    }
    preesistenti.add(anello);
    // Without a way to read the owner, the ownership checks stay off, as before.
    const nostro = uid === null || typeof st.uid !== 'number' || st.uid === uid;
    const systemAndroid = anelloSistemaAndroid(st);
    if (!protetto) {
      // The anchor comes first: a ring of ours at exactly 0700 protects the
      // subtree even when the current user is root or happens to be the Android
      // system identity. The rules below describe a shared ring, which is never
      // ours.
      if (nostro && (st.mode & 0o777) === 0o700) {
        protetto = true;
      } else if (st.uid === 0) {
        // Root is shared: acceptable while it is not writable by group or other,
        // or while it is and carries the sticky bit.
        if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) return rifiuta('ESTALE');
      } else if (systemAndroid) {
        if ((st.mode & 0o002) !== 0) return rifiuta('ESTALE');
      } else if (nostro) {
        // An own ring writable by group or other would let anyone remove or
        // replace everything below it, and the anchor itself would be
        // replaceable; it is refused, not tightened.
        if ((st.mode & 0o022) !== 0) return rifiuta('ESTALE');
      } else {
        return rifiuta('EPERM');
      }
    } else if (!nostro) {
      // Below the anchor the private chain is ours and nobody else's, root and
      // the Android system identity included.
      return rifiuta('EPERM');
    }
    identita.set(anello, { dev: st.dev, ino: st.ino, mode: st.mode, uid: st.uid });
  }
  return { ok: true, anelli, preesistenti, identita };
}

// The part of the chain whose durability this call attests: unchanged scope.
// Inside the NexusCrew boundary every ring from `.nexuscrew` down to the target,
// pre-existing or new; outside it the missing rings plus the first one that
// exists, which can itself be a leftover never synced.
function trattoDaSincronizzare(q1, confine) {
  if (confine) {
    const i = q1.anelli.indexOf(confine);
    return i < 0 ? q1.anelli.slice() : q1.anelli.slice(i);
  }
  const tratto = [];
  for (let i = q1.anelli.length - 1; i >= 0; i -= 1) {
    tratto.push(q1.anelli[i]);
    if (q1.preesistenti.has(q1.anelli[i])) break;
  }
  return tratto.reverse();
}

// Creates `dir` (with the missing parents) and qualifies the chain AT EVERY
// write: every necessary ring is synced itself and as an entry of its own
// parent. The existence of a directory does not attest that a fsync ever
// succeeded: a chain that survived an earlier error (EIO on a ring, a tree built
// halfway) is qualified again, never accepted for existing — the retry on the
// same chain must retry the sync of the parent that is still broken, not succeed
// because the directories are there. Errors propagate: a directory that cannot
// be made durable is not a place to declare persistence.
function assicuraDirDurevole(fsImpl, dir) {
  const impl = fsImpl || fs;
  const assoluta = path.resolve(dir);
  // The whole chain is qualified BEFORE anything is created: a ring that is not
  // ours (a symbolic one included) is refused without creating anything below.
  const q1 = qualificaCatenaDirectory(impl, assoluta);
  if (!q1.ok) throw erroreCatena(q1.code, 'chain refused before creation');
  const tratto = trattoDaSincronizzare(q1, confineCatenaNc(assoluta));
  impl.mkdirSync(assoluta, { recursive: true, mode: 0o700 });
  // And again after the creation: a ring replaced while the tree was being made
  // would make the sync attest an object nobody qualified.
  const q2 = qualificaCatenaDirectory(impl, assoluta);
  if (!q2.ok) throw erroreCatena(q2.code, 'chain refused after creation');
  // The identity read before the creation is the expected one. A ring that was
  // already there and now answers with another object has been replaced between
  // the two qualifications: the difference is already visible, so it is refused
  // instead of being synced and adopted. The rings this call created have no
  // earlier identity and follow the rule of the new ones.
  const sincronizzabili = new Map(q2.identita);
  for (const anello of q1.anelli) {
    const prima = q1.identita.get(anello);
    if (!prima) continue;
    const dopo = q2.identita.get(anello);
    if (!dopo || dopo.dev !== prima.dev || dopo.ino !== prima.ino) {
      throw erroreCatena('ESTALE', 'chain ring replaced between the two qualifications');
    }
    sincronizzabili.set(anello, prima);
  }
  for (const anello of tratto) {
    const dopo = q2.identita.get(anello);
    if (!dopo) throw erroreCatena('ESTALE', 'chain ring disappeared during the sync');
    // Only the rings this call created must be private; the ones already there
    // are qualified as they are and never tightened.
    if (!q1.preesistenti.has(anello) && (dopo.mode & 0o777) !== 0o700) {
      throw erroreCatena('ESTALE', 'new ring is not private');
    }
    fsyncDirQualificato(impl, anello, sincronizzabili);
    fsyncDirQualificato(impl, path.dirname(anello), sincronizzabili);
  }
}

// Il contesto del lancio e' la base durevole dello stop protetto: la sua
// scrittura segue tutta la disciplina (temporaneo privato, fsync del file,
// rename, fsync della directory e qualifica della catena fino al confine NC,
// ANCHE quando esiste gia') e OGNI errore si propaga. Una scrittura che non
// si puo' dichiarare durabile non e' un successo: nessuna falsa persistenza.
function scriviContesto(stateDir, dato, fsImpl) {
  const impl = fsImpl || fs;
  assicuraDirDurevole(impl, stateDir);
  const file = dirContesto(stateDir);
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const fd = impl.openSync(tmp, 'wx', 0o600);
    try {
      impl.writeFileSync(fd, JSON.stringify(dato));
      impl.fchmodSync(fd, 0o600);
      impl.fsyncSync(fd);
    } finally { impl.closeSync(fd); }
    impl.renameSync(tmp, file);
  } catch (e) {
    // Il temporaneo non e' mai diventato il file: si toglie (best effort,
    // l'errore che conta e' quello propagato, non questo).
    try { impl.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  fsyncDirQualificato(impl, stateDir, null);
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

// Byte GREZZI del contesto, senza validazione: serve al confronto per bytes
// del rollback della readiness, che classifica il disco confrontandolo
// con le serializzazioni attese del PROPRIO lancio (stessa forma di
// scriviContesto). leggiContesto restituisce un oggetto validato, non i byte:
// questo è l'unico lettore qualificato della forma grezza.
//   Buffer  — i byte letti;
//   null    — assente (ENOENT): un'osservazione, NON una provenienza;
//   { errore } — illeggibile per qualunque altro motivo.
function leggiBytesContesto(stateDir) {
  let buf;
  try { buf = fs.readFileSync(dirContesto(stateDir)); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return { errore: 'illeggibile' };
  }
  return buf;
}

// Riqualifica la durabilità del contesto GIA' presente SENZA riscriverlo
// (il rename è avvenuto, un fsync successivo è fallito): catena
// (assicuraDirDurevole, idempotente), fsync del file sul DESCRIPTORE
// qualificato (O_NOFOLLOW, fstat regolare e coincidente con l'lstat del
// nome PRIMA di mutare — disciplina dei descriptor qualificati), fsync della
// directory, e rilettura dei byte. Nessun contenuto toccato: un sostituto
// sotto il nome viene rifiutato ({ errore }), mai sincronizzato per errore.
function riqualificaContesto(stateDir, fsImpl) {
  const impl = fsImpl || fs;
  const file = dirContesto(stateDir);
  let prima = null;
  try { prima = impl.lstatSync(file); } catch (_) { return { errore: 'assente' }; }
  if (!prima.isFile()) return { errore: 'tipo' };
  assicuraDirDurevole(impl, stateDir);
  let fd = null;
  try {
    fd = impl.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = impl.fstatSync(fd);
    if (!st.isFile() || st.dev !== prima.dev || st.ino !== prima.ino) {
      return { errore: 'sostituito' };
    }
    impl.fsyncSync(fd);
  } catch (_) {
    return { errore: 'illeggibile' };
  } finally {
    if (fd != null) { try { impl.closeSync(fd); } catch (_) { /* best-effort */ } }
  }
  fsyncDirQualificato(impl, stateDir, null);
  const dopo = leggiBytesContesto(stateDir);
  if (!dopo || dopo.errore) return { errore: 'illeggibile' };
  return dopo;
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

// KERNEL observation of the peer. Il pid che lo status
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

// ---------------------------------------------------------------------------
// L'osservatore kernel del peer
// ---------------------------------------------------------------------------
// Vive qui, ed e' privato di questo modulo: il modulo di recupero lo usa come
// proprio default (dipendenza sua, non export), cosi' la lettura del kernel e'
// una sola in tutta la flotta. La direzione dei require e' una sola e va in
// quel verso: il recupero richiede questo modulo (top-level, gia' esistente);
// da qui il recupero non si richiede mai.

// Un pid e' utilizzabile solo come intero sicuro maggiore di uno. Nulla si
// converte: una stringa numerica, un float, un booleano o un intero fuori
// range non sono un pid. Copia privata del predicato del modulo di recupero.
function guardPid(pid) {
  return Number.isSafeInteger(pid) && pid > 1;
}

// Una riga di stat di /proc/<pid>: il nome del comando puo' contenere spazi e
// parentesi, quindi i campi si leggono dopo l'ULTIMA parentesi chiusa.
function campiStat(testo) {
  if (typeof testo !== 'string') return null;
  const fine = testo.lastIndexOf(')');
  if (fine < 0) return null;
  const campi = testo.slice(fine + 2).trim().split(/\s+/);
  if (campi.length < 20) return null;
  const pgid = Number(campi[2]);
  const sid = Number(campi[3]);
  const startTicks = Number(campi[19]);
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return null;
  if (!Number.isSafeInteger(sid) || sid <= 0) return null;
  if (!Number.isSafeInteger(startTicks) || startTicks < 0) return null;
  return { stato: campi[0], pgid, sid, startTicks };
}

// L'osservatore di produzione legge l'identita' intera e legge la riga di stat
// DUE volte: un processo cambiato mentre gli si raccoglievano uid, namespace e
// boot non e' una fotografia, e una fotografia che non e' una fotografia non
// e' una prova. Un ENOENT senza nodo attestato non e' una morte.
function osservatoreKernel(fsImpl) {
  return (pid, instanceId) => {
    if (!guardPid(pid)) return { state: 'unverifiable', reason: 'malformed' };
    let prima;
    try {
      prima = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        const nodo = identitaNodoKernel(fsImpl);
        if (!nodo) return { state: 'unverifiable', reason: 'absent-domain-unknown' };
        return { state: 'absent', node: nodo };
      }
      return { state: 'unverifiable', reason: e && e.code === 'EACCES' ? 'access' : 'io' };
    }
    const inizio = campiStat(prima);
    if (!inizio) return { state: 'unverifiable', reason: 'malformed' };

    let uid;
    try {
      const riga = fsImpl.readFileSync(`/proc/${pid}/status`, 'utf8')
        .split('\n').find((r) => r.startsWith('Uid:'));
      const parti = riga ? riga.trim().split(/\s+/) : [];
      uid = Number(parti[2]);
    } catch (e) {
      return { state: 'unverifiable', reason: e && e.code === 'EACCES' ? 'access' : 'io' };
    }
    if (!Number.isSafeInteger(uid) || uid < 0) return { state: 'unverifiable', reason: 'malformed' };

    let ino;
    try { ino = fsImpl.statSync(`/proc/${pid}/ns/pid`).ino; } catch (e) {
      return { state: 'unverifiable', reason: e && e.code === 'EACCES' ? 'access' : 'io' };
    }
    if (!Number.isSafeInteger(ino) || ino <= 0) return { state: 'unverifiable', reason: 'malformed' };

    const bootId = bootIdKernel(fsImpl);
    if (!bootId) return { state: 'unverifiable', reason: 'io' };

    let dopo;
    try {
      dopo = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (_) {
      return { state: 'unverifiable', reason: 'changed-snapshot' };
    }
    // The two reads must be the same bytes: the identity collected between them
    // belongs to the object they describe only if it did not move.
    if (dopo !== prima) return { state: 'unverifiable', reason: 'changed-snapshot' };

    const identity = {
      state: 'live',
      source: 'kernel-peer-v1',
      instanceId,
      pid,
      uid,
      bootId,
      pidNamespaceInode: String(ino),
      startTicks: String(inizio.startTicks),
      pgid: inizio.pgid,
      sid: inizio.sid,
    };
    if (validaHostIdentity(identity)) return { state: 'unverifiable', reason: 'malformed' };
    return { state: 'observed', identity, processState: inizio.stato };
  };
}

// La qualifica che il RUNTIME esegue prima di fermare l'host di un lancio.
// Un solo probe di stato (lo stesso comando che fermerebbe l'host, riusato
// poi da fermaHost dentro lo stesso budget monotono); se un host c'e', si
// osserva il peer dichiarato nel kernel e lo si confronta con la tuple
// REGISTRATA NEL CONTESTO v2 ALL'UP:
// qualunque differenza (sostituzione, pid riusato, namespace/boot diversi)
// e' «ignoto», e un record ancora pending non si promuove qui — l'identita'
// nasce all'up dal binario attestante o non nasce.
// Poi il giudizio ternario (isolato / nel-gruppo / ignoto) con nodo e
// coordinatore. Esito: { isolamento, motivo, record, residuoMs, probe }.
// `motivo` e' bounded: none | budget | probe | pid-assente | osservazione |
// identita | isolato | nel-gruppo | ignoto.
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
  // Il campo vero di `vl host status --json` e' `declared_pid` (VL 0.4:
  // crates/vivling/src/host_status.rs:35). `pid` resta accettato come nome
  // storico di una versione precedente del contratto; se ci sono entrambi
  // vince `declared_pid`. In nessun caso il valore e' un'identita': e' solo il
  // puntatore con cui il kernel viene interrogato, e la prova arriva da
  // /proc (osservaPeerKernel).
  const pid = Number(stato.declared_pid !== undefined ? stato.declared_pid : stato.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return male('pid-assente', probe);
  // Un pid dichiarato che non nomina nessun processo (pid_number_in_use
  // false): non c'e' peer da osservare, quindi l'isolamento non e'
  // dimostrabile. Fail-closed, come un pid assente.
  if (stato.pid_number_in_use === false) return male('pid-assente', probe);
  const osserva = typeof osservaPeer === 'function' ? osservaPeer : osservaPeerKernel;
  const osservata = osserva(pid, instanceId);
  if (!osservata || validaHostIdentity(osservata)) return male('osservazione', probe);
  // L'identita' del peer si registra ALL'UP, prima di
  // dichiarare il lancio riuscito (registraIdentitaPeer). Qui non si promuove
  // MAI un pending: un record v2 senza identita' registrata e' un record non
  // attestato (lancio di una versione che non registrava, o registrazione
  // fallita) e chiede la procedura esplicita — non un «primo sguardo» che la
  // fa nascere al down. Il giudizio resta fail-closed: senza tuple registrata
  // non c'e' confronto possibile, quindi nessuno stop.
  const registrata = record.hostIdentity && record.hostIdentity.state === 'live'
    && !validaHostIdentity(record.hostIdentity) ? record.hostIdentity : null;
  if (!registrata) return male('identita', probe);
  const nodo = (typeof identitaNodo === 'function' ? identitaNodo : identitaNodoKernel)();
  const coordinatore = (typeof identitaCoordinatore === 'function' ? identitaCoordinatore : identitaCoordinatoreKernel)();
  const isolamento = giudicaIsolamento({ registrata, osservata, coordinatore, nodo });
  return { isolamento, motivo: isolamento, record, residuoMs: Math.max(0, resta()), probe };
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

function envDalRecord(record, extra = {}) {
  const vlModel = extra && typeof extra.vlModel === 'string' && extra.vlModel ? extra.vlModel : '';
  return {
    HOME: record.HOME,
    XDG_STATE_HOME: record.XDG_STATE_HOME,
    XDG_DATA_HOME: record.XDG_DATA_HOME,
    XDG_CONFIG_HOME: record.XDG_CONFIG_HOME,
    PATH: '/usr/bin:/bin',
    // Solo quando il lancio ha consegnato il modello come VL_MODEL: il probe
    // deve risolvere l'etichetta con la STESSA fonte del client (la precedenza
    // di VL: VL_MODEL > --profile > selected.toml > default_profile), non con
    // una diversa. Senza un VL_MODEL nel lancio la variabile non compare.
    ...(vlModel ? { VL_MODEL: vlModel } : {}),
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
    // Il tempo passato a questa sonda, visibile al test: e' lo stesso valore
    // del timer, gia' limitato al residuo dal chiamante.
    if (child) child.timeoutMs = timeoutMs;
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

// Preflight di capacità peer/stop PRIMA dello spawn. Il fatto
// dichiarato dallo status è del BINARIO (pinnato), non dell'host: `host
// status --json` porta `peer_identity_support` e `capabilities` in ogni
// stato, host assente compreso, quindi si chiede prima di crearne uno. Si
// richiedono ENTRAMBE le capacità versionate del ciclo peer/stop E il support
// all'osservazione del peer: senza una di queste l'up è rifiutato in modo
// visibile — nessuno spawn, nessun ripiego su un binario che non potrebbe
// attestare il processo che fermerebbe. Fall-closed: un probe non concluso,
// un JSON illeggibile, un support assente valgono come rifiuto. `motivo` è
// bounded: probe | support | capacita. NodeId e owner non c'entrano: qui
// non si deriva nessuna identità di nodo dal processo host.
const CAPACITA_PEER = 'host_peer_identity_v1';
const CAPACITA_STOP_ATTESO = 'host_stop_expected_v1';

// Root usa e getta per la sonda di capacità quando la root reale non c'è.
// Non è host-v1 e non entra nel contesto: --server-root è l'unica differenza.
function sondaPrivata(st, uid) {
  return !!st && !st.isSymbolicLink() && st.isDirectory()
    && st.uid === uid && (st.mode & 0o777) === 0o700;
}

// Il binario rifiuta un --server-root figlio diretto di /tmp (non è nostro).
// La root della sonda è un livello sotto una mkdtemp 0700, così il padre è
// nostro. base è l'inode che la pulizia rimuove; dir è solo --server-root.
function preparaSondaRadice(deps = {}) {
  const mkdtemp = deps.mkdtemp || ((p) => fs.mkdtempSync(p));
  const mkdir = deps.mkdir || ((p) => fs.mkdirSync(p, { mode: 0o700 }));
  const lstat = deps.lstat || fs.lstatSync;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  let base;
  try { base = mkdtemp(path.join('/tmp', 'nc-vl-cap-')); }
  catch (e) { return { ok: false, code: (e && e.code) || 'mkdir' }; }
  let bst;
  try { bst = lstat(base); }
  catch (e) {
    // La base esiste ma l'identita' non e' provata: non si cancella.
    return { ok: false, code: (e && e.code) || 'stat', base, residuo: base };
  }
  if (!sondaPrivata(bst, uid)) {
    return { ok: false, code: 'insicura', base, dir: base, dev: bst && bst.dev, ino: bst && bst.ino };
  }
  const dir = path.join(base, 'r');
  try { mkdir(dir); }
  catch (e) { return { ok: false, code: (e && e.code) || 'mkdir', base, dir, baseDev: bst.dev, baseIno: bst.ino }; }
  let st;
  try { st = lstat(dir); }
  catch (e) {
    return { ok: false, code: (e && e.code) || 'stat', base, dir, baseDev: bst.dev, baseIno: bst.ino };
  }
  if (!sondaPrivata(st, uid)) {
    return { ok: false, code: 'insicura', base, dir, dev: st && st.dev, ino: st && st.ino, baseDev: bst.dev, baseIno: bst.ino };
  }
  return { ok: true, dir, dev: st.dev, ino: st.ino, base, baseDev: bst.dev, baseIno: bst.ino };
}

function pulisciSondaRadice(prep, deps = {}) {
  if (!prep || typeof prep.dir !== 'string') return false;
  const lstat = deps.lstat || fs.lstatSync;
  const rm = deps.rm || ((p) => fs.rmSync(p, { recursive: true, force: false }));
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const base = typeof prep.base === 'string' ? prep.base : prep.dir;
  let bst;
  try { bst = lstat(base); }
  catch (e) { return !!(e && e.code === 'ENOENT'); }
  const attesoDev = prep.baseDev != null ? prep.baseDev : prep.dev;
  const attesoIno = prep.baseIno != null ? prep.baseIno : prep.ino;
  if (!bst || bst.isSymbolicLink() || !bst.isDirectory() || bst.uid !== uid || bst.dev !== attesoDev || bst.ino !== attesoIno) {
    return false;
  }
  // Il figlio si controlla solo se la sua identita' e' stata qualificata.
  // Senza, si rimuove la sola base gia' provata e non si tocca un path opaco.
  if (prep.base && prep.dev != null) {
    let st = null;
    try { st = lstat(prep.dir); }
    catch (e) { if (!e || e.code !== 'ENOENT') return false; }
    if (st && (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || st.dev !== prep.dev || st.ino !== prep.ino)) return false;
  }
  try { rm(base); }
  catch (_) { return false; }
  try { lstat(base); return false; }
  catch (e) { return !!(e && e.code === 'ENOENT'); }
}

async function verificaCapacitaPeerStop({ bin, env, root, budgetMs, spawnImpl }) {
  const tetto = Number.isFinite(budgetMs) ? Math.max(50, Math.min(PROBE_MS, budgetMs)) : PROBE_MS;
  const r = await lancia(bin, ['host', 'status', '--json', '--server-root', root], env, tetto, spawnImpl);
  const rifiuta = (motivo) => ({ ok: false, motivo, probe: r });
  if (!sondaConclusa(r)) return rifiuta('probe');
  const stato = leggiStato(r.stdout);
  if (!stato) return rifiuta('probe');
  if (stato.peer_identity_support !== 'supported') return rifiuta('support');
  const caps = Array.isArray(stato.capabilities) ? stato.capabilities : [];
  if (!caps.includes(CAPACITA_PEER) || !caps.includes(CAPACITA_STOP_ATTESO)) return rifiuta('capacita');
  return { ok: true, stato };
}

// Registrazione dell'identita' del peer host ALL'UP, prima che il lancio
// sia dichiarato riuscito. Dopo lo spawn la TUI
// ha un host (nasce con lei, o era gia' li'): il binario PINNATO lo
// interroga e la sua `peer_identity` dev'essere `verified` — la tuple
// kernel provata dal binario sulla connessione Observer, NON un pid
// diagnostico. La tuple viene salvata nel contesto del launchId con la
// stessa disciplina durevole di scriviContesto. Senza `verified` il lancio
// e' FALLITO e visibile: nessun «isolato» si deduce da declared_pid, e un
// record resta pending solo se la registrazione e' fallita (mai promosso
// dopo, al down).
// L'host puo' nascere un istante dopo la readiness della TUI: lo stato
// `none` si RI-prova dentro un budget limitato (la TUI appena partita sta
// ancora facendo nascere l'host); un host VIVO senza verified invece non si
// ritenta — un hello rifiutato o una tuple illeggibile non guariscono
// riprovando. `motivo` e' bounded: budget | probe | assente | identita |
// persistenza.
const REGISTRAZIONE_BUDGET_MS = 5000;
const REGISTRAZIONE_PROBE_MS = 1500;
const REGISTRAZIONE_ATTESA_MS = 200;
const REGISTRAZIONE_TENTATIVI = 16;

// Il profilo con cui la TUI e' stata lanciata (`-p`/`--profile` nell'argv
// dell'engine): il probe di registrazione lo ripresenta, perche' l'hello
// dell'Observer viene RIFIUTUTO da un host con un'etichetta diversa — un
// mismatch di profilo e' un host vivo ma «unverified», non un host morto.
// Nessun profilo nell'argv → nessun --profile: il probe risolve la stessa
// etichetta della TUI (stesso XDG_CONFIG_HOME, stesso catalogo).
function profiloDaArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-p' || a === '--profile') {
      const v = argv[i + 1];
      return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : null;
    }
    if (typeof a === 'string' && a.startsWith('--profile=')) {
      const v = a.slice('--profile='.length);
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : null;
    }
  }
  return null;
}

// Il blocco `peer_identity` di uno status LIVE, nella forma hostIdentity del
// contesto v2. STRICT: solo `verified` con la tuple chiusa (i sette fatti
// kernel del peer, ognuno della forma che la sua sorgente scrive); ogni
// altro stato (unverified, unsupported, null), uno schema non-1 o un campo
// malformato valgono null — non si estrae un'identita' parziale.
function identitaDaPeerIdentity(peer, instanceId) {
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)) return null;
  if (peer.schema_version !== 1) return null;
  if (peer.state !== 'verified') return null;
  const h = {
    state: 'live',
    source: 'kernel-peer-v1',
    instanceId,
    pid: peer.pid,
    uid: peer.uid,
    bootId: peer.boot_id,
    pidNamespaceInode: typeof peer.pidns === 'number' ? String(peer.pidns) : peer.pidns,
    startTicks: typeof peer.starttime === 'number' ? String(peer.starttime) : peer.starttime,
    pgid: peer.pgid,
    sid: peer.sid,
  };
  return validaHostIdentity(h) ? null : h;
}

// La parte del blocco `peer_identity` che si puo' mostrare in un errore:
// schema e stato, mai la tuple (pid/uid/nascita restano fuori dal corpo e dal
// log). Un blocco assente o malformato vale null, non un oggetto inventato.
function peerRedatto(peer) {
  if (!peer || typeof peer !== 'object' || Array.isArray(peer)) return null;
  return {
    schemaVersion: Number.isSafeInteger(peer.schema_version) ? peer.schema_version : null,
    state: typeof peer.state === 'string' ? peer.state : null,
  };
}

function registraIdentitaPeer({
  bin, env, root, stateDir, record, profile, instanceId,
  budgetMs, monoNow, spawnImpl, attesaImpl, log,
}) {
  const adesso = typeof monoNow === 'function' ? monoNow : () => Date.now();
  const dormi = typeof attesaImpl === 'function' ? attesaImpl : (ms) => new Promise((r) => setTimeout(r, ms));
  const effettivoMs = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : REGISTRAZIONE_BUDGET_MS;
  const limite = adesso() + Math.min(effettivoMs, REGISTRAZIONE_BUDGET_MS);
  const argv = ['host', 'status', '--json', '--server-root', root];
  if (profile) argv.push('--profile', profile);
  let ultimo = null;
  let tentativi = 0;
  return (async () => {
    for (;;) {
      const resta = limite - adesso();
      // Il tetto dei tentativi protegge anche da un clock iniettato fermo:
      // il budget da solo non basterebbe a chiudere il giro.
      if (tentativi >= REGISTRAZIONE_TENTATIVI || (tentativi > 0 && resta < 50)) {
        const motivo = !ultimo ? 'budget'
          : ultimo.stato && ultimo.stato.state === 'none' ? 'assente' : 'probe';
        return { ok: false, motivo, probe: ultimo };
      }
      tentativi += 1;
      const r = await lancia(bin, argv, env, Math.min(REGISTRAZIONE_PROBE_MS, Math.max(50, resta)), spawnImpl);
      const stato = sondaConclusa(r) ? leggiStato(r.stdout) : null;
      ultimo = { r, stato };
      if (stato && stato.state === 'live') {
        // VIVO: qui si decide. La tuple del binario o c'e, con i sette fatti
        // kernel chiusi, o il lancio non si puo dichiarare: un live senza
        // verified non si ritenta (non guarisce) e un pid diagnostico non
        // vale identita'.
        const identita = identitaDaPeerIdentity(stato.peer_identity, instanceId);
        if (!identita) {
          return { ok: false, motivo: 'identita', stage: 'identity', peer: peerRedatto(stato.peer_identity), probe: ultimo };
        }
        const completo = completaIdentita(record, identita);
        if (!completo) {
          return { ok: false, motivo: 'identita', stage: 'context', peer: peerRedatto(stato.peer_identity), probe: ultimo };
        }
        try {
          scriviContesto(stateDir, completo);
        } catch (_) {
          // Il COMPLETO torna al chiamante anche nel fallimento: il rollback
          // della readiness lo usa per classificare i byte sul disco
          // (pending proprio da ritentare, completo proprio da riqualificare)
          // senza mai esporre la tuple nel body o nel log.
          return { ok: false, motivo: 'persistenza', record: completo, probe: ultimo };
        }
        if (typeof log === 'function') log('host-identity-registered');
        return { ok: true, record: completo, probe: ultimo };
      }
      // none / lock / silent / probe non concluso: l'host puo' essere in
      // fase di nascita — si riprova dentro il budget.
      await dormi(REGISTRAZIONE_ATTESA_MS);
    }
  })();
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

const ATTESA_NONE_MS = 50;

// Tetto fissato una volta, al momento dell'ack. La prima lettura e' compresa.
// Non si ricalcola se lo status torna live: il clock fermo resta finito.
function tettoOsservazione(residuoMs) {
  const residuo = Number.isFinite(residuoMs) && residuoMs > 0 ? residuoMs : 0;
  const dalResiduo = 1 + Math.ceil(residuo / ATTESA_NONE_MS);
  const dalBudget = 1 + Math.ceil(BUDGET_MS / ATTESA_NONE_MS);
  return Math.min(dalResiduo, dalBudget);
}

function peerDivergente(record, stato) {
  const p = stato && stato.peer_identity;
  if (!p || p.state !== 'verified') return false;
  const atteso = tuplaAttesaDaRecord(record);
  if (!atteso) return false;
  const start = typeof p.starttime === 'number' ? String(p.starttime) : p.starttime;
  const pidns = typeof p.pidns === 'number' ? String(p.pidns) : p.pidns;
  return `${p.pid}:${p.uid}:${start}:${p.boot_id}:${pidns}:${p.pgid}:${p.sid}` !== atteso;
}

// Il dominio REGISTRATO nel record: la tupla live del contesto v2, se c'e'. Un
// record v1 non ne ha una e resta sul cammino storico; un record v2 senza
// tupla valida e' gia' stato rifiutato prima di arrivare qui.
function dominioRegistrato(record) {
  const h = record && record.hostIdentity;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  if (h.state !== 'live' || validaHostIdentity(h)) return null;
  return h;
}

// Un nodo appartiene al dominio registrato solo con lo stesso boot e lo stesso
// spazio dei pid: due letture che si somigliano in un altro mondo non parlano
// del processo del record.
function stessoDominio(nodo, h) {
  return !!nodo && typeof nodo === 'object'
    && nodo.bootId === h.bootId
    && String(nodo.pidNamespaceInode) === String(h.pidNamespaceInode);
}

// La prova d'uscita dopo l'ack: il pid registrato deve MANCARE al kernel nel
// dominio registrato, e il nodo che osserva deve essere quello del record. Solo
// una foto `absent` con quel nodo e' prova. Un pid vivo, uno zombie, un pid
// riusato, un'osservazione incerta, un nodo diverso o un osservatore che lancia
// non lo sono: non si promuove niente. Solo letture sincrone, zero await; il
// consenso al recupero non c'entra e non viene letto.
function uscitaProvata(h, osservaKernel, identitaNodo) {
  let nodo = null;
  try { nodo = identitaNodo(); } catch (_) { return false; }
  if (!stessoDominio(nodo, h)) return false;
  let oss = null;
  try { oss = osservaKernel(h.pid, h.instanceId); } catch (_) { return false; }
  if (!oss || typeof oss !== 'object' || oss.state !== 'absent') return false;
  return stessoDominio(oss.node, h);
}

// Dopo un solo shutdown_ack attestato. Si osserva lo status: un none promuove
// a host-stopped-clean SOLO con l'uscita provata dal kernel nel dominio
// registrato; senza prova il ciclo prosegue come per un host vivo. Un vivo
// continua, una sonda guasta e' BARRIER subito. Nessun secondo stop. La
// deadline e' quella gia' fissata; un none a scadenza non vale.
async function attendiNoneDopoAck({ nMax, resta, record, dormi, leggi, osservaKernel, identitaNodo }) {
  const barriera = { outcome: 'host-stop-failed', code: 'BARRIER', reason: 'shutdown_ack' };
  const registrato = dominioRegistrato(record);
  let letture = 0;
  while (letture < nMax) {
    const residuo = resta();
    if (!(residuo > 0)) return barriera;
    letture += 1;
    const letto = await leggi(Math.min(PROBE_MS, residuo));
    if (!(resta() > 0)) return barriera;
    if (!letto || !sondaConclusa(letto.r) || !letto.stato) return barriera;
    if (letto.stato.state === 'none') {
      // Un record v1 non ha un dominio registrato: resta la promozione
      // storica. Un record con tupla vive la prova del kernel.
      if (!registrato) return { outcome: 'host-stopped-clean' };
      // Le due letture della prova sono sincrone ma non gratuite: il budget si
      // rilegge DOPO, e una prova conclusa a scadenza o oltre non promuove. La
      // deadline resta quella gia' fissata, nessun rinnovo.
      if (uscitaProvata(registrato, osservaKernel, identitaNodo) && resta() > 0) {
        return { outcome: 'host-stopped-clean' };
      }
    } else if (peerDivergente(record, letto.stato)) {
      return { outcome: 'host-stop-failed', code: 'HOST_PEER_MISMATCH', reason: 'peer_mismatch' };
    }
    if (letture >= nMax) break;
    const perPausa = resta();
    if (!(perPausa > 0)) break;
    await dormi(Math.min(ATTESA_NONE_MS, perPausa));
    if (!(resta() > 0)) break;
  }
  return barriera;
}

function sondaConclusa(r) {
  // Un'uscita troncata non e' una sonda conclusa: da un prefisso non si ricava
  // ne' una capacita' ne' un `none`.
  return !!r && r.code === 0 && r.ucciso !== true && r.troncato !== true && !r.errore;
}

async function fermaHost({ record, bin, budgetMs, monoNow, spawnImpl, isolamento, probeIniziale, deadlineAt, attesaImpl,
  osservaKernel, identitaNodo }) {
  const inizio = monoNow();
  const effettivoMs = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : BUDGET_MS;
  let limite = inizio + Math.min(effettivoMs, BUDGET_MS);
  if (Number.isFinite(deadlineAt)) limite = Math.min(limite, deadlineAt);
  const resta = () => limite - monoNow();
  const dormi = typeof attesaImpl === 'function'
    ? attesaImpl
    : (ms) => new Promise((r) => setTimeout(r, ms));
  // Le dipendenze della prova d'uscita: i default di produzione leggono /proc,
  // i test passano i propri doppi. Non sono un interruttore: dopo un ack la
  // promozione a pulito passa sempre da qui.
  const osserva = typeof osservaKernel === 'function' ? osservaKernel : osservatoreKernel(fs);
  const nodoOra = typeof identitaNodo === 'function' ? identitaNodo : () => identitaNodoKernel(fs);
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
  // Il chiamante (qualificaIsolamentoHost) puo' consegnare il probe di
  // stato gia' fatto, nello stesso budget monotono: si riusa quella
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
  // Lo stop protetto: la tuple REGISTRATA ALL'UP e' la condizione per fermare
  // l'host. Un contesto v2 che non ne ha una (pending: registrazione fallita o
  // lancio di una versione che non registrava) non si promuove al down —
  // rifiuto visibile, zero comandi. I record v1 (senza hostIdentity) restano
  // sul cammino storico: il runtime non li porta piu' fin qui.
  const attesa = tuplaAttesaDaRecord(record);
  if (record && record.hostIdentity !== undefined && !attesa) {
    return { outcome: 'host-stop-failed', code: 'IDENTITY_UNKNOWN', spawned };
  }
  // La capacita' dice quale comando; non autorizza lo stop (l'isolamento l'ha
  // gia' fatto sopra). Il vecchio comando e' solo per chi non la dichiara.
  const interno = dichiaraStop(primo.stato);
  const via = interno ? 'internal' : 'legacy';
  const argv = interno
    ? ['internal', 'host-stop', '--server-root', root, '--json',
      ...(attesa ? ['--expected', attesa] : [])]
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
    // Un rifiuto PROTETTO dello stop expected (peer diverso, identita' non
    // provata, tuple malformita) e' un fallimento con un CODICE SUO, che
    // viaggia fino all'operatore: e non c'e' alcun ripiego, ne' sul vecchio
    // comando ne' su un secondo tentativo.
    if (!esito.ok && ESITI_STOP_ATTESO[esito.reason]) {
      return { outcome: 'host-stop-failed', code: ESITI_STOP_ATTESO[esito.reason], reason: esito.reason, spawned, via };
    }
    // Un rifiuto dichiarato e' un fallimento, con la sua parola. Fa eccezione
    // server_absent: l'host puo' essere sparito tra i due probe, e lo dice lo
    // status che segue, senza inventare un ack.
    if (!esito.ok && esito.reason !== 'server_absent') {
      return { outcome: 'host-stop-failed', code: 'STOP_FAILED', reason: esito.reason, spawned, via };
    }
    if (esito.ok && esito.reason === 'shutdown_ack') {
      const visto = await attendiNoneDopoAck({
        nMax: tettoOsservazione(resta()),
        resta, record, dormi, osservaKernel: osserva, identitaNodo: nodoOra, leggi: async (ms) => {
          spawned += 1;
          const r = await lancia(bin, ['host', 'status', '--json', '--server-root', root], env, ms, spawnImpl);
          return { r, stato: leggiStato(r.stdout) };
        },
      });
      return { ...visto, spawned, via };
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
  leggiBytesContesto, riqualificaContesto, assicuraDirDurevole, qualificaCatenaDirectory,
  validaHostIdentity, contestoIniziale, completaIdentita, giudicaIsolamento,
  qualificaIsolamentoHost, osservaPeerKernel, identitaNodoKernel, identitaCoordinatoreKernel, bootIdKernel,
  // L'osservatore del kernel: interna. Il modulo di recupero la usa come
  // proprio default; non e' una superficie di prodotto.
  osservatoreKernel,
  // Esposti per i test (registrazione identita' peer).
  identitaDaPeerIdentity, registraIdentitaPeer, profiloDaArgv,
  // Esposti per i test (stop e capacita').
  leggiEsitoStop, leggiStato, dichiaraStop, tempoStop, STOP_REASONS, verificaCapacitaPeerStop,
  preparaSondaRadice, pulisciSondaRadice,
  // Lo stop protetto con la tuple registrata all'up.
  tuplaAttesaDaRecord, ESITI_STOP_ATTESO,
  PROBE_MS, STOP_MS, BUDGET_MS, POST_PROBE_RESERVE_MS, MARGIN_MS, MAX_OUT,
  REGISTRAZIONE_BUDGET_MS, REGISTRAZIONE_PROBE_MS, REGISTRAZIONE_ATTESA_MS, REGISTRAZIONE_TENTATIVI,
};
