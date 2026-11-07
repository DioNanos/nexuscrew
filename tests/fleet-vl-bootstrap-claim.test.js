'use strict';
// Prove minime del bootstrap vl: classifier VL 0.4, claim persistente,
// consegna single-owner a generation 0, skip espliciti, regressioni kimi/claude.
// Tutto con seam iniettati: nessun tmux vero, HOME isolata in /tmp.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pd = require('../lib/fleet/prompt-delivery.js');
const { decideVlBootstrap, readVlBootstrapClaim } = require('../lib/fleet/vl-bootstrap-claim.js');
const cellExec = require('../lib/fleet/cell-exec.js');

// Supervised-delivery fixture: the prompt-outcome channel is required. The
// ephemeral dirs it creates are removed when the test process exits.
const FX_DIRS = [];
process.on('exit', () => { for (const d of FX_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-claim-'));
}

// ---------------------------------------------------------------- (a) classifier

test('classifier vl 0.4: ready unicode e ascii', () => {
  assert.equal(pd.classifyPane('benvenuto\nVL (•‿•) ready\n', 'vl'), 'ready');
  assert.equal(pd.classifyPane('welcome\nVL [o_o] ready\n', 'vl'), 'ready');
});

test('classifier vl 0.4: facce occupate e non consegnabili sono busy', () => {
  const rows = [
    'VL (•_•)? thinking', 'VL [o_O] thinking',
    'VL (•̀ᴗ•́) working · bash', 'VL [>_<] working | bash',
    'VL (・_・)⁇ asking', 'VL [?_?] asking',
    'VL (•_•)⇄ compacting', 'VL [o_o]~ compacting',
    'VL (◡_◡)⌁ offline', 'VL [._.] offline',
    'VL (×_×) error', 'VL [x_x] error',
    'VL (^‿^) done', 'VL [^_^] done',
    'VL (－_－)zz resting', 'VL [-_-] resting',
    'VL (⊙_⊙)! alarm', 'VL [O_O] alarm',
  ];
  for (const row of rows) {
    assert.equal(pd.classifyPane(`testo\n${row}\n`, 'vl'), 'busy', row);
  }
});

test('classifier vl: la riga di stato CORRENTE vince, non quella vecchia nel transcript', () => {
  // ready vecchio sopra, busy corrente sotto (vicino al composer): busy.
  assert.equal(pd.classifyPane('VL (•‿•) ready\nrisposta del modello\nVL (・_・)⁇ asking\n', 'vl'), 'busy');
  assert.equal(pd.classifyPane('VL (•‿•) ready\nlavoro\nVL (•_•)? thinking\n', 'vl'), 'busy');
  // busy vecchio sopra, ready corrente sotto: ready.
  assert.equal(pd.classifyPane('VL (•_•)? thinking\nfatto\nVL (•‿•) ready\n', 'vl'), 'ready');
});

test('classifier vl: done scade in ready (FaceClock 3s) — le due catture classificano diversamente', () => {
  assert.equal(pd.classifyPane('VL (^‿^) done\n', 'vl'), 'busy');
  assert.equal(pd.classifyPane('VL (•‿•) ready\n', 'vl'), 'ready');
});

test('classifier vl: unknown senza riga di stato; legacy 0.3 esplicitamente versionato', () => {
  assert.equal(pd.classifyPane('solo testo qualsiasi\n', 'vl'), 'unknown');
  assert.equal(pd.classifyPane('vivling [o] e12 ↑3 esc quit · ^y yield\n', 'vl'), 'ready');
  // la riga VL 0.4 batte il marcatore legacy
  assert.equal(pd.classifyPane('vivling [o] e12 ↑3 esc quit · ^y yield\nVL (•_•)? thinking\n', 'vl'), 'busy');
});

test('vlPaneIdle: disponibili ready/done/error/resting e legacy; mai le facce occupate', () => {
  for (const f of ['ready', 'done', 'error', 'resting']) {
    const glyph = pd.VL_FACES.find((x) => x.face === f);
    assert.ok(pd.vlPaneIdle(`VL ${glyph.unicode} ${f}\n`), f);
    assert.ok(pd.vlPaneIdle(`VL ${glyph.ascii} ${f}\n`), `${f} ascii`);
  }
  for (const f of ['thinking', 'working', 'asking', 'compacting', 'offline', 'alarm']) {
    const glyph = pd.VL_FACES.find((x) => x.face === f);
    assert.equal(pd.vlPaneIdle(`VL ${glyph.unicode} ${f}\n`), false, f);
  }
  assert.ok(pd.vlPaneIdle('vivling [o] e1 ↑1 esc quit · ^y yield\n'));
  assert.equal(pd.vlPaneIdle('niente\n'), false);
});

test('vlPaneReadiness riconosce idle e degrada a timeout senza attendere per sempre', async () => {
  let calls = 0;
  const r = await pd.vlPaneReadiness('/usr/bin/tmux', '%1', {
    timeoutMs: 0, pollMs: 1,
    captureImpl: async () => { calls += 1; return 'VL (^‿^) done\n'; },
  });
  assert.deepEqual(r, { ready: true, degraded: false });
  const none = await pd.vlPaneReadiness('/usr/bin/tmux', '%1', {
    timeoutMs: 0, pollMs: 1, captureImpl: async () => 'boh\n',
  });
  assert.equal(none.degraded, true); // MAI fail-closed
  assert.ok(calls >= 1);
});

// ---------------------------------------------------------------- (a/R4) candidata corrente

test('R4: riga corrente non riconosciuta — la ready PRECEDENTE non vince (controprova 1)', () => {
  // 'ask' non e' parola di faccia ('asking' troncata): la superficie corrente
  // non e' interpretabile -> unknown, MAI la ready vecchia del transcript.
  assert.equal(pd.vlCurrentFace('VL (•‿•) ready\nrisposta\nVL [?_?] ask\n'), 'unknown');
  assert.equal(pd.classifyPane('VL (•‿•) ready\nrisposta\nVL [?_?] ask\n', 'vl'), 'unknown');
});

test('R4: candidata 0.4 presente ma non riconosciuta — MAI fallback legacy 0.3 (controprova 2)', () => {
  const text = 'vivling [o] e12 ↑3 esc quit · ^y yield\nVL [?_?] ask\n';
  assert.equal(pd.classifyPane(text, 'vl'), 'unknown', 'nessun ready via legacy con candidata 0.4 sopra');
  assert.equal(pd.vlPaneIdle(text), false);
  // la candidata si trova PRIMA, poi si interpreta: e' l'ultima riga dichiarata
  assert.equal(pd.vlCandidateLine(text), 'VL [?_?] ask');
});

test('R4: cattura stretta — parola o glifo troncati valgono unknown, anche con ready nota sopra', () => {
  assert.equal(pd.classifyPane('VL (•‿•) ready\nVL (•‿•) rea\n', 'vl'), 'unknown', 'parola troncata');
  assert.equal(pd.classifyPane('VL (•‿•) ready\nVL (•‿•)\n', 'vl'), 'unknown', 'solo glifo, senza parola');
  assert.equal(pd.classifyPane('VL (•‿•) ready\nVL [o_o]\n', 'vl'), 'unknown', 'glifo ascii senza parola');
  assert.equal(pd.vlCurrentFace('VL (•‿•) rea\n'), 'unknown');
});

test('R4: legacy 0.3 vale SOLO senza alcuna riga candidata 0.4; le coppie note restano riconosciute', () => {
  assert.equal(pd.classifyPane('vivling [o] e12 ↑3 esc quit · ^y yield\n', 'vl'), 'ready', 'solo legacy: resta valido');
  // candidata 0.4 sopra al marcatore legacy: la candidata e' quella corrente
  assert.equal(pd.classifyPane('VL [?_?] asking\nvivling [o] e12 ↑3 esc quit · ^y yield\n', 'vl'), 'busy');
  // nessuna candidata, nessun legacy: unknown
  assert.equal(pd.vlCurrentFace('testo qualunque\n'), null);
  assert.equal(pd.vlCandidateLine('testo qualunque\n'), null);
});

// ---------------------------------------------------------------- (b) claim per avvio

const { vlCellBaseDir } = require('../lib/fleet/managed.js');

function hostRootOf(home) {
  // root canonica dell'host VL della cella (vl-roots radiceServer)
  return path.join(vlCellBaseDir(home, 'local', 'C'), 'state', 'vl', 'host-v1');
}

// Crea la catena privata NC pre-esistente con i permessi GIUSTI (0700): una
// catena 0755 sarebbe rifiutata da safePrivateDir — è il contratto, non un
// dettaglio del test. Si chmoddano solo i componenti DENTRO home.
function mkPrivateChain(home, dir) {
  fs.mkdirSync(dir, { recursive: true });
  let acc = home;
  const parts = path.relative(home, dir).split(path.sep);
  for (const part of parts) {
    acc = path.join(acc, part);
    if (fs.existsSync(acc)) fs.chmodSync(acc, 0o700);
  }
}

test('claim per avvio: OGNI avvio e\' idoneo — host NUOVO e host GIA\' ESISTENTE (requisito)', () => {
  // host nuovo: la root non esiste
  const home = tmpHome();
  const d1 = decideVlBootstrap({
    home, ownerInstanceId: 'local', cellId: 'Research', launchId: 'aabbccdd11223344',
  });
  assert.equal(d1.eligible, true);
  assert.equal(d1.reason, 'launch');
  assert.ok(d1.claimPath.endsWith('bootstrap-aabbccdd11223344.json'), 'claim chiave = launchId dell\'avvio');
  assert.ok(d1.claimPath.includes(path.join('.nexuscrew', 'vl-cells')), 'claim accanto alla root, sotto il tree NC');
  assert.ok(!d1.claimPath.includes(path.join('state', 'vl', 'host-v1')), 'mai dentro i file di VL');
  const rec = readVlBootstrapClaim({ home, ownerInstanceId: 'local', cellId: 'Research', launchId: 'aabbccdd11223344' });
  assert.equal(rec.launchId, 'aabbccdd11223344');
  assert.equal(rec.state, 'pending');
  const raw = fs.readFileSync(d1.claimPath, 'utf8');
  assert.ok(!raw.includes('Leggi CLAUDE'), 'nessun testo del prompt nel record');
  assert.equal((fs.statSync(d1.claimPath).mode & 0o777), 0o600);

  // host GIA\' ESISTENTE (cella con storia, pre-fix compresa): STESSA idoneita\'
  const home2 = tmpHome();
  mkPrivateChain(home2, path.dirname(hostRootOf(home2)));
  fs.mkdirSync(path.join(hostRootOf(home2), 'sessions'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(hostRootOf(home2), 'sessions', 'default'), '');
  const d2 = decideVlBootstrap({
    home: home2, ownerInstanceId: 'local', cellId: 'C', launchId: 'aabbccdd11223345',
  });
  assert.equal(d2.eligible, true, 'host esistente: il prompt si consegna comunque, un paste per avvio');
  assert.equal(d2.reason, 'launch');
});

test('claim per avvio: stesso launchId (respawn che ripercorre il preflight) -> claim-taken; avvio nuovo -> nuova claim', () => {
  const home = tmpHome();
  const base = { home, ownerInstanceId: 'local', cellId: 'C' };
  const d1 = decideVlBootstrap({ ...base, launchId: '1111111111111111' });
  assert.equal(d1.eligible, true);
  // lo STESSO avvio non ottiene una seconda claim: al piu\' UN paste per avvio
  const again = decideVlBootstrap({ ...base, launchId: '1111111111111111' });
  assert.equal(again.eligible, false);
  assert.equal(again.reason, 'claim-taken');
  assert.equal(again.claimPath, d1.claimPath);
  // avvio NUOVO (nuovo up: nuovo supervisore generation 0): nuova claim idonea
  const d2 = decideVlBootstrap({ ...base, launchId: '2222222222222222' });
  assert.equal(d2.eligible, true);
  assert.notEqual(d2.claimPath, d1.claimPath);
});

test('claim: id non sicuri rifiutati prima di toccare il disco', () => {
  const home = tmpHome();
  for (const bad of ['x', '', 'AABBCCDD11223344', '1111111111111111.json', 'gggggggggggggggg']) {
    assert.throws(() => decideVlBootstrap({ home, ownerInstanceId: 'local', cellId: 'C', launchId: bad }),
      /unsafe vl launch id/, `launchId ${bad} rifiutato`);
  }
  assert.throws(() => decideVlBootstrap({ home, ownerInstanceId: 'local', cellId: '../..', launchId: '1111111111111111' }),
    /unsafe vl cell id/);
  assert.ok(!fs.existsSync(path.join(home, '.nexuscrew')), 'nessuna directory creata');
});

test('claim: catena NC non materializzabile — claim-unavailable, fail-closed, nessun claimPath', () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, '.nexuscrew'), 'x'); // file al posto della directory
  const d = decideVlBootstrap({ home, ownerInstanceId: 'local', cellId: 'C', launchId: '1111111111111111' });
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'claim-unavailable');
  assert.equal(d.claimPath, undefined);
});

