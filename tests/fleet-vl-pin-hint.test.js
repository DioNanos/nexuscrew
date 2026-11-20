'use strict';
// Hint localizzato del ripiego sul pin locale, fino al VERO consumer. Il dato
// nasce nel rifiuto del preflight (dove il ripiego e' stato deciso), viene
// copiato dal runtime nella risposta e appiattito dalle route; il foglio di
// alimentazione legge `error.data.pinRecovery`, mostra il testo della lingua
// attiva e RILANCIA l'errore: status, data e causa restano intatti, l'up resta
// fallito e il foglio non si chiude come benigno. Il comando nel testo e'
// costante nel dizionario: nessun testo remoto si rende, nessun comando
// ricevuto si esegue.
const { test } = require('node:test');
const assert = require('node:assert');
const radici = require('../lib/fleet/vl-roots.js');
const W = require('./helpers/launch-world.js');
const F = require('./helpers/vl-pin-fixture.js');

const CHIAVE = 'fleet-vl-pin-recovery';

const TESTI = {
  it: 'aggiornamento del pacchetto rilevato: la flock di sistema non corrisponde più al catalogo della release. Un operatore può ripristinare la riserva registrando il pin locale: nexuscrew vl-pin provision --again',
  en: 'package update detected: the system flock no longer matches the release catalog. An operator can restore the reservation by registering the local pin: nexuscrew vl-pin provision --again',
  es: 'actualización del paquete detectada: la flock del sistema ya no coincide con el catálogo de la release. Un operador puede restaurar la reserva registrando el pin local: nexuscrew vl-pin provision --again',
};

const CANARY_REMOTO = 'CANARY-REMOTO-provider--again';

function creaStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: (k) => { m.delete(String(k)); },
    clear: () => m.clear(),
  };
}

async function caricaUi() {
  const i18n = await import('../frontend/src/lib/i18n.js');
  const notice = await import('../frontend/src/lib/fleet-action-notice.js');
  return { i18n, notice };
}

