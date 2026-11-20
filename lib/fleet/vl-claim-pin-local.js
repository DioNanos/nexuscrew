'use strict';
// Pin LOCALE della toolchain per la claim della root vl, su piattaforme che il
// manifest di build non copre (Termux: node e flock sono pacchetti dell'utente
// e cambiano con gli aggiornamenti di sistema).
//
// Regole del contratto:
//  - il pin locale esiste SOLO se un operatore lo ha registrato con un'azione
//    esplicita (`nexuscrew vl-pin provision`): niente auto-pin al primo up, al
//    postinstall o al boot. Cancellare il file non e' un consenso: senza pin
//    la richiesta e' rifiutata.
//  - dichiara la PROVENIENZA (`operator-provisioned`) e la piattaforma del
//    RUNTIME (`process.platform`+`process.arch`), mai un nome di target.
//  - il componente localizzato e' il SOLO `flock` (record v2). Il Node della
//    claim non e' piu' un pin: e' il runtime effettivo, qualificato dal
//    processo. I record v1 legacy (flock+node) si leggono, si validano per
//    intero e si proiettano senza mai aprire il loro node. L'helper della
//    sezione critica resta vincolato all'hash della release, sempre.
//  - i path devono stare nel prefisso del runtime (la directory del node che
//    esegue NexusCrew) su Android, oppure nell'insieme CHIUSO del flock di
//    sistema su Linux: niente PATH o PREFIX arbitrari, niente path relativi.
//  - pubblicazione atomica e no-replace: temporaneo 0600 nella stessa
//    directory qualificata, fsync, `link(2)`; `EEXIST` e' un rifiuto, salvo
//    ri-registrazione esplicita (`again`).
//  - nessuna credenziale nel file: solo path, hash, versione, provenienza,
//    istante e l'etichetta dichiarata dall'operatore.
//  - verifiche: schema chiuso, hash dei byte dei sorgenti, versione di flock
//    letta sull'oggetto QUALIFICATO (mai sul sorgente non approvato). Una
//    sostituzione successiva e' `PIN_MISMATCH`; un file assente e'
//    `PIN_ABSENT`; un pin che non c'e' e' `PIN_UNCOVERED`.
const fs = require('node:fs');
const path = require('node:path');
const { pubblicaEsclusiva } = require('./exclusive-publish.js');
const crypto = require('node:crypto');

const SCHEMA = 'vl-claim-pin-local';
const V = 1;
const V2 = 2;
const PROVENIENZA = 'operator-provisioned';
// Node su Android riporta platform 'android' e arch 'arm64'. Su Linux il pin
// e' il ripiego dopo un aggiornamento di sistema che cambia la flock rispetto
// al catalogo della release; darwin resta fuori (un altro schema).
const PIATTAFORME_AUTORIZZATE = new Set(['android-arm64', 'linux-x64', 'linux-arm64']);
const RE_SHA = /^[0-9a-f]{64}$/;

