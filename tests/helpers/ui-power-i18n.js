'use strict';

// Test-only bridge to the REAL i18n module and the UI power action.
// No product map is exported: the five key names are decided here and the
// tests read them from the dictionaries the interface actually consumes.

const CHIAVI = Object.freeze({
  HOST_ALIVE: 'fleet-host-alive',
  LEASE_BLOCKS: 'fleet-lease-blocks',
  LEASE_UNREADABLE: 'fleet-lease-unreadable',
  ATTESTED_TERM: 'fleet-host-stopped-attested-term',
  ATTESTED_KILL: 'fleet-host-stopped-attested-kill',
});

const LINGUE = Object.freeze(['it', 'en', 'es']);

function creaStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

async function caricaUi() {
  const i18n = await import('../../frontend/src/lib/i18n.js');
  const notice = await import('../../frontend/src/lib/fleet-action-notice.js');
  return { i18n, notice };
}

// Installs a test-only storage, activates the language through the real
// setLang, and asserts the module actually reports it before the action.
async function conLingua(lang, fn) {
  const precedente = globalThis.localStorage;
  globalThis.localStorage = creaStorage();
  try {
    const ui = await caricaUi();
    ui.i18n.setLang(lang);
    const attiva = ui.i18n.getLang();
    if (attiva !== lang) {
      throw new Error(`lingua non attiva: attesa ${lang}, ottenuta ${attiva}`);
    }
    return await fn(ui);
  } finally {
    if (precedente === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = precedente;
  }
}

// Proofs are fictional and recognisable: they must survive on the structured
// error and must never appear in anything the interface presents.
const PROVE_FINTE = Object.freeze({
  pid: 987654,
  root: '/tmp/canary-prove-root',
  startTicks: 'canary-prove-ticks',
  incarnation: 'canary-incarnation',
  digest: 'f'.repeat(64),
});

// Shape produced by jsonFetch in the browser: status on the error, structured
// cause in data.code. Deliberately NOT error.fleetCode.
function erroreApi({ status, code, message = 'CANARY-REMOTE-MESSAGE', phase = 'teardown', prove = PROVE_FINTE, extra }) {
  const err = new Error(message);
  err.name = 'FleetApiError';
  err.status = status;
  err.data = {
    code,
    phase,
    prove,
    ...(extra || {}),
  };
  return err;
}

function testo(chiave, i18n, lang) {
  const dict = i18n.DICTS[lang] || {};
  return Object.prototype.hasOwnProperty.call(dict, chiave) ? dict[chiave] : undefined;
}

async function eseguiDown(ui, { fleetDown, onNotice = false } = {}) {
  const notice = [];
  const chiamate = [];
  const api = {
    fleetDown: async (...args) => { chiamate.push('down'); return fleetDown(...args); },
    fleetUp: async (...args) => { chiamate.push('up'); return { ok: true }; },
  };
  let esito = null;
  let errore = null;
  try {
    esito = await ui.notice.runFleetPowerAction({
      token: 'token-di-prova',
      powerCell: { cell: 'CellaUi', route: ['local'] },
      payload: { action: 'down' },
      onNotice: onNotice ? (msg) => notice.push(msg) : () => {},
      fleetApi: api,
    });
  } catch (e) {
    errore = e;
  }
  return { esito, errore, notice, chiamate };
}

const CASI_ERRORE = [
  { codice: 'HOST_ALIVE', status: 500, chiave: CHIAVI.HOST_ALIVE, extra: {} },
  { codice: 'LEASE_BLOCKS', status: 409, chiave: CHIAVI.LEASE_BLOCKS, extra: { extra: { graceRemainingMs: 45000 } } },
  { codice: 'LEASE_UNREADABLE', status: 409, chiave: CHIAVI.LEASE_UNREADABLE, extra: { extra: { graceRemainingMs: null } } },
];

// Full interface contract of the down path. Every language is exercised
// through the real i18n module; a missing translation cannot hide behind the
// Italian fallback because each language asserts its own dictionary entry.
async function verificaContrattoUi(tag) {
  const assert = require('node:assert/strict');
  const { i18n } = await caricaUi();

  // 1. Parity and non-empty entries for the five decided keys. The presented
  // strings carry no placeholder and no invented countdown.
  for (const lang of LINGUE) {
    const dict = i18n.DICTS[lang];
    assert.ok(dict, `${tag}: dizionario ${lang} presente`);
    for (const chiave of Object.values(CHIAVI)) {
      const voce = testo(chiave, i18n, lang);
      assert.equal(typeof voce, 'string', `${tag}: ${lang}/${chiave} deve essere una stringa`);
      assert.ok(voce.length > 0, `${tag}: ${lang}/${chiave} non puo' essere vuota`);
      assert.equal(voce.trim(), voce, `${tag}: ${lang}/${chiave} senza spazi ai bordi`);
      assert.equal(voce.trim().length > 0, true, `${tag}: ${lang}/${chiave} non puo' essere solo spazi`);
      assert.notEqual(voce, chiave, `${tag}: ${lang}/${chiave} non puo' restare la chiave grezza`);
      assert.equal(voce.includes('{'), false, `${tag}: ${lang}/${chiave} senza placeholder irrisolti`);
      assert.equal(voce.includes('}'), false, `${tag}: ${lang}/${chiave} senza placeholder irrisolti`);
    }
    // La lease illeggibile non ha un conto alla rovescia da mostrare.
    assert.equal(
      /\d/.test(testo(CHIAVI.LEASE_UNREADABLE, i18n, lang)),
      false,
      `${tag}: ${lang}/fleet-lease-unreadable non deve contenere un conto alla rovescia inventato`,
    );
  }

  // 2. Real errors: the promise still rejects, the structured cause survives —
  // proofs and any timing included — and nothing internal reaches the text or
  // the notices, which stay empty on this path.
  for (const lang of LINGUE) {
    await conLingua(lang, async (ui) => {
      for (const caso of CASI_ERRORE) {
        const { errore, esito, chiamate, notice } = await eseguiDown(ui, {
          fleetDown: async () => { throw erroreApi({ status: caso.status, code: caso.codice, ...caso.extra }); },
          onNotice: true,
        });
        assert.equal(esito, null, `${tag}: ${lang}/${caso.codice} non deve risolvere`);
        assert.ok(errore, `${tag}: ${lang}/${caso.codice} deve rigettare`);
        assert.equal(errore.status, caso.status, `${tag}: ${lang}/${caso.codice} conserva lo status`);
        assert.equal(errore.data && errore.data.code, caso.codice, `${tag}: ${lang}/${caso.codice} conserva data.code`);
        assert.equal(errore.data && errore.data.phase, 'teardown', `${tag}: ${lang}/${caso.codice} conserva la fase`);
        assert.deepEqual(errore.data && errore.data.prove, PROVE_FINTE, `${tag}: ${lang}/${caso.codice} conserva le prove`);
        assert.deepEqual(chiamate, ['down'], `${tag}: ${lang}/${caso.codice} un solo down, nessuna up`);
        assert.deepEqual(notice, [], `${tag}: ${lang}/${caso.codice} nessuna notice grezza o aggiuntiva sull'errore`);

        const atteso = testo(caso.chiave, i18n, lang);
        assert.equal(errore.message, atteso, `${tag}: ${lang}/${caso.codice} testo locale atteso`);
        assert.notEqual(errore.message, 'CANARY-REMOTE-MESSAGE', `${tag}: ${lang}/${caso.codice} non passa il testo remoto`);
        for (const sentinella of [String(PROVE_FINTE.pid), PROVE_FINTE.root, PROVE_FINTE.startTicks, PROVE_FINTE.digest]) {
          assert.equal(
            errore.message.includes(sentinella),
            false,
            `${tag}: ${lang}/${caso.codice} il testo presentato non espone ${sentinella}`,
          );
        }
        if (caso.extra && caso.extra.extra && caso.extra.extra.graceRemainingMs !== undefined) {
          assert.equal(
            errore.data.graceRemainingMs,
            caso.extra.extra.graceRemainingMs,
            `${tag}: ${lang}/${caso.codice} il conteggio residuo resta strutturato nell'errore`,
          );
          assert.equal(
            errore.message.includes(String(caso.extra.extra.graceRemainingMs)),
            false,
            `${tag}: ${lang}/${caso.codice} il testo presentato non espone il conteggio residuo`,
          );
        }
        for (const altro of CASI_ERRORE) {
          if (altro.codice === caso.codice) continue;
          assert.notEqual(
            errore.message,
            testo(altro.chiave, i18n, lang),
            `${tag}: ${lang}/${caso.codice} distinto da ${altro.codice}`,
          );
        }
      }
    });
  }

  // 3. Attested host success: the down result is presented exactly once, term
  // and kill stay distinct, and the promise resolves on the full path.
  for (const lang of LINGUE) {
    await conLingua(lang, async (ui) => {
      for (const method of ['term', 'kill']) {
        const chiave = method === 'term' ? CHIAVI.ATTESTED_TERM : CHIAVI.ATTESTED_KILL;
        const { esito, errore, notice, chiamate } = await eseguiDown(ui, {
          fleetDown: async () => ({ ok: true, host: { outcome: 'host-stopped-attested', method } }),
          onNotice: true,
        });
        assert.equal(errore, null, `${tag}: ${lang}/${method} non deve rigettare`);
        assert.equal(esito, undefined, `${tag}: ${lang}/${method} risolve sul percorso pieno`);
        assert.deepEqual(chiamate, ['down'], `${tag}: ${lang}/${method} un solo down`);
        const atteso = testo(chiave, i18n, lang);
        assert.deepEqual(
          notice,
          [atteso],
          `${tag}: ${lang}/${method} una sola notice, e quella locale (ricevute ${JSON.stringify(notice)})`,
        );
        assert.ok(
          !notice.includes(testo(method === 'term' ? CHIAVI.ATTESTED_KILL : CHIAVI.ATTESTED_TERM, i18n, lang)),
          `${tag}: ${lang}/${method} non confonde term e kill`,
        );
      }
    });
  }

  // 4. Negatives at the same boundary: no attestation, no notice; unknown or
  // malformed method is neither interpolated nor promoted.
  await conLingua('it', async (ui) => {
    const ordinario = await eseguiDown(ui, {
      fleetDown: async () => ({ ok: true }),
      onNotice: true,
    });
    assert.equal(ordinario.errore, null, `${tag}: down ordinario risolve`);
    assert.deepEqual(ordinario.notice, [], `${tag}: down senza attestazione non emette notice attestata`);

    for (const host of [
      { outcome: 'host-stopped-attested' },
      { outcome: 'host-stopped-attested', method: 'sconosciuto' },
      { outcome: 'host-stopped-attested', method: 42 },
    ]) {
      const negativo = await eseguiDown(ui, {
        fleetDown: async () => ({ ok: true, host }),
        onNotice: true,
      });
      assert.equal(negativo.errore, null, `${tag}: method ${String(host.method)} non deve rigettare`);
      assert.equal(
        negativo.notice.length,
        0,
        `${tag}: method ${String(host.method)} non va promosso a term/kill`,
      );
    }
  });
}

module.exports = { CHIAVI, LINGUE, conLingua, erroreApi, testo, eseguiDown, caricaUi, verificaContrattoUi };
