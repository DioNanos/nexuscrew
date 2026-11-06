'use strict';
// lib/fleet/tmux-control.js — la connessione di controllo tmux POSSIEDUTA
// dal lancio.
//
// PERCHE' QUESTO MODULO ESISTE. Un client tmux a invocazioni (un processo
// nuovo per ogni comando) verifica il server su una connessione e agisce su
// un'altra: fra le due, il server puo' morire e un sostituto puo' occupare lo
// stesso pathname del socket. Fermare «per id» su un client nuovo puo'
// quindi raggiungere il sostituto. La garanzia «zero kill sul sostituto» non
// viene dal confronto di numeri (pathname e pid sono entrambi riutilizzabili)
// ma dalla CONTINUITA' della connessione: un solo canale aperto ALLA
// CREAZIONE della sessione, tenuto per la vita del lancio, su cui viaggiano
// sia la verifica sia il comando. Se il server muore o viene sostituito, il
// canale riceve EOF: nessun comando potra' piu' arrivare al sostituto, e il
// down dichiara l'esito onesto (stop-unknown / identita' non verificabile)
// invece di aprire client nuovi per «riprovare».
//
// LO SCENARIO DEL PATHNAME OGGI. Il lancio vive sul server tmux CONDIVISO
// (path stabile di default, vedi sharedTmuxSocketPath): il pathname e' piu'
// longevo e la sostituzione e' piu' rara, ma resta uno scenario REALE — il
// server condiviso puo' morire e un sostituto puo' legarsi allo stesso
// pathname — e la difesa e' la stessa: continuita' del canale aperto alla
// creazione e teardown solo per id $N. La rarefazione dello scenario non e'
// la garanzia; la continuita' si'.
//
// Protocollo osservato su tmux 3.4 (prove su socket privato di test):
//   %begin <t> <n> <flags> ...righe... %end <t> <n> <flags>    comando ok
//   %begin <t> <n> <flags> ...righe... %error <t> <n> <flags> comando fallito
//   notifiche asincrone fuori frame (%sessions-changed, %output, ...): ignorate
//   EOF su stdin o morte del server -> il client esce (riga %exit)
// L'apertura passa un comando esplicito sull'argv, cosi' il client non
// ricade sul default che crea una sessione. Il primo frame deve essere
// l'esito positivo di quel comando: un %error non apre il canale e non
// viene attribuito a una richiesta successiva.

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { tmuxClientEnv } = require('../runtime/env.js');

const CAP_RIGA = 64 * 1024;
const TOKEN_APERTURA = 'nc-control-open';
const CAP_FRAME = 64 * 1024;
const RE_ID = /^[$%@][0-9]+$/;
RE_ID.session = /^\$[0-9]+$/;
RE_ID.window = /^@[0-9]+$/;
RE_ID.pane = /^%[0-9]+$/;

// Il verdetto con cui tmux dichiara inesistente la sessione chiesta: e' la
// sola parola del server che ATTESTA l'assenza di QUEL target. Sul canale di
// controllo viaggia nel corpo del frame %error, come lo stderr del comando.
// Il verdetto di assenza vale SOLO per il target esatto della grammatica di
// tmux: `can't find session: $N`, da solo, senza testo aggiunto. Un confronto
// per sottostringa prenderebbe `$70` per `$7`; un errore generico non e' un
// verdetto sul target. Una sola definizione, usata sia dal canale posseduto
// sia dall'attestazione di sola lettura.
const RE_VERDETTO_ASSENZA = /^can't find session:\s*(\$[0-9]+)$/i;

function verdettoAssenzaTarget(testo, id) {
  if (typeof testo !== 'string' || typeof id !== 'string' || !id) return false;
  const m = RE_VERDETTO_ASSENZA.exec(testo.trim());
  return !!m && m[1] === id;
}