function chiave(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function piattaformaAutorizzata(k) {
  return typeof k === 'string' && PIATTAFORME_AUTORIZZATE.has(k);
}

function percorso(home) {
  return path.join(home, '.nexuscrew', 'vl-claim-pin.local.json');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function testoBounded(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
}

function chiaviEsatte(ogg, attese) {
  if (!ogg || typeof ogg !== 'object' || Array.isArray(ogg)) return true;
  const chiavi = Object.keys(ogg).sort();
  const volute = [...attese].sort();
  return chiavi.length !== volute.length || chiavi.some((k, i) => k !== volute[i]);
}

function pathAssoluto(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 && path.isAbsolute(v);
}

// Schema chiuso, DISPATCH ESPLICITO sulla versione del record: `v` deve
// essere l'intero esatto 1 oppure 2 — niente coercizione, default o inferenza
// dai componenti. v1 e' il record legacy (components flock+node): si valida
// PER INTERO, ma il suo node e' dato legacy che non si apre e non si
// confronta col runtime. v2 e' il record corrente: components contiene il
// SOLO flock. Ogni chiave in piu' o in meno e' un rifiuto.
function validaPin(pin) {
  const ko = (motivo) => ({ ok: false, motivo });
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return ko('forma');
  if (pin.v !== V && pin.v !== V2) return ko('versione');
  const chiavi = Object.keys(pin).sort();
  const attese = ['by', 'components', 'helper', 'platform', 'provenance', 'schema', 'ts', 'v'].sort();
  if (chiavi.length !== attese.length || chiavi.some((k, i) => k !== attese[i])) return ko('schema');
  if (pin.schema !== SCHEMA || pin.provenance !== PROVENIENZA) return ko('provenienza');
  if (!pin.platform || typeof pin.platform !== 'object' || Array.isArray(pin.platform)) return ko('piattaforma');
  if (chiaviEsatte(pin.platform, ['arch', 'platform'])) return ko('piattaforma');
  if (!testoBounded(pin.platform.platform, 32) || !testoBounded(pin.platform.arch, 32)) return ko('piattaforma');
  const comp = pin.components;
  if (!comp || typeof comp !== 'object' || Array.isArray(comp)) return ko('componenti');
  const chiaviComp = Object.keys(comp).sort();
  const volute = pin.v === V ? ['flock', 'node'] : ['flock'];
  if (chiaviComp.length !== volute.length || chiaviComp.some((k) => !volute.includes(k))) return ko('componenti');
  for (const nome of volute) {
    const c = comp[nome];
    if (!c || typeof c !== 'object' || Array.isArray(c)) return ko('componenti');
    if (chiaviEsatte(c, nome === 'flock' ? ['sha256', 'source', 'version'] : ['sha256', 'source'])) return ko('componenti');
    if (!pathAssoluto(c.source)) return ko('sorgente');
    if (typeof c.sha256 !== 'string' || !RE_SHA.test(c.sha256)) return ko('hash');
    if (nome === 'flock' && !testoBounded(c.version, 32)) return ko('versione');
  }
  if (!pin.helper || typeof pin.helper !== 'object' || Array.isArray(pin.helper)) return ko('helper');
  if (chiaviEsatte(pin.helper, ['sha256'])) return ko('helper');
  if (typeof pin.helper.sha256 !== 'string' || !RE_SHA.test(pin.helper.sha256)) return ko('helper');
  if (!Number.isSafeInteger(pin.ts) || pin.ts < 0) return ko('ts');
  if (!testoBounded(pin.by, 64)) return ko('attestatore');
  return { ok: true };
}

// La CATENA del pin, qualificata in sola lettura: `.nexuscrew` deve essere una
// directory vera, nostra e privata. `O_NOFOLLOW` sul file finale non vede un
// antenato simbolico: sostituire `.nexuscrew` con un link porta la lettura
// altrove restando «regolare». Qui si guarda e basta — nessun mkdir, nessun
// chmod: la verifica non crea e non corregge niente. Ritorna anche
// dev/ino per legare la catena prima e dopo la lettura del descriptor.
function catenaQualificata(home) {
  const dir = path.join(home, '.nexuscrew');
  let st;
  try { st = fs.lstatSync(dir); } catch (e) {
    // Nessuna directory significa nessun pin (assente), non «illeggibile»: la
    // differenza conta perche' PIN_UNCOVERED e PIN_REREAD sono codici diversi.
    return { ok: false, motivo: e && e.code === 'ENOENT' ? 'assente' : 'catena' };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, motivo: 'catena' };
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, motivo: 'catena-uid' };
  if ((st.mode & 0o777) !== 0o700) return { ok: false, motivo: 'catena-modo' };
  return { ok: true, dev: st.dev, ino: st.ino };
}

/**
 * Legge il pin locale. `stato`: `assente` (nessun file, nessun consenso),
 * `illeggibile` (I/O o schema), `presente` (con `pin` valido).
 */
function leggi(home) {
  const p = percorso(home);
  // La catena si qualifica a OGNI lettura, non solo al provision, e si
  // ricontrolla DOPO la lettura: se la directory viene sostituita durante il
  // lavoro, l'inode non e' piu' quello di prima e il pin non vale.
  const catena = catenaQualificata(home);
  if (!catena.ok && catena.motivo === 'assente') return { stato: 'assente' };
  if (!catena.ok) return { stato: 'illeggibile', motivo: catena.motivo };
  // Lettura per DESCRIPTOR: O_NOFOLLOW non segue un link, fstat qualifica il
  // file che si sta davvero leggendo (tipo, uid, modo 0600) e la seconda
  // fstat dimostra che il descriptor punta ancora allo stesso inode. Il
  // pathname non si riapre mai.
  let fd = null;
  let raw;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    return { stato: e && e.code === 'ENOENT' ? 'assente' : 'illeggibile', motivo: e && e.code === 'ELOOP' ? 'tipo' : 'apertura' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { stato: 'illeggibile', motivo: 'tipo' };
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { stato: 'illeggibile', motivo: 'uid' };
    if ((st.mode & 0o777) !== 0o600) return { stato: 'illeggibile', motivo: 'modo' };
    raw = fs.readFileSync(fd, 'utf8');
    const dopo = fs.fstatSync(fd);
    if (dopo.dev !== st.dev || dopo.ino !== st.ino) return { stato: 'illeggibile', motivo: 'sostituito' };
    const catenaDopo = catenaQualificata(home);
    if (!catenaDopo.ok) return { stato: 'illeggibile', motivo: catenaDopo.motivo };
    if (catenaDopo.dev !== catena.dev || catenaDopo.ino !== catena.ino) {
      return { stato: 'illeggibile', motivo: 'catena-sostituita' };
    }
  } catch (_) {
    return { stato: 'illeggibile', motivo: 'lettura' };
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) { /* best-effort */ }
  }
  let pin;
  try { pin = JSON.parse(raw); } catch (_) { return { stato: 'illeggibile', motivo: 'json' }; }
  const v = validaPin(pin);
  if (!v.ok) return { stato: 'illeggibile', motivo: v.motivo };
  return { stato: 'presente', pin };
}

