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
const { generaCoppia, sshKeygenDisponibile } = require('./helpers/pubkey.js');
const { loadPty } = require('../lib/pty/provider.js');

// Chiave VALIDA, non un segnaposto: viene anche scritta in un `.pub` e riletta,
// e la lettura ora valida algoritmo e blob. Un finto piu' permissivo del vero
// rendeva verdi test che in produzione non sarebbero mai passati.
// `authorizedKeysLine` riceve la pubblica GIA' derivata: qui e' un valore
// opaco e una stringa fissa basta. Il legame con la privata lo prova il test
// dedicato piu' sotto, sull'unica funzione che lo puo' garantire.
const FAKE_PUB = 'ssh-ed25519 AAAAC3TestLinea PermitOpenPannello';

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
// restare appeso da solo (osservato: misurato sul campo).
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
    const key = generaCoppia(dir, 'tunnel_key', 'hint test');
    const pub = tunnel.readPublicKey(key);
    const hint = supervisor.refusalHint({
      remoteDestinations: ['127.0.0.1:41820', '127.0.0.1:41821'],
      identityFile: key,
    });
    assert.ok(hint.includes('authorized_keys'), 'nomina authorized_keys');
    assert.ok(hint.includes(`permitopen="127.0.0.1:41820",permitopen="127.0.0.1:41821"`), 'la riga con TUTTE le destinazioni');
    assert.ok(hint.includes(pub), 'la pubkey derivata dalla privata: la riga e\' incollabile');
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
  const key = generaCoppia(dir, 'id_ed25519');
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
test('authorizedKeysForNode: esito enumerato — riga solo se derived, mai mezza istruzione', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akfn-'));
  const key = generaCoppia(dir, 'id_ed25519');

  const conChiave = tunnel.authorizedKeysForNode(
    { remotePort: 41800, identityFile: key }, 41821);
  assert.equal(conChiave.outcome, tunnel.PUBKEY_DERIVED);
  assert.ok(conChiave.line.includes('permitopen="127.0.0.1:41800"'), 'la porta nexus');
  assert.ok(conChiave.line.includes('permitopen="127.0.0.1:41821"'), 'la porta pannello');
  assert.ok(conChiave.line.includes(tunnel.readPublicKey(key)),
    'la chiave derivata dalla privata, non letta da un file accanto');

  // IL LIMITE, dichiarato: senza identityFile ssh usa le chiavi di default
  // dell'utente, un agent o la config, e il prodotto non sa quale. Non si
  // inventa una riga — ma ora l'esito e' un DATO con nome, non un null muto:
  // chi compone il messaggio puo' dire la cosa giusta invece di tacere.
  const senzaIdentita = tunnel.authorizedKeysForNode({ remotePort: 41800 }, 41821);
  assert.equal(senzaIdentita.outcome, tunnel.PUBKEY_ACTUAL_KEY_UNKNOWN);
  assert.equal(senzaIdentita.line, null);
  // IdentityFile dichiarata ma assente sul disco: esito DISTINTO — prima era
  // lo stesso null di «cifrata», «illeggibile» e «ssh-keygen assente».
  const assente = tunnel.authorizedKeysForNode(
    { remotePort: 41800, identityFile: path.join(dir, 'inesistente') }, 41821);
  assert.equal(assente.outcome, tunnel.PUBKEY_NO_IDENTITY);
  assert.equal(assente.line, null);
});

// —— resolver a esito enumerato: i cinque esiti, uno per uno ————————————————
// Il difetto strutturale che ha generato meta' della 0.9.5: null|stringa
// comprimeva stati diversi. Qui ogni esito ha la sua prova; la coppia
// cifrata/in-chiaro sullo STESSO meccanismo prova che la discriminante
// guarda l'oggetto giusto.

test('resolvePublicKey: chiave valida -> derived con la riga', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-der-'));
  const key = generaCoppia(dir, 'id_ed25519');
  const r = tunnel.resolvePublicKey(key);
  assert.equal(r.outcome, tunnel.PUBKEY_DERIVED);
  assert.ok(r.line.startsWith('ssh-ed25519 '), 'la riga pubblica derivata');
});

test('resolvePublicKey: dichiarata ma assente sul disco -> no-identity (distinto da cifrata)', () => {
  const r = tunnel.resolvePublicKey('/non/esiste/da/nessuna/parte/id_ed25519');
  assert.equal(r.outcome, tunnel.PUBKEY_NO_IDENTITY);
  assert.equal(r.path, '/non/esiste/da/nessuna/parte/id_ed25519');
});

