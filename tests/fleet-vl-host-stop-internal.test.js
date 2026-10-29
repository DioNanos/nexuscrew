'use strict';
// D-549 S4b — lo stop dell'host passa da `vl internal host-stop` quando lo
// status dichiara `host_stop_v1`; `vl shutdown` resta solo per chi non la
// dichiara. Il binario è un finto: nessun segnale a un host vero, il timeout
// uccide solo il CLI creato dal test.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const host = require('../lib/fleet/vl-host-stop.js');

const CAP = 'host_stop_v1';
const ROOT_ATTESA = (rec) => rec.serverRoot;

function procEsito(output, code) {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = () => {};
  p.unref = () => {};
  queueMicrotask(() => {
    // `output` e' un testo o un elenco di pezzi, ognuno un evento `data`.
    const pezzi = Array.isArray(output) ? output : [output];
    for (const pezzo of pezzi) if (pezzo) p.stdout.emit('data', Buffer.from(pezzo));
    p.emit('close', code);
  });
  return p;
}

function casa() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hoststop-'));
  fs.mkdirSync(path.join(home, '.nexuscrew'), { mode: 0o700 });
  return home;
}

function scriviBin(file, corpo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, corpo, { mode: 0o755 });
  return file;
}

function record(home, bin) {
  const state = path.join(home, 'state');
  fs.mkdirSync(state, { recursive: true });
  return {
    launchId: 'ab'.repeat(8),
    vlBin: bin,
    vlBinSha256: host.sha256File(bin),
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    HOME: home,
    uid: process.getuid(),
    serverRoot: path.join(state, 'vl', 'host-v1'),
    ts: 1,
  };
}

function statoJson(stato, extra = {}) {
  return `${JSON.stringify({ schema_version: 1, state: stato, ...extra })}\n`;
}

// Uno spawn finto: lo status risponde secondo l'elenco (l'ultimo si ripete),
// ogni altro comando risponde `stop`. Registra gli argv di ogni chiamata.
function finto({ stati, stop }) {
  const chiamate = [];
  let n = 0;
  const spawnImpl = (bin, args) => {
    chiamate.push(args.slice());
    if (args[0] === 'host') {
      const s = stati[Math.min(n, stati.length - 1)];
      n += 1;
      return procEsito(s.out, s.code === undefined ? 0 : s.code);
    }
    return procEsito(stop.out, stop.code);
  };
  return { spawnImpl, chiamate };
}

async function ferma(prove, extra = {}) {
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'), '#!/bin/sh\nexit 0\n');
  const rec = record(home, bin);
  const esito = await host.fermaHost({
    record: rec, bin, budgetMs: 8000, monoNow: () => Date.now(), isolamento: 'isolato',
    spawnImpl: prove.spawnImpl, ...extra,
  });
  return { esito, rec, chiamate: prove.chiamate };
}

const VIVO_CON_CAP = { out: statoJson('live', { capabilities: [CAP] }) };
const NONE = { out: statoJson('none', { capabilities: [CAP] }) };
const riga = (ok, reason) => `${JSON.stringify({ ok, reason })}\n`;
const comandi = (chiamate) => chiamate.map((a) => (a[0] === 'host' ? 'status' : a[0] === 'internal' ? 'internal' : a[0]));

// ── ogni `reason` della lista chiusa ───────────────────────────────────────

test('ogni reason della lista chiusa ha il suo esito, e nessuna cade sul vecchio comando', async () => {
  assert.equal(host.STOP_REASONS.length, 16);
  for (const reason of host.STOP_REASONS) {
    const ok = reason === 'shutdown_ack';
    const stop = { out: riga(ok, reason), code: ok ? 0 : 1 };
    // L'host sparisce davvero dopo lo stop: lo status che segue dice none.
    const { esito, rec, chiamate } = await ferma(finto({ stati: [VIVO_CON_CAP, NONE], stop }));
    assert.equal(esito.via, 'internal', reason);
    assert.deepEqual(chiamate[1], ['internal', 'host-stop', '--server-root', ROOT_ATTESA(rec), '--json'], reason);
    assert.ok(!comandi(chiamate).includes('shutdown'), `${reason}: nessun ripiego sul vecchio comando`);
    if (ok) {
      assert.equal(esito.outcome, 'host-stopped-clean');
      assert.deepEqual(comandi(chiamate), ['status', 'internal', 'status']);
    } else if (reason === 'server_absent') {
      // Una corsa: l'host e' sparito tra i due probe. Lo dice lo status none,
      // senza inventare un ack.
      assert.equal(esito.outcome, 'host-already-stopped');
      assert.equal(esito.race, true);
      assert.deepEqual(comandi(chiamate), ['status', 'internal', 'status']);
    } else {
      assert.equal(esito.outcome, 'host-stop-failed', reason);
      assert.equal(esito.code, 'STOP_FAILED', reason);
      assert.equal(esito.reason, reason);
      assert.deepEqual(comandi(chiamate), ['status', 'internal'], `${reason}: nessun secondo probe`);
    }
  }
});