function prefissoRuntime(execPath = process.execPath) {
  return typeof execPath === 'string' && path.isAbsolute(execPath) ? path.dirname(execPath) : null;
}

function nelPrefisso(file, execPath = process.execPath) {
  const pref = prefissoRuntime(execPath);
  if (!pref || !pathAssoluto(file)) return false;
  return path.dirname(path.resolve(file)) === path.resolve(pref);
}

// --- Sorgente del pin su Linux: insieme CHIUSO di sistema ------------------
// Su Linux il Node vive nella home dell'utente (nvm): il suo prefisso non e'
// un'ancora, e lo stesso vale per qualunque percorso della home. La sorgente
// ammessa e' il flock di sistema, di root, in una catena di directory di root.
// L'insieme e' chiuso: le due spelling qui sotto e nient'altro. `/bin/flock`
// vale solo se risolve allo stesso oggetto del canonico (usrmerge); un
// percorso della home non entra mai, nemmeno se risolve allo stesso file.
const SORGENTI_LINUX = Object.freeze(['/usr/bin/flock', '/bin/flock']);
const SORGENTE_LINUX_CANONICA = SORGENTI_LINUX[0];

function sorgenteLinux(piattaforma) {
  return typeof piattaforma === 'string' && piattaforma.startsWith('linux-');
}

// Qualifica di UN file di sistema: regolare, non link, eseguibile, di root,
// non scrivibile da gruppo/altri. La lettura e' O_NOFOLLOW e la stessa
// qualifica si rifa' sul DESCRIPTOR (l'oggetto aperto deve essere quello visto
// per nome). La catena delle directory fino a / e' tutta di root e non
// scrivibile da gruppo/altri, senza eccezione sticky. Ogni violazione e' un
// rifiuto motivato: nessun chmod, nessuna correzione, nessun PATH.
// `sourceFs` e' il seam interno dei test (metadati sintetici): default il
// filesystem reale, nessuna config/env/API/CLI puo' sceglierlo.
function qualificaFileSistema(file, sfs) {
  let st;
  try { st = sfs.lstatSync(file); } catch (e) {
    return { ok: false, motivo: e && e.code === 'ENOENT' ? 'assente' : 'source-policy' };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, motivo: 'source-policy' };
  if (st.uid !== 0 || (st.mode & 0o111) === 0 || (st.mode & 0o022) !== 0) {
    return { ok: false, motivo: 'source-policy' };
  }
  let buf;
  let fd = null;
  try {
    fd = sfs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const fst = sfs.fstatSync(fd);
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino
      || fst.uid !== 0 || (fst.mode & 0o111) === 0 || (fst.mode & 0o022) !== 0) {
      return { ok: false, motivo: 'source-policy' };
    }
    buf = sfs.readFileSync(fd);
  } catch (e) {
    return { ok: false, motivo: e && e.code === 'ENOENT' ? 'assente' : 'source-policy' };
  } finally {
    try { if (fd !== null) sfs.closeSync(fd); } catch (_) { /* best-effort */ }
  }
  let dir = path.dirname(file);
  for (;;) {
    let dst;
    try { dst = sfs.lstatSync(dir); } catch (_) { return { ok: false, motivo: 'source-policy' }; }
    if (dst.isSymbolicLink() || !dst.isDirectory()) return { ok: false, motivo: 'source-policy' };
    if (dst.uid !== 0 || (dst.mode & 0o022) !== 0) return { ok: false, motivo: 'source-policy' };
    const su = path.dirname(dir);
    if (su === dir) break;
    dir = su;
  }
  return { ok: true, dev: st.dev, ino: st.ino, buf };
}

