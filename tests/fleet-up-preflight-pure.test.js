'use strict';
// Preflight puro dell'up vl e riconciliazione di un prepared mai materializzato.
//
// Il guasto che questi test fissano: un rifiuto NOTO in preflight (la claim
// della root vl di un altro lancio, VL_ROOT_COLLISION) veniva scoperto DOPO la
// scrittura del record `prepared`, e l'abort che seguiva non provava l'host
// assente (base della cella presente, il caso reale) — cosi' restavano sul
// disco un record v2 `prepared, incerto:true` e la guardia `esitiIncerti` in
// memoria, e ogni up successivo rispondeva STOP_UNKNOWN. La riconciliazione
// esplicita restava a sua volta bloccata su HOST_BARRIER context-missing,
// perche' la barriera esigeva un host-context col launchId del record: per un
// prepared mai materializzato quel file e' del lancio VECCHIO, e il nuovo
// launchId non potra' mai comparirvi.
//
// Contratti (preflight puro, poi ammissione durevole):
//  - un rifiuto deterministico prima dell'ammissione non scrive NESSUN byte
//    (record, claim, own) e non lascia esitiIncerti: dopo il rifiuto il
//    launch-state dice none;
//  - tolta la causa del rifiuto, l'up successivo riesce: nessun veleno;
//  - una corsa persa alla riserva DOPO il prepared si classifica con la sua
//    fase reale (certamente non materializzato: nessuna claim nostra, nessun
//    effetto) e si chiude con la rimozione del record, non con un incerto;
//  - un record `prepared` (fase write-ahead precedente a ogni creazione) si
//    riconcilia con la prova della fase, senza esigere l'host-context del
//    vecchio lancio e senza toccare la lease di un altro lancio;
//  - un record `creating` (entrato in creazione) resta incerto: la mancanza
//    di ack non prova che niente sia nato.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite } = require('../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const radici = require('../lib/fleet/vl-roots.js');
const sezione = require('../lib/fleet/vl-claim-section.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const { vlCellBaseDir } = require('../lib/fleet/managed.js');
const {
  OWNER_INSTANCE_ID, STATO_HOST_ATTESTATO,
} = require('./helpers/vl-attestato.js');

const SONDA_NONE = JSON.stringify({
  state: 'none',
  capabilities: ['host_stop_v1', 'host_peer_identity_v1', 'host_stop_expected_v1'],
  peer_identity_support: 'supported',
});

// Il launcher finto: '--version' per il gate di versione, 'host status' con le
// capacita' peer/stop e l'host attestato (o `none` sulle root usa e getta
// della sonda di capacita'), silenzio altrove. Contratto del binario attestato
// condiviso con gli altri test runtime del fleet.
function scriptVl() {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'vl 0.5.0\\n'; exit 0; fi
if [ "$1" = "host" ]; then
  root=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--server-root" ]; then root=$a; fi
    prev=$a
  done
  case $root in
    *nc-vl-cap-*) printf '%s\\n' '${SONDA_NONE}' ;;
    *) printf '%s\\n' '${STATO_HOST_ATTESTATO}' ;;
  esac
  exit 0
