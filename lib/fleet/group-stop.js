'use strict';
// Fase di stop del gruppo.
//
// Il coordinatore e' un membro vivo del proprio gruppo. Su {op:'stop'} congela
// i respawn, chiude la delivery, e solo dopo segnala con kill(0, signal): il
// kernel sceglie il gruppo del chiamante. Nessun pid e nessun killpg.
// Il TERM durante la grazia e' un handler vuoto in questo processo, non una
// maschera: un figlio nato dopo continua a ricevere SIGTERM.
// pidfd non e' in questo strato: i conteggi vengono dagli exit e, in
// produzione, da una lettura limitata di /proc. Senza traccia completa la
// qualita' resta ignoti e l'esito non diventa pulito — a meno dell'ATTESTAZIONE:
// uscita del supervisore provata e sessione assente osservata DOPO la prova
// sul canale posseduto del lancio (due prove che non enumerano /proc).

const crypto = require('node:crypto');
const fs = require('node:fs');
const { creaDedup } = require('./control-protocol.js');

const CAP_SCAN = 256;

function killGruppoCorrente(signal) {
  process.kill(0, signal);
}

// Un solo parser per lo stat: numero di gruppo (campo 5) e NASCITA (campo 22)
// escono dalla stessa lettura, cosi' l'identita' che si confronta dopo e'
// quella del MEDESIMO processo e non di un pid omonimo. `comm` (campo 2) puo'
// contenere spazi e parentesi: si riparte dall'ULTIMA ')', e senza quel
// delimitatore non si legge una coda a caso.
//   { esito: 'assente', pgrp: 0 }              /proc/<pid> non esiste (ENOENT):
//                                             assenza ACCERTATA del numero;
//   { esito: 'presente', pgrp, nascita }      il processo c'e'; la nascita e'
//                                             null quando il token manca o non
//                                             e' un intero nel dominio: il
//                                             processo c'e' ma non e'
//                                             identificabile;
//   { esito: 'indeterminata', pgrp: null }    EACCES, EIO, stat corrotto, pgrp
//                                             fuori dominio: non e' una prova.
function leggiStatoDa(procRoot, pid) {
  let stat;
  try {
    stat = fs.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { esito: 'assente', pgrp: 0, nascita: null };
    return { esito: 'indeterminata', pgrp: null, nascita: null };
  }
  if (typeof stat !== 'string' || stat.length === 0) return { esito: 'indeterminata', pgrp: null, nascita: null };
  const fine = stat.lastIndexOf(')');
  if (fine < 0) return { esito: 'indeterminata', pgrp: null, nascita: null };
  const campi = stat.slice(fine + 2).trim().split(/\s+/);
  const pgrp = Number(campi[2]);
  // pgrp 0 e' un valore VALIDO e noto: i thread del kernel non appartengono a
  // nessun gruppo. Trattarlo come «illeggibile» rendeva `ignoti` ogni
  // censimento su un /proc reale (ci sono sempre kthread visibili), cioe' il
  // pulito non era dichiarabile per costruzione. Resta indeterminato solo un
  // token non numerico o negativo.
  if (!Number.isSafeInteger(pgrp) || pgrp < 0) return { esito: 'indeterminata', pgrp: null, nascita: null };
  const nascita = Number(campi[19]);
  return {
    esito: 'presente',
    pgrp,
    // Stato del processo (campo 3): distingue un processo capace di eseguire
    // da uno uscito e non ancora raccolto (Z/X). Solo il primo e' un residuo.
    stato: typeof campi[0] === 'string' && campi[0] ? campi[0] : null,
    nascita: Number.isSafeInteger(nascita) && nascita >= 0 ? nascita : null,
  };
}

function leggiPgrpDa(procRoot, pid) {
  const stato = leggiStatoDa(procRoot, pid);
  if (stato.esito === 'assente') return 0;
  return stato.esito === 'presente' ? stato.pgrp : null;
}

function leggiPgrp(pid) {
  return leggiPgrpDa('/proc', pid);
}

function leggiIdentitaDa(procRoot, pid) {
  return leggiStatoDa(procRoot, pid);
}

// Variante asincrona dello stesso parser, per il censimento a tempo: una
// lettura bloccata non deve fermare il processo che tiene il lease.
async function leggiStatoAsyncDa(procRoot, pid, leggiStat, signal) {
  let stat;
  try {
    stat = await leggiStat(`${procRoot}/${pid}/stat`, signal ? { signal } : undefined);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { esito: 'assente', pgrp: 0, nascita: null };
    return { esito: 'indeterminata', pgrp: null, nascita: null };
  }
  if (typeof stat !== 'string' || stat.length === 0) return { esito: 'indeterminata', pgrp: null, nascita: null };
  const fine = stat.lastIndexOf(')');
  if (fine < 0) return { esito: 'indeterminata', pgrp: null, nascita: null };
  const campi = stat.slice(fine + 2).trim().split(/\s+/);
  const pgrp = Number(campi[2]);
  // pgrp 0 e' un valore VALIDO e noto: i thread del kernel non appartengono a
  // nessun gruppo. Trattarlo come «illeggibile» rendeva `ignoti` ogni
  // censimento su un /proc reale (ci sono sempre kthread visibili), cioe' il
  // pulito non era dichiarabile per costruzione. Resta indeterminato solo un
  // token non numerico o negativo.
  if (!Number.isSafeInteger(pgrp) || pgrp < 0) return { esito: 'indeterminata', pgrp: null, nascita: null };
  const nascita = Number(campi[19]);
  return {
    esito: 'presente',
    pgrp,
    // Stato del processo (campo 3): distingue un processo capace di eseguire
    // da uno uscito e non ancora raccolto (Z/X). Solo il primo e' un residuo.
    stato: typeof campi[0] === 'string' && campi[0] ? campi[0] : null,
    nascita: Number.isSafeInteger(nascita) && nascita >= 0 ? nascita : null,
  };
}

// `procRoot` e' il SEAM di test: la produzione legge sempre /proc con il
// tetto di scansione di prodotto (CAP_SCAN). Una directory sintetica con
// piu' voci del tetto forza il regime «affollato» senza generare processi
// veri; i default restano esattamente quelli di produzione.
function osservaProduzione(noti, pgrpTarget = null, { procRoot = '/proc', cap = CAP_SCAN } = {}) {
  const root = typeof procRoot === 'string' && procRoot ? procRoot : '/proc';
  const tetto = Number.isSafeInteger(cap) && cap >= 0 ? cap : CAP_SCAN;
  const mio = pgrpTarget != null ? pgrpTarget : leggiPgrpDa(root, process.pid);
  if (!mio) return { inGruppo: 0, fuoriGruppo: 0, qualita: 'ignoti' };
  let inGruppo = 0;
  let fuoriGruppo = 0;
  let ignoti = 0;
  const visti = new Set([process.pid]);
  const lista = Array.isArray(noti) ? noti : [];
  for (const membro of lista) {
    if (!membro || !membro.pid || membro.exited) continue;
    visti.add(membro.pid);
    const gruppo = leggiPgrpDa(root, membro.pid);
    if (gruppo === 0) continue;
    if (gruppo == null) { ignoti += 1; continue; }
    if (gruppo === mio) inGruppo += 1;
    else fuoriGruppo += 1;
  }
  let nomi;
  try { nomi = fs.readdirSync(root); } catch (_) {
    return { inGruppo, fuoriGruppo, qualita: 'ignoti' };
  }
  let letti = 0;
  for (const nome of nomi) {
    if (letti >= tetto) return { inGruppo, fuoriGruppo, qualita: 'almeno' };
    if (!/^[0-9]+$/.test(nome)) continue;
    letti += 1;
    const pid = Number(nome);
    if (visti.has(pid)) continue;
    const gruppo = leggiPgrpDa(root, pid);
    if (gruppo === 0) continue;
    if (gruppo == null) { ignoti += 1; continue; }
    if (gruppo === mio) { inGruppo += 1; visti.add(pid); }
  }
  if (ignoti > 0) return { inGruppo, fuoriGruppo, qualita: 'ignoti' };
  return { inGruppo, fuoriGruppo, qualita: 'noti' };
}

