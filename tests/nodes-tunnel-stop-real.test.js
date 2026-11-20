'use strict';
// R6 giro 2 — lo stop di un supervisore del tunnel usa le primitive VERE: il
// figlio che ignora SIGTERM deve essere MORTO davvero alla fine, e la ragione
// non deve dire «dopo SIGKILL» se il segnale non e' partito. Il caso che il mock
// nascondeva: killPidfile rimuove il pidfile subito dopo il TERM, quindi una
// seconda chiamata per pathname non trova piu' niente e il KILL non parte.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');
const tunnel = require('../lib/nodes/tunnel.js');

const NOME = 'prova-escalation';
const RUN = 'a'.repeat(32);
const attesa = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function prepara(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tunnel-stop-'));
  const pidPath = tunnel.tunnelPidPath(home, NOME);
  const figli = [];
  // Ogni figlio stampa READY DOPO aver installato il proprio handler: aspettare
  // la sola esistenza del processo non basta, un TERM arrivato prima
  // dell'handler lo ucciderebbe col comportamento di default.
  const avvia = (codice) => {
    const c = spawn(process.execPath, ['-e', codice], { stdio: ['ignore', 'pipe', 'ignore'] });
    c.pronto = new Promise((r) => {
      let buf = '';
      c.stdout.setEncoding('utf8');
      c.stdout.on('data', (d) => { buf += d; if (buf.includes('READY')) r(true); });
      c.once('exit', () => r(false));
    });
    figli.push(c);
    return c;
  };
  const attendiAvvio = async (c) => {
    if (!(await c.pronto)) throw new Error(`figlio ${c.pid} non pronto`);
    const cmd = pidf.readCmdline(c.pid);
    if (!cmd) throw new Error(`figlio ${c.pid} senza cmdline`);
    return cmd;
  };
  t.after(() => {
    for (const c of figli) { try { process.kill(c.pid, 'SIGKILL'); } catch (_) {} }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  });
  return { home, pidPath, avvia, attendiAvvio, figli };
}

// L'uscita del figlio si aspetta con un tetto: se il KILL non parte il test deve
// dire «ancora vivo», non scadere in silenzio.
const entro = (ms, promessa) => Promise.race([
  promessa,
  new Promise((r) => setTimeout(() => r({ signal: 'ancora-vivo', code: null }), ms)),
]);

const IGNORA_TERM = 'process.on("SIGTERM", () => {}); process.stdout.write("READY\\n"); setInterval(() => {}, 1000);';

// Un figlio che si ferma al TERM: il caso in cui l'escalation NON deve partire.
const ESCE_AL_TERM = 'process.on("SIGTERM", () => { process.exit(0); }); process.stdout.write("READY\\n"); setInterval(() => {}, 1000);';

test('R6/R6b: un supervisore che ignora SIGTERM e\' ucciso davvero, non dichiarato fermo', { timeout: 20000 }, async (t) => {
  const p = prepara(t);
  const figlio = p.avvia(IGNORA_TERM);
  const cmd = await p.attendiAvvio(figlio);
  pidf.writePidfile(p.pidPath, figlio.pid, cmd, { runId: RUN });
  assert.equal(pidf.isAttributable(pidf.readPidfile(p.pidPath)), true, 'pidfile non attribuibile');
  const uscita = new Promise((r) => figlio.once('exit', (code, signal) => r({ code, signal })));
  const r = tunnel.stopTunnel({ home: p.home, name: NOME, stopWaitMs: 300, killWaitMs: 1000 });
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.equal(r.escalated, true, 'escalation non dichiarata');
  assert.equal(r.pid, figlio.pid);
  const e = await entro(3000, uscita);
  assert.equal(e.signal, 'SIGKILL', `il figlio non e' stato ucciso: ${JSON.stringify(e)}`);
  assert.equal(fs.existsSync(p.pidPath), false, 'pidfile del supervisore morto lasciato indietro');
});

test('R6/R6b: un supervisore che esce al TERM non riceve nessun KILL', { timeout: 20000 }, async (t) => {
  const p = prepara(t);
  const figlio = p.avvia(ESCE_AL_TERM);
  const cmd = await p.attendiAvvio(figlio);
  pidf.writePidfile(p.pidPath, figlio.pid, cmd, { runId: RUN });
  const uscita = new Promise((r) => figlio.once('exit', (code, signal) => r({ code, signal })));
  const r = tunnel.stopTunnel({ home: p.home, name: NOME, stopWaitMs: 2000, killWaitMs: 500 });
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.equal(r.escalated, undefined, 'escalation su un supervisore che era gia' + " uscito");
  const e = await entro(3000, uscita);
  assert.equal(e.code, 0, JSON.stringify(e));
  assert.equal(fs.existsSync(p.pidPath), false, 'pidfile lasciato indietro');
});

