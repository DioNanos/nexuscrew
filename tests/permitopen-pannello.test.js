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

const FAKE_PUB = 'ssh-ed25519 AAAAfake PermitOpenPannello test key';

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
  fs.writeFileSync(`${key}.pub`, 'ssh-ed25519 AAAAC3Test prova\n');
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