// Stato dell'INCARNAZIONE registrata al lancio, letto in forma ternaria:
//   'morte'  il numero non esiste piu' (ENOENT): quel processo e' finito;
//   'riuso'  il numero esiste con una nascita DIVERSA: la vecchia incarnazione
//            e' finita comunque, e il processo nuovo non si tocca;
//   'vivo'   stesso numero e stessa nascita: il server e' ancora quello;
//   'ignoto' lettura negata, corrotta o non qualificata: non e' una prova.
// Non esegue azioni: nessun segnale, nessun client, nessuna risoluzione.
function verificaMorteIncarnazione({ serverPid, serverStarttime, leggiIdentitaProc }) {
  if (!Number.isSafeInteger(serverPid) || serverPid <= 1) return 'ignoto';
  if (!Number.isFinite(serverStarttime)) return 'ignoto';
  if (typeof leggiIdentitaProc !== 'function') return 'ignoto';
  let stato;
  try { stato = leggiIdentitaProc(serverPid); } catch (_) { return 'ignoto'; }
  if (!stato || typeof stato !== 'object') return 'ignoto';
  if (stato.esito === 'assente') return 'morte';
  if (stato.esito !== 'presente') return 'ignoto';
  if (!Number.isSafeInteger(stato.nascita)) return 'ignoto';
  return stato.nascita === serverStarttime ? 'vivo' : 'riuso';
}

class CanaleControllo {
  constructor(proc) {
    this.proc = proc;
    this.uscita = false; // processo uscito (o fermato)
    this.rotto = false; // timeout/protocollo: non piu' attendibile
    this.buf = '';
    this.trascuro = 0; // byte oltre il cap della riga in corso, scartati
    this.richieste = []; // FIFO: { risolvi } una per comando in attesa
    this.frame = null; // { t, n, testo, tot } frame in costruzione
    this.suPrimoFrame = null; // hook dell'handshake
    // L'attach produce un frame vuoto PRIMA del comando di apertura: quel
    // preambolo vale solo per apri(). La creazione ha UN comando, e il suo
    // primo frame completo e' la sua risposta: non si salta niente.
    this.saltaFrameVuotoIniziale = true;
    this.frameCompleti = 0; // frame chiusi (%end/%error) osservati sul canale
    proc.stdin.on('error', () => { /* EPIPE: il client e' gia' uscito */ });
  }

  morto() { return this.uscita || this.rotto; }

  riga(r) {
    if (this.trascuro > 0) { // riga precedente oltre cap: resto scartato
      this.trascuro = Math.max(0, this.trascuro - (r.length + 1));
      return;
    }
    if (r.length >= CAP_RIGA) { this.trascuro = r.length; return; }
    if (!this.frame) {
      if (r.startsWith('%begin ')) {
        const p = r.split(' ');
        if (p.length >= 4) this.frame = { t: p[1], n: p[2], testo: [], tot: 0 };
      }
      // fuori frame: notifiche asincrone, ignorate
      return;
    }
    const fine = r.startsWith('%end ') || r.startsWith('%error ');
    if (fine) {
      const p = r.split(' ');
      if (p[1] === this.frame.t && p[2] === this.frame.n) {
        const esito = { ok: !r.startsWith('%error '), testo: this.frame.testo };
        this.frame = null;
        this.frameCompleti += 1;
        if (this.suPrimoFrame) {
          const testo = (esito.testo || []).join('\n').trim();
          // Preambolo vuoto dell'attach (solo apri): non e' un errore e non
          // chiude il canale.
          if (this.saltaFrameVuotoIniziale && esito.ok === true && testo === '') return;
          const h = this.suPrimoFrame;
          this.suPrimoFrame = null;
          // `indice` e' la posizione del frame fra i frame chiusi del canale:
          // la risposta al comando unico di creazione e' esattamente la 0.
          h({ ...esito, indice: this.frameCompleti - 1 });
          return;
        }
        const rich = this.richieste.shift() || null;
        if (rich) rich.risolvi(esito);
        return;
      }
      // %end/%error con (t,n) diverso: riga di output del frame, resta testo
    }
    if (this.frame.tot > CAP_FRAME) return;
    this.frame.testo.push(r);
    this.frame.tot += r.length;
  }

