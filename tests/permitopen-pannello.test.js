'use strict';
// tests/permitopen-pannello.test.js — R19: il tunnel del pannello era
// AUTORIZZATO A NON FUNZIONARE. La riga authorized_keys generata elencava una
// sola destinazione (porta nexus): da 0.9.1 il pannello ha una porta sua e il
// server rifiuta quel canale. Due difetti in uno: la riga è nata dove
// l'informazione non c'è (nodesAdd non può conoscere la porta pannello del
// peer: la annuncia il join), e «forward ready» misurava solo il bind locale.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cmds = require('../lib/nodes/commands.js');
const store = require('../lib/nodes/store.js');
const tunnel = require('../lib/nodes/tunnel.js');
const supervisor = require('../lib/nodes/tunnel-supervisor.js');
const { pubValida, campoSsh } = require('./helpers/pubkey.js');

// Chiave VALIDA, non un segnaposto: viene anche scritta in un `.pub` e riletta,
// e la lettura ora valida algoritmo e blob. Un finto piu' permissivo del vero
// rendeva verdi test che in produzione non sarebbero mai passati.
const FAKE_PUB = pubValida('PermitOpenPannello test key');

// —— A: la riga con DUE destinazioni esplicite (mai un permesso generico) ———

test('authorizedKeysLine: una destinazione quando il pannello non c\'è, DUE esplicite quando c\'è', () => {
  const sola = tunnel.authorizedKeysLine({ remotePort: 41820, pub: FAKE_PUB });
  assert.equal(sola,
    `restrict,port-forwarding,permitopen="127.0.0.1:41820",command="/bin/false" ${FAKE_PUB}`);
  const doppia = tunnel.authorizedKeysLine({ remotePort: 41820, panelRemotePort: 41821, pub: FAKE_PUB });
  assert.equal(doppia,
    `restrict,port-forwarding,permitopen="127.0.0.1:41820",permitopen="127.0.0.1:41821",command="/bin/false" ${FAKE_PUB}`);
  // Dedup e onestà: stessa porta pannello e nexus → una sola dichiarazione.
  assert.equal(tunnel.authorizedKeysLine({ remotePort: 41820, panelRemotePort: 41820, pub: FAKE_PUB }).match(/permitopen/g).length, 1);
  // Porta pannello invalida: ignorata, MAI un campo malformato nella riga.
  assert.ok(tunnel.authorizedKeysLine({ remotePort: 41820, panelRemotePort: 70000, pub: FAKE_PUB }).includes('permitopen="127.0.0.1:41820",command'));
  // Senza pubkey non c'è riga da installare.
  assert.equal(tunnel.authorizedKeysLine({ remotePort: 41820, panelRemotePort: 41821 }), null);
});

// —— B: nodesAdd compone quando l'informazione c'è ————————————————

function nodeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-permit-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
  store.initStore(path.join(home, '.nexuscrew', 'nodes.json'));
  return home;
}