test('R6/R6b: un pidfile sostituito durante l\'attesa non viene adottato ne\' segnalato', { timeout: 20000 }, async (t) => {
  const p = prepara(t);
  const figlio = p.avvia(IGNORA_TERM);
  const cmd = await p.attendiAvvio(figlio);
  pidf.writePidfile(p.pidPath, figlio.pid, cmd, { runId: RUN });
  // L'esca: un secondo processo vivo, con un pidfile suo, che qualcuno scrive
  // al posto del nostro mentre lo stop aspetta.
  const esca = p.avvia(IGNORA_TERM);
  const cmdEsca = await p.attendiAvvio(esca);
  const tmpEsca = path.join(p.home, 'esca.pid');
  pidf.writePidfile(tmpEsca, esca.pid, cmdEsca, { runId: RUN });
  const metaEsca = fs.readFileSync(tmpEsca, 'utf8');
  fs.unlinkSync(tmpEsca);
  const sostitutore = p.avvia(`setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(p.pidPath)}, ${JSON.stringify(metaEsca)}, { mode: 0o600 }); }, 200); process.stdout.write("READY\\n"); setInterval(() => {}, 1000);`);
  await p.attendiAvvio(sostitutore);
  const uscita = new Promise((r) => figlio.once('exit', (code, signal) => r({ code, signal })));
  const r = tunnel.stopTunnel({ home: p.home, name: NOME, stopWaitMs: 700, killWaitMs: 1000 });
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.equal(r.pid, figlio.pid, 'lo stop ha segnalato un pid adottato dal pathname');
  const e = await entro(3000, uscita);
  assert.equal(e.signal, 'SIGKILL', JSON.stringify(e));
  assert.equal(pidf.isAlive(JSON.parse(metaEsca)), true, 'il processo dell\'esca e\' stato ucciso');
  const ora = pidf.readPidfile(p.pidPath);
  assert.equal(ora && ora.pid, esca.pid, 'il pidfile sostitutivo e\' stato rimosso o riscritto');
});

test('R6/R6b: se l\'uscita non e\' provata dopo il KILL lo stop e\' FALLITO e il pidfile resta', { timeout: 20000 }, async (t) => {
  const p = prepara(t);
  const figlio = p.avvia(IGNORA_TERM);
  const cmd = await p.attendiAvvio(figlio);
  pidf.writePidfile(p.pidPath, figlio.pid, cmd, { runId: RUN });
  const uscita = new Promise((r) => figlio.once('exit', (code, signal) => r({ code, signal })));
  const r = tunnel.stopTunnel({
    home: p.home, name: NOME, stopWaitMs: 100, killWaitMs: 100,
    // Solo la PROVA di uscita e' negata: il KILL parte davvero e il figlio muore.
    supervisorExitedImpl: () => false,
  });
  assert.equal(r.stopped, false, JSON.stringify(r));
  assert.match(String(r.reason), new RegExp(String(figlio.pid)), 'la ragione non nomina il pid');
  const e = await entro(3000, uscita);
  assert.equal(e.signal, 'SIGKILL', 'il KILL non e\' partito: ' + JSON.stringify(e));
  assert.equal(fs.existsSync(p.pidPath), true, 'senza uscita provata il pidfile NON si cancella');
});

test('R6/R6b: se la nascita attestata non e\' piu\' quella viva, nessun SIGKILL parte', { timeout: 20000 }, async (t) => {
  const p = prepara(t);
  const figlio = p.avvia(IGNORA_TERM);
  const cmd = await p.attendiAvvio(figlio);
  pidf.writePidfile(p.pidPath, figlio.pid, cmd, { runId: RUN });
  const uscita = new Promise((r) => figlio.once('exit', (code, signal) => r({ code, signal })));
  const r = tunnel.stopTunnel({
    home: p.home, name: NOME, stopWaitMs: 150, killWaitMs: 200,
    // Solo la LETTURA della nascita e' negata: e' il caso «il numero e' stato
    // riassegnato», in cui segnalare sarebbe un kill di un altro processo.
    pidfileImpl: { readProcessStartImpl: () => '999999' },
    supervisorExitedImpl: () => false,
  });
  assert.equal(r.stopped, false, JSON.stringify(r));
  assert.match(String(r.reason), /attested identity/, 'la ragione non dice perche\' non si e\' segnalato');
  const e = await entro(1500, uscita);
  assert.equal(e.signal, 'ancora-vivo', `un SIGKILL e' partito lo stesso: ${JSON.stringify(e)}`);
  assert.equal(fs.existsSync(p.pidPath), true, 'senza prova il pidfile resta');
});