fi
exit 0
`;
}

// tmux finto del ciclo di lancio reale (matrice argv): le sessioni vive sono
// un file di stato, new-session/kill-session lo mutano, capture-pane mostra
// il marcatore di pronta della TUI e -C serve il canale di controllo. In piu'
// qui has-session deve dare un VERDETTO: uscita 1 con «can't find session»
// quando il nome non e' fra i vivi — e' l'assenza che il valutatore accetta.
function scriviTmuxFinto(root, statoPath) {
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
const args = argv[0] === '-S' ? argv.slice(2) : argv;
if (args[0] === '-C') {
  if (process.argv.includes('new-session')) {
    const { spawnSync: creaSync } = require('node:child_process');
    const rCrea = creaSync(process.execPath, [__filename].concat(process.argv.slice(2).filter((a) => a !== '-C')), { encoding: 'utf8' });
    const corpoCrea = (s) => (s ? (s.endsWith('\\n') ? s : s + '\\n') : ''); if ((rCrea.status || 0) === 0) process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stdout) + '%end 1 0 1\\n');
    else process.stdout.write('%begin 1 0 1\\n' + corpoCrea(rCrea.stderr) + '%error 1 0 1\\n');
  } else {
  process.stdout.write('%begin 1 0 1\\nnc-control-open\\n%end 1 0 1\\n');
  }
  const { spawnSync } = require('node:child_process');
  let buf = '';
  let n = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\\n')) >= 0) {
      const riga = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!riga) continue;
      if (riga === 'display-message -p nc-control-open') continue;
      n += 1;
      const r = spawnSync(process.execPath, [__filename, '-S', 'sock'].concat(riga.split(/\\s+/)), { encoding: 'utf8' });
      if ((r.status || 0) === 0) process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stdout || '') + '%end 1 ' + n + ' 1\\n');
      else process.stdout.write('%begin 1 ' + n + ' 1\\n' + (r.stderr || '') + '%error 1 ' + n + ' 1\\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
  return;
}
const STATO = ${JSON.stringify(statoPath)};
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  const i = args.indexOf('-s');
  const nome = i >= 0 ? args[i + 1] : 'sessione-senza-nome';
  fs.writeFileSync(STATO, vive().concat([nome]).join('\\n') + '\\n');
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message' && process.argv.join(' ').includes('pane_pid')) { process.stdout.write('4242\\t2222\\n'); process.exit(0); }
if (cmd === 'display-message') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
if (cmd === 'capture-pane') {
  process.stdout.write('>\\nvivling [o] writer e42 \\u00b7 zai-a-coding \\u00b7 \\u2191267     esc quit \\u00b7 ^y yield\\n');
  process.exit(0);
}
if (cmd === 'has-session') {
  const t = String(args[args.indexOf('-t') + 1] || '').replace(/^=/, '');
  if (vive().includes(t)) process.exit(0);
  process.stderr.write("can't find session: " + t + "\\n");
  process.exit(1);
}
if (cmd === 'kill-session') {
  const t = String(args[args.length - 1] || '').replace(/^=/, '');
  fs.writeFileSync(STATO, vive().filter((n) => n !== t).map((n) => n + '\\n').join(''));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  return tmuxBin;
}

function idLancio() { return crypto.randomBytes(8).toString('hex'); }

// Fotografia ricorsiva di una directory: nome -> sha256 del contenuto (e modo,
// per accorgersi di chmod silenziosi). Le directory vuote non esistono per la
// foto: conta cio' che sta su disco. Il lock di scrittore (.writer-lock.json)
// e' infrastruttura di serializzazione del runtime, preso dal primo preflight
// e tenuto per la vita del processo: non e' un effetto del lancio e cambia a
// ogni presa, quindi resta fuori dalla foto.
function foto(dir) {
  const out = [];
  const walk = (d, pref) => {
    let nomi;
    try { nomi = fs.readdirSync(d); } catch (_) { return; }
    for (const n of nomi.sort()) {
      const p = path.join(d, n);
      const rel = pref ? `${pref}/${n}` : n;
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, rel);
      else if (n !== '.writer-lock.json') out.push(`${rel}:${st.mode & 0o777}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)}`);
    }
  };
  walk(dir, '');
  return out.join('\n');
}

async function crea(t, { riservaRootClaim = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-r0-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'Cella');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.nexuscrew', 'run'), { mode: 0o700 });

  const catalogo = path.join(home, 'catalogo.toml');
  fs.writeFileSync(catalogo, '[profiles.work]\nmodel = "m-work"\n', { mode: 0o600 });

  const pathBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(pathBin, scriptVl(), { mode: 0o755 });
  fs.chmodSync(pathBin, 0o755);

  const statoTmux = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoTmux, '');
  const tmuxBin = scriviTmuxFinto(root, statoTmux);

  const defs = {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL', rc: false,
      managed: {
        client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard',
        vlBinary: pathBin, vlConfigFile: catalogo, vlProfile: 'work',
      },
    }],
    cells: [{ id: 'Cella', tmuxSession: 'cloud-Cella', cwd, engine: 'vl.native', boot: false }],
  };
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, defs);

  const tickets = [];
  const runtime = createBuiltinRuntime({
    cfg: {
      activityHooks: false, launchReadyMs: 0,
      filesRoot: path.join(home, 'NexusFiles'),
      log: () => {}, vlLaunchCooldownMs: 0,
    },
    home,
    defsPath,
    tmuxBin,
    readonly: () => false,
    launchBroker: {
      issue: async (payload) => {
        tickets.push({ command: payload.command, args: [...(payload.args || [])] });
        return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
      },
      revoke: async () => {},
    },
    boot: defs,
    identityOwnerInstanceId: OWNER_INSTANCE_ID,
    ...(riservaRootClaim ? { riservaRootClaim } : {}),
  });

  t.after(() => {
    try { runtime.shutdown(); } catch (_) { /* best-effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    root, home, defs, runtime, tickets, statoTmux,
    filesRoot: path.join(home, 'NexusFiles'),
    claimsDir: radici.dirClaim(home),
    vlRoot: radici.radiceServer(home, OWNER_INSTANCE_ID, 'Cella'),
    base: vlCellBaseDir(home, OWNER_INSTANCE_ID, 'Cella'),
    sessioniVive: () => fs.readFileSync(statoTmux, 'utf8').split('\n').filter(Boolean),
  };
}

// La claim della root di un lancio VECCHIO (altro launchId, stessa cella): il
// modo in cui si presenta la collisione reale.
async function claimVecchia(h, launchId) {
  const esito = await radici.riserva({
    home: h.home, root: h.vlRoot, launchId,
    ownerInstanceId: OWNER_INSTANCE_ID, cellId: 'Cella', budgetMs: 4000,
  });
  assert.equal(esito.ok, true, `claim del vecchio lancio non ottenuta: ${JSON.stringify(esito)}`);
}

// L'ombra del lancio VECCHIO: base della cella presente, root host presente e
// host-context del vecchio launchId. E' la condizione del guasto reale — con
// la root gia' li', l'abort di un lancio rifiutato non puo' provare l'host
// assente e il percorso attuale lo dichiara incerto lasciando il record.
function ombraVecchia(h, launchIdVecchio) {
  fs.mkdirSync(path.join(h.base, 'state', 'vl', 'host-v1'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(h.base, 'host-context.json'), JSON.stringify({
    launchId: launchIdVecchio,
    vlBin: '/usr/local/bin/vl',
    vlBinSha256: 'ab'.repeat(32),
    XDG_STATE_HOME: path.join(h.base, 'state'),
    XDG_DATA_HOME: path.join(h.base, 'data'),
    XDG_CONFIG_HOME: path.join(h.base, 'config'),
    HOME: h.home,
    uid: process.getuid(),
    serverRoot: h.vlRoot,
    ts: 1,
    version: 2,
    hostIdentity: {
      state: 'live', source: 'kernel-peer-v1', instanceId: OWNER_INSTANCE_ID,
      pid: 4242, uid: process.getuid(),
      bootId: '12345678-1234-1234-1234-123456789abc',
      pidNamespaceInode: '4026531836', startTicks: '1234', pgid: 4242, sid: 4242,
    },
  }), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// T1 — il rifiuto noto della claim, scoperto in preflight, non scrive nulla.
// ---------------------------------------------------------------------------
test('up vl con claim di un altro lancio: rifiuto in preflight senza record, senza effetti', async (t) => {
  const h = await crea(t);
  ombraVecchia(h, idLancio());
  await claimVecchia(h, idLancio());

  const primaTargets = foto(h.filesRoot);
  const primaClaims = foto(h.claimsDir);

  await assert.rejects(
    () => h.runtime.up('Cella'),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.fleetCode, 'VL_ROOT_COLLISION');
      return true;
    },
  );

  // Byte e stato in memoria: invariati. Nessun record prepared, nessuna
  // traccia nuova nelle claim, nessuno spawn, nessuna sessione.
  assert.equal(foto(h.filesRoot), primaTargets, 'launch-targets deve restare intatto dopo il rifiuto');
  assert.equal(foto(h.claimsDir), primaClaims, 'vl-root-claims deve restare intatto dopo il rifiuto');
  assert.equal(h.tickets.length, 0, 'nessun payload di lancio emesso');
  assert.deepEqual(h.sessioniVive(), [], 'nessuna sessione tmux creata');

  // E la pratica risulta mai aperta: il rifiuto non ha lasciato un prepared
  // incerto dietro di sé.
  const st = await h.runtime.launchState('Cella');
  assert.equal(st.classification, 'none');
  assert.equal(st.launchId, null);
});

// ---------------------------------------------------------------------------
// T2 — tolta la causa, l'up successivo riesce: il rifiuto non ha avvelenato.
// ---------------------------------------------------------------------------
test('dopo il rifiuto di preflight, liberata la claim, l’up riesce senza STOP_UNKNOWN', async (t) => {
  const h = await crea(t);
  const vecchio = idLancio();
  ombraVecchia(h, vecchio);
  await claimVecchia(h, vecchio);

  await assert.rejects(
    () => h.runtime.up('Cella'),
    (err) => err.status === 409 && err.fleetCode === 'VL_ROOT_COLLISION',
  );

  // Il vecchio lancio rilascia la sua claim: la causa del rifiuto sparisce.
  const rilascio = await radici.rilascia({
    home: h.home, root: h.vlRoot, launchId: vecchio,
    ownerInstanceId: OWNER_INSTANCE_ID, cellId: 'Cella', budgetMs: 4000,
  });
  assert.equal(rilascio.ok, true, `rilascio del vecchio lancio fallito: ${JSON.stringify(rilascio)}`);

  const res = await h.runtime.up('Cella');
  assert.equal(res.ok, true, `l'up dopo il rifiuto non e' riuscito: ${JSON.stringify(res)}`);
  assert.equal(h.tickets.length, 1, 'un solo lancio emesso');
  assert.deepEqual(h.sessioniVive(), ['cloud-Cella'], 'la sessione della cella è l’unica creata');
});

// ---------------------------------------------------------------------------
// T5 — corsa persa alla riserva DOPO l'ammissione: si classifica con la fase
// reale (certamente non materializzato), non con un incerto eterno.
// ---------------------------------------------------------------------------
test('claim apparsa dopo l’ammissione: la corsa persa chiude aborted, senza record ne’ incerti', async (t) => {
  const vecchio = idLancio();
  // Il seam della riserva pubblica la lease di un altro lancio NELLA finestra
  // fra il preflight read-only della claim (che l'ha vista libera) e la
  // riserva vera: e' la corsa fra ammissione e riserva, con il record
  // prepared gia' scritto quando la collisione si scopre.
  let corsaIniettata = false;
  const h = await crea(t, {
    riservaRootClaim: async (opts) => {
      if (!corsaIniettata) {
        corsaIniettata = true;
        const canon = sezione.canonicaRadice(opts.root);
        const claims = radici.dirClaim(opts.home);
        fs.mkdirSync(claims, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(claims, `${sezione.hashRadice(canon)}.lease`), JSON.stringify({
          v: 1, kind: 'lease', root: canon,
          ownerInstanceId: opts.ownerInstanceId, cellId: opts.cellId, launchId: vecchio,
        }), { mode: 0o600 });
      }
      return radici.riserva(opts);
    },
  });
  ombraVecchia(h, idLancio());

  await assert.rejects(
    () => h.runtime.up('Cella'),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.fleetCode, 'VL_ROOT_COLLISION');
      return true;
    },
  );
  assert.equal(corsaIniettata, true, 'la corsa non e’ stata iniettata nella finestra giusta');

  // La corsa persa si classifica con la sua fase reale: nessuna claim nostra,
  // nessun effetto. Il record del NOSTRO lancio non resta: la pratica e'
  // chiusa, non incerta.
  assert.ok(!fs.existsSync(path.join(h.filesRoot, 'launch-targets', 'cloud-Cella.json')),
    'il record prepared della corsa persa non e’ stato rimosso');
  const st = await h.runtime.launchState('Cella');
  assert.equal(st.classification, 'none', 'la corsa persa ha lasciato una pratica aperta');
  assert.equal(h.tickets.length, 0, 'nessun payload di lancio emesso');
  assert.deepEqual(h.sessioniVive(), [], 'nessuna sessione tmux creata: un solo concorrente, zero creatori');

  // E l'incerto in-process non c'e': tolta la lease dell'altro, l'up riesce.
  const rilascio = await radici.rilascia({
    home: h.home, root: h.vlRoot, launchId: vecchio,
    ownerInstanceId: OWNER_INSTANCE_ID, cellId: 'Cella', budgetMs: 4000,
  });
  assert.equal(rilascio.ok, true, `rilascio della lease della corsa fallito: ${JSON.stringify(rilascio)}`);
  const res = await h.runtime.up('Cella');
  assert.equal(res.ok, true, `l'up dopo la corsa non e' riuscito: ${JSON.stringify(res)}`);
});

// ---------------------------------------------------------------------------
// T3 — reconcile di un prepared mai materializzato con l'host-context di un
// altro lancio: si chiude con la prova della fase, senza toccare l'altrui.
// ---------------------------------------------------------------------------
test('reconcile di prepared mai materializzato con host-context di un altro lancio: si chiude', async (t) => {
  const h = await crea(t);
  const vecchio = idLancio();
  const nostro = idLancio();
  ombraVecchia(h, vecchio);
  await claimVecchia(h, vecchio);

  // Il record del NOSTRO tentativo: fase prepared, risorse coerenti col nodo.
  const preparato = launchTarget.registraPrepared(h.filesRoot, 'cloud-Cella', {
    launchId: nostro, family: 'vl', cellId: 'Cella',
    ownerInstanceId: OWNER_INSTANCE_ID,
    tmuxSocket: '/tmp/tmux-test/default',
    bootId: null, pidNs: null, daemonInc: 'test-daemon-inc',
    res: { vlOwner: OWNER_INSTANCE_ID, vlRoot: h.vlRoot },
    ora: Date.now(),
  });
  assert.equal(preparato.ok, true, `record prepared non scritto: ${JSON.stringify(preparato)}`);

  const st = await h.runtime.launchState('Cella');
  assert.equal(st.classification, 'never-materialized');
  assert.equal(st.phase, 'prepared');
  assert.equal(st.reconcilable, true, `il prepared non e' riconciliabile: ${JSON.stringify(st.blockers)}`);

  const fotoClaims = foto(h.claimsDir);
  const r = await h.runtime.reconcile('Cella', nostro);
  assert.equal(r.outcome, 'reconciled', `reconcile bloccato: ${JSON.stringify(r)}`);

  // La pratica e' chiusa: il record vive in quarantena, la cella e' libera.
  assert.ok(!fs.existsSync(path.join(h.filesRoot, 'launch-targets', 'cloud-Cella.json')),
    'il record riconciliato e’ ancora al suo posto');
  const quarantena = path.join(h.filesRoot, 'launch-targets', 'reconciled', `cloud-Cella-${nostro}.json`);
  assert.ok(fs.existsSync(quarantena), 'il record non e’ in quarantena');
  const dopo = await h.runtime.launchState('Cella');
  assert.equal(dopo.classification, 'none');

  // La lease del vecchio lancio non e' un effetto del NOSTRO tentativo: resta
  // intatta, byte per byte. Non la fermiamo e non la adottiamo.
  assert.equal(foto(h.claimsDir), fotoClaims, 'la lease dell’altro lancio e’ stata toccata');
});