// Qualifica della SORGENTE richiesta o registrata: deve appartenere
// all'insieme chiuso e superare la qualifica. `/bin/flock` in piu' deve
// risolvere allo stesso dev/ino del canonico. Una sola funzione, identica in
// provision e verifica, a ogni uso.
function qualificaSorgente(candidato, deps = {}) {
  const sfs = (deps && deps.sourceFs) || fs;
  if (typeof candidato !== 'string' || !SORGENTI_LINUX.includes(candidato)) {
    return { ok: false, motivo: 'source-policy' };
  }
  const canonico = qualificaFileSistema(SORGENTE_LINUX_CANONICA, sfs);
  if (!canonico.ok) return canonico;
  if (candidato === SORGENTE_LINUX_CANONICA) return canonico;
  let st;
  try { st = sfs.statSync(candidato); } catch (e) {
    return { ok: false, motivo: e && e.code === 'ENOENT' ? 'assente' : 'source-policy' };
  }
  if (st.dev !== canonico.dev || st.ino !== canonico.ino) return { ok: false, motivo: 'source-policy' };
  return canonico;
}

/**
 * Registra il pin locale (azione ESPLICITA dell'operatore).
 * Esito { ok: true, pin } oppure { ok: false, code } con i codici chiusi:
 * PIN_UNCOVERED (piattaforma non autorizzata), PIN_PREFIX (path fuori dal
 * prefisso del runtime o node diverso da quello effettivo), PIN_HELPER (hash
 * dell'helper diverso da quello della release), PIN_ABSENT / PIN_MISMATCH /
 * PIN_VERSION (misura dei sorgenti o dell'oggetto qualificato), PIN_EXISTS
 * (pin gia' presente senza `again`), PIN_WRITE (pubblicazione).
 * `versioneQualificata({source, sha256})` MUST leggere la versione
 * sull'oggetto qualificato (copia in staging), mai sul sorgente.
 */