async function conLingua(lang, fn) {
  const precedente = globalThis.localStorage;
  globalThis.localStorage = creaStorage();
  try {
    const ui = await caricaUi();
    ui.i18n.setLang(lang);
    assert.equal(ui.i18n.getLang(), lang, `lingua attiva: ${lang}`);
    return await fn(ui);
  } finally {
    if (precedente === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = precedente;
  }
}

// Forma prodotta da jsonFetch nel browser: status sull'errore, corpo del
// server in data (le route appiattiscono e.data: il campo e' al primo livello).
function errorePreflight({ status = 500, pinRecovery = 'provision-again', data = {} } = {}) {
  const e = new Error(CANARY_REMOTO);
  e.name = 'FleetApiError';
  e.status = status;
  e.data = {
    error: CANARY_REMOTO,
    outcome: 'refused',
    pinCode: 'PIN_MISMATCH',
    platform: 'linux-x64',
    component: 'flock',
    code: 'PIN_MISMATCH',
    phase: 'preflight',
    ...(pinRecovery === undefined ? {} : { pinRecovery }),
    ...data,
  };
  return e;
}

async function esegui(ui, { action = 'up', fleetUp, fleetDown, onNotice = true } = {}) {
  const notice = [];
  const chiamate = [];
  const api = {
    fleetUp: async (...args) => { chiamate.push('up'); return fleetUp(...args); },
    fleetDown: async (...args) => { chiamate.push('down'); return fleetDown(...args); },
  };
  let esito = null;
  let errore = null;
  try {
    esito = await ui.notice.runFleetPowerAction({
      token: 'token-di-prova',
      powerCell: { cell: 'CellaPin', route: ['local'] },
      payload: { action },
      onNotice: onNotice ? (msg) => notice.push(msg) : () => {},
      fleetApi: api,
    });
  } catch (e) {
    errore = e;
  }
  return { esito, errore, notice, chiamate };
}

test('la chiave del hint esiste nelle tre lingue con il testo esatto', async () => {
  const { i18n } = await caricaUi();
  for (const lang of ['it', 'en', 'es']) {
    const dict = i18n.DICTS[lang];
    assert.ok(dict, `dizionario ${lang}`);
    assert.equal(dict[CHIAVE], TESTI[lang], `${lang}: testo esatto`);
    assert.match(dict[CHIAVE], /nexuscrew vl-pin provision --again$/);
  }
});

test('wiring nel dato: il rifiuto del preflight porta error.data.pinRecovery', async (t) => {
  const d = W.scriviMondo({ famiglia: 'vl' });
  t.after(() => W.pulisci(d));
  // Il wrapper passa dalla DI interna: il manifest per-test rifiuta la flock e
  // il ripiego trova il pin assente (home finta del mondo). Nessun pin creato.
  const { runtime } = W.apriRuntime(d, {
    riservaRootClaim: (opts) => radici.riserva({ ...opts, manifest: F.manifestAggiornato() }),
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  const errore = await runtime.up(d.cella).then(() => null, (e) => e);
  assert.ok(errore, 'l\'up doveva rifiutare');
  assert.equal(errore.status, 500);
  assert.equal(errore.fleetCode, 'PIN_MISMATCH');
  assert.equal(errore.fleetPhase, 'preflight');
  assert.equal(errore.data.pinCode, 'PIN_MISMATCH');
  assert.equal(errore.data.component, 'flock');
  assert.equal(errore.data.platform, 'linux-x64');
  assert.equal(errore.data.pinRecovery, 'provision-again', 'il campo e\' al primo livello del dato');
  assert.equal(errore.data.data, undefined, 'nessun livello annidato');
  assert.equal(errore.data.manifestCause, undefined, 'pin assente: la causa e\' il codice del manifest');
  assert.equal(String(errore.message).includes('/usr/bin'), false, 'nessun path nella risposta');
  // Il pin non e' stato creato da solo.
  const locale = require('../lib/fleet/vl-claim-pin-local.js');
  assert.equal(require('node:fs').existsSync(locale.percorso(d.home)), false);
});

test('il consumer vero mostra il testo locale e RILANCIA senza secondo POST', async () => {
  for (const lang of ['it', 'en', 'es']) {
    await conLingua(lang, async (ui) => {
      const errore = errorePreflight({ data: { manifestCause: { code: 'PIN_MISMATCH', component: 'flock' } } });
      const esito = await esegui(ui, { fleetUp: async () => { throw errore; } });
      assert.equal(esito.esito, null, `${lang}: non risolve`);
      assert.ok(esito.errore, `${lang}: rigetta`);
      assert.equal(esito.errore, errore, `${lang}: lo stesso errore, rilanciato`);
      assert.equal(esito.errore.status, 500, `${lang}: status intatto`);
      assert.equal(esito.errore.data.pinRecovery, 'provision-again', `${lang}: data intatto`);
      assert.deepEqual(esito.errore.data.manifestCause, { code: 'PIN_MISMATCH', component: 'flock' });
      assert.deepEqual(esito.notice, [ui.i18n.DICTS[lang][CHIAVE]], `${lang}: una notice, quella locale`);
      assert.notEqual(esito.notice[0], TESTI[lang === 'it' ? 'en' : 'it'], `${lang}: non e' la lingua sbagliata`);
      assert.equal(esito.notice[0].includes(CANARY_REMOTO), false, `${lang}: nessun testo remoto`);
      assert.deepEqual(esito.chiamate, ['up'], `${lang}: un solo POST, nessuna riprova`);
    });
  }
});

test('anche il down passa dal catch comune: notice e rilancio', async () => {
  await conLingua('it', async (ui) => {
    const errore = errorePreflight();
    const esito = await esegui(ui, {
      action: 'down',
      fleetUp: async () => ({ ok: true }),
      fleetDown: async () => { throw errore; },
    });
    assert.equal(esito.errore, errore);
    assert.deepEqual(esito.notice, [ui.i18n.DICTS.it[CHIAVE]]);
    assert.deepEqual(esito.chiamate, ['down']);
  });
});

test('un campo remoto invalido e\' ignorato: nessuna notice, errore comunque rilanciato', async () => {
  await conLingua('it', async (ui) => {
    for (const valore of ['provision-again ', 'nexuscrew vl-pin provision --again', 'PROVISION-AGAIN', true, 1, { cmd: 'provision' }, null]) {
      const errore = errorePreflight({ pinRecovery: valore });
      const esito = await esegui(ui, { fleetUp: async () => { throw errore; } });
      assert.equal(esito.errore, errore, `valore ${JSON.stringify(valore)}: rilanciato`);
      assert.deepEqual(esito.notice, [], `valore ${JSON.stringify(valore)}: nessuna notice locale`);
      assert.equal(esito.errore.data.pinRecovery, valore, 'il dato resta quello ricevuto, non interpretato');
    }
  });
});

test('up riuscito: sola notice generica di avvio, nessuna notice del pin', async () => {
  await conLingua('it', async (ui) => {
    const esito = await esegui(ui, { fleetUp: async () => ({ ok: true }) });
    assert.equal(esito.errore, null);
    // La conferma neutra emette la sola notice generica: senza di essa
    // «avviata» e «non e' cambiato nulla» sono indistinguibili. Il ramo
    // specifico del pin e' separato: qui nessuna notice del pin.
    assert.deepEqual(esito.notice, [ui.i18n.DICTS.it['fleet-up-started']]);
  });
});
