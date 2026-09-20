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

test('la classe dei workcode copre la forma lettera+cifra+minuscole e resta chiusa sui token legittimi', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'publish', 'public-surface-rules.json'), 'utf8'));
  // Positivo: la forma con suffisso minuscolo (un marker interno che finisce
  // in un commento di lib/) deve essere VISTA dalla famiglia — senza, il gate
  // taceva proprio sul caso che l'ha fatto nascere. Vista e NON classificata:
  // il gate la segnala unclosed e fallisce, che e' la protezione voluta.
  const famB = new RegExp(rules.workcodes.families.B.source, 'g');
  const visti = [...'marker interno A2, forma nuova X1a, composta B12.3x'.matchAll(famB)].map((m) => m[0]);
  assert.ok(visti.includes('X1a'), 'lettera+cifra+minuscola non coperta dalla famiglia B');
  assert.ok(visti.includes('A2') && visti.includes('B12.3x'), 'le forme preesistenti restano coperte');
  assert.equal(classificato(rules, 'X1a'), false, 'la forma nuova resta non classificata: unclosed = gate rosso');
  // Chiusura sul corpus legittimo: ogni token della famiglia che il payload
  // legittimo contiene e' classificato (deny/allow), quindi la classe non si
  // apre a caso con l'estensione.
  const legittimi = 'K3, ARM64, GLM-5, UTF-8, SHA-256 e versioni come 0.10.0 non sono marker interni';
  for (const t of [...legittimi.matchAll(new RegExp(rules.workcodes.families.B.source, 'g'))].map((m) => m[0])) {
    assert.ok(classificato(rules, t), `token legittimo ${t} non classificato: aggiungerlo a denyToken o allowToken, mai ignorarlo`);
  }
  // I tasti di frontend (F1/F3 in frontend/src) non entrano nel gate: il
  // sorgente non e' nel pacchetto e il bundle e' escluso per contesto — si
  // esclude il contesto, non la regola.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.files.includes('frontend/src'), false, 'frontend/src non e\' nel payload');
  const wc = rules.workcodes.allowPathPrefix || [];
  assert.ok(wc.some((p) => p.startsWith('frontend/dist')), 'il bundle compilato e\' escluso per contesto');
});

function classificato(rules, token) {
  if ((rules.workcodes.denyToken || []).includes(token)) return true;
  if ((rules.workcodes.allowToken || []).includes(token)) return true;
  return (rules.workcodes.allowTokenRe || []).some((r) => new RegExp(r.source || r).test(token));
}


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