test('server_absent con lo status che non dice none non e uno stop riuscito', async () => {
  const stop = { out: riga(false, 'server_absent'), code: 1 };
  const { esito } = await ferma(finto({ stati: [VIVO_CON_CAP, VIVO_CON_CAP], stop }));
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'BARRIER');
  assert.equal(esito.reason, 'server_absent');
});

test('un ack non basta: serve lo status none, concluso', async () => {
  const stop = { out: riga(true, 'shutdown_ack'), code: 0 };
  const dopo = [
    { out: statoJson('live', { capabilities: [CAP] }) },
    { out: statoJson('lock_held_socket_silent', { capabilities: [CAP] }) },
    { out: statoJson('none'), code: 2 },
    { out: statoJson('probe_error'), code: 3 },
    { out: 'non e json\n' },
    { out: '' },
  ];
  for (const secondo of dopo) {
    const { esito, chiamate } = await ferma(finto({ stati: [VIVO_CON_CAP, secondo], stop }));
    assert.equal(esito.outcome, 'host-stop-failed', JSON.stringify(secondo));
    assert.equal(esito.code, 'BARRIER', JSON.stringify(secondo));
    assert.deepEqual(comandi(chiamate), ['status', 'internal', 'status']);
  }
});

// ── la capacita' sceglie il comando, e non autorizza nulla ─────────────────

test('capacita presente: il comando interno, con la root del record e --json', async () => {
  for (const caps of [[CAP], ['altra_v9', CAP], [CAP, 'altra_v9']]) {
    const stop = { out: riga(true, 'shutdown_ack'), code: 0 };
    const { esito, rec, chiamate } = await ferma(finto({
      stati: [{ out: statoJson('live', { capabilities: caps }) }, NONE], stop,
    }));
    assert.equal(esito.outcome, 'host-stopped-clean', JSON.stringify(caps));
    assert.deepEqual(chiamate[0], ['host', 'status', '--json', '--server-root', rec.serverRoot]);
    assert.deepEqual(chiamate[1], ['internal', 'host-stop', '--server-root', rec.serverRoot, '--json']);
  }
});

test('capacita assente o sconosciuta con status valido: il vecchio comando, e solo quello', async () => {
  const senza = [
    statoJson('live'),
    statoJson('live', { capabilities: [] }),
    statoJson('live', { capabilities: ['altra_v9'] }),
    statoJson('live', { capabilities: ['host_stop_v2'] }),
    statoJson('lock_held_socket_silent'),
  ];
  for (const out of senza) {
    const stop = { out: riga(true, 'shutdown_ack'), code: 0 };
    const { esito, rec, chiamate } = await ferma(finto({ stati: [{ out }, NONE], stop }));
    assert.equal(esito.outcome, 'host-stopped-clean', out);
    assert.equal(esito.via, 'legacy', out);
    assert.deepEqual(chiamate[1], ['shutdown', '--server-root', rec.serverRoot], out);
    assert.ok(!comandi(chiamate).includes('internal'), out);
  }
});

test('con il vecchio comando restano le regole di prima: conta lo status finale, non l uscita', async () => {
  // Il vecchio comando non e' piu' tenuto a dire una riga: e' lo status none a
  // concludere. Con lo status vivo dopo l'ack lo stop e' fallito.
  const garbage = { out: 'qualunque cosa\n', code: 7 };
  const a = await ferma(finto({ stati: [{ out: statoJson('live') }, NONE], stop: garbage }));
  assert.equal(a.esito.outcome, 'host-stopped-clean');
  const b = await ferma(finto({ stati: [{ out: statoJson('live') }, { out: statoJson('live') }], stop: garbage }));
  assert.equal(b.esito.code, 'BARRIER');
});

