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
const ASSENZA_TARGET_RE = /can't find session/i;

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
        if (this.suPrimoFrame) {
          const testo = (esito.testo || []).join('\n').trim();
          // L'attach produce un frame vuoto prima del comando di apertura.
          // Non e' un errore e non chiude il canale.
          if (esito.ok === true && testo === '') return;
          const h = this.suPrimoFrame;
          this.suPrimoFrame = null;
          h(esito);
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
    const assente = r.ok !== true && ASSENZA_TARGET_RE.test(testo) && testo.includes(id);
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
 *   tmux -S <socket> -C new-session -x <w> -y <h> -s <nome> -c <cwd> -P -F "#{session_id}\t#{window_id}\t#{pane_id}" <node> <cellHold> [args...]
 * senza -d e senza -A.
 *
 * Il processo client viene osservato attraverso le sue pipe.
 * Il frame iniziale (%begin ... %end) deve confermare il comando e fornire
 * esattamente sessionId ($N), windowId (@N) e paneId (%N).
 * Risolve { ok: true, canale, createdIds: { sessionId, windowId, paneId } }.
 * Se il frame iniziale fallisce (%error, output invalido, timeout o EOF prima della conferma),
 * ferma il processo e risolve { ok: false, err, isDuplicate }.
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
      '-F', '#{session_id}\t#{window_id}\t#{pane_id}',
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
        const raw = (esito && esito.testo ? esito.testo : []).join('\n').trim();
        const isDuplicate = /duplicate session/i.test(raw);
        chiudiCreazione({
          ok: false,
          err: new Error(raw || 'creazione sessione tmux rifiutata (%error)'),
          isDuplicate,
          rawText: raw,
        });
        return;
      }
      // Formato iniziale CHIUSO: il primo frame e' l'esito del comando
      // new-session passato sull'argv, e contiene ESATTAMENTE una riga con
      // i tre id (-P -F). Qualsiasi altra cosa — righe extra, campi extra,
      // token di apertura del canale di attach, frame vuoti che arrivano a
      // farsi attendere fino alla scadenza — e' una risposta non conforme e
      // la creazione e' rifiutata. Nessun secondo client, nessun attach,
      // nessun ripiego: la sessione, se anche esistesse, non e' posseduta
      // da una connessione dimostrata.
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
    proc.on('exit', (code) => {
      canale._esci();
      chiudiCreazione({ ok: false, err: new Error(`client tmux terminato prematuramente con codice ${code}`) });
    });
    proc.on('close', () => {
      canale._esci();
      chiudiCreazione({ ok: false, err: new Error('pipe client tmux chiuse prematuramente') });
    });
  });
}

module.exports = { apri, creaSessionePosseduta, RE_ID };