test('resolvePublicKey: non dichiarata -> actual-key-unknown (la chiave di ssh non e\' sapibile)', () => {
  for (const v of [undefined, null, '', '   ', 42]) {
    assert.equal(tunnel.resolvePublicKey(v).outcome, tunnel.PUBKEY_ACTUAL_KEY_UNKNOWN,
      `per ${JSON.stringify(v)}`);
  }
});

test('resolvePublicKey: ssh-keygen assente -> tool-unavailable (distinto dal file che non si deriva)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-tool-'));
  const key = generaCoppia(dir, 'id_ed25519'); // il file C'E' ed e' valido
  const mancaBinario = () => { const e = new Error('spawn ssh-keygen ENOENT'); e.code = 'ENOENT'; throw e; };
  const r = tunnel.resolvePublicKey(key, { execImpl: mancaBinario });
  assert.equal(r.outcome, tunnel.PUBKEY_TOOL_UNAVAILABLE,
    'l\'assenza del binario e\' un\'altra causa rispetto al file che non si deriva');
});

test('resolvePublicKey: cifrata vs in chiaro — la coppia discriminante (P4)', () => {
  if (!sshKeygenDisponibile()) return; // oracolo assente: dichiarato, non finto verde
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-cifr-'));
  const cifrata = path.join(dir, 'cifrata');
  const inchiaro = path.join(dir, 'inchiaro');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'passphrase-di-prova', '-f', cifrata],
    { stdio: 'ignore', timeout: 20000 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', inchiaro],
    { stdio: 'ignore', timeout: 20000 });

  // Prima erano lo stesso null. Ora: cifrata -> encrypted-or-unreadable,
  // in chiaro -> derived. Se la guardia guardasse l'oggetto sbagliato, i due
  // esiti coinciderebbero.
  const rc = tunnel.resolvePublicKey(cifrata);
  assert.equal(rc.outcome, tunnel.PUBKEY_ENCRYPTED_OR_UNREADABLE,
    'la chiave cifrata non si deriva, e ora ha il SUO esito');
  assert.equal(rc.line, undefined);
  const ri = tunnel.resolvePublicKey(inchiaro);
  assert.equal(ri.outcome, tunnel.PUBKEY_DERIVED);
  assert.ok(ri.line.startsWith('ssh-ed25519 '));
  // E il contratto storico resta intatto per chi compone ancora su null|stringa.
  assert.equal(tunnel.readPublicKey(cifrata), null);
  assert.equal(tunnel.readPublicKey(inchiaro), ri.line);
});

// I DUE RAMI DEVONO DIRE COSE DIVERSE. Prima, senza la chiave pubblica, si
// costruiva un frammento e lo si presentava come "Riga da usare (SOSTITUISCI
// quella esistente)": chi avesse obbedito avrebbe sostituito una riga valida
// con mezza riga, rompendo l'accesso invece di ripararlo. Un messaggio che
// peggiora il guasto e' peggio di nessun messaggio.
test('refusalDetails: senza chiave pubblica non promette una riga da sostituire', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal2-'));
  const key = generaCoppia(dir, 'id_ed25519');

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

  // Identita' dichiarata ma assente sul disco: col resolver enumerato e il
  // formatter unico la causa ORA e' ESATTA — non piu' l'elenco di possibilita'
  // che si usava quando non si potevano distinguere.
  const rotta = supervisor.refusalDetails({
    remoteDestinations: ['127.0.0.1:41800'], identityFile: path.join(dir, 'assente'),
  });
  assert.equal(rotta.authorizedKeys, '');
  assert.equal(rotta.outcome, tunnel.PUBKEY_NO_IDENTITY, 'l\'esito enumerato viaggia col hint');
  assert.doesNotMatch(rotta.hint, /SOSTITUISCI/);
  assert.match(rotta.hint, /non esiste/, 'dice la causa ESATTA: il file manca');
  assert.doesNotMatch(rotta.hint, /passphrase/,
    'e non elenca piu\' possibilita\' che ora sa distinguere');
  assert.doesNotMatch(rotta.hint, /parte pubblica non e' leggibile/,
    'MAI dire che la pubblica non e\' leggibile: con una chiave cifrata esiste eccome');

  // IL CASO VERO, che il test precedente non copriva: privata cifrata con il
  // suo `.pub` valido accanto. La pubblica ESISTE; cio' che non si puo' fare in
  // batch e' derivarla. Dirlo male manda a cercare il problema dove non e'.
  if (sshKeygenDisponibile()) {
    const cifrata = path.join(dir, 'cifrata');
    require('node:child_process').execFileSync('ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', 'passphrase-di-prova', '-f', cifrata], { stdio: 'ignore', timeout: 20000 });
    assert.ok(fs.existsSync(`${cifrata}.pub`), 'il .pub c\'e\' ed e\' valido');
    const conCifrata = supervisor.refusalDetails({
      remoteDestinations: ['127.0.0.1:41800'], identityFile: cifrata,
    });
    assert.equal(conCifrata.authorizedKeys, '', 'nessuna riga: la privata non e\' derivabile in batch');
    assert.equal(conCifrata.outcome, tunnel.PUBKEY_ENCRYPTED_OR_UNREADABLE,
      'la cifrata ha il SUO esito, distinto dal file mancante');
    assert.match(conCifrata.hint, /cifrata o illeggibile/, 'la causa esatta nel hint');
    assert.doesNotMatch(conCifrata.hint, /non esiste/, 'e non dice che manca: il file c\'e\'');
    assert.doesNotMatch(conCifrata.hint, /parte pubblica non e' leggibile/,
      'e il messaggio non afferma una cosa falsa su un file che esiste');
  }
});