test('uno status che non si sa leggere non sceglie nessun comando', async () => {
  const stop = { out: riga(true, 'shutdown_ack'), code: 0 };
  const inutilizzabili = [
    { out: '' },
    { out: 'non e json\n' },
    { out: '[]\n' },
    { out: statoJson('live'), code: 1 },
    { out: statoJson('unsafe_root'), code: 3 },
    { out: statoJson('probe_error'), code: 3 },
    { out: statoJson('usage_error'), code: 2 },
    { out: statoJson('stato_mai_visto') },
    // Un elenco di capacita' che non e' un elenco: nemmeno questo e' «vecchio».
    { out: statoJson('live', { capabilities: CAP }) },
    { out: statoJson('live', { capabilities: { [CAP]: 1 } }) },
    { out: statoJson('live', { capabilities: null }) },
  ];
  for (const primo of inutilizzabili) {
    const { esito, chiamate } = await ferma(finto({ stati: [primo, NONE], stop }));
    assert.equal(esito.outcome, 'host-stop-failed', JSON.stringify(primo));
    assert.equal(esito.code, 'STATUS_UNUSABLE', JSON.stringify(primo));
    assert.deepEqual(comandi(chiamate), ['status'], `${JSON.stringify(primo)}: nessun comando di stop`);
  }
});

test('status none: gia fermo, anche con la capacita; nessuno stop', async () => {
  const { esito, chiamate } = await ferma(finto({ stati: [NONE], stop: { out: '', code: 1 } }));
  assert.equal(esito.outcome, 'host-already-stopped');
  assert.deepEqual(comandi(chiamate), ['status']);
});

// ── isolamento ─────────────────────────────────────────────────────────────

test('se l isolamento non e isolato non si ferma niente, con o senza la capacita', async () => {
  const stop = { out: riga(true, 'shutdown_ack'), code: 0 };
  for (const isolamento of [undefined, null, true, 'ignoto', 'nel-gruppo', 'Isolato']) {
    for (const out of [VIVO_CON_CAP.out, statoJson('live')]) {
      const prove = finto({ stati: [{ out }, NONE], stop });
      const home = casa();
      const bin = scriviBin(path.join(home, 'vl'), '#!/bin/sh\nexit 0\n');
      const esito = await host.fermaHost({
        record: record(home, bin), bin, budgetMs: 8000, monoNow: () => Date.now(),
        isolamento, spawnImpl: prove.spawnImpl,
      });
      assert.equal(esito.outcome, 'host-stop-failed', String(isolamento));
      assert.equal(esito.code, isolamento === 'nel-gruppo' ? 'HOST_IN_GROUP' : 'IDENTITY_UNKNOWN', String(isolamento));
      assert.ok(!comandi(prove.chiamate).includes('internal') && !comandi(prove.chiamate).includes('shutdown'), String(isolamento));
    }
  }
});

// ── l'uscita del comando nuovo si legge in modo stretto ────────────────────