test('NEGATIVO nodesAdd con panelRemotePort noto: la riga porta ENTRAMBE le destinazioni', () => {
  const home = nodeHome();
  const l = [];
  try {
    const r = cmds.nodesAdd({
      home, log: (m) => l.push(m), name: 'vps', ssh: 'u@h',
      remotePort: 41820, panelRemotePort: 41821,
      keygen: () => FAKE_PUB,
    });
    assert.equal(r.code, 0);
    const out = l.join('\n');
    // Contro il codice attuale: la riga ha UNA destinazione — il tunnel del
    // pannello nasce autorizzato a non funzionare.
    assert.ok(out.includes('permitopen="127.0.0.1:41820",permitopen="127.0.0.1:41821"'),
      `due destinazioni esplicite nella riga generata: ${out}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('nodesAdd senza pannello (informazione che ancora non c\'è): una destinazione, come sempre', () => {
  const home = nodeHome();
  const l = [];
  try {
    cmds.nodesAdd({ home, log: (m) => l.push(m), name: 'vps', ssh: 'u@h', remotePort: 41820, keygen: () => FAKE_PUB });
    const out = l.join('\n');
    assert.ok(out.includes('restrict,port-forwarding,permitopen="127.0.0.1:41820",command="/bin/false"'));
    assert.equal((out.match(/permitopen/g) || []).length, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// —— C: probeForwardChannels — connect NON basta: il canale si vede dalla
// chiusura. Fedele al comportamento OpenSSH con PermitOpen negato: il listener
// locale ACCETTA la TCP e il canale negato la CHIUDE nel giro di millisecondi.

// Il caso 'aperto' tiene la connessione accettata SENZA chiuderla mai: e' il
// punto del test (il canale che regge). Ma srv.close() da solo non libera
// l'handle finche' una connessione resta aperta — e la chiusura lato client
// (settle() in probeForwardChannels distrugge il socket del probe DOPO la
// finestra di grazia) non e' garanzia che il lato server abbia gia' propagato
// la chiusura nell'istante in cui il test chiama srv.close(): una corsa, non
// un fatto. Senza tracciare e distruggere i socket accettati, il file puo'
// restare appeso da solo (osservato: misurato da Dev sul campo).
function serverChe(onConnessione) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const srv = net.createServer((s) => {
      sockets.add(s);
      s.once('close', () => sockets.delete(s));
      onConnessione(s);
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      srv,
      port: srv.address().port,
      chiudi: () => new Promise((r) => {
        for (const s of sockets) { try { s.destroy(); } catch (_) {} }
        srv.close(() => r());
      }),
    }));
  });
}

test('probeForwardChannels: distingue canale APERTO da canale RIFIUTATO da bind MANCANTE', async () => {
  const aperto = await serverChe(() => { /* il canale tiene: nessuna chiusura */ });
  const rifiutato = await serverChe((s) => { setImmediate(() => { try { s.destroy(); } catch (_) {} }); });
  const porteLibere = 1; // nessun listener: connect rifiutato dal loopback
  const libera = await serverChe(() => {});
  await libera.chiudi(); // ottiene una porta e la libera
  const esiti = await supervisor.probeForwardChannels({
    ports: [aperto.port, rifiutato.port, libera.port + porteLibere],
    graceMs: 300,
  });
  assert.equal(esiti.get(aperto.port), 'channel-ok', 'listener che tiene: canale aperto');
  assert.equal(esiti.get(rifiutato.port), 'channel-refused', 'accetta e chiude: il server ha negato il canale');
  assert.equal(esiti.get(libera.port + porteLibere), 'bind-failed', 'nessuno in ascolto: bind locale fallito');
  await Promise.all([aperto.chiudi(), rifiutato.chiudi()]);
});

// —— D: il rifiuto deve DIRE la riga da sostituire (chi ha la chiave vecchia) —

test('refusalHint: con il .pub accanto alla chiave dice la riga COMPLETA da incollare', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hint-'));
  try {
    const key = path.join(dir, 'tunnel_key');
    fs.writeFileSync(key, 'PRIVATA-finta');
    fs.writeFileSync(`${key}.pub`, `${FAKE_PUB}\n`);
    const hint = supervisor.refusalHint({
      remoteDestinations: ['127.0.0.1:41820', '127.0.0.1:41821'],
      identityFile: key,
    });
    assert.ok(hint.includes('authorized_keys'), 'nomina authorized_keys');
    assert.ok(hint.includes(`permitopen="127.0.0.1:41820",permitopen="127.0.0.1:41821"`), 'la riga con TUTTE le destinazioni');
    assert.ok(hint.includes(FAKE_PUB), 'la pubkey: la riga è incollabile');
    // Senza .pub: comunque le destinazioni, mai una riga incompleta.
    const senzaPub = supervisor.refusalHint({ remoteDestinations: ['127.0.0.1:41821'], identityFile: path.join(dir, 'inesistente') });
    assert.ok(senzaPub.includes('127.0.0.1:41821') && !senzaPub.includes('restrict,'), 'senza pubkey: cosa aggiungere, non una riga a metà');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Il contratto che la UI consuma: la riga e' un CAMPO, non una frase da
// ritagliare. Chi la mostra non deve conoscere il testo italiano costruito
// qui, altrimenti riscrivere la frase rompe la riparazione senza che nessun
// test se ne accorga.
test('refusalDetails espone la riga come campo, oltre che dentro la frase', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-'));
  const key = path.join(dir, 'id_ed25519');
  fs.writeFileSync(`${key}.pub`, `${pubValida()}\n`);
  const d = supervisor.refusalDetails({
    remoteDestinations: ['127.0.0.1:41800', '127.0.0.1:41821'],
    identityFile: key,
  });
  assert.ok(d.authorizedKeys.startsWith('restrict,port-forwarding,permitopen='),
    `il campo deve portare la riga intera: ${d.authorizedKeys}`);
  assert.ok(d.authorizedKeys.includes('127.0.0.1:41821'), 'la porta pannello deve esserci');
  assert.ok(d.hint.includes(d.authorizedKeys), 'la frase contiene la stessa riga, per chi legge un log');

  // Senza la chiave pubblica la riga completa non si puo' comporre: il campo
  // resta VUOTO invece di portare mezza istruzione che l'utente incollerebbe.
  const senza = supervisor.refusalDetails({ remoteDestinations: ['127.0.0.1:41800'] });
  assert.equal(senza.authorizedKeys, '');
  assert.ok(senza.hint.includes('permitopen'), 'la frase resta utile a chi legge');
});

// LA COMPOSIZIONE DAL NODO, cioe' la stessa funzione che la route del pairing
// usa per rispondere. Il test precedente prova il pezzo che compone la riga;
// questo prova la domanda che il prodotto si pone davvero — "quale riga deve
// incollare il peer di QUESTO nodo?" — e il suo limite.
//
// NON copre il giro HTTP completo: quello richiede un peer che risponda al
// join, e l'infrastruttura sta in pairing-panel-port-e2e.test.js. Qui si prova
// la logica che la route invoca, e il limite che decide se la riga esce.
test('authorizedKeysForNode: con la chiave la riga esce, senza identityFile no', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akfn-'));
  const key = path.join(dir, 'id_ed25519');
  fs.writeFileSync(`${key}.pub`, `${pubValida()}\n`);

  const conChiave = tunnel.authorizedKeysForNode(
    { remotePort: 41800, identityFile: key }, 41821);
  assert.ok(conChiave.includes('permitopen="127.0.0.1:41800"'), 'la porta nexus');
  assert.ok(conChiave.includes('permitopen="127.0.0.1:41821"'), 'la porta pannello');
  assert.ok(conChiave.includes('prova@test'), 'la chiave letta dal .pub accanto alla privata');

  // IL LIMITE, dichiarato: senza identityFile ssh usa le chiavi di default
  // dell'utente, un agent o la config, e il prodotto non sa quale. Non si
  // inventa una riga: si torna null. E non esiste un altro canale che ripari —
  // nemmeno la sonda del supervisore, che la chiave la ricava solo da `-i`.
  // Per quei nodi la riparazione automatica NON c'e', e il prodotto lo dice.
  assert.equal(tunnel.authorizedKeysForNode({ remotePort: 41800 }, 41821), null);
  // E con la chiave dichiarata ma il .pub assente, stesso verso: niente mezza istruzione.
  assert.equal(tunnel.authorizedKeysForNode(
    { remotePort: 41800, identityFile: path.join(dir, 'inesistente') }, 41821), null);
});

// I DUE RAMI DEVONO DIRE COSE DIVERSE. Prima, senza la chiave pubblica, si
// costruiva un frammento e lo si presentava come "Riga da usare (SOSTITUISCI
// quella esistente)": chi avesse obbedito avrebbe sostituito una riga valida
// con mezza riga, rompendo l'accesso invece di ripararlo. Un messaggio che
// peggiora il guasto e' peggio di nessun messaggio.
test('refusalDetails: senza chiave pubblica non promette una riga da sostituire', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal2-'));
  const key = path.join(dir, 'id_ed25519');
  fs.writeFileSync(`${key}.pub`, `${pubValida()}\n`);

  const con = supervisor.refusalDetails({ remoteDestinations: ['127.0.0.1:41800'], identityFile: key });
  assert.match(con.hint, /SOSTITUISCI/, 'con la chiave si sostituisce la riga intera');
  assert.equal(con.authorizedKeys, con.hint.slice(con.hint.indexOf('restrict,')),
    'e il campo copiabile e\' esattamente quella riga');

  // Nessun -i: ssh usa chiavi di default, un agent o la config. Da qui non si
  // puo' sapere quale, quindi non esiste una riga da dare.
  const senza = supervisor.refusalDetails({ remoteDestinations: ['127.0.0.1:41800', '127.0.0.1:41821'] });
  assert.equal(senza.authorizedKeys, '', 'niente campo copiabile: non c\'e\' una riga completa');
  assert.doesNotMatch(senza.hint, /SOSTITUISCI/, 'mai chiedere di sostituire cio\' che non abbiamo');
  assert.doesNotMatch(senza.hint, /Riga da usare/, 'e mai chiamarlo "riga"');
  assert.match(senza.hint, /A MANO/, 'si chiede una modifica manuale della riga esistente');
  assert.match(senza.hint, /permitopen="127\.0\.0\.1:41821"/, 'ma le destinazioni da aggiungere si dicono');

  // .pub illeggibile: stesso verso, con la causa diversa nominata.
  const rotta = supervisor.refusalDetails({
    remoteDestinations: ['127.0.0.1:41800'], identityFile: path.join(dir, 'assente'),
  });
  assert.equal(rotta.authorizedKeys, '');
  assert.doesNotMatch(rotta.hint, /SOSTITUISCI/);
  assert.match(rotta.hint, /non e' leggibile/, 'la causa e\' diversa e va detta');
});


// IL CONFINE CHE QUESTA LETTURA DIFENDE. Il valore letto viene CONCATENATO
// dopo `restrict,port-forwarding,permitopen=...`: se il file contenesse due
// chiavi, il blocco che l'utente copia diventerebbe due righe e la seconda
// sarebbe una chiave SENZA restrizioni. Incollandola si aggirerebbe proprio la
// regola che quella riga esiste per imporre. Qui non si tollera: si rifiuta.
test('readPublicKey: una sola chiave valida, altrimenti niente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubkey-'));
  const scrivi = (nome, testo) => {
    const k = path.join(dir, nome);
    fs.writeFileSync(`${k}.pub`, testo);
    return k;
  };

  const buona = scrivi('ok', `${pubValida('dag@host con spazi')}\n`);
  const letta = tunnel.readPublicKey(buona);
  assert.ok(letta && letta.startsWith('ssh-ed25519 '), 'una riga valida si legge');
  assert.ok(!/[\r\n]/.test(letta), 'e non porta dentro ritorni a capo');
  // e la riga composta resta UNA sola: e' la proprieta' che protegge l'utente
  const riga = tunnel.authorizedKeysForNode({ remotePort: 41800, identityFile: buona }, 41821);
  assert.equal(riga.split('\n').length, 1, 'il blocco da copiare e\' una riga sola');

  const dueChiavi = scrivi('due', `${pubValida()}\n${pubValida('seconda')}\n`);
  assert.equal(tunnel.readPublicKey(dueChiavi), null,
    'due chiavi concatenate: la seconda finirebbe SENZA restrizioni nel blocco copiato');
  assert.equal(tunnel.authorizedKeysForNode({ remotePort: 41800, identityFile: dueChiavi }, 41821), null,
    'e quindi non esce nessun blocco copiabile');

  assert.equal(tunnel.readPublicKey(scrivi('opz', `command="/bin/sh" ${pubValida()}\n`)), null,
    'opzioni prefissate: non e\' una chiave nuda e non si compone');
  const b = pubValida().split(' ')[1];
  assert.equal(tunnel.readPublicKey(scrivi('inc', `ssh-rsa ${b} x\n`)), null,
    'algoritmo dichiarato diverso da quello scritto dentro il blob');
  assert.equal(tunnel.readPublicKey(scrivi('vuoto', '\n\n')), null, 'nessuna chiave');
  assert.equal(tunnel.readPublicKey(scrivi('spazzatura', 'non-una-chiave\n')), null, 'testo qualunque');
});

// L'ORACOLO NON SIAMO NOI. Il test precedente costruiva la chiave con lo stesso
// sottoinsieme di formato che il parser controlla: verde per costruzione, e
// infatti quel finto era rifiutato da `ssh-keygen -l`. Qui la chiave dell'helper
// la valida CHI ESEGUE DAVVERO L'OPERAZIONE, e i casi che il parser deve
// rifiutare sono blob strutturalmente rotti — non nomi sbagliati.
test('readPublicKey: la struttura del blob, verificata contro ssh-keygen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-'));
  const scrivi = (nome, testo) => {
    const k = path.join(dir, nome);
    fs.writeFileSync(`${k}.pub`, testo);
    return k;
  };

  const buona = scrivi('ok', `${pubValida('oracolo@test')}\n`);
  let riconosciuta = null;
  try {
    riconosciuta = require('node:child_process')
      .execFileSync('ssh-keygen', ['-l', '-f', `${buona}.pub`], { encoding: 'utf8' }).trim();
  } catch (e) {
    // Se ssh-keygen non c'e' su questa macchina lo si DICHIARA: un oracolo
    // assente non e' un oracolo soddisfatto.
    riconosciuta = null;
    console.log('# ssh-keygen non disponibile: oracolo esterno non eseguito');
  }
  if (riconosciuta !== null) {
    assert.match(riconosciuta, /ED25519/, `ssh-keygen deve riconoscere la chiave dell'helper: ${riconosciuta}`);
  }
  assert.ok(tunnel.readPublicKey(buona), 'e il nostro lettore concorda con lui');

  // Blob composto SOLO dal nome dell'algoritmo: nessuna chiave dentro.
  const soloNome = campoSsh(Buffer.from('ssh-ed25519')).toString('base64');
  assert.equal(tunnel.readPublicKey(scrivi('sn', `ssh-ed25519 ${soloNome} x\n`)), null,
    'un blob senza la chiave non e\' una chiave');

  // ed25519 con payload troncato: la lunghezza dichiarata c\'e\', i byte no.
  const corto = Buffer.concat([campoSsh(Buffer.from('ssh-ed25519')), campoSsh(Buffer.alloc(1))]).toString('base64');
  assert.equal(tunnel.readPublicKey(scrivi('c1', `ssh-ed25519 ${corto} x\n`)), null,
    'ed25519 vuole 32 byte esatti: 1 non e\' "quasi giusto"');

  // Due chiavi separate da un CR NUDO: `split(/\r?\n/)` non le separava, e il
  // ritorno a capo finiva dentro il valore restituito.
  assert.equal(tunnel.readPublicKey(scrivi('cr', `${pubValida()}\r${pubValida()}\n`)), null,
    'un CR nudo non trasforma due chiavi in una riga sola');

  // Byte di coda dopo l'ultimo campo: firma di un blob costruito a mano.
  const conCoda = Buffer.concat([
    campoSsh(Buffer.from('ssh-ed25519')), campoSsh(Buffer.alloc(32)), Buffer.from([0x00, 0x01]),
  ]).toString('base64');
  assert.equal(tunnel.readPublicKey(scrivi('coda', `ssh-ed25519 ${conCoda} x\n`)), null,
    'byte che avanzano dopo l\'ultimo campo');
});