// ------------------------------------------------------- (b/R2) durabilita' della claim

// Inietta EIO selettivo sui fsync: `colpa(path)` decide quali path falliscono.
// I descriptor restano tracciati all'open, cosi' il fault colpisce file,
// directory o parent in modo mirato (controprova).
function injectFsyncFailure(t, colpa) {
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  const fdPath = new Map();
  fs.openSync = function patched(...argv) {
    const fd = realOpen.apply(fs, argv);
    try { fdPath.set(fd, String(argv[0])); } catch (_) { /* fd non tracciato: passa */ }
    return fd;
  };
  fs.fsyncSync = function patched(fd) {
    const p = fdPath.get(fd) || '';
    if (colpa(p)) {
      const e = new Error('injected EIO');
      e.code = 'EIO';
      throw e;
    }
    return realFsync.call(fs, fd);
  };
  t.after(() => { fs.openSync = realOpen; fs.fsyncSync = realFsync; });
}

test('R2: EIO sul fsync del FILE della claim — fail-closed claim-unavailable, claim NON cancellata, avvio nuovo non avvelenato', (t) => {
  const home = tmpHome();
  injectFsyncFailure(t, (p) => p.endsWith('bootstrap-1111111111111111.json'));
  const d = decideVlBootstrap({ home, ownerInstanceId: 'local', cellId: 'C', launchId: '1111111111111111' });
  assert.equal(d.eligible, false, 'esito del trasporto incerto: nessun paste');
  assert.equal(d.reason, 'claim-unavailable');
  // la claim forse gia\' pubblicata NON si cancella: resta visibile sul disco
  const nc = path.join(vlCellBaseDir(home, 'local', 'C'), 'nc');
  assert.ok(fs.existsSync(path.join(nc, 'bootstrap-1111111111111111.json')), 'claim non cancellata');
  // un AVVIO NUOVO non e\' avvelenato dal fallimento del precedente
  const d2 = decideVlBootstrap({ home, ownerInstanceId: 'local', cellId: 'C', launchId: '2222222222222222' });
  assert.equal(d2.eligible, true);
  assert.equal(d2.reason, 'launch');
});

