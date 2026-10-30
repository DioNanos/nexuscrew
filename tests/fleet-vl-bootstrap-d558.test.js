'use strict';
// D-558 — prove minime del bootstrap vl: classifier VL 0.4, claim persistente,
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

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d558-'));
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

// ---------------------------------------------------------------- (b) claim

function hostRootOf(home) {
  return path.join(home, 'vlhost', 'state', 'vl', 'host-v1');
}

test('claim: host NUOVO — fresh-host idoneo, record durabile senza prompt ne segreti', () => {
  const home = tmpHome();
  const d1 = decideVlBootstrap({
    home, ownerInstanceId: 'local', cellId: 'Research', hostRoot: hostRootOf(home), launchId: 'aabbccdd11223344',
  });
  assert.equal(d1.eligible, true);
  assert.equal(d1.reason, 'fresh-host');
  assert.ok(d1.claimPath.endsWith('bootstrap-host.json'));
  assert.ok(d1.claimPath.includes(path.join('.nexuscrew', 'vl-cells')), 'claim accanto alla root, sotto il tree NC');
  assert.ok(!d1.claimPath.includes(path.join('state', 'vl', 'host-v1')), 'mai dentro i file di VL');
  const rec = readVlBootstrapClaim({ home, ownerInstanceId: 'local', cellId: 'Research' });
  assert.equal(rec.proof, 'fresh-host');
  assert.equal(rec.state, 'pending');
  const raw = fs.readFileSync(d1.claimPath, 'utf8');
  assert.ok(!raw.includes('Leggi CLAUDE'), 'nessun testo del prompt nel record');
  assert.equal((fs.statSync(d1.claimPath).mode & 0o777), 0o600);
});

test('claim: concorrenza — il secondo lancio sulla stessa incarnazione non ottiene una seconda claim', () => {
  const home = tmpHome();
  const args = { home, ownerInstanceId: 'local', cellId: 'C', hostRoot: hostRootOf(home), launchId: 'l1' };
  assert.equal(decideVlBootstrap(args).eligible, true);
  const d2 = decideVlBootstrap({ ...args, launchId: 'l2' });
  assert.equal(d2.eligible, false);
  assert.equal(d2.reason, 'claim-taken');
});

test('claim: host ESISTENTE senza ricevuta (host pre-fix) — skip esplicito, mai verginita dedotta', () => {
  const home = tmpHome();
  fs.mkdirSync(hostRootOf(home), { recursive: true });
  const d = decideVlBootstrap({
    home, ownerInstanceId: 'local', cellId: 'Research', hostRoot: hostRootOf(home), launchId: 'x',
  });
  assert.equal(d.eligible, false);
  assert.equal(d.reason, 'host-pre-existing');
});

test('claim: sessione NUOVA ruotata — idonea per incarnazione; chiave diversa = claim diversa', () => {
  const home = tmpHome();
  fs.mkdirSync(hostRootOf(home), { recursive: true }); // host gia' popolato
  const base = { home, ownerInstanceId: 'local', cellId: 'C', hostRoot: hostRootOf(home) };
  const r1 = decideVlBootstrap({ ...base, rotation: { applied: true, key: 'rot:1:1' }, launchId: 'l1' });
  assert.equal(r1.eligible, true);
  assert.equal(r1.reason, 'rotated-session');
  // respawn sullo stesso lancio/rotazione: claim gia' presa
  const again = decideVlBootstrap({ ...base, rotation: { applied: true, key: 'rot:1:1' }, launchId: 'l2' });
  assert.equal(again.reason, 'claim-taken');
  // rotazione SUCCESSIVA: nuova incarnazione di sessione, nuova claim
  const r2 = decideVlBootstrap({ ...base, rotation: { applied: true, key: 'rot:2:2' }, launchId: 'l3' });
  assert.equal(r2.eligible, true);
  assert.notEqual(r2.claimPath, r1.claimPath);
});

test('claim: root irraggiungibile in lettura — claim-unavailable, fail-closed', () => {
  const home = tmpHome();
  // hostRoot = file regolare: lstat risolve, non e' ENOENT -> host-pre-existing
  fs.mkdirSync(path.dirname(hostRootOf(home)), { recursive: true });
  fs.writeFileSync(hostRootOf(home), 'x');
  assert.equal(decideVlBootstrap({
    home, ownerInstanceId: 'local', cellId: 'C', hostRoot: hostRootOf(home), launchId: 'x',
  }).reason, 'host-pre-existing');
});

