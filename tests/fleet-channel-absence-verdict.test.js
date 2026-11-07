'use strict';
// Verdetto TIPIZZATO dell'assenza sul canale di controllo posseduto. La sola
// parola di tmux che ATTESTA l'assenza della sessione e' il messaggio
// specifico del target chiesto («can't find session: $N», nel corpo del frame
// %error). Tutto il resto NON e' una prova: un %error generico e' un comando
// fallito, il timeout chiude il client senza dire niente sulla sessione, e la
// morte del client non attesta niente (EOF, timeout e sostituzione del server
// sono indistinguibili dalla fine della sessione). Questi test provano la
// conversione del seam del down (attestazioneAssenzaCanale) e il verdetto del
// canale VERO (CanaleControllo) con un client finto che parla il protocollo:
// nessun tmux reale, nessun server da creare o toccare.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmuxControl = require('../lib/fleet/tmux-control.js');
const { attestazioneAssenzaCanale } = require('../lib/fleet/runtime.js');

// --- unit: la conversione del seam del down --------------------------------

const canaleChe = (esitoHas) => ({ morto: () => false, hasSession: async () => esitoHas });

test('seam: verdetto specifico (assente) -> true', async () => {
  const r = await attestazioneAssenzaCanale(
    canaleChe({ ok: false, assente: true, testo: "can't find session: $7" }), '$7',
  );
  assert.equal(r, true);
});

test('seam: client morto PRIMA della verifica -> false, senza chiamare has-session', async () => {
  let chiamato = false;
  const canale = {
    morto: () => true,
    hasSession: async () => { chiamato = true; return { ok: true }; },
  };
  assert.equal(await attestazioneAssenzaCanale(canale, '$7'), false);
  assert.equal(chiamato, false);
});

test('seam: timeout del comando ({ok:false, morto:true}) -> false', async () => {
  assert.equal(await attestazioneAssenzaCanale(canaleChe({ ok: false, morto: true }), '$7'), false);
});

test('seam: %error generico -> false', async () => {
  assert.equal(
    await attestazioneAssenzaCanale(canaleChe({ ok: false, testo: 'generic protocol refusal' }), '$7'),
    false,
  );
});

test('seam: sessione viva (ok:true) -> false', async () => {
  assert.equal(await attestazioneAssenzaCanale(canaleChe({ ok: true, testo: '' }), '$7'), false);
});

test('seam: hasSession che throw -> false', async () => {
  const canale = {
    morto: () => false,
    hasSession: async () => { throw new Error('canale illeggibile'); },
  };
  assert.equal(await attestazioneAssenzaCanale(canale, '$7'), false);
});

test('seam: canale senza hasSession o nullo -> false', async () => {
  assert.equal(await attestazioneAssenzaCanale({ morto: () => false }, '$7'), false);
  assert.equal(await attestazioneAssenzaCanale(null, '$7'), false);
});

// --- canale vero su client finto: il verdetto tipizzato di hasSession ------

// Il client finto parla il protocollo control-mode osservato su tmux 3.4:
// handshake col token, poi un frame per comando. Il MODO (file) decide la
// risposta di has-session: viva | verdetto | altro | generico | silenzio.
function creaMondoCanale(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-verd-'));
  const modoPath = path.join(root, 'modo');
  fs.writeFileSync(modoPath, 'viva');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const MODO = ${JSON.stringify(modoPath)};
process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
let n = 0; let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!riga) continue;
    if (riga === 'display-message -p nc-control-open') continue;
    n += 1;
    const p = riga.split(/\\s+/);
    if (p[0] === 'has-session') {
      const modo = fs.readFileSync(MODO, 'utf8').trim();
      const id = p[p.length - 1];
      if (modo === 'viva') process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
      else if (modo === 'verdetto') process.stdout.write('%begin 1 ' + n + ' 1\\ncan\\'t find session: ' + id + '\\n%error 1 ' + n + ' 1\\n');
      else if (modo === 'altro') process.stdout.write('%begin 1 ' + n + ' 1\\ncan\\'t find session: $9999\\n%error 1 ' + n + ' 1\\n');
      else if (modo === 'generico') process.stdout.write('%begin 1 ' + n + ' 1\\nprotocol refused\\n%error 1 ' + n + ' 1\\n');
      else if (modo === 'silenzio') { /* nessuna risposta: il client tace */ }
    } else {
      process.stdout.write('%begin 1 ' + n + ' 1\\n%end 1 ' + n + ' 1\\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return { root, tmuxBin, modo: (m) => fs.writeFileSync(modoPath, m) };
}

test('canale: hasSession distingue verdetto, generico, altro target, viva', async (t) => {
  const w = creaMondoCanale(t);
  const canale = await tmuxControl.apri({
    tmuxBin: w.tmuxBin,
    socket: path.join(w.root, 'finto.sock'),
    sessionId: '$7',
  });
  t.after(() => { try { canale.ferma(); } catch (_) {} });
  assert.ok(canale, 'canale aperto');

  // sessione viva: ok, nessun verdetto di assenza
  w.modo('viva');
  const viva = await canale.hasSession('$7');
  assert.equal(viva.ok, true);
  assert.equal(viva.assente, undefined);

  // verdetto specifico sul target: assenza ATTESTATA
  w.modo('verdetto');
  const verdetto = await canale.hasSession('$7');
  assert.equal(verdetto.ok, false);
  assert.equal(verdetto.assente, true);
  assert.match(verdetto.testo, /can't find session: \$7/);

  // il verdetto per un ALTRO target non attesta il nostro
  w.modo('altro');
  const altro = await canale.hasSession('$7');
  assert.equal(altro.ok, false);
  assert.equal(altro.assente, undefined);

  // %error generico: comando fallito, non un verdetto
  w.modo('generico');
  const generico = await canale.hasSession('$7');
  assert.equal(generico.ok, false);
  assert.equal(generico.assente, undefined);
  assert.equal(canale.morto(), false, 'un %error non rompe il canale');

  // silenzio: timeout del comando, il canale si dichiara rotto e non attesta
  w.modo('silenzio');
  const muta = await canale.hasSession('$7', 400);
  assert.equal(muta.ok, false);
  assert.equal(muta.morto, true);
  assert.equal(muta.assente, undefined);
  assert.equal(canale.morto(), true);
  // dopo il timeout il canale non accetta piu' comandi
  const dopo = await canale.hasSession('$7');
  assert.equal(dopo.morto, true);
});