// ---------------------------------------------------------------------------
// SONDA DEL GRUPPO — `kill(-pgrp, 0)`.
//
// Dopo l'uscita PROVATA del supervisore il demone non e' piu' membro del
// gruppo: la domanda «il gruppo e' vuoto?» ha una risposta diretta dal kernel,
// O(1), senza enumerare /proc. Il segnale ZERO e' fissato qui dentro e non e'
// un parametro: questo helper non recapita nulla a nessuno. Non e' la
// scansione generica e non ne eredita il tetto sulle voci, che su un nodo
// carico taglia proprio i membri del gruppo (i pid piu' alti).
//
// Guardie, tutte obbligatorie perche' un `-pgrp` sbagliato e' pericoloso:
//   * solo un intero sicuro > 1 (mai 0, 1, negativi, NaN, stringhe);
//   * il gruppo PROPRIO del demone deve essere noto in positivo e diverso:
//     se non si legge, o coincide, la sonda non parte;
//   * l'identita' del capogruppo (nascita) deve essere stata catturata PRIMA
//     dello stop: senza, non si distingue il gruppo originale da un numero
//     riusato e la sonda non parte.
//
// Esiti: ESRCH -> gruppo vuoto al momento della sonda (`noti`, zero);
// successo -> almeno un membro, mai un censimento esatto (`almeno`); EPERM ->
// almeno un membro che non possiamo segnalare, mai pulito (`almeno`); ogni
// altro errore -> `ignoti`. Nessun messaggio d'errore entra nel record.
const SEGNALE_SONDA = 0;
const CONTI_IGNOTI = 'ignoti';

function contiIgnoti() {
  return { inGruppo: 0, fuoriGruppo: 0, qualita: CONTI_IGNOTI };
}

// Reasons the post-exit probe can fail to decide. Closed list: the down
// refusal carries no free text, and an unknown value never reaches the data.
const MOTIVI_SONDA = Object.freeze([
  'argomenti', 'gruppo-proprio', 'identita', 'riuso', 'errore', 'scaduta', 'sonda',
]);
function motivoSondaBounded(v) {
  return typeof v === 'string' && MOTIVI_SONDA.includes(v) ? v : null;
}

// The only proof of an empty group this module accepts is ESRCH. A PGID kept
// alive by an unreaped zombie does NOT become empty by waiting: the census
// counts the executables (zombies excluded) and, when nothing is left to run,
// the count is conclusive with the zombie beside it (`killed-zombie-held`).
// `SONDA_RIPROVA_*` used here for a 1.5 s repeat of the same probe: removed,
// because it only held the down open (the pane teardown releases the zombie).

// Il segnale 0 esiste in UNA sola riga del prodotto, qui: nessun chiamante lo
// sceglie e nessun altro percorso lo passa alla sonda.
function inviaSegnaleZeroReale(gruppo) {
  return process.kill(-gruppo, SEGNALE_SONDA);
}

function sondaGruppo({
  pgrp,
  identita,
  procRoot = '/proc',
  inviaSegnaleZero: sonda = inviaSegnaleZeroReale,
  leggiIdentita,
} = {}) {
  // `motivo` e' l'AUTOREVOLEZZA della risposta e viaggia fino alla decisione
  // finale: un EPERM non e' un successo, e un capo vivo non e' un censimento.
  // Chi decide non deve ricostruirlo dal solo `qualita`, o un rifiuto torna a
  // sembrare una prova.
  const conMotivo = (foto, motivo) => ({ ...foto, motivo });
  if (!Number.isSafeInteger(pgrp) || pgrp <= 1) return conMotivo(contiIgnoti(), 'argomenti');
  const leggiId = typeof leggiIdentita === 'function'
    ? leggiIdentita
    : (pid) => leggiIdentitaDa(procRoot, pid);
  // «Gruppo proprio non leggibile» non si indovina: senza un positivo non c'e'
  // modo di escludere di stare per sondare il gruppo in cui gira il demone.
  const mio = leggiPgrpDa(procRoot, process.pid);
  if (!Number.isSafeInteger(mio) || mio <= 1 || mio === pgrp) return conMotivo(contiIgnoti(), 'gruppo-proprio');
  const nascita = identita && Number.isSafeInteger(identita.nascita) && identita.nascita >= 0
    ? identita.nascita : null;
  if (nascita == null) return conMotivo(contiIgnoti(), 'identita');
  const stato = leggiId(pgrp);
  if (!stato || (stato.esito !== 'presente' && stato.esito !== 'assente')) return conMotivo(contiIgnoti(), 'identita');
  if (stato.esito === 'presente') {
    // Il numero e' ancora occupato: e' lo stesso processo solo se la nascita
    // coincide. Con un riuso il giudizio e' conservativo: nessuna sonda, nessun
    // conteggio, e nessuna azione correttiva sul nuovo gruppo.
    if (stato.nascita !== nascita) return conMotivo(contiIgnoti(), 'riuso');
    // Capo vivo e identificato (stato diverso da Z/X): residuo CERTO, senza
    // sondare. Un capo Z/X invece e' uscito e non raccolto: tiene vivo il PGID
    // ma non e' un residuo, e non dice nulla sui figli — per quello servono la
    // sonda e poi il censimento.
    if (stato.stato !== 'Z' && stato.stato !== 'X') {
      return conMotivo({ inGruppo: 1, fuoriGruppo: 0, qualita: 'almeno' }, 'capo-vivo');
    }
  }
  try {
    sonda(pgrp);
    return conMotivo({ inGruppo: 1, fuoriGruppo: 0, qualita: 'almeno' }, 'successo');
  } catch (e) {
    const codice = e && e.code;
    if (codice === 'ESRCH') return conMotivo({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }, 'esrch');
    if (codice === 'EPERM') return conMotivo({ inGruppo: 1, fuoriGruppo: 0, qualita: 'almeno' }, 'eperm');
    return conMotivo(contiIgnoti(), 'errore');
  }
}

// ---------------------------------------------------------------------------
// CENSIMENTO A TEMPO (lato supervisore).
//
// Stessa domanda della scansione generica — chi e' ancora nel gruppo? — ma con
// un tetto al TEMPO invece che al numero di voci: su un nodo carico il tetto
// sul numero non arriva mai in fondo e non dichiara mai il gruppo vuoto,
// proprio perche' i membri del gruppo hanno i pid piu' alti. Il budget e'
// MONOTONO e condiviso da enumerazione, membri noti, letture e yield: non si
// rinnova a ogni blocco ne' a ogni giro. L'I/O e' asincrono e a concorrenza
// limitata: un `readFileSync` bloccato non diventa bounded perche' ogni tanto
// si cede il turno, e il supervisore deve restare vivo (lease, cuore) mentre
// enumera. Una scansione interrotta non da' mai `noti`; EACCES, stat corrotto o
// enumerazione negata non diventano zero.
const LOTTO_SCAN = 32;
const SENTINELLA_SCADUTO = Symbol('budget-scaduto');