// ---------------------------------------------------------------- (b) supervisore

function supervisorSeams() {
  const calls = { deliver: [], options: [] };
  // Il timer del supervisore e' unref(): in un test niente altro tiene vivo il
  // loop, quindi lo shim mantiene un ref interno (unref no-op).
  const live = new Set();
  return {
    calls,
    seams: {
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

test('supervisore vl: host nuovo gen0 — UNA consegna, client vl, testo identico a cell.prompt', async () => {
  const { calls, seams } = supervisorSeams();
  const ctl = cellExec.startGenerationPrompt(vlConfig({
    vlBootstrap: { eligible: true, reason: 'fresh-host', claimPath: '/tmp/claim.json' },
  }), 0, { exited: false }, seams);
  const settled = await ctl.settled;
  assert.equal(settled, null); // submitted: nessuna incertezza
  assert.equal(calls.deliver.length, 1, 'un solo paste+Enter');
  assert.equal(calls.deliver[0].client, 'vl');
  assert.equal(calls.deliver[0].prompt, 'Leggi CLAUDE.md e parti');
  assert.equal(calls.deliver[0].session, 'cloud-C');
  assert.ok(calls.options.includes('submitted'));
});

test('supervisore vl: host pre-fix (claim non idonea) — NESSUN paste, skip esplicito subito', async () => {
  const { calls, seams } = supervisorSeams();
  const ctl = cellExec.startGenerationPrompt(vlConfig({
    vlBootstrap: { eligible: false, reason: 'host-pre-existing' },
  }), 0, { exited: false }, seams);
  await ctl.settled;
  assert.equal(calls.deliver.length, 0);
  assert.ok(calls.options.includes('skipped-vl-bootstrap:host-pre-existing'));
});

test('supervisore vl: generation > 0 (respawn/riattacco) — skip esplicito, zero reinvii', async () => {
  const { calls, seams } = supervisorSeams();
  const ctl = cellExec.startGenerationPrompt(vlConfig({
    vlBootstrap: { eligible: true, reason: 'fresh-host', claimPath: '/tmp/claim.json' },
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
    vlBootstrap: { eligible: true, reason: 'fresh-host', claimPath: '/tmp/c.json' },
  })), true);
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: false, reason: 'host-pre-existing' },
  })), true);
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: true, reason: 'fresh-host' },
  })), false, 'eligible senza claimPath rifiutato');
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    client: 'kimi', vlBootstrap: { eligible: true, reason: 'fresh-host', claimPath: '/c' },
  })), false, 'vlBootstrap solo per vl');
  assert.equal(cellExec.validRestartPrompt(vlConfig({
    vlBootstrap: { eligible: false, reason: 'motivo-inventato' },
  })), false, 'motivo fuori enum rifiutato');
});

test('waitDeliveryReport: skip vl bounded attraversa il report, reason non bounded viene droppato', async () => {
  const exec = async (bin, args) => (args.some((a) => a === '#{@nc_delivery}')
    ? { err: null, stdout: 'skipped-vl-bootstrap:host-pre-existing\n', stderr: '' }
    : { err: null, stdout: '', stderr: '' });
  const r = await pd.waitDeliveryReport('/usr/bin/tmux', '%1', { exec, timeoutMs: 100, pollMs: 1 });
  assert.equal(r.state, 'skipped-vl-bootstrap');
  assert.equal(r.notReady, 'host-pre-existing');
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
    vlBootstrap: { eligible: true, reason: 'fresh-host', claimPath: '/tmp/c.json' },
  }), 0, { exited: false }, seams);
  await ctl.settled;
  assert.equal(calls.deliver[0].prompt, 'Leggi CLAUDE.md e parti');
});

test('prompt assente: nessuna delivery — il payload restartPrompt non esiste senza cell.prompt', async () => {
  // runtime.js costruisce restartPrompt solo con cell.prompt; il supervisore
  // senza restartPrompt non avvia mai una consegna. Prova del contratto:
  const cfg = vlConfig({ vlBootstrap: { eligible: true, reason: 'fresh-host', claimPath: '/c' } });
  delete cfg.prompt;
  assert.equal(cellExec.validRestartPrompt(cfg), false, 'payload senza prompt non valido');
});