// IL LEGAME FRA LE DUE META', che e' la proprieta' che conta. Validare `A.pub`
// prova che quel file contiene UNA chiave valida, non che sia LA chiave di A.
// Se `A.pub` e' stale o ripristinato da un backup, si pubblica la chiave
// sbagliata: l'utente sostituisce la riga di A con quella di B e al reconnect
// successivo A perde l'accesso — il prodotto causa il guasto che prometteva di
// riparare. Derivare la pubblica DALLA privata rende il legame garantito per
// costruzione invece che verificato a posteriori.
test('readPublicKey: la pubblica viene dalla privata, non dal file accanto', (t) => {
  if (!sshKeygenDisponibile()) return t.skip('ssh-keygen non disponibile su questa macchina');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-'));
  const A = generaCoppia(dir, 'A', 'chiave-A');
  const B = generaCoppia(dir, 'B', 'chiave-B');

  const daA = tunnel.readPublicKey(A);
  assert.ok(daA && daA.startsWith('ssh-ed25519 '), 'una coppia vera si legge');

  // Il `.pub` di A viene sostituito con quello di B: e' il caso reale del
  // backup ripristinato o del file stale.
  fs.copyFileSync(`${B}.pub`, `${A}.pub`);
  assert.equal(tunnel.readPublicKey(A), daA,
    'la pubblica non cambia: viene dalla privata, il file accanto non la decide');

  // E senza `.pub` del tutto continua a funzionare: quel file non serve piu'.
  fs.unlinkSync(`${A}.pub`);
  assert.equal(tunnel.readPublicKey(A), daA, 'il .pub non e\' piu\' una dipendenza');

  // Una privata che non esiste, o che non e' una chiave, non produce niente.
  assert.equal(tunnel.readPublicKey(path.join(dir, 'inesistente')), null);
  fs.writeFileSync(path.join(dir, 'spazzatura'), 'non sono una chiave\n');
  assert.equal(tunnel.readPublicKey(path.join(dir, 'spazzatura')), null);

  // La riga composta resta UNA sola.
  const esito = tunnel.authorizedKeysForNode({ remotePort: 41800, identityFile: A }, 41821);
  assert.equal(esito.outcome, tunnel.PUBKEY_DERIVED);
  assert.equal(esito.line.split('\n').length, 1, 'il blocco da copiare e\' una riga sola');
  assert.ok(esito.line.includes('permitopen="127.0.0.1:41821"'), 'con la destinazione pannello');
});

