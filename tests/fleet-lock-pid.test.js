'use strict';
// tests/fleet-lock-pid.test.js — il lock di un pid RIASSEGNATO (fetta R, 2026-08-16).
//
// «Un pid non è un'identità: è un numero riciclato.» kill(pid, 0) chiede al
// kernel se ESISTE un processo con quel numero — non se è ancora vivo QUEL
// processo che prese il lock. Se il proprietario è morto e il sistema ha
// riassegnato il numero a chiunque altro, la guardia risponde «vivo» per
// sempre: il lock non è mai abbandonato e ogni scrittura rinuncia in
// silenzio. La degradazione peggiore proprio perché invisibile.
//
// La correzione confronta la NASCITA del processo (starttime, /proc/<pid>/stat
// campo 22): due processi con lo stesso numero in momenti diversi nascono in
// istanti diversi — la coppia pid+nascita è l'identità. Il token del lock la
// porta come terzo campo: «pid:hex:starttime».
//
// L'asimmetria che governa tutto: dichiarare morto un vivo ROMPE la mutua
// esclusione (la malattia della cura precedente); dichiarare vivo un morto
// costa una scrittura rimandata. Nel dubbio — criterio non calcolabile,
// formato vecchio senza nascita, /proc assente — il lock RESTA.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  aggiornaDefinizioni, atomicWrite, loadDefinitions, proprietarioVivo,
} = require('../lib/fleet/definitions.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lock-pid-'));
const cellIds = (defs) => (defs ? defs.cells.map((c) => c.id).sort() : null);

// Engine/celle minime valide per parseDefinitions STRICT di atomicWrite
// (stessa forma di fleet-lock-edges.test.js).
function validDef(cells) {
  return {
    schemaVersion: 1,
    engines: [{ id: 'sh', command: '/bin/sh', promptMode: 'send-keys' }],
    cells: cells || [{ id: 'Base', cwd: '/tmp', engine: 'sh' }],
  };
}

// Un proprietario VERO, vivo, non questo processo: kill(pid, 0) deve poter
// dire «esiste» a chi consulta il lock. (Stessa fixture di fleet-lock-edges.)
function figlioVivo() {
  const figlio = spawn('sleep', ['10'], { stdio: 'ignore' });
  return {
    pid: figlio.pid,
    spegni: () => { try { figlio.kill('SIGKILL'); } catch (_) { /* già andato */ } },
  };
}

// La nascita di un pid, letta dal test stesso per costruire i casi — NON dal
// codice sotto esame, così il negativo regge anche contro il codice attuale.
function nascitaDi(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const dopoComm = stat.slice(stat.lastIndexOf(')') + 2);
  return Number(dopoComm.split(' ')[19]); // campo 22 della stat (1-based)
}

// Lock nel formato NUOVO «pid:hex:starttime», con l'età che si vuole simulare.
// `nascita` è la nascita CHE IL PROPRIETARIO ATTESTÒ quando prese il lock.
function lockConNascita(p, pid, nascita, etaMs) {
  fs.writeFileSync(`${p}.lock`, `${pid}:deadbeefdeadbeef:${nascita}\n`, { mode: 0o600 });
  const t = (Date.now() - etaMs) / 1000;
  fs.utimesSync(`${p}.lock`, t, t);
}

const PID_MORTO = 999999999; // non assegnato: kill(pid,0) -> ESRCH, non EPERM

