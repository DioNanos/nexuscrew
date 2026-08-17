'use strict';
// Le tre regole non opinabili della telemetria per-cella, provate una a una:
// timestamp obbligatorio (il dato stantio e' assente, non "fresco per sbaglio"),
// assenza legittima (niente file = null, senza errori), lettura tollerante
// (JSON rotto, campi fuori contratto → si degrada senza far fallire nulla).
// E il verso, che e' OPPOSTO: contextFreePct e' quanto resta, tier*UsedPct e'
// quanto e' consumato — i valori passano tali e quali, senza inversioni.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { leggiTelemetria, MASSIMA_ETA_MS, FUTURO_TOLLERATO_MS, NOME_FILE } = require('../lib/files/telemetry.js');

const dirsDaRipulire = [];
test.after(() => { for (const d of dirsDaRipulire) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } } });

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tele-'));
  dirsDaRipulire.push(dir);
  return dir;
}

// Scrive il file di telemetria per `sessione` con contenuto già serializzato.
function scrivi(root, sessione, corpo) {
  fs.mkdirSync(path.join(root, sessione), { recursive: true });
  fs.writeFileSync(path.join(root, sessione, NOME_FILE), corpo, { mode: 0o600 });
}

const ORA = 1_800_000_000_000;

test('fresco e valido: i tre campi passano tali e quali, con il loro verso', () => {
  const root = tmpRoot();
  scrivi(root, 'cloud-Dev', JSON.stringify({
    ts: ORA - 1000,
    contextFreePct: 71,
    tier5hUsedPct: 33,
    tier7dUsedPct: 8,
  }));
  assert.deepStrictEqual(leggiTelemetria(root, 'cloud-Dev', ORA), {
    ts: ORA - 1000,
    contextFreePct: 71,
    tier5hUsedPct: 33,
    tier7dUsedPct: 8,
  });
});

test('assenza legittima: cella senza file (non-Claude) → null, nessuna eccezione', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'cloud-Agy'), { recursive: true });
  assert.strictEqual(leggiTelemetria(root, 'cloud-Agy', ORA), null);
  // E nemmeno una directory inesistente alza errori.
  assert.strictEqual(leggiTelemetria(root, 'mai-creata', ORA), null);
});

test('timestamp obbligatorio: oltre la soglia il dato è morto → null', () => {
  const root = tmpRoot();
  scrivi(root, 'cloud-Dev', JSON.stringify({
    ts: ORA - MASSIMA_ETA_MS - 1,
    contextFreePct: 71, tier5hUsedPct: 33, tier7dUsedPct: 8,
  }));
  assert.strictEqual(leggiTelemetria(root, 'cloud-Dev', ORA), null,
    'un numero stantio che sembra fresco è peggio di un numero assente');
  // Al limite esatto è ancora vivo: la soglia taglia dopo, non prima.
  scrivi(root, 'cloud-Dev', JSON.stringify({
    ts: ORA - MASSIMA_ETA_MS,
    contextFreePct: 71, tier5hUsedPct: 33, tier7dUsedPct: 8,
  }));
  assert.ok(leggiTelemetria(root, 'cloud-Dev', ORA));
});

test('timestamp nel futuro: oltre la tolleranza il dato è rotto → null, «fresco per sempre» non è fresco', () => {
  const root = tmpRoot();
  // ts NEL FUTURO: `ora - ts` è NEGATIVO e non supera mai la massima età —
  // il rilievo dell'audit. Un orologio avanti, o uno ts scritto male, e la
  // riga mostrerebbe un numero morto che non scadrà mai. La soglia ora
  // guarda anche questo verso.
  scrivi(root, 'cloud-Dev', JSON.stringify({
    ts: ORA + FUTURO_TOLLERATO_MS + 1,
    contextFreePct: 71, tier5hUsedPct: 33, tier7dUsedPct: 8,
  }));
  assert.strictEqual(leggiTelemetria(root, 'cloud-Dev', ORA), null,
    'uno ts troppo avanti è un ts rotto: il dato non esiste');
  // Entro la tolleranza resta accettato: due minuti sono lo skew che un
  // orologio legittimamente sforato può avere, e rifiutarli scarterebbe
  // dati buoni su macchine normali.
  scrivi(root, 'cloud-Dev', JSON.stringify({
    ts: ORA + FUTURO_TOLLERATO_MS,
    contextFreePct: 71, tier5hUsedPct: 33, tier7dUsedPct: 8,
  }));
  assert.ok(leggiTelemetria(root, 'cloud-Dev', ORA));
});

test('lettura tollerante: JSON rotto, non-oggetto, ts mancante → null senza lanciare', () => {
  const root = tmpRoot();
  scrivi(root, 'rotto', '{questo non è json');
  assert.strictEqual(leggiTelemetria(root, 'rotto', ORA), null);
  scrivi(root, 'array', '[1,2,3]');
  assert.strictEqual(leggiTelemetria(root, 'array', ORA), null);
  scrivi(root, 'senza-ts', JSON.stringify({ contextFreePct: 50 }));
  assert.strictEqual(leggiTelemetria(root, 'senza-ts', ORA), null,
    'senza timestamp non c’è freschezza da verificare');
  scrivi(root, 'ts-stringa', JSON.stringify({ ts: 'ora', contextFreePct: 50 }));
  assert.strictEqual(leggiTelemetria(root, 'ts-stringa', ORA), null);
});

test('contratto intero 0..100: frazioni e fuori scala rifiutati, i campi sani restano', () => {
  const root = tmpRoot();
  // 0.5 che voleva essere 50%: mostrare 1% sarebbe un numero SBAGLIATO con
  // sicurezza — il campo sparisce, gli altri due restano.
  scrivi(root, 'cloud-Dev', JSON.stringify({
    ts: ORA, contextFreePct: 0.5, tier5hUsedPct: 33.7, tier7dUsedPct: 8,
  }));
  assert.deepStrictEqual(leggiTelemetria(root, 'cloud-Dev', ORA),
    { ts: ORA, tier7dUsedPct: 8 });
  scrivi(root, 'oltre', JSON.stringify({ ts: ORA, contextFreePct: 150, tier5hUsedPct: -3, tier7dUsedPct: 100 }));
  assert.deepStrictEqual(leggiTelemetria(root, 'oltre', ORA),
    { ts: ORA, tier7dUsedPct: 100 }, '0 e 100 sono valori leciti; fuori scala no');
  scrivi(root, 'tutti-muti', JSON.stringify({ ts: ORA, contextFreePct: 'molto', tier5hUsedPct: null, tier7dUsedPct: true }));
  assert.strictEqual(leggiTelemetria(root, 'tutti-muti', ORA), null,
    'nessun campo valido → nessun dato mostrato');
  // null→0 e true→1 con Number(): il caso trovato davvero — un campo assente
  // letto come «0%» sarebbe il numero sbagliato mostrato con sicurezza.
  scrivi(root, 'null-zero', JSON.stringify({ ts: ORA, contextFreePct: null, tier5hUsedPct: 0, tier7dUsedPct: false }));
  assert.deepStrictEqual(leggiTelemetria(root, 'null-zero', ORA),
    { ts: ORA, tier5hUsedPct: 0 }, 'lo 0 esplicito è un valore; null e false no');
});