test('una riga che non si sa attestare non e un esito e non fa ripiegare sul vecchio comando', async () => {
  const buona = '{"ok":true,"reason":"shutdown_ack"}';
  const casi = [
    // vuoto, con ogni exit
    { out: '', code: 0 }, { out: '', code: 1 },
    // non JSON, o JSON che non e' un oggetto
    { out: 'garbage\n', code: 1 }, { out: '[]\n', code: 1 }, { out: '"x"\n', code: 1 }, { out: 'null\n', code: 1 },
    // forma della riga
    { out: buona, code: 0 },                               // manca l'a capo
    { out: `${buona}\n${buona}\n`, code: 0 },              // due righe
    { out: `${buona}\naltro\n`, code: 0 },                 // testo dopo
    { out: `prima\n${buona}\n`, code: 0 },                 // testo prima
    { out: `${buona}\n\n`, code: 0 },                      // riga vuota in coda
    { out: ` ${buona}\n`, code: 0 },                      // spazio prima
    { out: `${buona} \n`, code: 0 },                      // spazio dopo
    { out: `${buona}\r\n`, code: 0 },                     // CRLF
    { out: `{"ok":true,\n"reason":"shutdown_ack"}\n`, code: 0 }, // JSON su due righe
    // chiavi e tipi
    { out: '{"ok":true}\n', code: 0 },
    { out: '{"reason":"shutdown_ack"}\n', code: 0 },
    { out: '{"ok":true,"reason":"shutdown_ack","x":1}\n', code: 0 },
    { out: '{"ok":"true","reason":"shutdown_ack"}\n', code: 0 },
    { out: '{"ok":1,"reason":"shutdown_ack"}\n', code: 0 },
    { out: '{"ok":true,"reason":7}\n', code: 0 },
    { out: '{"ok":true,"reason":null}\n', code: 0 },
    // una reason che non e' nella lista chiusa
    { out: '{"ok":false,"reason":"altro_motivo"}\n', code: 1 },
    { out: '{"ok":false,"reason":""}\n', code: 1 },
    // ok e reason che non si accordano
    { out: '{"ok":true,"reason":"no_ack"}\n', code: 0 },
    { out: '{"ok":false,"reason":"shutdown_ack"}\n', code: 1 },
    // exit e ok che non si accordano
    { out: riga(true, 'shutdown_ack'), code: 1 },
    { out: riga(true, 'shutdown_ack'), code: 2 },
    { out: riga(false, 'no_ack'), code: 0 },
    { out: riga(false, 'server_absent'), code: 0 },
    // il processo non e' finito normalmente
    { out: riga(true, 'shutdown_ack'), code: null },
  ];
  for (const stop of casi) {
    // Anche con uno status finale none: la riga non attestata non diventa un
    // successo, e il vecchio comando non parte.
    const { esito, chiamate } = await ferma(finto({ stati: [VIVO_CON_CAP, NONE], stop }));
    assert.equal(esito.outcome, 'host-stop-failed', JSON.stringify(stop));
    assert.equal(esito.code, 'STOP_UNATTESTED', JSON.stringify(stop));
    assert.equal(esito.via, 'internal');
    assert.deepEqual(comandi(chiamate), ['status', 'internal'], JSON.stringify(stop));
    assert.equal(esito.spawned, 2);
  }
});

test('leggiEsitoStop: la forma attestata, e solo quella', () => {
  const ok = host.leggiEsitoStop({ code: 0, stdout: riga(true, 'shutdown_ack') });
  assert.deepEqual(ok, { ok: true, reason: 'shutdown_ack' });
  const no = host.leggiEsitoStop({ code: 1, stdout: riga(false, 'no_ack') });
  assert.deepEqual(no, { ok: false, reason: 'no_ack' });
  assert.equal(host.leggiEsitoStop({ code: 0, stdout: riga(true, 'shutdown_ack'), ucciso: true }), null);
  assert.equal(host.leggiEsitoStop({ code: 0, stdout: riga(true, 'shutdown_ack'), errore: new Error('x') }), null);
  assert.equal(host.leggiEsitoStop(null), null);
  assert.equal(host.leggiEsitoStop({ code: 0 }), null);
});

// ── timeout: muore solo il CLI, e nessun altro comando lo sostituisce ──────

test('il comando interno appeso: muore solo il CLI, l host resta e il vecchio comando non parte', async () => {
  const home = casa();
  const hostVivo = path.join(home, 'host-vivo');
  fs.writeFileSync(hostVivo, '1');
  const log = path.join(home, 'chiamate.log');
  const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2, 4).join(' ') + '\\n');
if (process.argv[2] === 'host') {
  process.stdout.write(${JSON.stringify(statoJson('live', { capabilities: [CAP] }))});
  process.exit(0);
}
setInterval(() => {}, 1000);
`);
  const rec = record(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  const t0 = Date.now();
  // Il budget e' corto: allo stop restano ~0,8 s dopo la riserva del probe finale.
  const esito = await host.fermaHost({
    record: rec, bin: pin.path, budgetMs: 3000, monoNow: () => Date.now(), isolamento: 'isolato',
  });
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'TIMEOUT');
  assert.equal(esito.via, 'internal');
  assert.equal(fs.readFileSync(hostVivo, 'utf8'), '1', 'l host non e toccato');
  assert.ok(Date.now() - t0 < 3000, 'il CLI e terminato entro il budget');
  const viste = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(viste, ['host status', 'internal host-stop'], 'nessun vecchio comando dopo il timeout');
});

test('uno status appeso non sceglie nessun comando', async () => {
  const home = casa();
  const log = path.join(home, 'chiamate.log');
  const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2, 4).join(' ') + '\\n');
setInterval(() => {}, 1000);
`);
  const rec = record(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  const esito = await host.fermaHost({
    record: rec, bin: pin.path, budgetMs: 1200, monoNow: () => Date.now(), isolamento: 'isolato',
  });
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'STATUS_UNUSABLE');
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['host status']);
});