test('R2: EIO sul fsync della DIRECTORY che contiene la claim — fail-closed, nessun paste, claim NON cancellata', (t) => {
  const home = tmpHome();
  const base = { home, ownerInstanceId: 'local', cellId: 'C' };
  // la catena esiste GIA\' (materializzata da un avvio precedente).
  // La regola: l'anello `nc` viene sincronizzato a OGNI acquisizione, anche
  // PRIMA di aprire il file — il fault quindi scatta SOLO quando la claim e'
  // gia' sul disco (fsync della directory DOPO la creazione del file).
  assert.equal(decideVlBootstrap({ ...base, launchId: '0000000000000000' }).eligible, true);
  const nc = path.join(vlCellBaseDir(home, 'local', 'C'), 'nc');
  const claim1111 = path.join(nc, 'bootstrap-1111111111111111.json');
  injectFsyncFailure(t, (p) => p === nc && fs.existsSync(claim1111));
  const d = decideVlBootstrap({ ...base, launchId: '1111111111111111' });
  assert.equal(d.eligible, false, 'entry della claim non nota durevole: nessun paste');
  assert.equal(d.reason, 'claim-unavailable');
  assert.ok(fs.existsSync(claim1111), 'claim non cancellata');
});

test('R2: EIO sul fsync del PARENT della catena appena creata — fail-closed claim-unavailable', (t) => {
  const home = tmpHome();
  // home e\' il parent di .nexuscrew: la entry della nuova directory non e'
  // durevole se quel fsync fallisce (contratto FSYNC_DIR di vl-claim-section)
  injectFsyncFailure(t, (p) => p === home);
  const d = decideVlBootstrap({ home, ownerInstanceId: 'local', cellId: 'C', launchId: '1111111111111111' });
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'claim-unavailable');
});