// SE L'ORACOLO NON C'E', NON SI PROMETTE NIENTE.
test('readPublicKey: senza ssh-keygen non si compone nessuna riga', () => {
  const assente = () => { const e = new Error('spawn ssh-keygen ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.equal(tunnel.readPublicKey('/qualunque/chiave', { execImpl: assente }), null,
    'binario assente: si rifiuta, non si tira a indovinare');
  const rifiuta = () => { const e = new Error('load failed'); e.status = 255; throw e; };
  assert.equal(tunnel.readPublicKey('/qualunque/chiave', { execImpl: rifiuta }), null,
    'e una privata illeggibile o protetta da passphrase porta allo stesso esito');
});

// L'HELPER CHE SOPRAVVIVE AL PADRE. `execFileSync` col timeout uccide SOLO il
// processo diretto: se `ssh-keygen` ha lanciato un askpass, quello resta orfano.
// Il supervisore chiama questa strada a ogni rifiuto del canale, quindi i retry
// accumulerebbero processi che nessuno raccoglie.
//
// LA PRIMA VERSIONE DI QUESTO TEST ERA CIECA, e vale la pena che resti scritto:
// il finto «che non torna» usava `exec -a <nome> sleep`, che e' una bashism —
// `/bin/sh` qui e' dash, l'helper moriva subito con exit 127, e le asserzioni
// restavano verdi ANCHE SENZA la difesa. Il marcatore ora sta nel NOME del file
// dell'helper (che `ps` mostra comunque) e il corpo e' un `sleep` nudo.
//
// E il controllo negativo e' DENTRO il test, non a fianco: il secondo braccio
// esegue la stessa chiamata con l'ambiente EREDITATO — cioe' il comportamento
// di prima — e pretende che l'orfano ci sia. Se un giorno qualcuno togliesse la
// difesa, il primo braccio diventerebbe rosso; se la togliesse anche dal
// braccio di controllo, sarebbe il secondo a cadere.
test('readPublicKey: una privata cifrata non lascia discendenti askpass', (t) => {
  if (!sshKeygenDisponibile()) return t.skip('ssh-keygen non disponibile su questa macchina');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askpass-'));
  const key = path.join(dir, 'cifrata');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'passphrase-di-prova', '-f', key],
    { stdio: 'ignore', timeout: 20000 });

  // UN SOLO PROCESSO, CON UN'IDENTITA' OSSERVABILE. Due difetti pagati qui:
  //  1. marcavo la shell e uccidevo quella, ma `sleep` era un FIGLIO separato e
  //     senza marcatore — sopravviveva, e la ricerca dei residui non lo vedeva:
  //     il test che prova «non lascia orfani» ne lasciava uno per esecuzione;
  //  2. poi ho identificato il processo col solo PID letto da un file. Un pid
  //     e' un NUMERO, non un'identita': se la suite resta sospesa oltre la vita
  //     dell'helper (oggi se n'e' vista una ferma 23 minuti), quel numero puo'
  //     essere riassegnato e il cleanup ucciderebbe un estraneo dello stesso
  //     utente. E' la stessa classe che il prodotto ha appena finito di
  //     chiudere nel pidfile, reintrodotta in un test.
  // `exec` sostituisce la shell, quindi il processo e' UNO; `tail -f` su un
  // path unico di questo tempdir mette quel path nell'argv, dove resta
  // osservabile fino al segnale. Prima di uccidere si RIVERIFICA che l'argv sia
  // ancora il nostro: il numero da' la liveness, l'argv da' l'appartenenza.
  const testimone = path.join(dir, `askpass-${process.pid}-${Date.now()}.vivo`);
  fs.writeFileSync(testimone, 'x');
  const pidfile = path.join(dir, 'askpass.pid');
  const ap = path.join(dir, 'ap.sh');
  fs.writeFileSync(ap, `#!/bin/sh\necho $$ > ${pidfile}\nexec tail -f -n 0 ${testimone} >/dev/null 2>&1\n`, { mode: 0o700 });

  const pidResiduo = () => {
    try {
      const n = Number(String(fs.readFileSync(pidfile, 'utf8')).trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch (_) { return null; }
  };
  // Appartenenza PRIMA della liveness: un pid vivo che non porta il nostro
  // testimone nell'argv non e' nostro, e non si tocca.
  const nostro = (pid) => {
    try {
      const argv = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
      return argv.includes(testimone);
    } catch (_) { return false; }
  };
  const vivo = () => {
    const pid = pidResiduo();
    return pid !== null && nostro(pid);
  };
  // P2 (rilievo auditor): `uccidiResidui` cancellava il pidfile PRIMA che
  // l'assert finale potesse rileggerlo — `vivo()` a quel punto non trova piu'
  // nessun pid e torna false SEMPRE, che l'uccisione sia riuscita o no.
  // L'auditor ha tolto il SIGKILL sotto e la suite e' rimasta verde: la
  // guardia non pinnava niente. Ora il pid si legge e si CATTURA prima di
  // toccare qualunque file, e l'ultimo assert lo riverifica per appartenenza
  // (argv) — non per numero nudo, ne' rileggendolo da un file che non c'e' piu'.
  let pidCatturato = null;
  const uccidiResidui = () => {
    const pid = pidResiduo();
    pidCatturato = pid;
    if (pid !== null && nostro(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    try { fs.unlinkSync(pidfile); } catch (_) {}
  };

  assert.equal(vivo(), false, 'nessun residuo prima di cominciare');

  const ambienteOstile = { SSH_ASKPASS: ap, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':99' };
  try {
    // BRACCIO 1 — la difesa: ambiente controllato dentro readPublicKey.
    const t0 = Date.now();
    const salva = { ...process.env };
    Object.assign(process.env, ambienteOstile);
    let esito;
    try { esito = tunnel.readPublicKey(key); } finally {
      for (const k of Object.keys(ambienteOstile)) {
        if (salva[k] === undefined) delete process.env[k]; else process.env[k] = salva[k];
      }
    }
    assert.equal(esito, null, 'una privata cifrata non si deriva in batch');
    assert.ok(Date.now() - t0 < 4000, 'fallisce SUBITO, non aspettando il timeout');
    assert.equal(vivo(), false, 'e non lascia nessun helper askpass vivo dietro di se');

    // BRACCIO 2 — il controllo negativo: la STESSA chiamata con l'ambiente
    // ereditato, cioe' come si comportava prima. Se qui l'orfano NON comparisse,
    // vorrebbe dire che il braccio 1 non prova niente.
    const ereditaAmbiente = (bin, args, opts) => execFileSync(bin, args, {
      ...opts, env: { ...process.env, ...ambienteOstile },
    });
    const t1 = Date.now();
    assert.equal(tunnel.readPublicKey(key, { execImpl: ereditaAmbiente }), null,
      'anche senza la difesa la chiave non si deriva: cambia il COSTO, non l\'esito');
    const durataSenza = Date.now() - t1;
    assert.equal(vivo(), true,
      `senza l'ambiente controllato l'askpass DEVE restare orfano, altrimenti il braccio 1 non prova niente (durata ${durataSenza} ms)`);
  } finally {
    uccidiResidui();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Sul PID catturato PRIMA della cancellazione, non riletto da un pidfile
  // che a questo punto non esiste piu': `nostro` interroga il kernel via
  // `ps`, non il filesystem del tempdir gia' rimosso — un pid morto (o
  // riassegnato a un estraneo senza il nostro testimone nell'argv) risulta
  // correttamente "non nostro" comunque.
  assert.ok(pidCatturato !== null, 'il braccio 2 deve aver lasciato un pid da ripulire, altrimenti non si e\' provato niente');
  assert.equal(nostro(pidCatturato), false, 'il test ripulisce i propri residui, e lo chiede al kernel');
});

// —— P4: il difetto che il gate non-PTY non poteva vedere ——————————————————
//
// Con una chiave CIFRATA e un controlling terminal, `ssh-keygen` legge la
// passphrase da /dev/tty — non da stdin, e con SSH_ASKPASS_REQUIRE=never
// nemmeno da un askpass — e li' resta ad aspettare fino al timeout intero di
// execFileSync. Il percorso e' raggiungibile in produzione: `nexuscrew serve`
// foreground chiama authorizedKeysForNode in modo sincrono durante il pairing.
//
// Il gate non-PTY non l'ha visto per tre giri perche' senza controlling
// terminal il difetto non si tocca: ssh-keygen non apre /dev/tty e fallisce
// subito anche sul codice rotto. Quindi questo test il PTY SE LO PORTA:
// node-pty, lo stesso provider dei terminali. E la probe dichiara se il
// controlling terminal era davvero aperto — un verde che mente sul tty non
// vale niente.

// Lancia la probe dentro un PTY reale e aspetta l'exit (con watchdog proprio:
// il timeout iniettato nella readPublicKey e' della probe, non del lancio).
function lanciaProbePty(pty, args, watchdogMs) {
  const probe = path.join(__dirname, 'helpers', 'pubkey-pty-probe.js');
  return new Promise((resolve, reject) => {
    let out = '';
    let sciolto = false;
    const child = pty.spawn(process.execPath, [probe, ...args], {
      cols: 80, rows: 24,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || os.homedir() },
    });
    const watchdog = setTimeout(() => {
      if (sciolto) return;
      sciolto = true;
      try { child.kill(); } catch (_) {}
      reject(new Error(`probe PTY oltre il watchdog di ${watchdogMs} ms; output: ${out}`));
    }, watchdogMs);
    child.onData((d) => { out += d; });
    child.onExit(({ exitCode }) => {
      if (sciolto) return;
      sciolto = true;
      clearTimeout(watchdog);
      resolve({ out, exitCode });
    });
  });
}

// La probe stampa UNA riga JSON; il PTY ci mette del suo (\r, eventuali
// echi): si cerca la riga che ha forma di JSON, non si assume sia l'unica.
function parseProbe(out) {
  for (const riga of String(out).split('\n')) {
    const pulita = riga.replace(/\r/g, '').trim();
    if (pulita.startsWith('{') && pulita.endsWith('}')) {
      try { return JSON.parse(pulita); } catch (_) { /* continua a cercare */ }
    }
  }
  return null;
}

test('readPublicKey (P4): sotto PTY la chiave cifrata fallisce subito, non sul timeout', async (t) => {
  if (!sshKeygenDisponibile()) return t.skip('ssh-keygen non disponibile su questa macchina');
  let pty;
  try { pty = loadPty(); } catch (e) {
    // Niente provider PTY reale: il difetto non si tocca in-test. SI DICHIARA,
    // non si finge verde. Riproduzione a mano, dentro un PTY vero:
    //   script -qec 'node tests/helpers/pubkey-pty-probe.js <chiave-cifrata> 3000' /dev/null
    // (su macOS: script -q /dev/null node tests/helpers/pubkey-pty-probe.js <chiave> 3000)
    return t.skip(`nessun provider PTY reale disponibile (${e.message}): difetto non riproducibile in-test`);
  }
  const TIMEOUT_MS = 3000; // iniettato: l'esito deve arrivare SENZA che scatti
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p4-pty-'));
  const cifrata = path.join(dir, 'cifrata');
  const inChiaro = path.join(dir, 'inchiaro');
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'passphrase-di-prova', '-f', cifrata],
      { stdio: 'ignore', timeout: 20000 });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', inChiaro],
      { stdio: 'ignore', timeout: 20000 });

    // BRACCIO 1 — la chiave cifrata: null, e SUBITO. Non un cronometro stretto
    // (ci e' gia' costato un falso rosso 164 vs 110): si inietta il timeout e
    // si pretende che l'esito arrivi a meta' strada da esso, con margine largo.
    // Sul codice rotto ssh-keygen aspetta il timeout INTERO su /dev/tty:
    // elapsedMs ~ TIMEOUT_MS, e questa asserzione cade.
    const r1 = parseProbe((await lanciaProbePty(pty, [cifrata, String(TIMEOUT_MS)], TIMEOUT_MS + 15000)).out);
    assert.ok(r1, 'la probe deve stampare l\'esito in JSON');
    assert.equal(r1.tty, 'aperto',
      'la probe DEVE avere un controlling terminal aperto: senza, ssh-keygen non tocca /dev/tty e questo test non vede il difetto');
    assert.equal(r1.esito, null, 'una chiave cifrata non si deriva in batch');
    assert.ok(r1.elapsedMs < TIMEOUT_MS / 2,
      `deve fallire subito (${r1.elapsedMs} ms), non aspettare il timeout di ${TIMEOUT_MS} ms: se cade, ssh-keygen sta leggendo la passphrase da /dev/tty`);

    // BRACCIO 2 — il caso buono non deve regredire (misura F del briefing):
    // chiave in chiaro, stessa cura force+askpass-inesistente, stessa PTY.
    const r2 = parseProbe((await lanciaProbePty(pty, [inChiaro, String(TIMEOUT_MS)], TIMEOUT_MS + 15000)).out);
    assert.ok(r2, 'la probe deve stampare l\'esito in JSON (chiave in chiaro)');
    assert.equal(r2.tty, 'aperto', 'anche il caso buono va misurato sotto PTY');
    assert.ok(typeof r2.esito === 'string' && r2.esito.startsWith('ssh-ed25519 '),
      'la chiave in chiaro continua a derivare la pubblica');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