function provisiona({
  home, flock, helperHash, by, ts = Date.now(), again = false,
  deps = {},
}) {
  const piattaforma = chiave(deps.platform, deps.arch);
  if (!piattaformaAutorizzata(piattaforma)) return { ok: false, code: 'PIN_UNCOVERED', platform: piattaforma };
  if (!pathAssoluto(flock)) return { ok: false, code: 'PIN_PREFIX', detail: 'flock' };
  // Sulle piattaforme senza policy di sistema (Android) il prefisso del
  // runtime decide PRIMA di ogni altro rifiuto: con una sorgente fuori
  // prefisso e un secondo dato invalido il codice resta PIN_PREFIX, come
  // nella serie storica. Linux non passa di qui: la sua sorgente ha la
  // qualifica d'insieme piu' sotto, e quella policy resta invariata.
  if (!sorgenteLinux(piattaforma)
    && !nelPrefisso(flock, deps.execPath || process.execPath)) {
    return { ok: false, code: 'PIN_PREFIX', detail: 'flock' };
  }
  if (typeof helperHash !== 'string' || !RE_SHA.test(helperHash)) return { ok: false, code: 'PIN_HELPER' };
  if (!testoBounded(by, 64)) return { ok: false, code: 'PIN_ATTESTATORE' };
  const versioneQualificata = deps.versioneQualificata;
  if (typeof versioneQualificata !== 'function') return { ok: false, code: 'PIN_VERSION' };

  const sorgente = path.resolve(flock);
  let bufFlock;
  if (sorgenteLinux(piattaforma)) {
    // Su Linux l'ancora e' la sorgente di SISTEMA, non il prefisso del Node:
    // fuori dall'insieme chiuso, o non qualificabile, il provision rifiuta
    // PIN_PREFIX e non registra niente.
    const q = qualificaSorgente(sorgente, deps);
    if (!q.ok) {
      return q.motivo === 'assente'
        ? { ok: false, code: 'PIN_ABSENT', component: 'flock' }
        : { ok: false, code: 'PIN_PREFIX', detail: 'flock' };
    }
    bufFlock = q.buf;
  } else {
    try { bufFlock = fs.readFileSync(flock); } catch (_) { return { ok: false, code: 'PIN_ABSENT', component: 'flock' }; }
  }
  const shaFlock = sha256(bufFlock);

  let versione = '';
  try {
    const letta = versioneQualificata({ source: sorgente, sha256: shaFlock });
    // A structured refusal means the object could not be materialized: that is
    // a staging problem, never a statement about the flock version.
    if (letta && typeof letta === 'object' && letta.ok === false) {
      if (letta.code === 'PIN_STAGE' || letta.code === 'PIN_DIR' || letta.code === 'PIN_REREAD') {
        return { ok: false, code: 'PIN_STAGE', component: 'flock' };
      }
      versione = '';
    } else {
      versione = String(letta || '');
    }
  } catch (_) { versione = ''; }
  if (!testoBounded(versione, 32)) return { ok: false, code: 'PIN_VERSION', component: 'flock' };

  // Il record v2 registra il SOLO flock (piattaforma, hash, versione) e
  // l'helper della release: il Node della claim non e' piu' un componente del
  // pin, e' il runtime qualificato dal processo. Nessun consenso Node si
  // scrive qui.
  const pin = {
    v: V2, schema: SCHEMA, provenance: PROVENIENZA,
    platform: { platform: deps.platform || process.platform, arch: deps.arch || process.arch },
    components: {
      flock: { source: sorgente, sha256: shaFlock, version: versione },
    },
    helper: { sha256: helperHash },
    ts: Number.isFinite(ts) ? Math.floor(ts) : Date.now(),
    by,
  };
  const valido = validaPin(pin);
  if (!valido.ok) return { ok: false, code: 'PIN_WRITE', detail: valido.motivo };

  const dir = path.join(home, '.nexuscrew');
  if (!assicuraDir(dir)) return { ok: false, code: 'PIN_DIR' };
  const dest = percorso(home);
  if (!again) {
    let esiste = false;
    try { fs.lstatSync(dest); esiste = true; } catch (_) { esiste = false; }
    if (esiste) return { ok: false, code: 'PIN_EXISTS' };
  }
  const tmp = path.join(dir, `.vl-claim-pin.local.${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(pin)}\n`);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (_) {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) { /* best-effort */ }
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ }
    return { ok: false, code: 'PIN_WRITE' };
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) { /* best-effort */ }
  }
  const corpo = `${JSON.stringify(pin)}\n`;
  // Identita' catturate prima della pubblicazione: il temporaneo si rimuove
  // solo se nome E directory indicano ancora gli oggetti di questa generazione
  // (un pathname ricordato non basta — la directory puo' essere stata
  // sostituita fra la scrittura e la pulizia).
  const identitaTmp = fs.lstatSync(tmp);
  const identitaDir = fs.lstatSync(dir);
  const rimuoviTmp = () => {
    try {
      const stT = fs.lstatSync(tmp);
      const stD = fs.lstatSync(dir);
      if (stT.dev !== identitaTmp.dev || stT.ino !== identitaTmp.ino
        || stD.dev !== identitaDir.dev || stD.ino !== identitaDir.ino) {
        return; // sostituzione osservata: non si rimuove niente per pathname
      }
      fs.unlinkSync(tmp);
    } catch (_) { /* best-effort: un tmp non rimosso e' solo un residuo */ }
  };
  if (again) {
    try {
      fs.renameSync(tmp, dest);
    } catch (_) {
      rimuoviTmp();
      return { ok: false, code: 'PIN_WRITE' };
    }
  } else {
    // link(2) when allowed; on the filesystems that deny it, exclusive
    // creation with verification (no atomic appearance). Never a replace.
    const pub = pubblicaEsclusiva({ src: tmp, dest, bytes: Buffer.from(corpo, 'utf8') });
    rimuoviTmp();
    if (pub.status === 'exists') return { ok: false, code: 'PIN_EXISTS' };
    if (pub.status !== 'published') return { ok: false, code: 'PIN_WRITE' };
  }
  try { fsyncDir(dir); } catch (_) { return { ok: false, code: 'PIN_WRITE' }; }
  // Il nome pubblicato si rilegge per DESCRIPTOR: stesso inode, 0600, byte
  // identici a quelli scritti. Qualunque divergenza e' un rifiuto, non un pin.
  let fdVer = null;
  try {
    fdVer = fs.openSync(dest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fdVer);
    const nostro = typeof process.getuid !== 'function' || st.uid === process.getuid();
    const testo = fs.readFileSync(fdVer, 'utf8');
    if (!st.isFile() || !nostro || (st.mode & 0o777) !== 0o600 || testo !== corpo) {
      return { ok: false, code: 'PIN_WRITE' };
    }
  } catch (_) {
    return { ok: false, code: 'PIN_WRITE' };
  } finally {
    try { if (fdVer !== null) fs.closeSync(fdVer); } catch (_) { /* best-effort */ }
  }
  return { ok: true, pin };
}

function assicuraDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    // Qualificato significa privato: 0700 esatto. Una directory preesistente
    // con altri permessi non si corregge (non e' nostra da cambiare) e non si
    // usa: il pin non si registra.
    if ((st.mode & 0o777) !== 0o700) return false;
    return true;
  } catch (_) { return false; }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Verifica il pin locale SENZA eseguire niente e senza riscrivere niente:
 * schema (v1 proiettato o v2), provenienza, piattaforma, helper uguale a
 * quello della release, sorgente flock nel prefisso del runtime (Android) o
 * nell'insieme CHIUSO di sistema (Linux) e byte ancora quelli registrati. Il
 * node di un v1 e' dato legacy: non si apre, non si confronta col runtime,
 * non e' un vincolo sui byte. Nessuna riscrittura.
 * Esito { ok: true, pin } oppure { ok: false, code, component? }.
 */
function verifica({ home, helperHash, deps = {} }) {
  const piattaforma = chiave(deps.platform, deps.arch);
  if (!piattaformaAutorizzata(piattaforma)) return { ok: false, code: 'PIN_UNCOVERED', platform: piattaforma };
  const l = leggi(home);
  if (l.stato === 'assente') return { ok: false, code: 'PIN_UNCOVERED', platform: piattaforma, motivo: 'assente' };
  if (l.stato !== 'presente') return { ok: false, code: 'PIN_REREAD', platform: piattaforma, motivo: l.motivo || 'illeggibile' };
  const pin = l.pin;
  if (chiave(pin.platform.platform, pin.platform.arch) !== piattaforma) {
    return { ok: false, code: 'PIN_UNCOVERED', platform: piattaforma, motivo: 'altra-piattaforma' };
  }
  if (pin.helper.sha256 !== helperHash) return { ok: false, code: 'PIN_MISMATCH', platform: piattaforma, component: 'helper', motivo: 'helper-diverso' };
  const c = pin.components.flock;
  let buf;
  if (sorgenteLinux(piattaforma)) {
    // A OGNI uso: la sorgente registrata deve stare nell'insieme chiuso e
    // qualificarsi (file di root, non scrivibile da gruppo/altri, catena di
    // root, lettura nofollow). Un percorso fuori insieme non entra mai, anche
    // se risolve allo stesso file.
    const q = qualificaSorgente(c.source, deps);
    if (!q.ok) {
      return q.motivo === 'assente'
        ? { ok: false, code: 'PIN_ABSENT', platform: piattaforma, component: 'flock' }
        : { ok: false, code: 'PIN_UNCOVERED', platform: piattaforma, component: 'flock', motivo: 'source-policy' };
    }
    buf = q.buf;
  } else {
    const execPath = deps.execPath || process.execPath;
    if (!nelPrefisso(c.source, execPath)) {
      return { ok: false, code: 'PIN_UNCOVERED', platform: piattaforma, component: 'flock', motivo: 'prefisso' };
    }
    try { buf = fs.readFileSync(c.source); } catch (_) { return { ok: false, code: 'PIN_ABSENT', platform: piattaforma, component: 'flock' }; }
  }
  if (sha256(buf) !== c.sha256) return { ok: false, code: 'PIN_MISMATCH', platform: piattaforma, component: 'flock' };
  return { ok: true, pin };
}

module.exports = {
  SCHEMA, V, V2, PROVENIENZA, PIATTAFORME_AUTORIZZATE, SORGENTI_LINUX, SORGENTE_LINUX_CANONICA,
  chiave, piattaformaAutorizzata, percorso, validaPin, catenaQualificata, leggi, provisiona, verifica,
  prefissoRuntime, nelPrefisso,
};