// ── i tempi ────────────────────────────────────────────────────────────────

test('i tempi: lo stop ha piu di 15 s se il budget lo consente, e il probe finale ha la sua riserva', () => {
  assert.equal(host.PROBE_MS, 5000);
  assert.ok(host.STOP_MS > 15000, 'lo stop puo attendere i 15 s del client e un margine');
  assert.ok(host.BUDGET_MS >= host.STOP_MS + 2 * host.PROBE_MS, 'il totale contiene stop e due probe');
  assert.equal(host.tempoStop(30000), host.STOP_MS);
  assert.ok(host.tempoStop(30000) > 15000);
  // Con il budget di 15 s di runtime (massimo) e il default di 8 s: il limite
  // reale e' il residuo meno la riserva e il margine, mai di piu'.
  assert.equal(host.tempoStop(15000), 15000 - host.POST_PROBE_RESERVE_MS - host.MARGIN_MS);
  assert.equal(host.tempoStop(8000), 8000 - host.POST_PROBE_RESERVE_MS - host.MARGIN_MS);
  assert.ok(host.tempoStop(host.POST_PROBE_RESERVE_MS + host.MARGIN_MS + 49) < 50);
});

test('un budget troppo corto per lo stop e BUDGET: nessun comando di stop, nessun kill', async () => {
  const stop = { out: riga(true, 'shutdown_ack'), code: 0 };
  // Dopo il primo probe restano 2100 ms: meno della riserva e del margine.
  const { esito, chiamate } = await ferma(finto({ stati: [VIVO_CON_CAP, NONE], stop }), { budgetMs: 2100 });
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'BUDGET');
  assert.deepEqual(comandi(chiamate), ['status']);
});

test('il totale che il modulo accetta ha un tetto: oltre 30 s non si va, qualunque sia il budget dato', async () => {
  const stop = { out: riga(true, 'shutdown_ack'), code: 0 };
  let ora = 1000;
  const prove = finto({ stati: [VIVO_CON_CAP, NONE], stop });
  const base = prove.spawnImpl;
  // Il primo probe «dura» 29 s sull'orologio finto: restano 1000 ms del tetto.
  prove.spawnImpl = (b, args) => { if (args[0] === 'host' && ora === 1000) ora += 29000; return base(b, args); };
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'), '#!/bin/sh\nexit 0\n');
  const esito = await host.fermaHost({
    record: record(home, bin), bin, budgetMs: 1000000, monoNow: () => ora, isolamento: 'isolato',
    spawnImpl: prove.spawnImpl,
  });
  assert.equal(esito.code, 'BUDGET');
  assert.deepEqual(comandi(prove.chiamate), ['status']);
});

test('un budget che finisce prima dello status finale e BUDGET, non un successo', async () => {
  const stop = { out: riga(true, 'shutdown_ack'), code: 0 };
  let ora = 1000;
  const prove = finto({ stati: [VIVO_CON_CAP, NONE], stop });
  const base = prove.spawnImpl;
  // Lo stop «dura» 7960 ms: restano 40 ms, sotto la soglia di 50.
  prove.spawnImpl = (b, args) => { if (args[0] === 'internal') ora += 7960; return base(b, args); };
  const home = casa();
  const bin = scriviBin(path.join(home, 'vl'), '#!/bin/sh\nexit 0\n');
  const esito = await host.fermaHost({
    record: record(home, bin), bin, budgetMs: 8000, monoNow: () => ora, isolamento: 'isolato',
    spawnImpl: prove.spawnImpl,
  });
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'BUDGET');
});

// ── cio' che il comando riceve ─────────────────────────────────────────────

