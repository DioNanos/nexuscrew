'use strict';

// Separate npm gate: pack/list/scan the exact checkout without publishing it.
// It intentionally does not rebuild the project or consume a Git public-tree
// artifact; the final workflow will bind both attestations to one source SHA.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [sourceSha, outDir, manifestPath] = process.argv.slice(2);
const ROOT = process.cwd();
const RULES = path.join(ROOT, 'publish', 'public-surface-rules.json');

function fail(message) {
  process.stderr.write(`npm-payload verifier: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: options.encoding || 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${String(result.stderr || '').trim()}`);
  return result.stdout;
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(file) { return sha256(fs.readFileSync(file)); }
function validSha(value) { return /^[0-9a-f]{40}$/i.test(value || ''); }

function parseRules(file) {
  const defs = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (defs.version !== 1 || !Array.isArray(defs.text) || !Array.isArray(defs.path)) throw new Error('rule bundle non valido');
  return {
    text: defs.text.map(({ source, flags, reason }) => ({ re: new RegExp(source, flags || ''), reason })),
    path: defs.path.map(({ source, flags, reason }) => ({ re: new RegExp(source, flags || ''), reason })),
  };
}

function safeEntries(raw) {
  const entries = raw.split(/\r?\n/).map((line) => line.replace(/^package\//, '')).filter(Boolean);
  if (!entries.length) throw new Error('packlist vuota');
  for (const rel of entries) {
    if (rel.startsWith('/') || rel.includes('\\') || rel.includes('..') || path.posix.normalize(rel) !== rel) {
      throw new Error(`path tar non sicuro: ${rel}`);
    }
  }
  return entries.sort();
}

function scan(root, entries, rules) {
  const hits = [];
  for (const rel of entries) {
    const file = path.join(root, 'package', rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`path pack mancante: ${rel}`);
    for (const { re, reason } of rules.path) if (re.test(rel)) hits.push(`${rel}: ${reason}`);
    const blob = fs.readFileSync(file);
    const binary = blob.includes(0) || !Buffer.from(blob.toString('utf8'), 'utf8').equals(blob);
    let text;
    if (binary) {
      const strings = spawnSync('strings', ['-a', '-n', '4', file], { encoding: 'utf8' });
      if (strings.error) throw new Error(`scanner binari non disponibile: ${strings.error.message}`);
      if (strings.status !== 0) throw new Error(`scanner binari exited ${strings.status}`);
      text = strings.stdout;
    } else text = blob.toString('utf8');
    for (const { re, reason } of rules.text) if (re.test(text)) hits.push(`${rel}: ${reason}`);
  }
  if (hits.length) throw new Error(`contenuto/percorso vietato:\n  ${hits.join('\n  ')}`);
}

if (!validSha(sourceSha)) fail('source SHA deve essere il commit completo (40 hex)');
if (!fs.existsSync(path.join(ROOT, 'package.json'))) fail('package.json mancante');
if (!fs.existsSync(RULES)) fail(`rule bundle mancante: ${RULES}`);
if (fs.existsSync(outDir) || fs.existsSync(manifestPath)) fail('output o manifest già esistente');

let temp;
try {
  const resolved = run('git', ['rev-parse', '--verify', `${sourceSha}^{commit}`]).trim();
  if (resolved !== sourceSha) throw new Error(`source SHA risolto diversamente: ${resolved}`);
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-npm-payload-'));
  const sourceDir = path.join(temp, 'source');
  fs.mkdirSync(sourceDir);
  run('git', ['archive', '--format=tar', sourceSha, '-o', path.join(temp, 'source.tar')]);
  run('tar', ['-xf', path.join(temp, 'source.tar'), '-C', sourceDir]);
  const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
  if (!pkg.name || !pkg.version) throw new Error('package name/version mancanti');
  fs.mkdirSync(outDir, { recursive: true });
  const npmEnv = { ...process.env, npm_config_ignore_scripts: 'true' };
  const dry = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: sourceDir, env: npmEnv }));
  if (!Array.isArray(dry) || dry.length !== 1 || !Array.isArray(dry[0].files)) throw new Error('npm dry-run senza packlist');
  const packlist = dry[0].files.map((entry) => entry.path).sort();
  if (!packlist.length || packlist.some((rel) => rel.startsWith('/') || rel.includes('\\') || rel.includes('..'))) throw new Error('packlist non sicura');
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', outDir], { cwd: sourceDir, env: npmEnv }));
  if (!Array.isArray(packed) || packed.length !== 1 || !packed[0].filename) throw new Error('npm pack senza tarball');
  const tarball = path.resolve(outDir, packed[0].filename);
  if (!fs.existsSync(tarball)) throw new Error(`tarball mancante: ${tarball}`);
  const listed = safeEntries(run('tar', ['-tzf', tarball]));
  const expected = packlist.map((rel) => `package/${rel}`).sort();
  const actual = listed.map((rel) => `package/${rel}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('tar packlist diversa da npm dry-run');
  const extract = path.join(temp, 'extract');
  fs.mkdirSync(extract);
  run('tar', ['-xzf', tarball, '--no-same-owner', '-C', extract]);
  const rules = parseRules(RULES);
  scan(extract, packlist, rules);
  const packlistRaw = `${packlist.join('\0')}\0`;
  const manifest = {
    schema: 1,
    source: { commitSha: sourceSha },
    npm: {
      name: pkg.name,
      version: pkg.version,
      tarball: tarball,
      sha256: sha256File(tarball),
      bytes: fs.statSync(tarball).size,
      fileCount: packlist.length,
      packlistSha256: sha256(packlistRaw),
      packlist,
      scan: { rulesSha256: sha256File(RULES), result: 'PASS', rc: 0 },
    },
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const candidate = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(candidate, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(candidate, manifestPath);
  process.stdout.write(`npm-payload verifier: verified ${tarball} sha256=${manifest.npm.sha256}\n`);
} catch (error) {
  try { if (fs.existsSync(manifestPath)) fs.rmSync(manifestPath, { force: true }); } catch (_) {}
  try { if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  fail(error && error.message ? error.message : String(error));
} finally {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
}