// Un budget che scade deve anche CANCELLARE il lavoro, non solo smettere di
// aspettarlo: il segnale viaggia fino alle letture che lo supportano e, alla
// chiusura, nessuna lettura resta appesa a produrre un risultato che nessuno
// usera' piu'. Un singolo I/O di sistema gia' entrato nel kernel non e'
// interrompibile: la promessa di quiete vale per le operazioni annullabili e
// per il fatto che non se ne avviano altre, non per una syscall in corso.
function entroBudget(lavoro, limite, monoNow) {
  const resta = limite - monoNow();
  if (!Number.isFinite(resta) || resta <= 0) return Promise.resolve(SENTINELLA_SCADUTO);
  const controllo = new AbortController();
  let timer = null;
  const lavoroP = Promise.resolve().then(() => lavoro(controllo.signal));
  // Il ramo che perde la race non deve diventare un rifiuto non gestito
  // quando l'abort lo fa fallire dopo la chiusura.
  lavoroP.catch(() => {});
  return Promise.race([
    lavoroP,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        try { controllo.abort(); } catch (_) {}
        resolve(SENTINELLA_SCADUTO);
      }, Math.max(1, resta));
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
    try { controllo.abort(); } catch (_) {}
  });
}

async function osservaProduzioneLimitata({
  noti = null,
  pgrpTarget = null,
  procRoot = '/proc',
  limite,
  monoNow = () => Date.now(),
  pausa = ({ signal } = {}) => new Promise((resolve, reject) => {
    const t = setImmediate(resolve);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearImmediate(t);
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      }, { once: true });
    }
  }),
  concorrenza = LOTTO_SCAN,
  leggiStat = (percorso, opts) => fs.promises.readFile(
    percorso, opts && opts.signal ? { encoding: 'utf8', signal: opts.signal } : 'utf8',
  ),
  leggiDir = (percorso, opts) => fs.promises.readdir(
    percorso, opts && opts.signal ? { signal: opts.signal } : undefined,
  ),
  escludiZombie = false,
} = {}) {
  // `inGruppo` conta i membri CAPACI DI ESEGUIRE quando `escludiZombie`:
  // Z/X letti davvero non contano come residui, ma restano contati a parte in
  // `zombie` — serve a distinguere «il gruppo e' vuoto» da «la mia vista non
  // lo vede». Stato mancante, corrotto o negato non si esclude mai.
  let zombie = 0;
  // `noti === null` = elenco NON disponibile; un array (anche vuoto) = elenco
  // completo dei membri del lancio. Solo col secondo `fuoriGruppo` e' una
  // prova: chi esce dal gruppo (setsid) non si vede nell'enumerazione generica.
  const elenco = Array.isArray(noti) ? noti : null;
  const conti = (inGruppo, fuoriGruppo, qualita) => ({
    inGruppo, fuoriGruppo, qualita,
    ...(escludiZombie ? { zombie, fuoriGruppoNoto: elenco !== null } : {}),
  });
  const ignoto = conti(0, 0, 'ignoti');
  if (!Number.isFinite(limite)) return ignoto;
  const scaduto = () => !(monoNow() < limite);
  if (scaduto()) return ignoto;
  const root = typeof procRoot === 'string' && procRoot ? procRoot : '/proc';
  const tettoLotto = Number.isSafeInteger(concorrenza) && concorrenza > 0 ? concorrenza : LOTTO_SCAN;

  let mio = pgrpTarget;
  if (mio == null) {
    let esito;
    try {
      esito = await entroBudget((signal) => leggiStatoAsyncDa(root, process.pid, leggiStat, signal), limite, monoNow);
    } catch (_) { return ignoto; }
    if (esito === SENTINELLA_SCADUTO) return ignoto;
    if (!esito || esito.esito !== 'presente') return ignoto;
    mio = esito.pgrp;
  }
  if (!Number.isSafeInteger(mio) || mio <= 0) return ignoto;

  let nomi;
  try {
    nomi = await entroBudget((signal) => leggiDir(root, { signal }), limite, monoNow);
  } catch (_) { return ignoto; }
  if (nomi === SENTINELLA_SCADUTO) return conti(0, 0, 'almeno');
  if (!Array.isArray(nomi)) return ignoto;

  let inGruppo = 0;
  let fuoriGruppo = 0;
  let ignoti = 0;
  const visti = new Set([process.pid]);
  for (const membro of elenco || []) {
    if (!membro || !membro.pid || membro.exited) continue;
    let stato;
    try {
      stato = await entroBudget((signal) => leggiStatoAsyncDa(root, membro.pid, leggiStat, signal), limite, monoNow);
    } catch (_) { stato = null; }
    if (stato === SENTINELLA_SCADUTO) return conti(inGruppo, fuoriGruppo, 'almeno');
    if (!stato || stato.esito === 'assente') continue;
    if (stato.esito !== 'presente') { ignoti += 1; continue; }
    // Identita': un pid riusato da un ALTRO processo non e' un membro del
    // lancio. Resta fuori da `visti`, cosi' l'enumerazione generica lo vede.
    if (Number.isSafeInteger(membro.nascita) && Number.isSafeInteger(stato.nascita)
      && membro.nascita !== stato.nascita) continue;
    visti.add(membro.pid);
    if (escludiZombie && (stato.stato === 'Z' || stato.stato === 'X')) zombie += 1;
    else if (stato.pgrp === mio) inGruppo += 1;
    else fuoriGruppo += 1;
  }

  const pids = [];
  for (const nome of nomi) {
    if (!/^[0-9]+$/.test(nome)) continue;
    const pid = Number(nome);
    if (visti.has(pid)) continue;
    pids.push(pid);
  }
  for (let i = 0; i < pids.length; i += tettoLotto) {
    if (scaduto()) return conti(inGruppo, fuoriGruppo, ignoti > 0 ? 'ignoti' : 'almeno');
    const lotto = pids.slice(i, i + tettoLotto);
    let letti;
    try {
      letti = await entroBudget(
        (signal) => Promise.all(lotto.map((pid) => leggiStatoAsyncDa(root, pid, leggiStat, signal))),
        limite, monoNow,
      );
    } catch (_) { return conti(inGruppo, fuoriGruppo, 'ignoti'); }
    if (letti === SENTINELLA_SCADUTO) {
      return conti(inGruppo, fuoriGruppo, ignoti > 0 ? 'ignoti' : 'almeno');
    }
    for (let k = 0; k < lotto.length; k += 1) {
      const stato = letti[k];
      if (!stato || stato.esito === 'assente') continue;
      if (stato.esito !== 'presente') { ignoti += 1; continue; }
      if (stato.pgrp !== mio) continue;
      if (escludiZombie && (stato.stato === 'Z' || stato.stato === 'X')) zombie += 1;
      else inGruppo += 1;
    }
    // Il turno si cede DENTRO il budget: se non c'e' piu' tempo non si aspetta
    // un'altra schedulazione, si chiude con `almeno`.
    let turno;
    try { turno = await entroBudget((signal) => pausa({ signal }), limite, monoNow); } catch (_) { turno = SENTINELLA_SCADUTO; }
    if (turno === SENTINELLA_SCADUTO) {
      return conti(inGruppo, fuoriGruppo, ignoti > 0 ? 'ignoti' : 'almeno');
    }
  }
  if (ignoti > 0) return conti(inGruppo, fuoriGruppo, 'ignoti');
  return conti(inGruppo, fuoriGruppo, 'noti');
}