test('il comando interno gira sul pin, con la root e l env del record e senza segreti', async () => {
  const home = casa();
  const visto = path.join(home, 'visto.json');
  const bin = scriviBin(path.join(home, 'bin', 'vl'), `#!${process.execPath}
const fs = require('fs');
const out = ${JSON.stringify(visto)};
if (process.argv[2] === 'internal') {
  fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), self: process.argv[1], env: process.env }));
  process.stdout.write('{"ok":true,"reason":"shutdown_ack"}\\n');
  process.exit(0);
}
const gia = fs.existsSync(out);
process.stdout.write(JSON.stringify({ schema_version: 1, state: gia ? 'none' : 'live', capabilities: ['host_stop_v1'] }) + '\\n');
`);
  const rec = record(home, bin);
  const pin = host.pinBinario({ source: bin, home, owner: 'local', cellId: 'Cella' });
  assert.equal(pin.ok, true);
  process.env.VL_API_KEY = 'segreto-di-prova';
  let esito;
  try {
    esito = await host.fermaHost({
      record: rec, bin: pin.path, budgetMs: 8000, monoNow: () => Date.now(), isolamento: 'isolato',
    });
  } finally { delete process.env.VL_API_KEY; }
  assert.equal(esito.outcome, 'host-stopped-clean');
  assert.equal(esito.via, 'internal');
  const v = JSON.parse(fs.readFileSync(visto, 'utf8'));
  assert.deepEqual(v.argv, ['internal', 'host-stop', '--server-root', rec.serverRoot, '--json']);
  assert.equal(v.self, pin.path, 'il binario e il pin');
  assert.equal(v.env.HOME, home);
  assert.equal(v.env.XDG_STATE_HOME, rec.XDG_STATE_HOME);
  assert.equal(v.env.VL_API_KEY, undefined);
  assert.equal(v.env.API_KEY, undefined);
});

// ── un'uscita oltre il limite di raccolta non e un'uscita ───────────────────

const LIMITE = host.MAX_OUT;
const X = (n) => 'X'.repeat(n);
const pezzi = (testo, dim) => {
  const v = [];
  for (let i = 0; i < testo.length; i += dim) v.push(testo.slice(i, i + dim));
  return v;
};
// Uno status valido riempito fino a un numero esatto di byte.
function statoDi(stato, byte, extra = {}) {
  const base = { schema_version: 1, state: stato, ...extra, pad: '' };
  const vuoto = `${JSON.stringify(base)}\n`;
  base.pad = 'p'.repeat(byte - Buffer.byteLength(vuoto));
  const testo = `${JSON.stringify(base)}\n`;
  assert.equal(Buffer.byteLength(testo), byte);
  return testo;
}

test('il limite di raccolta e quello dichiarato', () => {
  assert.equal(LIMITE, 65536);
});

test('una riga valida seguita da un suffisso oltre il limite non e un esito: STOP_UNATTESTED, nessun ripiego', async () => {
  const valida = riga(true, 'shutdown_ack');
  const piani = {
    'in pezzi da 16 KiB': [valida, ...pezzi(X(LIMITE), 16384)],
    'in un solo evento': valida + X(LIMITE),
    'la riga e poi un solo evento di 64 KiB': [valida, X(LIMITE)],
    'tanti pezzi da 1 KiB': [valida, ...pezzi(X(LIMITE), 1024)],
    'un byte oltre il limite, a confine di pezzo': [valida + X(LIMITE - valida.length), 'X'],
    'un byte oltre il limite, dentro un pezzo': [valida, X(LIMITE - valida.length + 1)],
  };
  for (const [nome, out] of Object.entries(piani)) {
    // Anche con lo status finale none: il suffisso perso non diventa un successo.
    const { esito, chiamate } = await ferma(finto({ stati: [VIVO_CON_CAP, NONE], stop: { out, code: 0 } }));
    assert.equal(esito.outcome, 'host-stop-failed', nome);
    assert.equal(esito.code, 'STOP_UNATTESTED', nome);
    assert.equal(esito.via, 'internal', nome);
    assert.deepEqual(comandi(chiamate), ['status', 'internal'], nome);
  }
});

test('esattamente al limite non e troncato, e non diventa valido per questo', async () => {
  const valida = riga(true, 'shutdown_ack');
  // Esattamente LIMITE byte: raccolti per intero, ma non sono una riga sola.
  const { esito, chiamate } = await ferma(finto({
    stati: [VIVO_CON_CAP, NONE], stop: { out: valida + X(LIMITE - valida.length), code: 0 },
  }));
  assert.equal(esito.code, 'STOP_UNATTESTED');
  assert.deepEqual(comandi(chiamate), ['status', 'internal']);
});