test('R2: percorso verde — file, directory e parent sincronizzati; riapertura e claim-taken al ripasso', () => {
  const home = tmpHome();
  const d = decideVlBootstrap({ home, ownerInstanceId: 'local', cellId: 'C', launchId: '1111111111111111' });
  assert.equal(d.eligible, true);
  const rec = readVlBootstrapClaim({ home, ownerInstanceId: 'local', cellId: 'C', launchId: '1111111111111111' });
  assert.equal(rec.cell, 'C');
  // la entry e' visibile a un secondo passaggio sullo STESSO avvio: EEXIST
  const again = decideVlBootstrap({ home, ownerInstanceId: 'local', cellId: 'C', launchId: '1111111111111111' });
  assert.equal(again.reason, 'claim-taken');
  assert.equal((fs.statSync(path.join(home, '.nexuscrew')).mode & 0o777), 0o700, 'catena NC privata 0700');
});

// ---------------------------------------------------------------- (b) supervisore

function supervisorSeams() {
  const calls = { deliver: [], options: [] };
  // Il timer del supervisore e' unref(): in un test niente altro tiene vivo il
  // loop, quindi lo shim mantiene un ref interno (unref no-op).
  const live = new Set();
  const fxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prompt-fx-'));
  FX_DIRS.push(fxDir);
  return {
    calls,
    seams: {
      // Supervised-delivery fixture: the prompt-outcome channel is required
      // (fresh ephemeral dir per seams instance).
      promptOutcome: {
        dir: fxDir,
        launchId: '7f8091a2b3c4d5e6',
      },
      setTimeout: (fn, ms) => {
        const h = {};
        live.add(h);
        setTimeout(() => { if (live.delete(h)) fn(); }, Math.min(ms, 2));
        return h;
      },
      clearTimeout: (h) => { live.delete(h); },
      tmuxExec: async (bin, args) => {
        if (args[0] === 'set-option') calls.options.push(args[args.length - 1]);
        return { err: null, stdout: '', stderr: '' };
      },
      deliverBootstrapPrompt: async (opts) => {
        calls.deliver.push(opts);
        return { delivered: true, state: 'submitted', notReady: '', attempts: 1, reason: 'submitted' };
      },
    },
  };
}