  chiama(tipo, args = [], timeoutMs = 5000) {
    return new Promise((resolveP) => {
      if (this.morto()) { resolveP({ ok: false, morto: true }); return; }
      const esito = new Promise((resolveT) => {
        const rich = { risolvi: resolveT };
        this.richieste.push(rich);
        try {
          const quota = (s) => {
            const t = String(s);
            // '#' e ';' vanno QUOTATI anche senza spazi: il parsing delle righe
            // stdin del control client e' config-like, dove '#' inizia un
            // commento (un '#{format}' nudo arriverebbe tagliato: la risposta
            // del display-message e' la status line, non il formato) e ';'
            // separa comandi.
            if (t.length > 0 && !/[\s'"#;]/.test(t)) return t;
            return `'${t.replace(/'/g, `'\\''`)}'`;
          };
          const riga = `${tipo} ${args.map(quota).join(' ')}\n`;
          this.proc.stdin.write(riga);
        } catch (_) {
          const i = this.richieste.indexOf(rich);
          if (i >= 0) this.richieste.splice(i, 1);
          resolveT({ ok: false, morto: true });
        }
      });
      const timer = setTimeout(() => {
        // Nessuna risposta entro la deadline: il canale non e' piu'
        // attendibile (il abbinamento delle risposte successive sarebbe
        // ambiguo). Rotto: esito onesto al chiamante, nessun ripiego.
        this.rotto = true;
        this.ferma();
        resolveP({ ok: false, morto: true });
      }, timeoutMs);
      esito.then((v) => { clearTimeout(timer); resolveP(v); });
    });
  }

  async hasSession(id, timeoutMs = 5000) {
    if (!RE_ID.test(id)) return { ok: false, argomento: true };
    const r = await this.chiama('has-session', ['-t', id], timeoutMs);
    if (r.morto) return r;
    const testo = (r.testo || []).join('\n');
    // L'assenza e' ATTESTATA solo dal verdetto SPECIFICO di tmux sul target
    // chiesto: il messaggio della sessione inesistente E l'id richiesto nel
    // testo. Un %error generico (comando fallito, protocollo, configurazione)
    // e' un comando fallito, non un verdetto sull'esistenza; timeout e morte
    // del client ({ morto: true }, gia' ritornati sopra) non dicono niente
    // sulla sessione. Chi consuma l'esito distingue: solo `assente === true`
    // prova l'assenza, ogni altro ok:false non prova niente.
    const assente = r.ok !== true && verdettoAssenzaTarget(testo, id);
    return { ok: r.ok === true, testo, ...(assente ? { assente: true } : {}) };
  }

  async killSession(id, timeoutMs = 5000) {
    if (!RE_ID.test(id)) return { ok: false, argomento: true };
    const r = await this.chiama('kill-session', ['-t', id], timeoutMs);
    if (r.morto) return r;
    return { ok: r.ok === true, testo: (r.testo || []).join('\n') };
  }

  ferma() {
    try { this.proc.stdin.end(); } catch (_) { /* gia' chiuso */ }
    try { this.proc.kill('SIGKILL'); } catch (_) { /* gia' uscito */ }
  }

  chiudi() {
    if (this.uscita) return;
    try { this.proc.stdin.end(); } catch (_) { /* gia' chiuso */ }
    const proc = this.proc;
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* uscito */ } }, 500);
    proc.once('exit', () => clearTimeout(t));
  }

  _esci() {
    this.uscita = true;
    while (this.richieste.length) {
      const r = this.richieste.shift();
      r.risolvi({ ok: false, morto: true });
    }
  }
}

/**
 * Apre il canale di controllo per un server tmux gia' in vita. Risolve null
 * se il canale non diventa operativo entro prontaMs (nessun server, client
 * che non parla control mode, handshake muto): il chiamante prosegue SENZA
 * canale e il down futuro dichiara l'identita' non dimostrabile — mai un
 * client nuovo come ripiego. Il canale aperto va chiuso con chiudi() quando
 * il lancio finisce. Mai throw.
 */
function apri({ tmuxBin, socket, sessionId, env = process.env, prontaMs = 2000 } = {}) {
  return new Promise((resolveP) => {
    if (!tmuxBin || typeof socket !== 'string' || !socket.startsWith('/')) {
      resolveP(null);
      return;
    }
    if (typeof sessionId !== 'string' || !/^\$[0-9]+$/.test(sessionId)) {
      resolveP(null);
      return;
    }
    let proc;
    try {
      // Comando esplicito: ci si attacca alla sessione gia' creata. Un client
      // -C con un comando che non attacca esce subito (%exit) e la scrittura
      // successiva rompe il processo. Senza comando, tmux creerebbe una
      // sessione nuova. L'env del client segue la politica unica del socket:
      // TMUX non entra, anche se il chiamante lo ha passato.
      proc = spawn(tmuxBin, ['-S', socket, '-C', 'attach-session', '-t', sessionId], {
        env: tmuxClientEnv(env), stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Il canale NON tiene in vita il processo che lo possiede: se NC esce
      // (o il processo di test finisce), la pipe stdin si chiude, il client
      // riceve EOF e termina da solo (comportamento standard di tmux -C).
      // Gli orfani non sopravvivono: nessun ciclo di vita appeso.
      proc.unref();
      proc.stdout.unref();
      proc.stderr.unref();
      proc.stdin.unref();
    } catch (_) {
      resolveP(null);
      return;
    }
    const canale = new CanaleControllo(proc);
    let conclusa = false;
    const chiudiApertura = (v) => {
      if (conclusa) return;
      conclusa = true;
      clearTimeout(timer);
      resolveP(v);
    };
    const timer = setTimeout(() => {
      // handshake muto: processo vivo ma nessuna risposta incorniciata. Non
      // e' un canale dimostrato: lo si ferma (processo creato qui) e si
      // dichiara l'assenza del canale.
      canale.ferma();
      chiudiApertura(null);
    }, prontaMs);
    canale.suPrimoFrame = (esito) => {
      const testo = (esito && esito.testo ? esito.testo : []).join('\n').trim();
      if (esito && esito.ok === true && testo === TOKEN_APERTURA) chiudiApertura(canale);
      else {
        canale.ferma();
        chiudiApertura(null);
      }
    };
    let buffer = '';
    proc.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const riga = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        try { canale.riga(riga); } catch (_) { /* il canale sara' dichiarato rotto */ }
      }
      if (buffer.length > CAP_RIGA) buffer = '';
    });
    proc.stderr.on('data', () => { /* diagnostica: ignorata */ });
    proc.stdin.on('error', () => { /* EPIPE: il client e' gia' uscito */ });
    proc.on('error', () => { canale._esci(); chiudiApertura(null); });
    proc.on('exit', () => { canale._esci(); chiudiApertura(null); });
    proc.on('close', () => { canale._esci(); chiudiApertura(null); });
    try { proc.stdin.write(`display-message -p ${TOKEN_APERTURA}\n`); } catch (_) { /* uscita gia' osservata */ }

  });
}

/**
 * Crea una sessione tmux sul canale di controllo POSSIEDUTO fin dalla nascita.
 * Esegue direttamente:
 *   tmux -S <socket> -C new-session -x <w> -y <h> -s <nome> -c <cwd> -P -F "#{session_id} #{window_id} #{pane_id}" <node> <cellHold> [args...]
 * senza -d e senza -A.
 *
 * Il processo client viene osservato attraverso le sue pipe.
 * Il frame iniziale (%begin ... %end) deve confermare il comando e fornire
 * esattamente sessionId ($N), windowId (@N) e paneId (%N).
 * Risolve { ok: true, canale, createdIds: { sessionId, windowId, paneId } }.
 * Se il frame iniziale fallisce (%error, output invalido, timeout o EOF prima della conferma),
 * ferma il processo e risolve { ok: false, err, isDuplicate }. `isDuplicate` e
 * `rifiutoProvato: 'duplicate-session'` compaiono SOLO per un frame %error
 * completo che e' esattamente «duplicate session: <nome richiesto>».
 * Mai throw.
 */
function creaSessionePosseduta({
  tmuxBin,
  socket,
  sessionName,
  cwd,
  nodeBin,
  cellHoldPath,
  cellHoldArgs = [],
  env = process.env,
  prontaMs = 3000,
  width = 80,
  height = 24,
} = {}) {
  return new Promise((resolveP) => {
    if (!tmuxBin || typeof socket !== 'string' || !socket.startsWith('/')
        || typeof sessionName !== 'string' || !sessionName) {
      resolveP({ ok: false, err: new Error('argomenti creaSessionePosseduta non validi') });
      return;
    }

    const argv = [
      '-S', socket,
      '-C',
      'new-session',
      '-x', String(width),
      '-y', String(height),
      '-s', sessionName,
      '-c', cwd || process.cwd(),
      '-P',
      '-F', '#{session_id} #{window_id} #{pane_id}',
    ];
    if (nodeBin) argv.push(nodeBin);
    if (cellHoldPath) argv.push(cellHoldPath);
    if (Array.isArray(cellHoldArgs) && cellHoldArgs.length > 0) argv.push(...cellHoldArgs);

    let proc;
    try {
      // Come apri(): l'env del client di creazione segue la politica unica del
      // socket, TMUX incluso, anche se il chiamante lo ha passato.
      proc = spawn(tmuxBin, argv, {
        env: tmuxClientEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.unref();
      proc.stdout.unref();
      proc.stderr.unref();
      proc.stdin.unref();
    } catch (err) {
      resolveP({ ok: false, err });
      return;
    }

    const canale = new CanaleControllo(proc);
    // Nessun preambolo da scartare: il primo frame completo e' la risposta al
    // new-session. Un successo senza gli ID richiesti NON e' un preambolo, e'
    // una materializzazione ignota che un frame successivo non puo' sanare.
    canale.saltaFrameVuotoIniziale = false;
    let conclusa = false;
    const chiudiCreazione = (res) => {
      if (conclusa) return;
      conclusa = true;
      clearTimeout(timer);
      if (!res || !res.ok) {
        canale.ferma();
      }
      resolveP(res);
    };

    const timer = setTimeout(() => {
      chiudiCreazione({ ok: false, err: new Error('timeout prima della conferma di creazione della sessione') });
    }, prontaMs);

    canale.suPrimoFrame = async (esito) => {
      if (!esito || esito.ok !== true) {
        const righeFrame = esito && Array.isArray(esito.testo) ? esito.testo : [];
        const raw = righeFrame.join('\n').trim();
        // RIFIUTO PROVATO. Il frame %error e' completo (stesso t,n del
        // %begin) ed e' l'esito del nostro unico comando, ma attesta solo che
        // QUEL comando e' fallito, non un rollback generale: «nulla e' stato
        // creato» vale soltanto per il messaggio di tmux che nomina la
        // sessione richiesta come duplicata, una riga, esattamente. Un testo
        // con «duplicate» fuori dal frame, un frame troncato, un messaggio
        // piu' lungo o che nomina un'altra sessione, un rifiuto generico,
        // timeout, EOF: nessuna prova, la materializzazione resta ignota.
        const duplicato = !!esito && esito.indice === 0 && esito.ok === false
          && righeFrame.length === 1 && raw === `duplicate session: ${sessionName}`;
        chiudiCreazione({
          ok: false,
          err: new Error(raw || 'creazione sessione tmux rifiutata (%error)'),
          isDuplicate: duplicato,
          ...(duplicato ? { rifiutoProvato: 'duplicate-session' } : {}),
          rawText: raw,
        });
        return;
      }
      // Formato iniziale CHIUSO. L'unico -F e' '#{session_id} #{window_id} #{pane_id}',
      // tre campi separati da uno spazio ASCII U+0020. Il primo frame deve
      // essere l'esito di quel new-session: una sola riga, esattamente tre
      // campi, regex chiuse $N / @N / %N. Una riga unita da underscore non
      // viene riscritta. Righe extra, campi in piu' o in meno, id malformati
      // o permutati, il token di apertura del canale di attach, %error,
      // timeout ed EOF prima della conferma rifiutano la creazione e non
      // producono createdIds. Nessun secondo client, nessun attach, nessun
      // ripiego: la sessione, se anche esistesse, non e' posseduta da una
      // connessione dimostrata.
      const raw = (esito.testo || []).join('\n').trim();
      if (raw === TOKEN_APERTURA) {
        chiudiCreazione({
          ok: false,
          err: new Error('frame iniziale non conforme: atteso l\'esito di new-session, ricevuto il token di apertura del canale'),
          rawText: raw,
        });
        return;
      }
      const righe = raw.split('\n');
      if (righe.length !== 1) {
        chiudiCreazione({
          ok: false,
          err: new Error(`formato ID non valido da tmux new-session: attesa una sola riga, ricevute ${righe.length}`),
          rawText: raw,
        });
        return;
      }
      const parti = righe[0].split(/\s+/);
      const sId = parti[0] || '';
      const wId = parti[1] || '';
      const pId = parti[2] || '';
      if (parti.length === 3
          && /^\$[0-9]+$/.test(sId) && /^@[0-9]+$/.test(wId) && /^%[0-9]+$/.test(pId)) {
        chiudiCreazione({
          ok: true,
          canale,
          createdIds: { sessionId: sId, windowId: wId, paneId: pId },
        });
        return;
      }
      chiudiCreazione({
        ok: false,
        err: new Error(`formato ID non valido da tmux new-session: ${raw}`),
        rawText: raw,
      });
    };

    let buffer = '';
    proc.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const riga = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        try { canale.riga(riga); } catch (_) {}
      }
      if (buffer.length > CAP_RIGA) buffer = '';
    });
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      canale._esci();
      chiudiCreazione({ ok: false, err: err || new Error('errore processo client tmux') });
    });
    // L'uscita del client NON chiude la creazione: 'exit' puo' precedere gli
    // ultimi dati di stdout, e un frame %error completo gia' scritto nella pipe
    // e' proprio la prova che distingue un rifiuto da un esito ignoto. La
    // creazione si chiude su 'close' (stdout esaurito, dati gia' consegnati) o
    // sul timeout; il canale invece e' subito dichiarato uscito.
    let codiceUscita = null;
    proc.on('exit', (code) => {
      codiceUscita = code;
      canale._esci();
    });
    proc.on('close', () => {
      canale._esci();
      chiudiCreazione({
        ok: false,
        err: new Error(codiceUscita !== null
          ? `client tmux terminato prematuramente con codice ${codiceUscita}`
          : 'pipe client tmux chiuse prematuramente'),
      });
    });
  });
}


/**
 * ATTESTAZIONE DI SOLA LETTURA SU UNA CONNESSIONE NUOVA.
 *
 * Serve in un solo caso: il comando di teardown e' partito e la sua risposta
 * non e' mai arrivata. Il canale posseduto e' morto e non puo' piu' dire se la
 * sessione esiste; senza un verdetto il down resta STOP_UNKNOWN. Qui si apre
 * una connessione NUOVA, breve, che NON puo' fare altro che identificare il
 * server e chiedere has-session: nessun kill-session, nessun send-keys,
 * nessuna creazione, nessun retry del teardown.
 *
 * L'identita' che conta e' l'INCARNAZIONE del server del lancio, congelata
 * prima dello stop (pid + starttime), non il pathname del socket (riusabile) e
 * non il nome della cella. Le due domande viaggiano sullo stesso client:
 *   display-message -p '#{pid}'   -> deve essere esattamente serverPid
 *   has-session -t <id esatto>    -> deve essere il verdetto specifico di
 *                                    assenza per QUEL target
 * Il client e' invocato con i comandi sull'argv: non attacca nessuna sessione
 * (nessun ridimensionamento del pane di un'altra cella).
 *
 * Attesta SOLO la connessione completa dei due frame, con identita' verificata
 * prima e dopo. EOF, timeout, connessione rifiutata, errore generico, server
 * sostituito o identita' non verificabile non attestano niente: la risposta e'
 * { attestato: false } con un motivo interno, mai un successo per assenza di
 * contraddizione. Il socket viene interrogato DOPO aver verificato che
 * qualcuno vi sia in ascolto: senza quel controllo un client tmux avvierebbe
 * un server nuovo e la sua stessa creazione falserebbe il verdetto.
 */
async function attestaAssenzaNuovaConnessione({
  tmuxBin,
  socket,
  sessionId,
  serverPid,
  serverStarttime,
  deadlineAt,
  monoNow = Date.now,
  leggiStarttimeProc,
  leggiIdentitaProc,
  connetti,
  env = process.env,
} = {}) {
  const no = (motivo) => ({ attestato: false, motivo });
  if (!tmuxBin || typeof socket !== 'string' || !socket.startsWith('/')) return no('argomenti');
  if (typeof sessionId !== 'string' || !RE_ID.session.test(sessionId)) return no('argomenti');
  if (!Number.isSafeInteger(serverPid) || serverPid <= 1) return no('identita');
  if (!Number.isFinite(serverStarttime)) return no('identita');
  if (typeof leggiStarttimeProc !== 'function') return no('identita');
  if (!Number.isFinite(deadlineAt)) return no('budget');
  const residuo = () => deadlineAt - monoNow();
  if (residuo() <= 0) return no('budget');
  if (typeof leggiIdentitaProc === 'function') {
    // Morte PROVATA della stessa incarnazione: il numero sparito o riusato con
    // una nascita diversa dicono che quel server non esiste piu', quindi la sua
    // sessione nemmeno. Un fatto, non un timeout: EOF, socket rifiutato e
    // client morto non bastano, e non si tocca il processo nuovo.
    const incarnazione = verificaMorteIncarnazione({ serverPid, serverStarttime, leggiIdentitaProc });
    if (incarnazione === 'morte' || incarnazione === 'riuso') {
      return { attestato: true, motivo: 'incarnazione-morta' };
    }
    if (incarnazione === 'ignoto') return no('identita');
  } else {
    let nascita;
    try { nascita = leggiStarttimeProc(serverPid); } catch (_) { nascita = null; }
    if (nascita !== serverStarttime) return no('identita');
  }
  let st;
  try { st = fs.lstatSync(socket); } catch (_) { return no('socket'); }
  if (!st.isSocket()) return no('socket');
  const vive = typeof connetti === 'function' ? connetti : (percorso, ms) => connettiSocket(percorso, ms);
  let inAscolto = false;
  try {
    inAscolto = await vive(socket, Math.min(1000, residuo()));
  } catch (_) { inAscolto = false; }
  if (!inAscolto) return no('server-assente');
  if (residuo() <= 0) return no('budget');

  const esito = await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(tmuxBin, [
        '-S', socket, '-C',
        'display-message', '-p', '#{pid}', ';',
        // L'enumerazione viene PRIMA del verdetto: tmux esegue la sequenza in
        // fila e si ferma al primo errore, e il caso che dobbiamo attestare e'
        // proprio quello in cui has-session fallisce. Messo dopo, non
        // verrebbe mai eseguito. Stesso client, sola lettura.
        'list-sessions', '-F', '#{session_id}', ';',
        'has-session', '-t', sessionId,
      ], { env: tmuxClientEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (_) { resolve(no('spawn')); return; }
    const canale = new CanaleControllo(proc);
    let fine = false;
    let timer = null;
    const chiudi = (v) => {
      if (fine) return;
      fine = true;
      if (timer) clearTimeout(timer);
      try { proc.stdout.removeAllListeners(); } catch (_) {}
      // La connessione e' breve per disegno: si chiude subito, senza la
      // grazia di 500 ms prevista per il canale posseduto.
      canale.ferma();
      resolve(v);
    };
    const primo = new Promise((r) => { canale.richieste.push({ risolvi: r }); });
    const secondo = new Promise((r) => { canale.richieste.push({ risolvi: r }); });
    const terzo = new Promise((r) => { canale.richieste.push({ risolvi: r }); });
    timer = setTimeout(() => chiudi(no('timeout')), Math.max(1, residuo()));
    let buffer = '';
    proc.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const riga = buffer.slice(0, i).replace(/\r$/, '');
        buffer = buffer.slice(i + 1);
        try { canale.riga(riga); } catch (_) { /* frame rotto: niente attestazione */ }
      }
      if (buffer.length > CAP_RIGA) buffer = '';
    });
    proc.stderr.on('data', () => {});
    proc.on('error', () => chiudi(no('spawn')));
    proc.on('exit', () => chiudi(no('eof')));
    Promise.all([primo, secondo, terzo]).then(([a, elencoF, verdettoF]) => {
      const testoA = ((a && a.testo) || []).join('\n').trim();
      const testoV = ((verdettoF && verdettoF.testo) || []).join('\n');
      if (!a || a.ok !== true || testoA !== String(serverPid)) { chiudi(no('identita')); return; }
      if (verdettoF && verdettoF.ok === true) { chiudi(no('presente')); return; }
      if (verdettoF && verdettoF.ok !== true && verdettoAssenzaTarget(testoV, sessionId)) {
        chiudi({ attestato: true, motivo: 'assente' });
        return;
      }
      // Enumerazione COMPLETA: risposta ok e solo identificatori di sessione.
      // Solo allora l'assenza del nostro id e' una prova. Un elenco in errore,
      // parziale o malformato resta ignoto; e se il nostro id compare, la
      // sessione c'e' e non si attesta nulla.
      const righe = elencoF && elencoF.ok === true && Array.isArray(elencoF.testo)
        ? elencoF.testo.map((t) => String(t).trim()).filter((t) => t !== '')
        : null;
      if (!righe || righe.some((r) => !/^\$[0-9]+$/.test(r))) {
        chiudi(no('verdetto'));
        return;
      }
      if (righe.includes(sessionId)) { chiudi(no('presente')); return; }
      chiudi({ attestato: true, motivo: 'enumerazione' });
    }).catch(() => chiudi(no('eof')));
  });
  if (!esito.attestato) return esito;
  // L'incarnazione deve essere la stessa anche DOPO il verdetto: se il server
  // e' morto nel frattempo, la risposta non e' piu' correlabile a quel lancio.
  let dopo;
  try { dopo = leggiStarttimeProc(serverPid); } catch (_) { dopo = null; }
  if (dopo !== serverStarttime) return no('identita');
  return { attestato: true, motivo: esito.motivo || 'assente' };
}

// Chi ascolta davvero sul socket? Serve a NON avviare un server tmux nuovo: un
// client su un pathname senza server ne creerebbe uno, e la creazione stessa
// falserebbe l'attestazione.
function connettiSocket(percorso, ms) {
  const net = require('node:net');
  return new Promise((resolve) => {
    let sock;
    let fine = false;
    const chiudi = (v) => {
      if (fine) return;
      fine = true;
      try { if (sock) sock.destroy(); } catch (_) {}
      resolve(v);
    };
    const t = setTimeout(() => chiudi(false), Math.max(1, ms));
    try {
      sock = net.connect({ path: percorso });
    } catch (_) { clearTimeout(t); resolve(false); return; }
    sock.once('connect', () => { clearTimeout(t); chiudi(true); });
    sock.once('error', () => { clearTimeout(t); chiudi(false); });
  });
}

module.exports = { apri, creaSessionePosseduta, attestaAssenzaNuovaConnessione, verdettoAssenzaTarget, verificaMorteIncarnazione, RE_ID };