// ---------------------------------------------------------------------------
// T4 — un prepared entrato in creazione resta incerto: la mancanza di ack non
// prova che niente sia nato. Pin di confine del fix.
// ---------------------------------------------------------------------------
test('reconcile di un prepared entrato in creazione: resta incerto, nessuna chiusura', async (t) => {
  const h = await crea(t);
  const nostro = idLancio();
  ombraVecchia(h, idLancio());

  const preparato = launchTarget.registraPrepared(h.filesRoot, 'cloud-Cella', {
    launchId: nostro, family: 'vl', cellId: 'Cella',
    ownerInstanceId: OWNER_INSTANCE_ID,
    tmuxSocket: '/tmp/tmux-test/default',
    bootId: null, pidNs: null, daemonInc: 'test-daemon-inc',
    res: { vlOwner: OWNER_INSTANCE_ID, vlRoot: h.vlRoot },
    ora: Date.now(),
  });
  assert.equal(preparato.ok, true, `record prepared non scritto: ${JSON.stringify(preparato)}`);
  const avanzato = launchTarget.avanza(h.filesRoot, 'cloud-Cella', {
    launchId: nostro, da: 'prepared', a: 'creating', ora: Date.now(),
  });
  assert.equal(avanzato.ok, true, `record non avanzato a creating: ${JSON.stringify(avanzato)}`);

  const r = await h.runtime.reconcile('Cella', nostro);
  assert.equal(r.outcome, 'blocked', `un creating e’ stato chiuso: ${JSON.stringify(r)}`);
  assert.equal(r.classification, 'materialization-unknown');
  assert.ok(fs.existsSync(path.join(h.filesRoot, 'launch-targets', 'cloud-Cella.json')),
    'il record incerto non deve sparire');
});