test('uno status esattamente al limite si legge; un byte oltre e inutilizzabile', async () => {
  // Al limite, in uno e in due pezzi: letto, e none vuol dire gia fermo.
  for (const out of [statoDi('none', LIMITE), pezzi(statoDi('none', LIMITE), 40000)]) {
    const { esito, chiamate } = await ferma(finto({ stati: [{ out }], stop: { out: '', code: 1 } }));
    assert.equal(esito.outcome, 'host-already-stopped');
    assert.deepEqual(comandi(chiamate), ['status']);
  }
  // Un byte oltre: troncato. Ne none ne live: nessun comando di stop.
  const oltre = statoDi('none', LIMITE + 1);
  const piani = {
    'in un evento': oltre,
    'a confine di pezzo': [oltre.slice(0, LIMITE), oltre.slice(LIMITE)],
    'in pezzi piccoli': pezzi(oltre, 1024),
  };
  for (const [nome, out] of Object.entries(piani)) {
    const { esito, chiamate } = await ferma(finto({ stati: [{ out }], stop: { out: '', code: 1 } }));
    assert.equal(esito.outcome, 'host-stop-failed', nome);
    assert.equal(esito.code, 'STATUS_UNUSABLE', nome);
    assert.deepEqual(comandi(chiamate), ['status'], nome);
  }
});

test('una capacita letta da uno status troncato non sceglie nessun comando', async () => {
  // La capacita sta all'inizio, il resto e' oltre il limite: ne' interno ne' legacy.
  const troncato = statoDi('live', LIMITE + 1, { capabilities: [CAP] });
  assert.ok(troncato.startsWith('{"schema_version":1,"state":"live","capabilities":["host_stop_v1"]'));
  const { esito, chiamate } = await ferma(finto({
    stati: [{ out: troncato }, NONE], stop: { out: riga(true, 'shutdown_ack'), code: 0 },
  }));
  assert.equal(esito.code, 'STATUS_UNUSABLE');
  assert.deepEqual(comandi(chiamate), ['status']);
});

test('uno status finale troncato non attesta il none', async () => {
  const { esito, chiamate } = await ferma(finto({
    stati: [VIVO_CON_CAP, { out: statoDi('none', LIMITE + 1, { capabilities: [CAP] }) }],
    stop: { out: riga(true, 'shutdown_ack'), code: 0 },
  }));
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'BARRIER');
  assert.deepEqual(comandi(chiamate), ['status', 'internal', 'status']);
});

// La stessa prova con un CLI vero: un processo che scrive, i pezzi li fa il kernel.
test('CLI vero: la riga di ack seguita da 64 KiB di X e uscita 0 non e uno stop attestato', async () => {
  const home = casa();
  const log = path.join(home, 'chiamate.log');
  const marca = path.join(home, 'fermato');
  const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2, 4).join(' ') + '\\n');
if (process.argv[2] === 'internal') {
  fs.writeFileSync(${JSON.stringify(marca)}, '1');
  process.stdout.write('{"ok":true,"reason":"shutdown_ack"}\\n');
  process.stdout.write('X'.repeat(${LIMITE}));
  process.exit(0);
}
const fermo = fs.existsSync(${JSON.stringify(marca)});
process.stdout.write(JSON.stringify({ schema_version: 1, state: fermo ? 'none' : 'live', capabilities: ['host_stop_v1'] }) + '\\n');
`);
  const rec = record(home, bin);
  const esito = await host.fermaHost({
    record: rec, bin, budgetMs: 8000, monoNow: () => Date.now(), isolamento: 'isolato',
  });
  assert.equal(esito.outcome, 'host-stop-failed');
  assert.equal(esito.code, 'STOP_UNATTESTED');
  assert.equal(esito.via, 'internal');
  // Lo status dopo c'e' none, e il vecchio comando non e' partito.
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['host status', 'internal host-stop']);
});

test('CLI vero: uno status di esattamente 64 KiB si legge, uno di un byte in piu no', async () => {
  for (const [byte, atteso] of [[LIMITE, 'host-already-stopped'], [LIMITE + 1, 'host-stop-failed']]) {
    const home = casa();
    const bin = scriviBin(path.join(home, 'vl'), `#!${process.execPath}
const base = { schema_version: 1, state: 'none', pad: '' };
const vuoto = JSON.stringify(base) + '\\n';
base.pad = 'p'.repeat(${byte} - Buffer.byteLength(vuoto));
process.stdout.write(JSON.stringify(base) + '\\n');
`);
    const esito = await host.fermaHost({
      record: record(home, bin), bin, budgetMs: 8000, monoNow: () => Date.now(), isolamento: 'isolato',
    });
    assert.equal(esito.outcome, atteso, `${byte} byte`);
    if (atteso === 'host-stop-failed') assert.equal(esito.code, 'STATUS_UNUSABLE');
  }
});

