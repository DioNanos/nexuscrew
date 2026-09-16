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
  let workcodes = null;
  if (defs.workcodes) {
    const wc = defs.workcodes;
    if (!wc.families || typeof wc.families !== 'object' || Array.isArray(wc.families)) {
      throw new Error('rule bundle: workcodes.families non valido');
    }
    const families = Object.entries(wc.families).map(([id, def]) => {
      if (!def || typeof def.source !== 'string') throw new Error(`rule bundle: famiglia workcode ${id} senza source`);
      // matchAll needs the global flag; workcode families are case-sensitive by definition.
      return { id, re: new RegExp(def.source, def.flags ? `${def.flags}g` : 'g'), reason: def.reason || `internal work code (${id})` };
    });
    workcodes = {
      families,
      denyToken: new Set(Array.isArray(wc.denyToken) ? wc.denyToken : []),
      allowToken: new Set(Array.isArray(wc.allowToken) ? wc.allowToken : []),
      allowTokenRe: (Array.isArray(wc.allowTokenRe) ? wc.allowTokenRe : []).map((source) => new RegExp(source)),
      allowLineRe: (Array.isArray(wc.allowLineRe) ? wc.allowLineRe : []).map((source) => new RegExp(source)),
      allowPathPrefix: Array.isArray(wc.allowPathPrefix) ? wc.allowPathPrefix : [],
    };
  }
  return {
    text: defs.text.map(({ source, flags, reason }) => ({ re: new RegExp(source, flags || ''), reason })),
    path: defs.path.map(({ source, flags, reason }) => ({ re: new RegExp(source, flags || ''), reason })),
    workcodes,
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

function isBinary(blob) {
  return blob.includes(0) || !Buffer.from(blob.toString('utf8'), 'utf8').equals(blob);
}

function scan(root, entries, rules) {
  const hits = [];
  for (const rel of entries) {
    const file = path.join(root, 'package', rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`path pack mancante: ${rel}`);
    for (const { re, reason } of rules.path) if (re.test(rel)) hits.push(`${rel}: ${reason}`);
    const blob = fs.readFileSync(file);
    let text;
    if (isBinary(blob)) {
      const strings = spawnSync('strings', ['-a', '-n', '4', file], { encoding: 'utf8' });
      if (strings.error) throw new Error(`scanner binari non disponibile: ${strings.error.message}`);
      if (strings.status !== 0) throw new Error(`scanner binari exited ${strings.status}`);
      text = strings.stdout;
    } else text = blob.toString('utf8');
    for (const { re, reason } of rules.text) if (re.test(text)) hits.push(`${rel}: ${reason}`);
  }
  if (hits.length) throw new Error(`contenuto/percorso vietato:\n  ${hits.join('\n  ')}`);
}

// Counts internal work codes (families defined in the rule bundle) per line,
// reporting file:line and per-family totals. Binary files and the paths in
// allowPathPrefix (minified frontend bundles) are excluded by definition.
// Fail-closed: a rule bundle without `workcodes` is an error, never a pass,
// and a matched token in neither list fails the gate (unclosed class).
function scanWorkcodes(root, entries, workcodes) {
  if (!workcodes) throw new Error('rule bundle senza workcodes: il gate non può passare senza la classe (fail-closed)');
  const totals = {};
  for (const { id } of workcodes.families) totals[id] = 0;
  const hits = [];
  const unknowns = [];
  const hitFiles = new Set();
  for (const rel of entries) {
    if (workcodes.allowPathPrefix.some((prefix) => rel.startsWith(prefix))) continue;
    const file = path.join(root, 'package', rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const blob = fs.readFileSync(file);
    if (isBinary(blob)) continue;
    const lines = blob.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index];
      if (workcodes.allowLineRe.some((re) => re.test(lineText))) continue;
      for (const { id, re } of workcodes.families) {
        re.lastIndex = 0;
        for (const match of lineText.matchAll(re)) {
          const token = match[0];
          if (workcodes.allowToken.has(token)) continue;
          if (workcodes.allowTokenRe.some((allow) => allow.test(token))) continue;
          if (workcodes.denyToken.has(token)) {
            totals[id] += 1;
            hits.push(`${id} ${rel}:${index + 1} ${token}`);
            hitFiles.add(rel);
            continue;
          }
          // Matched but classified by neither list: the class is unclosed.
          unknowns.push(`${id} ${rel}:${index + 1} ${token}`);
        }
      }
    }
  }
  return { totals, files: hitFiles.size, hits, unknowns };
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
  const workcodes = scanWorkcodes(extract, packlist, rules.workcodes);
  if (workcodes.unknowns.length) {
    throw new Error(`token non classificati nel rule bundle (classe non chiusa): aggiungerli a denyToken o allowToken:\n  ${workcodes.unknowns.join('\n  ')}`);
  }
  if (workcodes.hits.length) {
    const summary = Object.entries(workcodes.totals).map(([id, count]) => `${id}=${count}`).join(', ');
    throw new Error(`codici di lavorazione interni nel payload (${summary}, totale ${workcodes.hits.length} su ${workcodes.files} file):\n  ${workcodes.hits.join('\n  ')}`);
  }
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
      scan: { rulesSha256: sha256File(RULES), result: 'PASS', rc: 0, workcodes: { totals: workcodes.totals, files: workcodes.files, result: 'PASS', rc: 0 } },
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