function vlConfig(extra) {
  return {
    tmuxBin: '/usr/bin/tmux', tmuxSession: 'cloud-C', prompt: 'Leggi CLAUDE.md e parti',
    readyMs: 1, client: 'vl', ...extra,
  };
}

test('supervisore vl: avvio gen0 (anche su host esistente) — UNA consegna, client vl, testo identico a cell.prompt', async () => {
  const { calls, seams } = supervisorSeams();
  const ctl = cellExec.startGenerationPrompt(vlConfig({
    vlBootstrap: { eligible: true, reason: 'launch', claimPath: '/tmp/claim.json' },
  }), 0, { exited: false }, seams);
  const settled = await ctl.settled;
  assert.equal(settled, null); // submitted: nessuna incertezza
  assert.equal(calls.deliver.length, 1, 'un solo paste+Enter');
  assert.equal(calls.deliver[0].client, 'vl');
  assert.equal(calls.deliver[0].prompt, 'Leggi CLAUDE.md e parti');
  assert.equal(calls.deliver[0].session, 'cloud-C');
  assert.ok(calls.options.includes('submitted'));
});

test('supervisore vl: claim non idonea (claim-taken/unavailable) — NESSUN paste, skip esplicito subito', async () => {
  const { calls, seams } = supervisorSeams();
  const ctl = cellExec.startGenerationPrompt(vlConfig({
    vlBootstrap: { eligible: false, reason: 'claim-taken' },
  }), 0, { exited: false }, seams);
  await ctl.settled;
  assert.equal(calls.deliver.length, 0);
  assert.ok(calls.options.includes('skipped-vl-bootstrap:claim-taken'));
});

test('supervisore vl: generation > 0 (respawn/riattacco) — skip esplicito, zero reinvii', async () => {
  const { calls, seams } = supervisorSeams();
  const ctl = cellExec.startGenerationPrompt(vlConfig({
    vlBootstrap: { eligible: true, reason: 'launch', claimPath: '/tmp/claim.json' },
  }), 1, { exited: false }, seams);
  await ctl.settled;
  assert.equal(calls.deliver.length, 0);
  assert.ok(calls.options.includes('skipped-vl-bootstrap:generation'));
});

test('supervisore vl: payload senza decisione vlBootstrap — fail-closed no-proof, nessun paste', async () => {
  const { calls, seams } = supervisorSeams();
  const ctl = cellExec.startGenerationPrompt(vlConfig(), 0, { exited: false }, seams);
  await ctl.settled;
  assert.equal(calls.deliver.length, 0);
  assert.ok(calls.options.includes('skipped-vl-bootstrap:no-proof'));
});