// ---------------------------------------------------------------------------
// OSSERVAZIONE DOPO L'USCITA PROVATA (lato demone).
//
// Tre passi, tutti nello stesso residuo della deadline monotona originale:
//   1. sonda: ESRCH qualificato = il kernel non ha piu' quel PGID (percorso
//      rapido, nessuna enumerazione);
//   2. sonda positiva = il PGID esiste ancora, ma puo' essere tenuto da un
//      processo uscito e non raccolto: breve retry, perche' il padre puo'
//      raccoglierlo fra un istante. Il retry non e' una prova di vuoto e non
//      consuma tutto il tempo del censimento;
//   3. censimento cooperativo a tempo che conta solo i membri con stato NON
//      Z/X effettivamente letto. `noti/0` vale solo a enumerazione completata
//      E con gli zombie visti: se la sonda sentiva un membro e il censimento
//      non ne vede nessuno, la vista e' ristretta e la risposta e' `ignoti`,
//      mai un pulito.
const RIPROVA_MAX = 4;
const RIPROVA_FRAZIONE = 0.25;
const RIPROVA_MAX_MS = 250;
const RIPROVA_MIN_MS = 5;

async function osservaGruppoDopoUscita({
  pgrp,
  identita,
  deadlineAt,
  noti = null,
  monoNow = () => Date.now(),
  procRoot = '/proc',
  inviaSegnaleZero,
  leggiIdentita,
  attesa,
  leggiStat,
  leggiDir,
  pausa,
  concorrenza,
} = {}) {
  // The probe is the AUTHORITY: only ESRCH says the kernel no longer has that
  // PGID. Success, EPERM and a live leader say the group exists — never that
  // it is empty, and a census that sees only zombies is a partial view that
  // never promotes to clean. `motivo` travels with the unknown reading so the
  // caller can say WHICH proof was missing (additive: no outcome changes).
  const ignoto = (motivo, tentativi, msRipetizione) => {
    const m = motivoSondaBounded(motivo);
    if (!m) return contiIgnoti();
    const out = { ...contiIgnoti(), motivo: m };
    if (Number.isSafeInteger(tentativi) && tentativi > 0) out.tentativi = tentativi;
    if (Number.isSafeInteger(msRipetizione) && msRipetizione > 0) out.msRipetizione = Math.round(msRipetizione);
    return out;
  };
  if (!Number.isFinite(deadlineAt)) return ignoto('scaduta');
  if (!(monoNow() < deadlineAt)) return ignoto('scaduta');
  const sonda = () => sondaGruppo({
    pgrp, identita, procRoot,
    ...(inviaSegnaleZero ? { inviaSegnaleZero } : {}),
    ...(leggiIdentita ? { leggiIdentita } : {}),
  });
  // La sonda e' l'AUTORITA': solo ESRCH dice che il kernel non ha piu' quel
  // PGID. Successo, EPERM e capo vivo dicono che il gruppo esiste — mai che
  // sia vuoto. Un censimento che vede solo zombie non prova l'assenza degli
  // altri membri (vista parziale), quindi non promuove mai a pulito.
  const decidi = (foto) => {
    // Un capo letto VIVO e' un positivo di vitalita': nessuna enumerazione
    // successiva puo' trasformarlo in una chiusura (vedi la promozione).
    if (foto.motivo === 'capo-vivo') capoVivo = true;
    if (foto.motivo === 'esrch') return { esito: 'pulito' };
    if (foto.motivo === 'eperm') return { esito: 'eperm' };
    if (foto.motivo === 'successo' || foto.motivo === 'capo-vivo') return { esito: 'positivo' };
    return { esito: 'ignoto' };
  };
  let foto = sonda();
  let capoVivo = false;
  let d = decidi(foto);
  if (d.esito === 'pulito') return { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' };
  if (d.esito === 'ignoto') return ignoto(foto.motivo);
  if (d.esito === 'eperm') return { inGruppo: 1, fuoriGruppo: 0, qualita: 'almeno' };
  const dormi = typeof attesa === 'function'
    ? attesa
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const residuo = deadlineAt - monoNow();
  const tetto = Math.min(
    deadlineAt,
    monoNow() + Math.min(RIPROVA_MAX_MS, Math.max(RIPROVA_MIN_MS, residuo * RIPROVA_FRAZIONE)),
  );
  for (let i = 1; i < RIPROVA_MAX && monoNow() < tetto; i += 1) {
    const resta = tetto - monoNow();
    if (!(resta > 0)) break;
    try { await dormi(Math.min(25, resta)); } catch (_) { break; }
    if (!(monoNow() < deadlineAt)) return { inGruppo: 0, fuoriGruppo: 0, qualita: 'almeno' };
    foto = sonda();
    d = decidi(foto);
    if (d.esito === 'pulito') return { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' };
    if (d.esito === 'ignoto') return ignoto(foto.motivo);
    if (d.esito === 'eperm') return { inGruppo: 1, fuoriGruppo: 0, qualita: 'almeno' };
  }
  // Censimento: solo per CONTARE i residui eseguibili. Non dichiara mai il
  // vuoto: la sonda e' ancora positiva e non e' mai arrivata a ESRCH.
  const censimento = () => osservaProduzioneLimitata({
    pgrpTarget: pgrp,
    procRoot,
    limite: deadlineAt,
    monoNow,
    escludiZombie: true,
    noti,
    ...(leggiStat ? { leggiStat } : {}),
    ...(leggiDir ? { leggiDir } : {}),
    ...(pausa ? { pausa } : {}),
    ...(concorrenza ? { concorrenza } : {}),
  });
  const positivo = (c) => ({ inGruppo: c.inGruppo, fuoriGruppo: c.fuoriGruppo, qualita: 'almeno' });
  // Zero eseguibili e almeno uno zombie, con un censimento COMPLETO e con
  // l'elenco dei membri noti disponibile: e' un conteggio conclusivo, perche'
  // aspettare un ESRCH che non puo' arrivare (il pane vivo tiene lo zombie)
  // teneva solo il down aperto. Senza elenco dei noti `fuoriGruppo` non e'
  // una prova e non si promuove.
  const conclusivo = (c) => !!c && c.qualita === 'noti' && c.inGruppo === 0 && c.fuoriGruppo === 0
    && c.fuoriGruppoNoto === true && (c.zombie || 0) > 0;
  const primo = await censimento();
  if (primo.inGruppo > 0 || primo.fuoriGruppo > 0) return positivo(primo);
  // Una sola enumerazione di /proc non e' una fotografia: fra una lettura e la
  // successiva un membro puo' generare un figlio e uscire. Servono DUE
  // censimenti completi a ~100 ms, entrambi a zero eseguibili, e almeno uno
  // zombie. Finestra residua DICHIARATA: fra il secondo censimento e il
  // teardown resta la stessa corsa, solo piu' stretta — nessuna atomicita'.
  const INTERVALLO_CENSIMENTI_MS = 100;
  if (!capoVivo && conclusivo(primo) && monoNow() + INTERVALLO_CENSIMENTI_MS < deadlineAt) {
    try { await dormi(INTERVALLO_CENSIMENTI_MS); } catch (_) { /* budget */ }
    const secondo = await censimento();
    if (secondo.inGruppo > 0 || secondo.fuoriGruppo > 0) return positivo(secondo);
    if (conclusivo(secondo)) {
      return {
        inGruppo: 0, fuoriGruppo: 0, qualita: 'noti',
        zombie: Math.max(primo.zombie, secondo.zombie),
      };
    }
  }
  // Un capo letto VIVO resta un positivo di vitalita': bloccante. Il fatto che
  // un censimento successivo non lo veda piu' non lo trasforma in una chiusura.
  if (capoVivo) return { inGruppo: 1, fuoriGruppo: 0, qualita: 'almeno' };
  return ignoto('sonda');
}

function idRichiesta() {
  return crypto.randomBytes(8).toString('hex');
}

function deadlineMsDi(payload) {
  const n = payload && payload.deadlineMs;
  if (!Number.isSafeInteger(n) || n < 1 || n > 60000) return 2000;
  return n;
}

function normalizzaConti(conti) {
  if (!conti || typeof conti !== 'object' || Array.isArray(conti)) return null;
  const intero = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000;
  if (!intero(conti.inGruppo) || !intero(conti.fuoriGruppo)) return null;
  if (conti.qualita !== 'noti' && conti.qualita !== 'almeno' && conti.qualita !== 'ignoti') return null;
  const out = { inGruppo: conti.inGruppo, fuoriGruppo: conti.fuoriGruppo, qualita: conti.qualita };
  // Additive: how many times the post-exit probe repeated and how long it
  // spent. They ride beside the counts and never take part in a decision.
  if (intero(conti.tentativi)) out.tentativi = conti.tentativi;
  if (intero(conti.msRipetizione)) out.msRipetizione = conti.msRipetizione;
  // Additive: how many members were seen as zombies (excluded from the
  // executable count). It is what distinguishes "the group is empty" from "the
  // group still holds an unreaped child", and it travels with the counts.
  if (intero(conti.zombie)) out.zombie = conti.zombie;
  return out;
}

function gruppoVuoto(foto) {
  // Un membro FUORI dal gruppo del supervisore non e' meno vivo di uno
  // dentro: il client interattivo su pty si mette in un gruppo proprio, e
  // dichiarare vuoto il gruppo mentre quel figlio e' ancora vivo era il
  // difetto (il pronto arrivava, il supervisore usciva, il figlio restava).
  return !!foto && foto.inGruppo === 0 && foto.fuoriGruppo === 0 && foto.qualita === 'noti';
}

function esitoGruppoPulito(outcome) {
  // `killed-zombie-held` is a group with no executable left and at least one
  // unreaped child: the kernel has not confirmed the PGID is gone, and the
  // outcome says exactly that instead of calling it clean. The teardown still
  // proceeds and closes the pane, which is what releases the zombie.
  return outcome === 'killed-clean' || outcome === 'killed-after-escalation'
    || outcome === 'killed-zombie-held';
}

// Rilascio della lease di CONTROLLO sul ramo «risposta del teardown persa».
// Solo la lease di QUESTO lancio: il canale di controllo e' morto e il demone
// arma una grace che bloccherebbe un up successivo (LEASE_BLOCKS), ma una lease
// di un ALTRO lancio non e' un effetto di questo tentativo e resta al suo
// proprietario. Nessuna primitiva nuova: `controlLaunchId` e `revokeControl`
// sono gia' esposti dal lease manager.
function rilasciaLeaseDelLancio(leaseManager, cellId, launchId) {
  if (!leaseManager || typeof leaseManager !== 'object') return false;
  if (typeof leaseManager.revokeControl !== 'function') return false;
  if (typeof leaseManager.controlLaunchId !== 'function') return false;
  if (typeof launchId !== 'string' || !launchId) return false;
  let corrente = null;
  try { corrente = leaseManager.controlLaunchId(cellId); } catch (_) { return false; }
  if (corrente !== launchId) return false;
  // La lease EFFETTIVA dello stesso lancio si chiude PRIMA della revoca del
  // binding: la revoca azzera `controlLaunchId`, e la transizione condizionata
  // del manager non avrebbe piu' la sua condizione.
  if (typeof leaseManager.rilasciaLeaseDelLancio === 'function') {
    try { leaseManager.rilasciaLeaseDelLancio(cellId, launchId); } catch (_) { /* resta la revoca */ }
  }
  try { leaseManager.revokeControl(cellId); } catch (_) { return false; }
  return true;
}

function osservazioneDopoUscita(v) {
  if (!v || v.uscito !== true) return null;
  return normalizzaConti(v.dopo);
}

function classificaEsito(v) {
  const report = v && v.report;
  // `uscito` e' un FATTO, non un esito: l'uscita del supervisore PROVATA da
  // attendiUscita resta visibile al chiamante anche quando la sessione non
  // e' attestata e il censimento non dichiara. Il down lo usa per il
  // recupero nella stessa chiamata (tre prove in lettura): senza questo bit
  // «uscita provata senza verdetto» e «nessuna prova di uscita» collassano
  // nello stesso stop-unknown. Campo additivo: nessun esito cambia.
  const uscito = v && v.uscito === true ? { uscito: true } : {};
  // L'osservazione dopo l'uscita viaggia con l'esito: e' il dato che dice
  // QUALE prova e' mancata quando il gruppo resta stop-unknown. Additivo.
  const dopo = osservazioneDopoUscita(v);
  if (report && report.code === 'eperm') {
    return { outcome: 'eperm', conti: normalizzaConti(report.conti), ...uscito, dopo };
  }
  // Attestazione: uscita del supervisore PROVATA (attendiUscita) e sessione
  // assente osservata DOPO la prova sul canale posseduto. Sono le due prove
  // che non dipendono dal censimento di /proc: valgono PRIMA dei rami del
  // censimento, che restano per i casi in cui la sessione NON muore col
  // supervisore (window rimasta) e per i percorsi senza seam. `attestato`
  // dice AL CHIAMANTE quale prova ha chiuso: il censimento pulito non lo
  // porta, e senza di lui il down non tratta l'esito come attestato.
  if (v && v.uscito === true && v.sessioneAssente === true) {
    return { outcome: 'killed-clean', conti: null, attestato: true, uscito: true, dopo };
  }
  if (v && v.ready) {
    if (dopo && dopo.inGruppo === 0 && dopo.fuoriGruppo === 0 && dopo.qualita === 'noti') {
      return {
        outcome: dopo.zombie > 0 ? 'killed-zombie-held' : 'killed-clean', conti: dopo, ...uscito, dopo,
      };
    }
    if (dopo && dopo.inGruppo > 0) return { outcome: 'stop-incomplete', conti: dopo, ...uscito, dopo };
    return { outcome: 'stop-unknown', conti: normalizzaConti(v.ready.conti), ...uscito, dopo };
  }
  if (v && v.commit) {
    if (dopo && dopo.inGruppo === 0 && dopo.fuoriGruppo === 0 && dopo.qualita === 'noti') {
      return {
        outcome: dopo.zombie > 0 ? 'killed-zombie-held' : 'killed-after-escalation', conti: dopo, ...uscito, dopo,
      };
    }
    if (dopo && dopo.inGruppo > 0) return { outcome: 'stop-incomplete', conti: dopo, ...uscito, dopo };
    return { outcome: 'stop-unknown', conti: normalizzaConti(v.commit.conti), ...uscito, dopo };
  }
  return { outcome: 'stop-unknown', conti: null, ...uscito, dopo };
}

function codiceEsito(outcome) {
  if (outcome === 'identity-lost') return 'IDENTITY_LOST';
  if (outcome === 'eperm') return 'EPERM';
  if (outcome === 'stop-incomplete') return 'STOP_INCOMPLETE';
  return 'STOP_UNKNOWN';
}

// La lista chiusa delle `reason` che un frame stop può portare nel payload.
// Ogni valore è bounded (<= 32): il ricevente deposita SOLO le parole di
// questa enum, tutto il resto è un frame valido senza reason. Oggi esiste
// il solo motivo del rollback della readiness fallita: il terminale
// del supervisore distingue così il proprio stop correlato dal generico
// 'operator-stop' del SIGHUP legacy.
const RAGIONI_STOP = Object.freeze(['readiness-rollback']);

function ragioneStopValida(reason) {
  return typeof reason === 'string' && reason.length <= 32 && RAGIONI_STOP.includes(reason);
}

async function eseguiFaseStop(ctx) {
  const frame = ctx.frame;
  const monoNow = ctx.monoNow;
  const sleep = ctx.sleep;
  const killGruppo = ctx.killGruppo || killGruppoCorrente;
  const osserva = ctx.osserva;
  const invia = ctx.invia;
  const rawSvuota = ctx.svuota || (async () => true);
  const limite = monoNow() + deadlineMsDi(frame.payload);
  const basePayload = {
    tokenHash: ctx.tokenHash,
    stopRequestId: frame.requestId,
  };
  const svuota = async () => {
    let timer = null;
    try {
      const residuo = Math.max(0, limite - monoNow());
      return await Promise.race([
        Promise.resolve().then(() => rawSvuota()),
        new Promise((r) => { timer = setTimeout(() => r(false), residuo); }),
      ]);
    } catch (_) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (typeof ctx.scriviLog === 'function') ctx.scriviLog('pidfd-hardening-absent');
  invia({
    op: 'stop-ack', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
    payload: basePayload,
  });
  if (typeof ctx.cancellaDelivery === 'function') {
    let timerCancel = null;
    try {
      const residuoCancel = Math.max(0, limite - monoNow());
      await Promise.race([
        Promise.resolve().then(() => ctx.cancellaDelivery()),
        new Promise((r) => { timerCancel = setTimeout(r, residuoCancel); }),
      ]);
    } catch (_) { /* la segnalazione aspetta comunque il settled */ }
    finally {
      if (timerCancel) clearTimeout(timerCancel);
    }
  }
  // OGNI sito di osservazione passa da qui: l'attesa e' bounded dal residuo
  // della stessa deadline (mai rinnovata), un rifiuto o una Promise che non
  // termina valgono `ignoti`, e un'osservazione mancata non produce MAI conti
  // positivi inventati. Il seam riceve la deadline assoluta: la scansione a
  // tempo la usa come proprio budget.
  const osservaBounded = async () => {
    if (typeof osserva !== 'function') return null;
    const resta = limite - monoNow();
    if (!Number.isFinite(resta) || resta <= 0) return contiIgnoti();
    let timer = null;
    try {
      const foto = await Promise.race([
        Promise.resolve().then(() => osserva(limite)),
        new Promise((resolve) => { timer = setTimeout(() => resolve(SENTINELLA_SCADUTO), Math.max(1, resta)); }),
      ]);
      if (foto === SENTINELLA_SCADUTO) return contiIgnoti();
      return normalizzaConti(foto) || contiIgnoti();
    } catch (_) {
      return contiIgnoti();
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (monoNow() >= limite) {
    return { code: 1, outcome: 'stop-unknown', conti: await osservaBounded() };
  }
  let rifiuto = null;
  try { killGruppo('SIGTERM'); } catch (e) { rifiuto = e; }
  if (rifiuto && rifiuto.code === 'EPERM') {
    const conti = await osservaBounded();
    invia({
      op: 'stop-report', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
      payload: { ...basePayload, code: 'eperm', conti },
    });
    await svuota();
    return { code: 1, outcome: 'eperm', conti };
  }
  let foto = await osservaBounded();
  // Il figlio che questo supervisore POSSIEDE puo' essere fuori dal suo
  // gruppo (job control su pty): il segnale al solo gruppo non lo raggiunge.
  // Va fermato sull'oggetto ChildProcess, non su un pid preso da un
  // censimento; TERM con un sotto-budget, poi KILL, e si aspetta l'uscita
  // VERA prima di qualunque dichiarazione. Se non e' dimostrabile uscito, il
  // chiamante riceve una diagnosi e la fase non dichiara pulito.
  if (typeof ctx.fermaFiglioNoto === 'function') {
    const resta = limite - monoNow();
    if (!Number.isFinite(resta) || resta <= 0) {
      const conti = await osservaBounded();
      invia({
        op: 'stop-report', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
        payload: { ...basePayload, code: 'incomplete', conti },
      });
      await svuota();
      return { code: 1, outcome: 'stop-unknown', conti };
    }
    const termMs = Math.max(1, Math.min(resta, Math.floor(resta / 3)));
    let esitoFiglio = null;
    try { esitoFiglio = await ctx.fermaFiglioNoto({ termMs, limiteMono: limite }); } catch (_) { esitoFiglio = null; }
    if (!esitoFiglio || esitoFiglio.uscito !== true) {
      const conti = await osservaBounded();
      const code = esitoFiglio && esitoFiglio.motivo === 'eperm' ? 'eperm' : 'incomplete';
      invia({
        op: 'stop-report', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
        payload: { ...basePayload, code, conti },
      });
      await svuota();
      return { code: 1, outcome: code === 'eperm' ? 'eperm' : 'stop-unknown', conti };
    }
    // Il figlio e' uscito: il censimento si rilegge DOPO, perche' il pronto
    // deve descrivere il residuo reale (nipoti compresi), non la foto di prima.
    foto = await osservaBounded();
  }
  while (monoNow() < limite && !gruppoVuoto(foto)) {
    const resta = limite - monoNow();
    if (resta <= 0) break;
    await sleep(Math.min(50, resta));
    foto = await osservaBounded();
  }
  if (gruppoVuoto(foto)) {
    invia({
      op: 'ready-to-exit', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
      payload: { ...basePayload, conti: foto },
    });
    await svuota();
    return { code: 0, outcome: 'ready-to-exit', conti: foto };
  }
  invia({
    op: 'escalate-commit', requestId: idRichiesta(), launchId: ctx.launchId, epoch: frame.epoch,
    payload: { ...basePayload, conti: foto },
  });
  await svuota();
  if (monoNow() <= limite) {
    try { killGruppo('SIGKILL'); } catch (_) { /* nessun frame dopo il KILL */ }
    return { code: 137, outcome: 'escalate-commit', conti: foto };
  }
  return { code: 1, outcome: 'stop-unknown', conti: foto };
}

function creaCoordinatore(opts) {
  let fase = null;
  let fasePreparazione = null;
  let preparato = false;
  let ultimaEpoca = 0;
  const dedup = creaDedup();
  let stopRichiesto = false;
  // La reason del frame stop ACCETTATO (enum chiusa): il terminale del
  // supervisore la pubblicherà al posto dell'etichetta generica quando il
  // mittente l'ha portata nel payload. Fuori enum o non stringa bounded:
  // il frame resta valido, la reason NON si deposita.
  let motivoStopRegistrato = null;
  let risolve = () => {};
  let risolviStop = null;
  const tokenHash = crypto.createHash('sha256').update(opts.token, 'utf8').digest('hex');
  // One single delivery cancellation per preparation cycle: the first admitted
  // prepare starts it, the retries with a new request id on the same epoch wait
  // for the same settlement and then receive their own correlated ack. The
  // queue is private: the caller has no access to that state.
  let cancellaAssestata = false;
  const preparazioniAttese = [];
  // Cap of the requests that may wait for the shared settlement, coherent with
  // the manager cap: past it a request is dropped, never acknowledged. Requests
  // of an epoch that has been overtaken are discarded when a newer one arrives.
  const MAX_PREPARAZIONI_ATTESE = 64;

  function scartaEpocheSuperate() {
    for (let i = preparazioniAttese.length - 1; i >= 0; i -= 1) {
      if (preparazioniAttese[i].epoch < ultimaEpoca) preparazioniAttese.splice(i, 1);
    }
  }

  function accoda(richiesta) {
    scartaEpocheSuperate();
    if (preparazioniAttese.length >= MAX_PREPARAZIONI_ATTESE) return false;
    preparazioniAttese.push(richiesta);
    return true;
  }

  function attendiSveglia() {
    if (stopRichiesto || preparato) return Promise.resolve();
    return new Promise((resolve) => { risolve = resolve; });
  }

  function attendiStop() {
    if (fase) return Promise.resolve();
    return new Promise((resolve) => { risolviStop = resolve; });
  }

  function emettiPrepareAck(richiesta) {
    opts.invia({
      op: 'prepare-ack',
      requestId: idRichiesta(),
      launchId: opts.launchId,
      epoch: richiesta.epoch,
      // tokenHash: the server admits ONLY frames that prove the token armed at
      // launch time (cell-lease-server handleControlFrame). Without it the
      // prepare-ack was discarded and a preparation without signals never
      // completed while the control channel was connected.
      payload: { stopRequestId: richiesta.requestId, tokenHash },
    });
  }

  // Shared settlement reached: the ack of each admitted request is emitted, but
  // ONLY after rechecking stop, stop phase and current epoch. No ack of a
  // prepare that precedes the stop or an epoch change.
  function assestaPreparazioni() {
    const pendenti = preparazioniAttese.splice(0, preparazioniAttese.length);
    for (const richiesta of pendenti) {
      if (stopRichiesto || fase) return;
      if (richiesta.epoch < ultimaEpoca) continue;
      emettiPrepareAck(richiesta);
    }
  }

  function avviaCancellazione() {
    const fatto = (async () => {
      if (typeof opts.cancellaDelivery === 'function') {
        try { await opts.cancellaDelivery(); } catch (_) { /* settled regardless */ }
      }
      cancellaAssestata = true;
      assestaPreparazioni();
      return { outcome: 'prepared' };
    })();
    fasePreparazione = fatto;
    return fatto;
  }

  function onFrame(frame) {
    if (!frame) return;
    if (frame.op === 'prepare') {
      if (frame.launchId !== opts.launchId) return;
      if (!Number.isSafeInteger(frame.epoch) || frame.epoch < 1) return;
      if (frame.epoch < ultimaEpoca) return;
      // Stop requested or an active stop phase stay a refusal: only the
      // "prepared" half of the old guard is replaced by the idempotent retry,
      // the refusal due to the stop is not.
      if (fase || stopRichiesto) return;
      if (!dedup.nuovo(frame.requestId)) return;
      ultimaEpoca = frame.epoch;
      const richiesta = { requestId: frame.requestId, epoch: frame.epoch };
      if (!preparato) {
        preparato = true;
        opts.disarmaLegacy();
        accoda(richiesta);
        risolve();
        return avviaCancellazione();
      }
      // Valid retry (new request id, current or later epoch): the re-ack is
      // correlated to its own request, without repeating the cancellation
      // already started and without re-arming the legacy path.
      const accodata = accoda(richiesta);
      risolve();
      if (accodata && cancellaAssestata) assestaPreparazioni();
      return fasePreparazione;
    }
    if (frame.op !== 'stop') return;
    if (frame.launchId !== opts.launchId) return;
    if (!Number.isSafeInteger(frame.epoch) || frame.epoch < 1) return;
    if (frame.epoch < ultimaEpoca) return;
    ultimaEpoca = frame.epoch;
    if (fase) return;
    if (!dedup.nuovo(frame.requestId)) return;
    opts.dichiaraStopping();
    opts.disarmaLegacy();
    opts.installaIgnoraTerm();
    stopRichiesto = true;
    // No queued ack survives the stop: the queue is emptied before the phase
    // starts, and the shared cancellation keeps running untouched.
    preparazioniAttese.length = 0;
    // SOLO nel percorso di accettazione (superati launchId, epoca e dedup):
    // una reason fuori enum lascia il frame valido senza reason depositata.
    if (ragioneStopValida(frame.payload && frame.payload.reason)) {
      motivoStopRegistrato = frame.payload.reason;
    }
    fasePreparazione = null;
    fase = eseguiFaseStop({
      frame,
      tokenHash,
      launchId: opts.launchId,
      monoNow: opts.monoNow,
      sleep: opts.sleep,
      killGruppo: opts.killGruppo,
      osserva: opts.osserva,
      invia: opts.invia,
      svuota: opts.svuota,
      cancellaDelivery: opts.cancellaDelivery,
      scriviLog: opts.scriviLog,
      // Il figlio posseduto viaggia fino alla fase: senza questo il seam
      // esisteva solo nei test che chiamano la fase direttamente.
      ...(typeof opts.fermaFiglioNoto === 'function' ? { fermaFiglioNoto: opts.fermaFiglioNoto } : {}),
    }).catch(() => ({ code: 1, outcome: 'stop-unknown' }));
    risolve();
    if (risolviStop) {
      const release = risolviStop;
      risolviStop = null;
      release();
    }
  }

  return {
    onFrame,
    attiva: () => fase || (preparato ? (fasePreparazione || { op: 'prepare' }) : null),
    stopAttivo: () => !!fase,
    preparazione: () => preparato && !fase,
    // La reason del frame stop accettato (o null): il terminale la usa al
    // posto di 'operator-stop' SOLO se il mittente l'ha dichiarata.
    motivoStop: () => motivoStopRegistrato,
    attendiSveglia,
    attendiStop,
  };
}

function attendiPreparazione({
  leaseManager, cellId, launchId, monoNow, deadlineAt,
}) {
  if (!leaseManager
    || typeof leaseManager.controlConnesso !== 'function'
    || typeof leaseManager.sendControl !== 'function'
    || typeof leaseManager.ascoltaControl !== 'function'
    || !leaseManager.controlConnesso(cellId)) {
    return Promise.resolve({ outcome: 'identity-lost' });
  }
  // The prepare-ack cache is consulted BEFORE generating or sending a prepare.
  // A missing method in the old doubles means miss, not error: the historical
  // path stays identical and no hit is invented.
  if (typeof leaseManager.consultaPrepareCache === 'function') {
    let hit = false;
    try {
      hit = leaseManager.consultaPrepareCache(cellId, { launchId, deadlineAt, monoNow }) === true;
    } catch (_) {
      hit = false;
    }
    if (hit) return Promise.resolve({ outcome: 'prepared' });
  }
  const residuo = deadlineAt - monoNow();
  if (!Number.isSafeInteger(residuo) || residuo < 1) {
    return Promise.resolve({ outcome: 'stop-unknown' });
  }
  const requestId = idRichiesta();
  let ack = false;
  let chiuso = false;
  let fine;
  const done = new Promise((resolve) => { fine = resolve; });
  let offFrame = () => {};
  let timer = null;
  const chiudi = () => {
    if (chiuso) return;
    chiuso = true;
    try { offFrame(); } catch (_) {}
    if (timer) clearTimeout(timer);
    fine();
  };
  offFrame = leaseManager.ascoltaControl((id, frame) => {
    if (id !== cellId || !frame) return;
    const rif = frame.payload && frame.payload.stopRequestId;
    if (frame.op === 'prepare-ack' && (rif === requestId || frame.requestId === requestId)) {
      ack = true;
      chiudi();
    }
  });
  timer = setTimeout(chiudi, Math.max(1, residuo));
  const spedito = leaseManager.sendControl(cellId, {
    op: 'prepare', requestId, launchId, payload: {},
  });
  if (!spedito) {
    chiudi();
    return Promise.resolve({ outcome: 'identity-lost' });
  }
  return done.then(() => (ack ? { outcome: 'prepared' } : { outcome: 'stop-unknown' }));
}

function attendiFermataGruppo({
  leaseManager, cellId, launchId, monoNow, deadlineAt, graziaMs,
  osserva, attendiUscita, verificaSessioneAssente, reason,
}) {
  if (!leaseManager
    || typeof leaseManager.controlConnesso !== 'function'
    || typeof leaseManager.sendControl !== 'function'
    || typeof leaseManager.ascoltaControl !== 'function'
    || !leaseManager.controlConnesso(cellId)) {
    return Promise.resolve({ outcome: 'identity-lost', conti: null });
  }
  const residuo = deadlineAt - monoNow();
  if (!Number.isSafeInteger(residuo) || residuo < 1) {
    return Promise.resolve({ outcome: 'stop-unknown', conti: null });
  }
  const grazia = Math.min(Math.max(1, graziaMs), residuo);
  const requestId = idRichiesta();
  const visto = { ack: false, ready: null, commit: null, report: null, eof: false };
  let chiuso = false;
  let fine;
  const done = new Promise((resolve) => { fine = resolve; });
  let offFrame = () => {};
  let offClose = () => {};
  let timer = null;
  const chiudi = () => {
    if (chiuso) return;
    chiuso = true;
    try { offFrame(); } catch (_) {}
    try { offClose(); } catch (_) {}
    if (timer) clearTimeout(timer);
    fine();
  };
  const considera = () => {
    if (visto.report && visto.report.code === 'eperm') chiudi();
    else if (visto.ready && visto.eof) chiudi();
    else if (visto.commit && visto.eof) chiudi();
    else if (visto.eof && !visto.ready && !visto.commit) chiudi();
  };
  offFrame = leaseManager.ascoltaControl((id, frame) => {
    if (id !== cellId || !frame || !frame.payload) return;
    const rif = frame.payload.stopRequestId;
    if (rif !== requestId && frame.requestId !== requestId) return;
    if (frame.op === 'stop-ack') visto.ack = true;
    else if (frame.op === 'ready-to-exit') visto.ready = frame.payload;
    else if (frame.op === 'escalate-commit') visto.commit = frame.payload;
    else if (frame.op === 'stop-report') visto.report = frame.payload;
    considera();
  });
  if (typeof leaseManager.suChiusuraControl === 'function') {
    offClose = leaseManager.suChiusuraControl(cellId, () => {
      visto.eof = true;
      considera();
    });
  }
  const attesa = deadlineAt - monoNow();
  timer = setTimeout(chiudi, Math.max(1, attesa));
  const spedito = leaseManager.sendControl(cellId, {
    op: 'stop', requestId, launchId,
    payload: { deadlineMs: grazia, ...(ragioneStopValida(reason) ? { reason } : {}) },
  });
  if (!spedito) {
    chiudi();
    return Promise.resolve({ outcome: 'identity-lost', conti: null });
  }
  return done.then(async () => {
    // La prova di uscita e' un VALORE, non una risoluzione: la callback di
    // attendiUscita conferma SOLO restituendo { provato: true }, cioe' quando
    // ha atteso un riscontro reale del supervisore distinto da EOF. Una API
    // assente, rifiutata (throw) o muta (undefined/false) non prova nulla:
    // l'esito resta ignoto, mai «pulito» per assenza di contraddizione.
    // Sia l'attesa di uscita sia l'osservazione post-uscita sono rigorosamente
    // bounded contro il residuo della deadline: nessuna attesa illimitata dopo EOF.
    let uscitoConfermato = false;
    const conLimite = (fn, fallbackVal) => {
      const ms = deadlineAt - monoNow();
      if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(fallbackVal);
      let t;
      const timeoutP = new Promise((resolve) => {
        t = setTimeout(() => resolve(fallbackVal), Math.max(1, ms));
      });
      return Promise.race([
        Promise.resolve().then(fn).finally(() => { if (t) clearTimeout(t); }),
        timeoutP,
      ]);
    };

    if (typeof attendiUscita === 'function' && (visto.ready || visto.commit)) {
      try {
        // Il taglio esterno E' la deadline: se scatta, il motivo e' quello.
        const prova = await conLimite(() => attendiUscita(), { provato: false, motivo: 'scaduta' });
        uscitoConfermato = !!(prova && typeof prova === 'object' && prova.provato === true);
        if (!uscitoConfermato) {
          // Il motivo viaggia fino al rifiuto: senza, la tupla dice «ignoto»
          // ma non QUALE prova e' mancata.
          visto.motivoUscita = prova && typeof prova.motivo === 'string' ? prova.motivo : 'non-provata';
        }
      } catch (_) {
        uscitoConfermato = false;
        visto.motivoUscita = 'errore';
      }
    }
    if (uscitoConfermato) {
      visto.uscito = true;
      // Attestazione della sessione, opzionale e DOPO la prova di uscita (il
      // seam corre sul canale posseduto del lancio: canale morto con la
      // sessione, oppure has-session per id che dice assente). Un seam
      // assente, rifiutato (throw) o falso NON attesta nulla: il giudizio
      // resta al censimento, bounded dallo stesso residuo della deadline.
      if (typeof verificaSessioneAssente === 'function') {
        try {
          const assente = await conLimite(() => verificaSessioneAssente(), false);
          if (assente === true) visto.sessioneAssente = true;
        } catch (_) { /* nessuna attestazione: vale il censimento */ }
      }
      if (typeof osserva === 'function') {
        // Un timeout o un errore NON sono un residuo osservato: il fallback
        // resta `ignoti` con zero membri contati. Prima qui c'era un 1
        // convenzionale, che `classificaEsito` leggeva come `stop-incomplete`:
        // un fatto inventato travestito da misura.
        try {
          visto.dopo = await conLimite(() => osserva(deadlineAt), { ...contiIgnoti(), motivo: 'scaduta' });
        } catch (_) {
          visto.dopo = { ...contiIgnoti(), motivo: 'errore' };
        }
      } else {
        visto.dopo = null;
      }
      // Additive: which proof the post-exit probe was missing. Closed list,
      // carried beside the counts; it never takes part in the decision.
      visto.dopoMotivo = visto.dopo && typeof visto.dopo.motivo === 'string'
        ? motivoSondaBounded(visto.dopo.motivo) : null;
    }
    const esito = classificaEsito(visto);
    if (esito.uscito !== true) esito.motivoUscita = visto.motivoUscita || null;
    esito.dopoMotivo = visto.dopoMotivo || null;
    return esito;
  });
}

module.exports = {
  killGruppoCorrente,
  leggiPgrp,
  leggiIdentitaDa,
  osservaProduzione,
  osservaProduzioneLimitata,
  osservaGruppoDopoUscita,
  sondaGruppo,
  normalizzaConti,
  classificaEsito,
  codiceEsito,
  esitoGruppoPulito,
  eseguiFaseStop,
  creaCoordinatore,
  attendiFermataGruppo,
  attendiPreparazione,
  rilasciaLeaseDelLancio,
  RAGIONI_STOP,
};
