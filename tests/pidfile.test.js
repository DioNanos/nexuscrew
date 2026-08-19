'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const {
  readPidfile, writePidfile, pidOwnership, pidExists, isAlive, cleanStale, killPidfile, removePidfile,
  currentUid, readCmdline, probeProcessStart, hasSchemaMarker, checkSchemaMarker, schemaMarkerPath,
} = require('../lib/cli/pidfile.js');

function tmpPid() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pid-'));
  return path.join(dir, 'nexuscrew.pid');
}

test('writePidfile + readPidfile round-trip', () => {
  const p = tmpPid();
  writePidfile(p, 12345, 'node nexuscrew serve');
  const meta = readPidfile(p);
  assert.equal(meta.pid, 12345);
  assert.equal(meta.cmd, 'node nexuscrew serve');
  assert.ok(meta.startTs > 0);
  // mode 0600
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('writePidfile exclusive (wx): no silent overwrite', () => {
  const p = tmpPid();
  writePidfile(p, 111, 'cmd-a');
  assert.throws(() => writePidfile(p, 222, 'cmd-b'), /EEXIST|file already exists/i);
  // contenuto invariato (primo writer)
  assert.equal(readPidfile(p).pid, 111);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readPidfile: assente/malformato -> null', () => {
  const p = tmpPid();
  assert.equal(readPidfile(p), null); // non esiste
  fs.writeFileSync(p, 'not json');
  assert.equal(readPidfile(p), null); // malformato
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('pidExists: processo vivo (self) true, pid morto false', () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(999999), false);
});

test('EPERM: PID esistente ma estraneo non e un processo NexusCrew vivo', () => {
  const foreign = (_pid, signal) => {
    assert.equal(signal, 0);
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  assert.equal(pidOwnership(424242, foreign), 'foreign');
  assert.equal(pidExists(424242, foreign), true, 'il PID esiste genericamente');
  assert.equal(isAlive({ pid: 424242, cmd: 'node tunnel-supervisor.js' }, { killImpl: foreign }), false);
});

test('isAlive: self vivo (cmd match conservativo); meta null false', () => {
  // process.pid e' vivo; 'node' e' sicuramente nel cmdline del processo test
  assert.equal(isAlive({ pid: process.pid, cmd: 'node' }), true);
  assert.equal(isAlive(null), false);
  assert.equal(isAlive({ pid: 999999, cmd: 'x' }), false); // pid morto
});

test('cleanStale: pid morto -> rimuove pidfile', () => {
  const p = tmpPid();
  writePidfile(p, 999999, 'dead-process'); // pid morto
  assert.equal(cleanStale(p), true);
  assert.equal(readPidfile(p), null); // rimosso
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('cleanStale: pid vivo -> non rimuove', () => {
  const p = tmpPid();
  writePidfile(p, process.pid, 'node');
  assert.equal(cleanStale(p), false);
  assert.ok(readPidfile(p)); // ancora presente
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('cleanStale: PID riutilizzato da altro UID viene rimosso automaticamente', () => {
  const p = tmpPid();
  writePidfile(p, 424242, 'node tunnel-supervisor.js');
  const foreign = () => {
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  assert.equal(cleanStale(p, { killImpl: foreign }), true);
  assert.equal(readPidfile(p), null);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: no pidfile -> no kill', () => {
  const p = tmpPid();
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /no pidfile/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: stale (pid morto) -> remove, no kill', () => {
  const p = tmpPid();
  writePidfile(p, 999999, 'dead');
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /stale/);
  assert.equal(readPidfile(p), null); // rimosso
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: PID reuse (cmd mismatch) -> NO kill, remove stale', () => {
  // pid esiste (self) ma cmd salvato non matcha -> PID reuse, non killare
  const p = tmpPid();
  writePidfile(p, process.pid, 'COMPLETELY-DIFFERENT-CMD-XYZ-NOT-MATCHING');
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /pid reuse|cmd mismatch/);
  assert.equal(readPidfile(p), null); // pidfile stale rimosso (no broad kill)
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: EPERM rimuove solo il pidfile e non segnala il processo estraneo', () => {
  const p = tmpPid();
  writePidfile(p, 424242, 'node tunnel-supervisor.js');
  const signals = [];
  const foreign = (_pid, signal) => {
    signals.push(signal);
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  const r = killPidfile(p, 'SIGTERM', { killImpl: foreign });
  assert.deepEqual(signals, [0], 'solo ownership probe, nessun SIGTERM');
  assert.equal(r.killed, false);
  assert.match(r.reason, /not owned/);
  assert.equal(readPidfile(p), null);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

// --- removePidfile: la rimozione verifica il SOGGETTO (rilievo di audit) ----
// Un pidfile non è un file qualunque: è la prova che un processo è vivo.
// Toglierlo quando appartiene a un vivo che non siamo noi cancella quella
// prova — chi lo governa lo crederebbe morto. I casi legittimi (self, stale,
// garbage, e la garanzia del chiamante che ha appena killato) devono continuare
// a funzionare: chiudere il difetto non deve creare un blocco.
const aspettaExit = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once('exit', resolve);
  setTimeout(resolve, 3000); // il test non resta appeso per un figlio ostinato
});

test('removePidfile: il pidfile di un ALTRO processo vivo SOPRAVVIVE al tentativo', async () => {
  // Il caso cattivo: il pidfile è di un processo vivo che non è chi chiama.
  // Qui il "altro processo" è un figlio vero del test (vivo, cmd reale).
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => setTimeout(r, 150)); // il figlio parte
  const p = tmpPid();
  try {
    writePidfile(p, child.pid, `${process.execPath} -e`);
    assert.ok(isAlive(readPidfile(p)), 'precondizione: il pid del file è vivo');
    assert.notEqual(child.pid, process.pid, 'precondizione: non è il nostro pid');
    // Il tentativo di rimozione naked: rifiutato, e il file resta.
    assert.equal(removePidfile(p), false, 'rifiutato: vivo che non siamo noi');
    assert.ok(fs.existsSync(p), 'il pidfile sopravvive: la prova di vita non si cancella');
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
  }
  // Il caso legittimo accanto: MORTO il processo, la pulizia torna a funzionare
  // (non abbiamo chiuso il difetto creando un blocco).
  assert.equal(removePidfile(p), true, 'stale dopo la morte: si rimuove');
  assert.ok(!fs.existsSync(p));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('removePidfile: il NOSTRO pidfile si rimuove (self-cleanup del serve)', () => {
  const p = tmpPid();
  writePidfile(p, process.pid, 'node nexuscrew serve');
  assert.equal(removePidfile(p), true, 'meta.pid === process.pid: è nostro');
  assert.ok(!fs.existsSync(p));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('removePidfile: file garbage (non un pidfile) si rimuove — non è il pidfile di nessuno', () => {
  const p = tmpPid();
  fs.writeFileSync(p, 'not json at all\n');
  assert.equal(removePidfile(p), true);
  assert.ok(!fs.existsSync(p));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('removePidfile: allowLive è la garanzia del chiamante — il vivo si rimuove SOLO con essa', async () => {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((r) => setTimeout(r, 150));
  const p = tmpPid();
  try {
    writePidfile(p, child.pid, `${process.execPath} -e`);
    assert.equal(removePidfile(p, { allowLive: true }), true, 'con la garanzia: rimozione');
    assert.ok(!fs.existsSync(p));
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
  }
  fs.rmSync(path.dirname(p), { recursive: true, force:true });
});

test('killPidfile: lo stop da CLI NON si rompe — post-kill il pidfile si toglie anche se /proc ritarda', () => {
  // Simulazione fedele: il pidfile è di un "server" vivo (mock killImpl non
  // uccide davvero), il cmd matcha, il segnale parte. La rimozione post-kill
  // usa la garanzia allowLive: senza, un /proc lento bloccherebbe lo stop.
  //
  // R-pidfile-2 (2026-08-17): il pid qui era 424243, un numero mai esistito
  // davvero — prima del fix odierno questo non contava, il ramo cmd-only non
  // guardava mai la nascita. Ora writePidfile classifica un pid inattestabile
  // come 'indeterminate' (non sappiamo perché 424243 non si legge: se manca
  // solo perché non esiste, o se questa macchina non sa attestare affatto) e
  // killPidfile rifiuta PRIMA di questo test, che non e' quello che questo
  // test vuole provare. Serve un pid REALMENTE attestabile perché il test
  // arrivi al codice che vuole esercitare (rimozione post-kill con /proc
  // lento) — usiamo process.pid, vivo per davvero: il cmd resta mockato,
  // quindi non importa che sia il nostro processo di test.
  const p = tmpPid();
  writePidfile(p, process.pid, 'node nexuscrew serve');
  const segnali = [];
  const killImpl = (pid, signal) => {
    segnali.push(signal);
    if (signal !== 0) return; // segnale partito, il "processo" resta visibile
    return; // ownership probe: ok (owned)
  };
  const r = killPidfile(p, 'SIGTERM', {
    killImpl,
    readCmdlineImpl: () => 'node nexuscrew serve', // cmd matcha: nessun pid-reuse
  });
  assert.deepEqual(segnali, [0, 'SIGTERM'], 'probe + segnale, in ordine');
  assert.equal(r.killed, true);
  assert.equal(readPidfile(p), null, 'post-kill: il pidfile è rimosso');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R-pidfile (2026-08-17): il pidfile di un morto il cui NUMERO è stato
// riassegnato a un processo NOSTRO con un cmd COMPATIBILE. cmdMatches è per
// inclusioni («salvato incluso nel vivo»), quindi un comando più lungo del
// salvato matcha: due supervisor dello stesso tunnel, due serve, il restart
// di ieri. Il cmd non distingue due processi con lo stesso comando — la
// NASCITA sì (processStart, già nel meta di writePidfile, mai confrontato
// qui). Costo visto sui chiamanti: commands.js getta «already running» per
// un server che non c'è; killPidfile (tunnel restart, stop) segnala il
// processo riusato. Finora.
// Costruzione: figlio REALE che porta il numero che fu del defunto; il
// pidfile attesta la nascita del defunto (un tick qualunque diverso dal
// vero) e il cmd VERO del figlio — l'osservabile esatto del riassegno.
// ---------------------------------------------------------------------------

// Piccolo figlio vivo che tiene il numero (come il test della sopravvivenza).
function figlioCheTieneIlNumero() {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  child.unref();
  return child;
}
async function figlioPronto(child) {
  await new Promise((r) => setTimeout(r, 150));
}

test('NEGATIVO riassegno cmd-compatibile: cleanStale riconosce lo stale dalla NASCITA, non dal cmd', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    const cmdVivo = readCmdline(child.pid);
    assert.ok(cmdVivo, 'precondizione: cmdline del figlio leggibile');
    // Il pidfile del DEFUNTO: il numero del figlio, il suo cmd (il riuso è
    // cmd-compatibile per costruzione), la nascita di CHI NON C'E' PIU'.
    fs.writeFileSync(p, `${JSON.stringify({ pid: child.pid, cmd: cmdVivo, processStart: 'linux:1', uid: currentUid() })}\n`);
    // Contro il codice attuale: owned + cmd match = «vivo» → cleanStale non
    // tocca MAI → already-running per sempre su un server che non c'è.
    assert.equal(cleanStale(p), true, 'la nascita non mente: lo stale si riconosce e si rimuove');
    assert.ok(!fs.existsSync(p));
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('NEGATIVO riassegno cmd-compatibile: killPidfile NON segnala il processo riusato', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    const cmdVivo = readCmdline(child.pid);
    fs.writeFileSync(p, `${JSON.stringify({ pid: child.pid, cmd: cmdVivo, processStart: 'linux:1', uid: currentUid() })}\n`);
    // Contro il codice attuale: ownership owned + cmd match → kill(child):
    // ammazza il riusato. Il contratto nuovo: la nascita attestata non è la
    // sua → il pidfile è stale, il processo non si tocca.
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, false, 'il processo riusato non si segnala');
    assert.ok(/start mismatch/.test(r.reason || ''), `reason parla di nascita: ${r.reason}`);
    assert.ok(!fs.existsSync(p), 'il pidfile stale si rimuove');
    // E il figlio è ancora lì: la dimostrazione che nessuno lo ha toccato.
    assert.equal(pidOwnership(child.pid), 'owned', 'il riusato è ancora vivo e nostro');
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('verso giusto: pidfile di un vivo con la PROPRIA nascita — vivo per la via nuova, protetto, e killabile come legittimo proprietario', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    writePidfile(p, child.pid, readCmdline(child.pid)); // start VERO nel meta
    const meta = readPidfile(p);
    assert.ok(typeof meta.processStart === 'string' && meta.processStart, 'precondizione: la nascita viaggia nel meta');
    // Il confronto della nascita è ATTIVO e la nascita è SUA: vivo.
    assert.equal(isAlive(meta), true, 'nascita matchante: è lui, è vivo');
    assert.equal(removePidfile(p), false, 'la rimozione naked resta rifiutata');
    assert.ok(fs.existsSync(p));
    // E il legittimo proprietario si ferma normalmente: il kill verificato
    // funziona perché la nascita È la sua.
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, true, 'il proprietario vero si ferma: la correzione non blocca lo stop');
    await aspettaExit(child);
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('isAlive: non calcolabile — senza nascita leggibile vale il cmd, nel dubbio il vivo resta vivo', async () => {
  // Solo isAlive: questo fix (R-pidfile-2) non la tocca. isAttributable resta
  // fail-closed sulla stessa mancanza (richiede processStart, invariato); qui
  // il criterio storico "nel dubbio vale il cmd" resta quello di sempre —
  // isAlive non manda mai un segnale, killPidfile si', ed e' li' che il
  // dubbio smette di essere gratis (vedi il test sotto).
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  try {
    const cmdVivo = readCmdline(child.pid);
    // a) meta SENZA processStart (pidfile vecchio, /proc nascosto): via cmd.
    const senza = { pid: child.pid, cmd: cmdVivo, uid: currentUid() };
    assert.equal(isAlive(senza), true, 'senza nascita nel meta: il cmd decide, come sempre');
    // b) nascita nel meta ma NON leggibile ora (macOS senza ps, /proc negato):
    // non è «morto», è NON LO SO — il cmd vale, il vivo resta vivo.
    const nonLeggibile = { pid: child.pid, cmd: cmdVivo, processStart: 'linux:1', uid: currentUid() };
    assert.equal(isAlive(nonLeggibile, { readProcessStartImpl: () => null }), true,
      'criterio non calcolabile: mai dichiarare morto un vivo');
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
  }
});

// R-pidfile-2 (2026-08-17, audit su 7b6571c/529e32f): primo giro — l'audit
// ha trovato che killPidfile segnalava sul solo pid+cmd quando il meta non
// aveva processStart, in QUALUNQUE caso. Questo test asseriva `r.killed ===
// true` per un meta senza processStart ("pidfile senza nascita: il kill
// verificato di sempre" — il commento originale). Un primo fix aveva reso
// TUTTI i meta senza attestazione un rifiuto, senza distinguere. E' stato
// MISURATO il costo di quella scelta sul path reale dell'aggiornamento
// automatico: lib/update/runner.js chiama stopPortableRuntime -> killPidfile
// nudo, senza degrado; un rifiuto fa FALLIRE l'update per ogni nodo il cui
// runtime e' ancora precedente a quando processStart e' nato — un guasto
// certo, non un rischio raro.
//
// R-pidfile-3: SECONDO giro. Il primo fix chiamava questo ramo "legacy" e lo
// permetteva SEMPRE quando il meta non aveva ne' processStart ne'
// attestation. L'auditor ha dimostrato che "nessun campo" non prova la
// provenienza (un chiamante puo' scrivere quella stessa forma anche con
// codice v2 — vedi il test sui campi riservati sotto) — quindi "legacy
// permanente" lasciava aperti per sempre restore da backup, corruzione e
// downgrade. Ora si chiama COMPATIBILITA' AMBIGUA (unverifiedBirth:
// 'ambiguous-compat', non piu' 'legacy') ed e' concessa SOLO finche' questa
// installazione non ha mai completato una scrittura v2 (nessun marker di
// schema nella directory del pidfile — schemaMarkerPath). Questo test resta
// nel caso PRE-migrazione (tmpPid() da' sempre una directory nuova, senza
// marker): l'asserzione e' la stessa di prima, `r.killed === true`, ma il
// significato e' piu' stretto — non "sempre", "finche' non e' successo
// altro". Il caso POST-migrazione (marker presente) e' il test subito sotto.
test('killPidfile: PRE-migrazione (nessun marker), meta senza attestazione ricade sul cmd, dichiarato ambiguous-compat', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    const cmdVivo = readCmdline(child.pid);
    const ambiguo = { pid: child.pid, cmd: cmdVivo, uid: currentUid() };
    fs.writeFileSync(p, `${JSON.stringify(ambiguo)}\n`);
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, true, 'nessun marker in questa directory: pre-migrazione, il kill via cmd resta possibile');
    assert.equal(r.unverifiedBirth, 'ambiguous-compat', 'dichiarato, e distinguibile da unsupported');
    await aspettaExit(child);
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// Il negativo che l'auditor ha chiesto per il marker one-way: STESSO meta
// senza attestazione, ma questa volta l'installazione ha GIA' completato una
// scrittura v2 (marker presente — costruito qui con una writePidfile REALE
// su un pid diverso, esattamente come farebbe il codice nuovo al primo
// avvio). Da questo momento "nessun campo" non e' piu' spiegabile come
// pre-migrazione: e' sospetto, e rifiuta come indeterminate.
test('killPidfile: POST-migrazione (marker presente), meta senza attestazione NON e\' piu\' accettato', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    // La prima scrittura v2 in QUESTA directory (quella di p): crea il
    // marker per davvero, come farebbe il codice nuovo al primo avvio.
    // Un pidfile usa-e-getta, in nulla diverso da un avvio vero.
    const scritturaV2 = path.join(path.dirname(p), 'altro.pid');
    writePidfile(scritturaV2, process.pid, 'node altro', {});
    fs.rmSync(scritturaV2, { force: true }); // il pidfile non serve, il marker accanto resta
    assert.equal(hasSchemaMarker(p), true, 'precondizione: il marker ora c\'e\' in questa directory');

    const cmdVivo = readCmdline(child.pid);
    const ambiguo = { pid: child.pid, cmd: cmdVivo, uid: currentUid() };
    fs.writeFileSync(p, `${JSON.stringify(ambiguo)}\n`);
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, false, 'marker presente: nessun campo attestazione non e\' piu\' pre-migrazione, e\' sospetto');
    assert.match(r.reason, /schema migration/, `reason nomina la causa: ${r.reason}`);
    assert.ok(fs.existsSync(p), 'il pidfile NON si tocca: non sappiamo se sia stale');
    assert.equal(pidOwnership(child.pid), 'owned', 'il legittimo e\' ancora vivo, non toccato');
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// R-pidfile-4 (2026-08-17, audit su develop@437d29f): CONTROLLO NEGATIVO
// OBBLIGATORIO, la sonda dell'auditor riprodotta alla lettera. PRIMA di
// questo giro: .pidfile-schema-v2 come DIRECTORY faceva tornare
// hasSchemaMarker() false per costruzione (isFile() falso su una directory)
// — "nessun marker" letto come "assente", cioe' PERMISSIVO — ed
// ensureSchemaMarker ingoiava l'errore di creazione (EISDIR, non EEXIST)
// senza distinguerlo. Due writePidfile v2 riuscite di fila non bastavano a
// far nascere il marker: l'ostacolo lo impediva OGNI volta, per sempre — non
// un giro in piu' di compatibilita'. PRIMA: killed:true, SIGTERM inviato.
// DOPO: il meccanismo che non sa determinare il proprio stato chiude invece
// di concedere — killed:false, motivo che nomina l'ostacolo.
test('AUDITOR R-pidfile-4: ostacolo DIRECTORY sul marker — PRIMA segnalava sempre, ORA rifiuta (stato non determinabile)', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    // Precrea .pidfile-schema-v2 come DIRECTORY, esattamente come l'auditor.
    fs.mkdirSync(schemaMarkerPath(p), { recursive: true });
    // Due writePidfile v2 riuscite di fila in questa stessa directory: il
    // marker non nasce mai (l'ostacolo lo impedisce), ma writePidfile non
    // fallisce mai per questo — e' il punto del difetto.
    for (let i = 0; i < 2; i += 1) {
      const scritturaV2 = path.join(path.dirname(p), `altro-${i}.pid`);
      writePidfile(scritturaV2, process.pid, `node altro-${i}`, {});
      fs.rmSync(scritturaV2, { force: true });
    }
    assert.equal(hasSchemaMarker(p), false, 'precondizione: il marker non e\' MAI nato (l\'ostacolo lo impedisce)');
    assert.equal(checkSchemaMarker(p).state, 'undeterminable', 'precondizione: non e\' "absent", e\' "non determinabile"');

    const cmdVivo = readCmdline(child.pid);
    const ambiguo = { pid: child.pid, cmd: cmdVivo, uid: currentUid() };
    fs.writeFileSync(p, `${JSON.stringify(ambiguo)}\n`);
    const segnali = [];
    const r = killPidfile(p, 'SIGTERM', {
      killImpl: (_pid, sig) => { segnali.push(sig); }, // non lancia mai: ownership 'owned'
    });
    assert.equal(r.killed, false, 'stato del marker non determinabile: NON si segnala, mai piu\' un bypass permanente');
    assert.match(r.reason, /undeterminable/, `reason nomina l'ostacolo: ${r.reason}`);
    assert.deepEqual(segnali, [0], 'solo la probe di ownership: nessun SIGTERM inviato');
    assert.ok(fs.existsSync(p), 'il pidfile NON si tocca: non sappiamo se sia stale');
    assert.equal(pidOwnership(child.pid), 'owned', 'il legittimo e\' ancora vivo, non toccato');
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// Lo stesso ostacolo, forma SYMLINK invece di directory — richiesto
// esplicitamente. lstat (non stat) lo vede come symlink PRIMA di
// seguirlo: non importa dove punti (un file regolare altrove, il nulla, o
// se stesso) — un symlink al posto del marker non e' mai un file regolare
// scritto da noi, ed e' esattamente il tipo di ostacolo che un avversario
// userebbe per tenere aperta la finestra di compatibilita' ambigua.
test('killPidfile: ostacolo SYMLINK sul marker — stato non determinabile, rifiuta', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    const altrove = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pid-symlink-target-')), 'niente');
    fs.symlinkSync(altrove, schemaMarkerPath(p)); // symlink dangling: punta al nulla
    for (let i = 0; i < 2; i += 1) {
      const scritturaV2 = path.join(path.dirname(p), `altro-${i}.pid`);
      writePidfile(scritturaV2, process.pid, `node altro-${i}`, {});
      fs.rmSync(scritturaV2, { force: true });
    }
    assert.equal(checkSchemaMarker(p).state, 'undeterminable', 'un symlink non e\' mai un file regolare "nostro"');
    assert.match(checkSchemaMarker(p).reason, /symlink/, 'la causa nomina esplicitamente il symlink');

    const cmdVivo = readCmdline(child.pid);
    fs.writeFileSync(p, `${JSON.stringify({ pid: child.pid, cmd: cmdVivo, uid: currentUid() })}\n`);
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, false, 'symlink al posto del marker: NON si segnala');
    assert.match(r.reason, /undeterminable/, `reason nomina l'ostacolo: ${r.reason}`);
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// AUDITOR R-pidfile-5 (2026-08-17, audit su develop@fa8bd90): controllo
// negativo alla lettera. La scrittura del marker fallisce SENZA lasciare
// traccia (ENOSPC qui — quota, EROFS, permesso transitorio, una race sono
// la stessa famiglia: nessuno lascia nulla sul filesystem). Due writePidfile
// "riuscite" (il pidfile stesso si scrive; SOLO il marker fallisce, come
// nella misura) — poi killPidfile su un meta senza attestazione, cmd
// compatibile. PRIMA di questo giro: checkSchemaMarker vedeva il path
// ENOENT (nessuna traccia dell'errore) -> 'absent' -> ambiguous-compat
// concesso, SIGTERM inviato. DOPO: claimSchemaMarker riprova ADESSO, fallisce
// ADESSO (l'errore e' ancora presente) -> rifiuta. DUE BRACCI, non uno:
// ripristinato l'errore, il kill successivo riprova e concede UNA volta —
// perche' ORA la scrittura riesce per davvero, non perche' glielo diciamo.
test('AUDITOR R-pidfile-5: scrittura del marker fallisce con ENOSPC senza lasciare traccia — PRIMA concedeva sempre, ORA rifiuta finche\' l\'errore c\'e\', concede UNA volta quando sparisce', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  const markerPath = schemaMarkerPath(p);
  const scritturaOriginale = fs.writeFileSync;
  const conENOSPC = (target, ...rest) => {
    if (target === markerPath) {
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    }
    return scritturaOriginale.call(fs, target, ...rest);
  };
  try {
    // Fa fallire SOLO la scrittura del marker (path esatto): il pidfile e
    // tutto il resto passano dalla scrittura vera.
    fs.writeFileSync = conENOSPC;
    for (let i = 0; i < 2; i += 1) {
      const scritturaV2 = path.join(path.dirname(p), `altro-${i}.pid`);
      writePidfile(scritturaV2, process.pid, `node altro-${i}`, {});
      fs.rmSync(scritturaV2, { force: true });
    }
    assert.equal(fs.existsSync(markerPath), false,
      'precondizione: due writePidfile "riuscite", il marker non e\' MAI nato — ENOSPC lo impedisce in silenzio, nessuna traccia');

    const cmdVivo = readCmdline(child.pid);
    fs.writeFileSync = scritturaOriginale; // il pidfile stesso lo scriviamo col vero fs
    fs.writeFileSync(p, `${JSON.stringify({ pid: child.pid, cmd: cmdVivo, uid: currentUid() })}\n`);
    fs.writeFileSync = conENOSPC; // l'errore torna attivo per il kill

    // Braccio 1: l'errore c'e' ancora -> rifiuta.
    const r1 = killPidfile(p, 'SIGTERM');
    assert.equal(r1.killed, false, 'ENOSPC ancora presente ADESSO: NON si segnala');
    assert.match(r1.reason, /undeterminable/, `reason nomina lo stato: ${r1.reason}`);
    assert.equal(pidOwnership(child.pid), 'owned', 'il legittimo e\' ancora vivo, non toccato');

    // Braccio 2: l'errore sparisce -> il prossimo kill riprova ADESSO,
    // riesce per davvero, e concede UNA volta.
    fs.writeFileSync = scritturaOriginale;
    const r2 = killPidfile(p, 'SIGTERM');
    assert.equal(r2.killed, true, 'ENOSPC rimosso: la creazione ORA riesce per davvero, concessa una volta');
    assert.equal(r2.unverifiedBirth, 'ambiguous-compat');
    assert.equal(hasSchemaMarker(p), true, 'il marker ora esiste per davvero: non piu\' un evento passato non osservabile');
    await aspettaExit(child);
  } finally {
    fs.writeFileSync = scritturaOriginale;
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// Il caso di confine dichiarato nel commento accanto a claimSchemaMarker:
// un pidfile che sta per essere RIMOSSO puo' lasciare dietro un marker in
// una directory che magari non ospitera' mai piu' un runtime. Qui lo si
// dimostra: dopo un kill che crea il marker E rimuove il pidfile, il marker
// resta — innocuo, perche' il suo unico effetto e' rendere le decisioni
// FUTURE su quella directory piu' caute (fail-closed), mai piu' permissive.
test('confine dichiarato: il marker sopravvive alla rimozione del pidfile che lo ha creato — innocuo, mai piu\' permissivo', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    const cmdVivo = readCmdline(child.pid);
    fs.writeFileSync(p, `${JSON.stringify({ pid: child.pid, cmd: cmdVivo, uid: currentUid() })}\n`);
    assert.equal(hasSchemaMarker(p), false, 'precondizione: nessuna migrazione ancora in questa directory');
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, true);
    assert.equal(fs.existsSync(p), false, 'il pidfile e\' rimosso, come sempre dopo un kill riuscito');
    assert.equal(hasSchemaMarker(p), true, 'il marker SOPRAVVIVE alla rimozione del pidfile che lo ha innescato');
    // Effetto del residuo: la STESSA directory, ora, rifiuta un ALTRO meta
    // ambiguo — mai il contrario.
    const secondoPath = path.join(path.dirname(p), 'secondo.pid');
    const child2 = figlioCheTieneIlNumero();
    await figlioPronto(child2);
    try {
      fs.writeFileSync(secondoPath,
        `${JSON.stringify({ pid: child2.pid, cmd: readCmdline(child2.pid), uid: currentUid() })}\n`);
      const r2 = killPidfile(secondoPath, 'SIGTERM');
      assert.equal(r2.killed, false, 'il residuo rende la STESSA directory piu\' cauta, mai piu\' permissiva');
    } finally {
      child2.kill('SIGKILL');
      await aspettaExit(child2);
    }
    await aspettaExit(child);
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// LA DOMANDA CHE DEV HA GIRATO ALL'AUDITOR, MISURATA non dedotta: dopo la
// migrazione (marker presente per davvero), un nodo che davvero non sa
// attestare resta fermabile? Si', perche' attestation:'unsupported' e'
// controllato PRIMA del marker nel codice (killPidfile sopra) — un nodo
// dichiarato unsupported non passa mai dal ramo del marker. Qui lo si
// dimostra costruendo il caso reale: marker presente (migrazione avvenuta),
// POI un pidfile con attestation:'unsupported' scritto da un nodo che non
// sa attestare — deve restare fermabile esattamente come prima.
test('MISURATO: dopo la migrazione, un nodo unsupported vero resta fermabile', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    const scritturaV2 = path.join(path.dirname(p), 'migrazione.pid');
    writePidfile(scritturaV2, process.pid, 'node migrazione', {});
    fs.rmSync(scritturaV2, { force: true });
    assert.equal(hasSchemaMarker(p), true, 'precondizione: la migrazione e\' avvenuta per davvero in questa directory');

    const cmdVivo = readCmdline(child.pid);
    fs.writeFileSync(p, `${JSON.stringify({
      pid: child.pid, cmd: cmdVivo, attestation: 'unsupported', uid: currentUid(),
    })}\n`);
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, true, 'MISURATO: unsupported vero resta fermabile anche dopo la migrazione (Termux non si spegne)');
    assert.equal(r.unverifiedBirth, 'unsupported', 'dichiarato, non confuso con ambiguous-compat');
    await aspettaExit(child);
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// GATE OBBLIGATORIO (R-pidfile-3): la sua misura esatta. Con lo spread
// di extra per ultimo, un chiamante poteva scrivere un'attestazione
// INVENTATA che vinceva sul valore vero calcolato da probeProcessStart —
// "nessun campo attestazione = pre-fix" non era piu' una deduzione valida
// perche' quella forma (o una fasulla) la poteva produrre anche il writer
// nuovo. RESERVED_META_FIELDS filtra extra e i campi veri sono scritti DOPO:
// dopo il fix questa chiamata non deve poter cambiare ne' processStart ne'
// attestation.
test('writePidfile: i campi riservati NON sono sovrascrivibili da extra (misura esatta)', () => {
  const p = tmpPid();
  try {
    writePidfile(p, process.pid, 'node test-reserved', {
      processStart: 'FINTO', attestation: 'unsupported', unaChiaveInnocua: 'ok',
    });
    const meta = readPidfile(p);
    assert.notEqual(meta.processStart, 'FINTO', 'processStart NON e\' quello iniettato da extra');
    assert.notEqual(meta.attestation, 'unsupported', 'attestation NON e\' quella iniettata da extra (o e\' assente: processStart vince)');
    // Sulla nostra macchina process.pid e' sempre attestabile per davvero:
    // il valore VERO deve essere quello scritto, non il finto.
    assert.ok(typeof meta.processStart === 'string' && meta.processStart.length > 0,
      'il valore VERO (probeProcessStart sul nostro pid) e\' quello che vince');
    assert.equal(meta.unaChiaveInnocua, 'ok', 'i campi NON riservati di extra restano scrivibili come sempre');
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

test('killPidfile: attestation indeterminate (tentativo fallito, non mai tentato) RIFIUTA', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    const cmdVivo = readCmdline(child.pid);
    const indeterminato = { pid: child.pid, cmd: cmdVivo, attestation: 'indeterminate', uid: currentUid() };
    fs.writeFileSync(p, `${JSON.stringify(indeterminato)}\n`);
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, false, 'tentativo fallito senza causa classificabile: NON si segnala');
    assert.match(r.reason, /indeterminate/, `reason nomina la causa: ${r.reason}`);
    assert.ok(fs.existsSync(p), 'il pidfile NON si tocca: non sappiamo se sia stale');
    assert.equal(pidOwnership(child.pid), 'owned', 'il legittimo e\' ancora vivo, non toccato');
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// CONTROLLO NEGATIVO OBBLIGATORIO (R-pidfile-2), riscritto per il
// secondo giro. La sonda ORIGINALE dell'auditor (meta senza NESSUN campo,
// pid ereditato, cmd compatibile) rappresentava, senza saperlo, il caso
// LEGACY — e quel caso ora DEVE tornare a segnalare (test sopra), o
// l'aggiornamento automatico si rompe per ogni nodo pre-0.9.4. Riscritta con
// attestation:'indeterminate' esplicito: e' quello il caso che l'intento
// dell'auditor vuole chiuso (un pid ereditato, verificato solo per
// inclusione di stringa, quando l'identita' avrebbe potuto essere provata e
// non lo e' stata) — non "qualunque meta senza nascita", che includerebbe
// anche il legacy onesto. PRIMA (prima del fix): segnala. DOPO: rifiuta.
test('AUDITOR negativo: pid ereditato + cmd compatibile + attestazione TENTATA E FALLITA — PRIMA segnalava, ORA no', () => {
  const p = tmpPid();
  fs.writeFileSync(p, `${JSON.stringify({ pid: 424242, cmd: 'node same-command', attestation: 'indeterminate' })}\n`);
  const segnali = [];
  const killImpl = (pid, signal) => { segnali.push([pid, signal]); }; // non lancia mai: ownership 'owned'
  const r = killPidfile(p, 'SIGTERM', {
    killImpl,
    readCmdlineImpl: () => 'node same-command',
    readProcessStartImpl: () => null,
  });
  assert.equal(r.killed, false, 'pid ereditato, cmd compatibile, attestazione tentata e fallita: NON si segnala');
  assert.deepEqual(segnali, [[424242, 0]], 'solo la probe di ownership: nessun SIGTERM verso il riusato');
  assert.ok(fs.existsSync(p), 'il pidfile non verificabile non si tocca: non sappiamo se sia stale');
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

// unsupported: DICHIARATO alla creazione (probeProcessStart, non ricalcolato
// al kill). Qui la piattaforma non sa attestare per davvero (mock: ne' proc
// ne' ps rispondono) e il kill ricade sul cmd — ma lo DICE nel risultato,
// distinto da 'ambiguous-compat' (stesso comportamento, causa diversa: qui è
// un fatto sulla piattaforma, verificato a ogni scrittura; lì è solo
// l'assenza di un marker per questa installazione).
test('killPidfile: unsupported dichiarato alla creazione ricade sul cmd, ma lo dichiara nel risultato', async () => {
  const child = figlioCheTieneIlNumero();
  await figlioPronto(child);
  const p = tmpPid();
  try {
    const cmdVivo = readCmdline(child.pid);
    fs.writeFileSync(p, `${JSON.stringify({ pid: child.pid, cmd: cmdVivo, attestation: 'unsupported', uid: currentUid() })}\n`);
    const r = killPidfile(p, 'SIGTERM');
    assert.equal(r.killed, true, 'unsupported dichiarato: il kill verificato via cmd resta possibile (Termux non si spegne)');
    assert.equal(r.unverifiedBirth, 'unsupported', 'dichiarato, e distinguibile da \'ambiguous-compat\'');
    await aspettaExit(child);
  } finally {
    child.kill('SIGKILL');
    await aspettaExit(child);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

// probeProcessStart: 'unsupported' e' una congiunzione (proc E ps ENTRAMBI
// strutturalmente impossibili), non "il tentativo e' fallito". Su questa
// macchina ne' /proc ne' ps sono strutturalmente assenti: un pid che
// semplicemente non esiste fallisce comunque, ma per un motivo che riguarda
// SOLO quel pid — mai unsupported, sempre indeterminate. E' la distinzione
// che l'audit ha chiesto: non "ha fallito?" ma "perche'?".
test('probeProcessStart: pid inesistente su una macchina normale e\' indeterminate, mai unsupported', () => {
  const pidInesistente = 999999;
  const { value, cause } = probeProcessStart(pidInesistente);
  assert.equal(value, null);
  assert.equal(cause, 'indeterminate',
    'ne\' /proc ne\' ps sono strutturalmente assenti qui: non e\' un fatto sulla piattaforma');
});

test('probeProcessStart: il nostro pid, sempre leggibile qui, attesta', () => {
  const { value, cause } = probeProcessStart(process.pid);
  assert.ok(value, 'su questa macchina /proc esiste: il probe sul nostro pid attesta');
  assert.equal(cause, null);
});

// Nascita attestata ma non rileggibile: l'identita' non e' verificabile e il
// segnale NON parte. Trovato dall'audit su codice gia' pubblicato: il ramo
// esisteva e proseguiva sul solo cmd, che matcha per inclusioni. La finestra
// qui non e' di microsecondi come il TOCTOU: dura quanto /proc resta illeggibile.
test('killPidfile: nascita attestata e ora illeggibile => rinuncia, nessun segnale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pid-unver-'));
  const p = path.join(dir, 'x.pid');
  fs.writeFileSync(p, JSON.stringify({
    pid: 424242, cmd: process.argv.join(' '), processStart: '99999',
  }));
  const segnali = [];
  const out = killPidfile(p, 'SIGTERM', {
    killImpl: (pid, sig) => { segnali.push(sig); },
    readCmdlineImpl: () => process.argv.join(' '),
    readProcessStartImpl: () => null,
  });
  assert.equal(out.killed, false, 'con nascita non riverificabile non si segnala');
  assert.match(String(out.reason), /unverifiable/);
  assert.deepEqual(segnali.filter((s) => s && s !== 0), [],
    'nessun segnale distruttivo deve essere partito');
  assert.ok(fs.existsSync(p), 'il pidfile resta: non sappiamo se sia stale');
  fs.rmSync(dir, { recursive: true, force: true });
});