test('supervisore: regressioni kimi/claude single-owner e reprompt ai restart', async () => {
  for (const client of ['kimi', 'claude']) {
    const { calls, seams } = supervisorSeams();
    const ctl = cellExec.startGenerationPrompt(vlConfig({ client }), 0, { exited: false }, seams);
    await ctl.settled;
    assert.equal(calls.deliver.length, 1, `${client} gen0 consegnato dal supervisore`);
    assert.equal(calls.deliver[0].client, client);
    const ctl2 = cellExec.startGenerationPrompt(vlConfig({ client }), 2, { exited: false }, seams);
    await ctl2.settled;
    assert.equal(calls.deliver.length, 2, `${client} reprompt alle generazioni > 0 invariato`);
  }
});

test('validRestartPrompt: vl ammesso con vlBootstrap bounded; rifiuti per kimi/valori aperti', () => {
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: true, reason: 'launch', claimPath: '/tmp/c.json' },
  })), true);
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: false, reason: 'claim-taken' },
  })), true);
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: true, reason: 'launch' },
  })), false, 'eligible senza claimPath rifiutato');
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    client: 'kimi', vlBootstrap: { eligible: true, reason: 'launch', claimPath: '/c' },
  })), false, 'vlBootstrap solo per vl');
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: false, reason: 'motivo-inventato' },
  })), false, 'motivo fuori enum rifiutato');
  // i motivi del vocabolario pre-fix non sono piu\' bounded (per avvio)
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: false, reason: 'host-pre-existing' },
  })), false, 'host-pre-existing fuori enum');
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: false, reason: 'fresh-host' },
  })), false, 'fresh-host fuori enum');
});

test('waitDeliveryReport: skip vl bounded attraversa il report, reason non bounded viene droppato', async () => {
  const exec = async (bin, args) => (args.some((a) => a === '#{@nc_delivery}')
    ? { err: null, stdout: 'skipped-vl-bootstrap:claim-taken\n', stderr: '' }
    : { err: null, stdout: '', stderr: '' });
  const r = await pd.waitDeliveryReport('/usr/bin/tmux', '%1', { exec, timeoutMs: 100, pollMs: 1 });
  assert.equal(r.state, 'skipped-vl-bootstrap');
  assert.equal(r.notReady, 'claim-taken');
  assert.equal(r.delivered, false);
  // Un motivo fuori enum NON viene mai promosso a notReady (droppato, stato
  // bounded resta): nessuna iniezione di testo libero dal pane.
  const bad = async () => ({ err: null, stdout: 'skipped-vl-bootstrap:libera-iniezione\n', stderr: '' });
  const rb = await pd.waitDeliveryReport('/usr/bin/tmux', '%1', { exec: bad, timeoutMs: 50, pollMs: 1 });
  assert.equal(rb.notReady, '');
  const badState = async () => ({ err: null, stdout: 'inventato-stato\n', stderr: '' });
  assert.equal(await pd.waitDeliveryReport('/usr/bin/tmux', '%1', { exec: badState, timeoutMs: 50, pollMs: 1 }), null);
});

// ---------------------------------------------------------------- (c) system append

test('(c) writeVlCellPrompt resta com\': cell.prompt + companion nel system append, delivery porta lo stesso testo', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fleet', 'managed.js'), 'utf8');
  // la composizione del file system append non cambia: prompt + companion.
  assert.ok(src.includes('const source = `${prompt ? `${prompt}\\n\\n` : \'\'}${companionInstructions()}\\n`;'));
  // e il primo turno utente e' ESATTAMENTE cell.prompt: il supervisore consegna
  // config.prompt, che nel payload e' cell.prompt (testato sopra: testo identico).
  const { calls, seams } = supervisorSeams();
  const ctl = cellExec.startGenerationPrompt(vlConfig({
    vlBootstrap: { eligible: true, reason: 'launch', claimPath: '/tmp/c.json' },
  }), 0, { exited: false }, seams);
  await ctl.settled;
  assert.equal(calls.deliver[0].prompt, 'Leggi CLAUDE.md e parti');
});

test('prompt assente: nessuna delivery — il payload restartPrompt non esiste senza cell.prompt', async () => {
  // runtime.js costruisce restartPrompt solo con cell.prompt; il supervisore
  // senza restartPrompt non avvia mai una consegna. Prova del contratto:
  const cfg = vlConfig({ vlBootstrap: { eligible: true, reason: 'launch', claimPath: '/c' } });
  delete cfg.prompt;
  assert.equal(cellExec.validRestartPrompt(cfg), false, 'payload senza prompt non valido');
});