// C1 giro 3 — la pulizia del pidfile confronta l'IDENTITA' COMPLETA della stessa
// esecuzione (pid, nascita, runId, uid), non il solo numero: un documento
// sostitutivo che riporta lo stesso pid resta intatto. La sostituzione e'
// atomica (tmp + rename) e avviene al confine del cleanup, dopo che la prova di
// uscita produttiva ha detto il vero.
function scriviAtomico(file, contenuto) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, contenuto, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function stopConSostituzione(t, { campo, valore }) {
  const p = prepara(t);
  const figlio = p.avvia(IGNORA_TERM);
  return p.attendiAvvio(figlio).then((cmd) => {
    pidf.writePidfile(p.pidPath, figlio.pid, cmd, { runId: RUN });
    const uscita = new Promise((r) => figlio.once('exit', (code, signal) => r({ code, signal })));
    let sostituito = false;
    const r = tunnel.stopTunnel({
      home: p.home, name: NOME, stopWaitMs: 300, killWaitMs: 1000,
      supervisorExitedImpl: (pid, ms) => {
        // La prova di uscita e' quella VERA: il seam serve solo a sincronizzare
        // la sostituzione del documento nel momento esatto del cleanup.
        const vero = tunnel.supervisorExited(pid, ms);
        if (vero && !sostituito) {
          sostituito = true;
          const meta = JSON.parse(fs.readFileSync(p.pidPath, 'utf8'));
          meta[campo] = valore;
          scriviAtomico(p.pidPath, `${JSON.stringify(meta)}\n`);
        }
        return vero;
      },
    });
    return { p, figlio, r, uscita, sostituito };
  });
}

test('C1/R6c: stesso pid ma runId diverso: il pidfile sostitutivo resta intatto', { timeout: 20000 }, async (t) => {
  const { p, figlio, r, uscita } = await stopConSostituzione(t, { campo: 'runId', valore: 'b'.repeat(32) });
  // (1) il processo fermato e' il NOSTRO, provato dall'exit
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.equal(r.escalated, true, JSON.stringify(r));
  assert.equal(r.pid, figlio.pid);
  const e = await entro(3000, uscita);
  assert.equal(e.signal, 'SIGKILL', JSON.stringify(e));
  // (2) il documento sostitutivo NON e' nostro: resta, com'era
  assert.equal(fs.existsSync(p.pidPath), true, 'il pidfile sostitutivo e\' stato cancellato');
  const ora = pidf.readPidfile(p.pidPath);
  assert.equal(ora && ora.runId, 'b'.repeat(32), 'il sostituto e\' stato riscritto');
});

test('C1/R6c: stesso pid ma nascita diversa: il pidfile sostitutivo resta intatto', { timeout: 20000 }, async (t) => {
  const { p, figlio, r, uscita } = await stopConSostituzione(t, { campo: 'processStart', valore: '999999' });
  assert.equal(r.stopped, true, JSON.stringify(r));
  const e = await entro(3000, uscita);
  assert.equal(e.signal, 'SIGKILL', JSON.stringify(e));
  assert.equal(fs.existsSync(p.pidPath), true, 'il pidfile sostitutivo e\' stato cancellato');
  assert.equal((pidf.readPidfile(p.pidPath) || {}).processStart, '999999');
});

test('C1/R6c: il pidfile INTATTO della nostra esecuzione viene ancora rimosso', { timeout: 20000 }, async (t) => {
  const p = prepara(t);
  const figlio = p.avvia(IGNORA_TERM);
  const cmd = await p.attendiAvvio(figlio);
  pidf.writePidfile(p.pidPath, figlio.pid, cmd, { runId: RUN });
  const uscita = new Promise((r) => figlio.once('exit', (code, signal) => r({ code, signal })));
  const r = tunnel.stopTunnel({ home: p.home, name: NOME, stopWaitMs: 300, killWaitMs: 1000 });
  assert.equal(r.stopped, true, JSON.stringify(r));
  const e = await entro(3000, uscita);
  assert.equal(e.signal, 'SIGKILL', JSON.stringify(e));
  assert.equal(fs.existsSync(p.pidPath), false, 'il pidfile della nostra esecuzione non e\' stato rimosso');
});
