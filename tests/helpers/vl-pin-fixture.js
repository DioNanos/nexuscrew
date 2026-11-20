'use strict';
// Fixture PER-TEST del pin locale su Linux. Misura la flock di SISTEMA reale
// del container (sha256, versione, dev/ino, uid, modo) e costruisce con quei
// dati un manifest «aggiornato» per il singolo test: hash e versione diversi,
// sorgente = il percorso reale. Il ramo manifest rifiuta (PIN_MISMATCH o
// PIN_VERSION) e il ripiego sul pin locale si esercita sulla flock VERA.
//
// Regole: /usr/bin/flock si legge e basta (mai scritto, mai sostituito, nessun
// symlink o montatura); il manifest di produzione non si tocca (la copia
// «aggiornata» vive solo in memoria); la home e' sempre finta (mkdtemp).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const locale = require('../../lib/fleet/vl-claim-pin-local.js');
const roots = require('../../lib/fleet/vl-roots.js');
const cliPin = require('../../lib/cli/vl-pin.js');

const CANONICO = locale.SORGENTE_LINUX_CANONICA;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(p) {
  return sha256(fs.readFileSync(p));
}

let misurato = null;

// Misura una volta la sorgente di sistema: e' il dato che ogni test dichiara.
function sistema() {
  if (misurato) return misurato;
  const st = fs.statSync(CANONICO);
  misurato = {
    source: CANONICO,
    sha256: sha256File(CANONICO),
    version: roots.versioneFlock(CANONICO),
    dev: st.dev,
    ino: st.ino,
    uid: st.uid,
    mode: st.mode & 0o7777,
  };
  return misurato;
}

// Il manifest per-test «aggiornato»: stessa piattaforma del manifest vero,
// sorgente reale, hash e/o versione diversi. In memoria, mai su disco.
function manifestAggiornato({ source = CANONICO, sha256: hash, version = '9.9.9' } = {}) {
  const m = sistema();
  return {
    ...roots.MANIFEST,
    platform: roots.MANIFEST.platform,
    flock: {
      source,
      sha256: hash || sha256(Buffer.from('flock-aggiornata', 'utf8')),
      version,
    },
  };
}

// Il manifest che combacia davvero (copia in memoria di quello di produzione).
function manifestCombaciante() {
  return JSON.parse(JSON.stringify(roots.MANIFEST));
}

function homeFinta(t, prefisso = 'pin-fixture-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefisso));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(home, '.nexuscrew'), 0o700);
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ } });
  return { dir, home };
}

// Record v2 valido per linux-x64 costruito sui byte REALI della sorgente.
function pinValido(over = {}) {
  const m = sistema();
  const {
    platform = 'linux', arch = 'x64', source = m.source, sha256: hash, version,
    helper = roots.MANIFEST.helper.sha256, v = 2, extra,
  } = over;
  return {
    v,
    schema: locale.SCHEMA,
    provenance: locale.PROVENIENZA,
    platform: { platform, arch },
    components: { flock: { source, sha256: hash || m.sha256, version: version || m.version } },
    helper: { sha256: helper },
    ts: 1,
    by: 'operatore',
    ...(extra || {}),
  };
}

function scriviPin(home, contenuto, { modo = 0o600 } = {}) {
  const file = locale.percorso(home);
  fs.writeFileSync(file, typeof contenuto === 'string' ? contenuto : `${JSON.stringify(contenuto)}\n`);
  fs.chmodSync(file, modo);
  return file;
}

// Registrazione sulla sorgente di sistema con la callback di produzione (la
// versione si legge sull'oggetto qualificato, mai un valore inventato).
function provisionaLinux(home, opts = {}) {
  const m = sistema();
  return locale.provisiona({
    home,
    flock: opts.flock || m.source,
    helperHash: opts.helperHash || roots.MANIFEST.helper.sha256,
    by: opts.by || 'operatore',
    again: opts.again === true,
    deps: {
      platform: 'linux',
      arch: 'x64',
      versioneQualificata: opts.versioneQualificata || cliPin.versioneQualificata,
      ...(opts.deps || {}),
    },
  });
}

function errore(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function statFile({ uid = 0, mode = 0o100755, dev = 10, ino = 20, symlink = false, tipo = 'file' } = {}) {
  return {
    dev, ino, uid, mode,
    isFile: () => tipo === 'file' && !symlink,
    isDirectory: () => tipo === 'dir' && !symlink,
    isSymbolicLink: () => symlink,
  };
}

function statDir({ uid = 0, mode = 0o040755, dev = 1, ino = 1, symlink = false } = {}) {
  return statFile({ uid, mode, dev, ino, symlink, tipo: 'dir' });
}

// Filesystem SINTETICO per la sola qualifica della sorgente: metadati
// iniettabili (uid/modo/dev/ino/nofollow) senza toccare il sistema. I byte
// letti sono quelli veri della sorgente, cosi' la verifica dell'hash resta
// reale. Le voci non dichiarate sono la catena di root sana.
function fsSistema({ file = {}, bin = null, dirs = {}, byte = null } = {}) {
  const m = sistema();
  const buf = byte || fs.readFileSync(CANONICO);
  const canonico = statFile({ dev: m.dev, ino: m.ino, ...file });
  const tabella = {
    [CANONICO]: { stat: canonico, lstat: canonico, buf },
    '/usr/bin': { stat: statDir(), lstat: statDir() },
    '/usr': { stat: statDir(), lstat: statDir() },
    '/': { stat: statDir(), lstat: statDir() },
  };
  for (const [p, over] of Object.entries(dirs)) {
    const st = over && over.isDirectory ? over : statDir(over || {});
    tabella[p] = { stat: st, lstat: st };
  }
  if (bin) {
    tabella['/bin/flock'] = { stat: bin.stat || bin, lstat: bin.lstat || bin, buf };
  }
  const aperti = new Map();
  let seq = 0;
  const voce = (p) => {
    const v = tabella[p];
    if (!v) throw errore('ENOENT');
    return v;
  };
  return {
    lstatSync: (p) => voce(p).lstat,
    statSync: (p) => voce(p).stat,
    openSync: (p) => {
      const v = voce(p);
      const fd = (seq += 1);
      aperti.set(fd, v);
      return fd;
    },
    fstatSync: (fd) => {
      const v = aperti.get(fd);
      if (!v) throw errore('EBADF');
      return v.stat;
    },
    readFileSync: (fd) => {
      const v = aperti.get(fd);
      if (!v) throw errore('EBADF');
      return v.buf;
    },
    closeSync: (fd) => { aperti.delete(fd); },
  };
}

module.exports = {
  CANONICO, sistema, sha256, sha256File, manifestAggiornato, manifestCombaciante,
  homeFinta, pinValido, scriviPin, provisionaLinux, fsSistema, statFile, statDir, errore,
};