// ---------------------------------------------------------------------------
// IL CONTROLLO NEGATIVO — contro il codice attuale questo test è ROSSO.
//
// Costruzione del pid riassegnato: riusare davvero lo stesso numero non è
// deterministico in test, ma l'OSSERVABILE del riassegnato è esatto e
// ricostruibile: il lock porta la nascita attestata da un processo ormai
// morto (una qualsiasi ≠ da quella dell'attuale detentore del numero), e il
// numero appartiene oggi a un processo VIVO. Per il kernel il pid esiste;
// per l'identità del lock, quel proprietario è morto.
// ---------------------------------------------------------------------------
test('NEGATIVO pid riassegnato: lock di un morto il cui NUMERO è di un vivo — si recupera e si scrive', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const estraneo = figlioVivo(); // vive e porta il numero che fu del proprietario
  try {
    atomicWrite(p, validDef());
    // La nascita del proprietario defunto: un istante DIVERSO da quella
    // dell'estraneo — il kernel non dà lo stesso pid+nascita due volte.
    const nascitaDelDefunto = nascitaDi(estraneo.pid) + 1;
    lockConNascita(p, estraneo.pid, nascitaDelDefunto, 31000);

    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'Erede', cwd: '/tmp', engine: 'sh' }]));
    const durata = Date.now() - inizio;

    // Contro il codice attuale: kill(estraneo.pid, 0) ok -> «vivo» -> il lock
    // resta -> si attende 2s e si RINUNCIA (durata >= 1800, out senza Erede).
    // Il contratto nuovo: il proprietario è morto, il numero è di un altro.
    assert.deepEqual(cellIds(out), ['Base', 'Erede'], 'il lock del riassegnato si recupera e si scrive');
    assert.ok(durata < 1800, `recupero senza attendere la scadenza (durata ${durata}ms)`);
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base', 'Erede'], 'su disco');
  } finally {
    estraneo.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Il verso SBAGLIATO, con identità calcolabile: un vivo VERO con la SUA
// nascita nel token non è espropriato nemmeno dopo LOCK_STALE_MS. Pin del
// criterio appena introdotto: il confronto per nascita non deve scambiare
// un vivo per un riassegnato.
test('vivo con la PROPRIA nascita nel token: lock resta, si attende e si rinuncia', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const vivo = figlioVivo();
  try {
    atomicWrite(p, validDef());
    lockConNascita(p, vivo.pid, nascitaDi(vivo.pid), 31000); // scaduto, ma è LUI
    const contenutoPrima = fs.readFileSync(`${p}.lock`, 'utf8');
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'NonDeve', cwd: '/tmp', engine: 'sh' }]));
    const durata = Date.now() - inizio;

    assert.deepEqual(cellIds(out), ['Base'], 'rinuncia: torna lo stato corrente');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'], 'il disco è intatto');
    assert.ok(durata >= 1800, `ha atteso fino a scadenza (durata ${durata}ms), non ha rubato`);
    assert.equal(fs.readFileSync(`${p}.lock`, 'utf8'), contenutoPrima,
      'il lock del vivo non è stato toccato: né rimosso, né riscritto');
  } finally {
    vivo.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// La scadenza che FUNZIONA resta tale: morto il cui numero non è riassegnato.
test('morto non riassegnato (numero di nessuno): recupero immediato', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    lockConNascita(p, PID_MORTO, 12345, 31000);
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'Erede', cwd: '/tmp', engine: 'sh' }]));
    const durata = Date.now() - inizio;
    assert.deepEqual(cellIds(out), ['Base', 'Erede'], 'si scrive');
    assert.ok(durata < 1800, `recupero immediato (durata ${durata}ms)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Il criterio NON CALCOLABILE — dove si nasconde la prossima degradazione
// silenziosa. Due facce, entrambe pin­nate, con il lettore iniettato che «non
// sa leggere» (il modo in cui il codice vede un sistema senza /proc, es. macOS):
//
//   pid di un VIVO  + criterio non calcolabile -> VIVO (il lock resta: nel
//                     dubbio non si espropria);
//   pid di NESSUNO  + criterio non calcolabile -> morto (il kernel dice che
//                     non c'è proprio nessuno: non è un dubbio sull'identità).
// ---------------------------------------------------------------------------
test('NON CALCOLABILE con pid esistente: vivo — nel dubbio il lock resta', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const vivo = figlioVivo();
  try {
    atomicWrite(p, validDef());
    lockConNascita(p, vivo.pid, nascitaDi(vivo.pid), 31000);
    assert.equal(proprietarioVivo(`${p}.lock`, () => null), true,
      'criterio non calcolabile + processo esistente: VIVO, il lock resta');
  } finally {
    vivo.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NON CALCOLABILE con pid inesistente: morto — non è un dubbio di identità', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    lockConNascita(p, PID_MORTO, 12345, 31000);
    assert.equal(proprietarioVivo(`${p}.lock`, () => null), false,
      'il kernel dice che il numero non è di nessuno: morto anche senza criterio');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Formato VECCHIO («pid:hex», senza nascita): identità non confrontabile.
// È il fail-safe di compatibilità per i lock già sul disco quando la
// correzione arriva — e il comportamento stabilito dei sistemi senza /proc.
test('formato vecchio senza nascita + pid riassegnato-vivo: il lock RESTA (fail-safe)', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const estraneo = figlioVivo();
  try {
    atomicWrite(p, validDef());
    fs.writeFileSync(`${p}.lock`, `${estraneo.pid}:deadbeefdeadbeef\n`, { mode: 0o600 });
    const t = (Date.now() - 31000) / 1000;
    fs.utimesSync(`${p}.lock`, t, t);

    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'NonDeve', cwd: '/tmp', engine: 'sh' }]));
    // Il buco dichiarato e residuo: per i lock vecchi non c'è nascita da
    // confrontare, e nel dubbio non si espropria. Costo: una scrittura
    // rimandata — mai un vivo espropriato.
    assert.deepEqual(cellIds(out), ['Base'], 'rinuncia: il lock senza identità resta');
  } finally {
    estraneo.spegni();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Il token CHE IL CODICE SCRIVE deve portare la nascita: osservato da DENTRO
// una presa reale (il lock vive mentre trasforma gira), senza export extra.
test('il token scritto da una presa reale porta pid, hex E nascita di questo processo', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  try {
    atomicWrite(p, validDef());
    let tokenOsservato = null;
    aggiornaDefinizioni(p, (defs) => {
      // Siamo DENTRO il lock: il file esiste ancora ed è il NOSTRO.
      tokenOsservato = fs.readFileSync(`${p}.lock`, 'utf8').trim();
      return validDef([...defs.cells, { id: 'Dentro', cwd: '/tmp', engine: 'sh' }]);
    });
    assert.ok(tokenOsservato, 'la presa è avvenuta e il token è stato letto da dentro');
    const parti = tokenOsservato.split(':');
    assert.equal(parti.length, 3, `tre campi pid:hex:nascita, non ${parti.length}: «${tokenOsservato}»`);
    assert.equal(Number(parti[0]), process.pid, 'il pid è di chi ha preso il lock');
    assert.ok(/^[0-9a-f]{16}$/.test(parti[1]), 'l\'hex della presa è al suo posto');
    assert.equal(Number(parti[2]), nascitaDi(process.pid),
      'la nascita nel token è quella VERA di questo processo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rilievo 2 dell'audit pre-release: la scrittura del token può FALLIRE
// («catch (_) { /* informativo */ }») — disco pieno, quota, errore transitorio.
// Il lock esiste ma è VUOTO: nessun pid da interrogare, e dopo 30s il lock di
// un proprietario VIVO E AL LAVORO viene espropriato, perché per il codice è
// «di nessuno». Quel contenuto non è informativo: è l'unica cosa che rende il
// lock attribuibile. Chi non riesce a scrivere il proprio token non è titolare
// di nulla — e non deve nemmeno fingere di esserlo scrivendo i dati.
// ---------------------------------------------------------------------------
test('NEGATIVO write del token fallita: la presa NON riesce, niente scrittura, nessun lock vuoto', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  // Disco che rifiuta SOLO la scrittura su fd (la firma del token): atomicWrite
  // scrive per PATH e non viene toccata. È il modo chirurgico di fare ENOSPC
  // su una sola write senza dipendere dal filesystem.
  const veroWrite = fs.writeFileSync;
  fs.writeFileSync = function writeCheFallisceSuFd(target, dati, ...resto) {
    if (typeof target === 'number') {
      const e = new Error('simulato: scrittura del token fallita (disco pieno)');
      e.code = 'ENOSPC';
      throw e;
    }
    return veroWrite.call(fs, target, dati, ...resto);
  };
  try {
    atomicWrite(p, validDef());
    const messaggi = [];
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'DiUno', cwd: '/tmp', engine: 'sh' }]), {
      log: (m) => messaggi.push(m),
    });

    // Contro il codice attuale: la presa RIESCE comunque (fd aperto, token mai
    // scritto), la trasforma gira, atomicWrite scrive — una scrittura sotto una
    // mutua esclusione ILLUSORIA — e il lock VUOTO resta sul disco, espropriabile
    // da chiunque dopo 30s. Il contratto nuovo: nessuna titolarità senza token.
    assert.ok(messaggi.some((m) => m.includes('lock non ottenuto')),
      'la presa senza token rinuncia e lo dichiara');
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base'],
      'nessuna scrittura senza mutua esclusione reale');
    const residui = fs.readdirSync(dir).filter((n) => n.endsWith('.lock'));
    assert.deepEqual(residui, [], 'nessun lock vuoto lasciato sul disco');
    void out;
  } finally {
    fs.writeFileSync = veroWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// La conseguenza dichiarata dal rilievo, provata COM'E' OGGI: un lock vuoto
// sul disco è già espropriabile a 31s. Dopo la correzione questo scenario non
// può più nascere da una presa (la write fallita non lascia nulla), e il
// relitto di un CRASH fra open e write — l'unica origine rimasta — è di un
// processo che non esiste più: recuperarlo è GIUSTO, e resta il test 162 di
// lock-edges a pinnare quella semantica.
test('dopo la correzione il sistema resta utilizzabile: la presa successiva scrive regolarmente', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'fleet.json');
  const veroWrite = fs.writeFileSync;
  try {
    atomicWrite(p, validDef());
    // Prima presa: write del token fallita -> rinuncia, disco intatto, zero lock.
    fs.writeFileSync = function (target, dati, ...resto) {
      if (typeof target === 'number') { const e = new Error('ENOSPC simulato'); e.code = 'ENOSPC'; throw e; }
      return veroWrite.call(fs, target, dati, ...resto);
    };
    aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'NonDeve', cwd: '/tmp', engine: 'sh' }]));
    fs.writeFileSync = veroWrite; // il disco «guarisce»

    // Seconda presa: disco tornato scrivibile, nessun relitto da attendere.
    const inizio = Date.now();
    const out = aggiornaDefinizioni(p, (defs) => validDef([...defs.cells, { id: 'Dopo', cwd: '/tmp', engine: 'sh' }]));
    const durata = Date.now() - inizio;
    assert.deepEqual(cellIds(out), ['Base', 'Dopo'], 'la presa successiva scrive');
    assert.ok(durata < 1800, `subito, senza attendere scadenze di lock fantasma (durata ${durata}ms)`);
    assert.deepEqual(cellIds(loadDefinitions(p)), ['Base', 'Dopo'], 'su disco');
  } finally {
    fs.writeFileSync = veroWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
