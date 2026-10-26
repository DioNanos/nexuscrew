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
// Protocollo osservato su tmux 3.4 (prove su socket privato di test):
//   %begin <t> <n> <flags> ...righe... %end <t> <n> <flags>    comando ok
//   %begin <t> <n> <flags> ...righe... %error <t> <n> <flags> comando fallito
//   notifiche asincrone fuori frame (%sessions-changed, %output, ...): ignorate
//   EOF su stdin o morte del server -> il client esce (riga %exit)
// Il flusso %output del pane e' soppresso all'apertura con il comando
// control-mode «disable-output», che serve anche da handshake: il canale e'
// operativo solo dopo la prima risposta incorniciata.

const { spawn } = require('node:child_process');

const CAP_RIGA = 64 * 1024;
const CAP_FRAME = 64 * 1024;
const RE_ID = /^[$%@][0-9]+$/;

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
        const rich = this.richieste.shift() || null;
        if (this.suPrimoFrame) { const h = this.suPrimoFrame; this.suPrimoFrame = null; h(); }
        if (rich) rich.risolvi(esito);
        return;
      }
      // %end/%error con (t,n) diverso: riga di output del frame, resta testo
    }
    if (this.frame.tot > CAP_FRAME) return;
    this.frame.testo.push(r);
    this.frame.tot += r.length;
  }

  chiama(tipo, args, timeoutMs) {
    return new Promise((resolveP) => {
      if (this.morto()) { resolveP({ ok: false, morto: true }); return; }
      const esito = new Promise((resolveT) => {
        const rich = { risolvi: resolveT };
        this.richieste.push(rich);
        try {
          this.proc.stdin.write(`${tipo} ${args.join(' ')}\n`);
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
    return { ok: r.ok === true, testo: (r.testo || []).join('\n') };
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
function apri({ tmuxBin, socket, env = process.env, prontaMs = 2000 } = {}) {
  return new Promise((resolveP) => {
    if (!tmuxBin || typeof socket !== 'string' || !socket.startsWith('/')) {
      resolveP(null);
      return;
    }
    let proc;
    try {
      proc = spawn(tmuxBin, ['-S', socket, '-C'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    canale.suPrimoFrame = () => chiudiApertura(canale);
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
    proc.on('error', () => { canale._esci(); chiudiApertura(null); });
    proc.on('exit', () => { canale._esci(); chiudiApertura(null); });
    proc.on('close', () => { canale._esci(); chiudiApertura(null); });
    try { proc.stdin.write('disable-output\n'); } catch (_) { chiudiApertura(null); }
  });
}

module.exports = { apri, RE_ID };
