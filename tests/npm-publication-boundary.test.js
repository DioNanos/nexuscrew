'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VERIFIER = path.join(ROOT, 'publish', 'verify-npm-payload.js');
// La versione attesa è quella del checkout, non un numero congelato: un assert
// hardcoded tornerebbe rosso a ogni bump e qualcuno lo aggiornerebbe a mano,
// rimandando la stessa trappola.
const EXPECTED_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

test('npm gate packs and scans the exact source checkout without publishing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-npm-boundary-'));
  try {
    const out = path.join(dir, 'pack');
    const manifest = path.join(dir, 'npm-manifest.json');
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    const result = spawnSync(process.execPath, [VERIFIER, sha, out, manifest], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.equal(data.source.commitSha, sha);
    assert.equal(data.npm.name, '@mmmbuto/nexuscrew');
    assert.equal(data.npm.version, EXPECTED_VERSION);
    assert.match(data.npm.sha256, /^[0-9a-f]{64}$/);
    assert.ok(data.npm.bytes > 0);
    assert.equal(data.npm.scan.result, 'PASS');
    assert.equal(fs.readdirSync(out).filter((name) => name.endsWith('.tgz')).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('le famiglie dei workcode vedono i riferimenti di processo e lasciano passare i token tecnici', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'publish', 'public-surface-rules.json'), 'utf8'));
  const vede = (testo) => Object.values(rules.workcodes.families)
    .flatMap((f) => [...testo.matchAll(new RegExp(f.source, 'g'))].map((m) => m[0]));
  // Positivo: i codici d'ordine e la provenienza d'audit sono VISTI. Senza,
  // il gate taceva proprio sui casi che l'hanno fatto nascere.
  const visti = vede('tracked as D-392, D447, V-69 and NC-E; found by an audit; come da piano C3; R27 rev3');
  for (const atteso of ['D-392', 'D447', 'V-69', 'NC-E', 'audit', 'come da piano C3', 'rev3']) {
    assert.ok(visti.includes(atteso), `${atteso} non coperto dalle famiglie`);
  }
  // Chiusura sul corpus legittimo: licenze, standard, dati SVG, costanti di
  // test e sigle brevi di specifica non sono marker di processo.
  const legittimi = 'K3, ARM64, GLM-5, UTF-8, SHA-256, MIT-0, BSD-3, HTML5, X11, T0, M12 4v10, R25, IC1.1, P1 e versioni come 0.10.0';
  assert.deepEqual(vede(legittimi), [], 'il corpus legittimo non deve essere intercettato');
  // I tasti di frontend (F1/F3 in frontend/src) non entrano nel gate: il
  // sorgente non e' nel pacchetto e il bundle e' escluso per contesto — si
  // esclude il contesto, non la regola.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.files.includes('frontend/src'), false, 'frontend/src non e\' nel payload');
  const wc = rules.workcodes.allowPathPrefix || [];
  assert.ok(wc.some((p) => p.startsWith('frontend/dist')), 'il bundle compilato e\' escluso per contesto');
});

test('la regola text dei nomi cella rifiuta i worker/auditor e lascia le etichette generiche', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'publish', 'public-surface-rules.json'), 'utf8'));
  const celle = rules.text.find((r) => r.reason === 'internal fleet cell name');
  assert.ok(celle, 'la regola text dei nomi cella deve esistere');
  const re = new RegExp(celle.source, celle.flags);
  for (const nome of ['BrowserAI', 'DevWorkerP', 'devworkera', 'DevAuditor', 'ForkAuditor', 'WarMaster', 'GameAuditor', 'GameDev', 'DesignCreator', 'ElNino']) {
    assert.ok(re.test(nome), `nome cella ${nome} deve essere rifiutato dalla superficie`);
  }
  for (const generica of ['SysAdmin', 'Dev', 'Research']) {
    assert.equal(re.test(generica), false, `etichetta generica ${generica} non toccata dalla regola`);
  }
  const legittimo = 'le fixture usano cell-alfa e le etichette generiche cloud-Dev, cloud-SysAdmin, cloud-Research';
  assert.equal(re.test(legittimo), false, 'il corpus legittimo resta fuori dalla regola');
});
