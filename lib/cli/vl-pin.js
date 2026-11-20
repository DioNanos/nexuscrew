'use strict';
// `nexuscrew vl-pin` — registrazione ESPLICITA del pin locale della toolchain
// per la claim della root vl (piattaforme non coperte dal manifest di build,
// oggi Termux/Android). Non e' un'auto-riparazione: senza questo comando il
// pin non esiste, e nessun percorso di lancio lo crea.
//
//  nexuscrew vl-pin provision [--prefix <dir>] [--by <etichetta>] [--again]
//  nexuscrew vl-pin show
//
// `--prefix` deve essere la directory del node che esegue NexusCrew (il
// prefisso del runtime): un prefisso arbitrario e' rifiutato. La versione di
// flock si legge sull'OGGETTO QUALIFICATO (copia in staging), mai sul sorgente.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pinna, versioneFlock, MANIFEST } = require('../fleet/vl-roots.js');
const pinLocale = require('../fleet/vl-claim-pin-local.js');

const USAGE = 'usage: nexuscrew vl-pin <provision [--prefix <dir>] [--by <etichetta>] [--again] | show>';

function versioneQualificata({ source, sha256 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vl-pin-prov-'));
  try {
    const p = pinna(source, sha256, dir);
    // A staging failure is reported as such; any other refusal keeps the
    // empty answer (version not recognised).
    if (!p.ok) {
      return p.code === 'PIN_STAGE' || p.code === 'PIN_DIR' || p.code === 'PIN_REREAD'
        ? { ok: false, code: p.code } : '';
    }
    return versioneFlock(p.path, sha256);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
}

// Il riassunto distingue la versione del RECORD, il flock
// operator-provisioned e il Node runtime-qualified. Il runtime mostrato e'
// quello del CLI che esegue `show`: non attesta che il demone usi lo stesso
// Node. Nessun path assoluto.
function riassunto(pin) {
  return {
    record: `v${pin.v}`,
    platform: `${pin.platform.platform}-${pin.platform.arch}`,
    provenance: pin.provenance,
    flock: { provisioned: 'operator', version: pin.components.flock.version, sha256: pin.components.flock.sha256.slice(0, 12) },
    node: {
      record: pin.v === 1 ? 'legacy-data-not-used' : 'none',
      runtime: 'qualified',
      cliVersion: process.versions.node,
    },
    helper: { sha256: pin.helper.sha256.slice(0, 12) },
    ts: pin.ts,
    by: pin.by,
  };
}

async function run(rest = [], flags = {}, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : (line) => process.stdout.write(`${line}\n`);
  const home = opts.home || os.homedir();
  const sub = rest[0];

  if (sub === 'show') {
    const l = pinLocale.leggi(home);
    if (l.stato === 'presente') { log(JSON.stringify(riassunto(l.pin), null, 2)); return { code: 0 }; }
    log(l.stato === 'assente'
      ? 'vl-pin: no local pin registered (on this platform use `nexuscrew vl-pin provision`)'
      : `vl-pin: pin locale non leggibile (${l.motivo || 'illeggibile'}); un up sara' rifiutato`);
    return { code: 1 };
  }

  if (sub === 'provision') {
    const prefix = typeof flags.prefix === 'string' && flags.prefix ? path.resolve(flags.prefix) : path.dirname(process.execPath);
    // Su Linux il candidato di default e' la flock DI SISTEMA, non quella
    // accanto al node: il prefisso del runtime e' scrivibile dall'utente e non
    // e' un'ancora. `--prefix` resta accettato solo se porta nell'insieme
    // chiuso; ogni altro valore viene rifiutato (PIN_PREFIX) dalla registrazione.
    const flock = !flags.prefix && process.platform === 'linux'
      ? pinLocale.SORGENTE_LINUX_CANONICA : path.join(prefix, 'flock');
    const by = typeof flags.by === 'string' && flags.by ? flags.by : 'operator';
    const r = pinLocale.provisiona({
      home,
      flock,
      helperHash: MANIFEST && MANIFEST.helper ? MANIFEST.helper.sha256 : '',
      by,
      again: flags.again === true,
      deps: { versioneQualificata },
    });
    if (!r.ok) {
      log(`vl-pin: registration refused (${r.code}${r.component ? `/${r.component}` : ''}${r.detail ? `: ${r.detail}` : ''})`);
      return { code: 1 };
    }
    log('vl-pin: local pin registered');
    log(JSON.stringify(riassunto(r.pin), null, 2));
    return { code: 0 };
  }

  log(USAGE);
  return { code: 1 };
}

module.exports = { run, versioneQualificata, riassunto, USAGE };
