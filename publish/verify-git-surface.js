'use strict';

// Fail-closed verifier for the deletion-only public-tree boundary. It compares
// the Git object made from staging with the frozen source, path by path/blob by
// blob, and writes the detached manifest only after every check passes.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [sourceSha, staging, manifestPath, excludePath, builderPath, rulesPath, verifierPath, invocationPath] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`public-surface verifier: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    env: options.env,
    encoding: options.encoding || 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command} ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function git(args, options = {}) { return run('git', args, options); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function hashObject(file) { return git(['hash-object', file]).trim(); }
function validSha(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value); }

function parseRules(file) {
  const defs = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (defs.version !== 1 || !Array.isArray(defs.text) || !Array.isArray(defs.path)) throw new Error('rule bundle non valido');
  const workcodes = defs.workcodes;
  if (!workcodes || typeof workcodes !== 'object' || typeof workcodes.families !== 'object' || workcodes.families === null || !Array.isArray(workcodes.denyToken)) {
    throw new Error('rule bundle non valido: sezione workcodes mancante o incompleta');
  }
  const compile = (list) => list.map(({ source, flags, reason }) => ({ re: new RegExp(source, flags || ''), reason }));
  const families = Object.entries(workcodes.families)
    .filter(([, def]) => def && typeof def.source === 'string')
    .map(([name, def]) => ({
      name,
      // `flags` (such as "i") apply to the family; matchAll needs the global flag as well.
      re: new RegExp(def.source, def.flags ? `${def.flags}g` : 'g'),
      reason: def.reason || 'internal work code',
      allowLineRe: (def.allowLineRe || []).map((source) => new RegExp(source)),
      allowPathPrefix: def.allowPathPrefix || [],
    }));
  if (!families.length) throw new Error('rule bundle non valido: nessuna famiglia di workcodes compilabile');
  const allowToken = new Set(workcodes.allowToken || []);
  const allowTokenRe = (workcodes.allowTokenRe || []).map((source) => new RegExp(source));
  const allowLineRe = (workcodes.allowLineRe || []).map((source) => new RegExp(source));
  return {
    text: compile(defs.text),
    path: compile(defs.path),
    workcodes: {
      families,
      denyToken: new Set(workcodes.denyToken),
      allowToken,
      allowTokenRe,
      allowLineRe,
      allowPathPrefix: workcodes.allowPathPrefix || [],
    },
  };
}

function normalPath(rel) {
  if (!rel || rel.startsWith('/') || rel.includes('\\')) throw new Error(`path non POSIX: ${rel}`);
  const normalized = path.posix.normalize(rel);
  if (normalized !== rel || normalized === '..' || normalized.startsWith('../')) throw new Error(`path non normalizzato: ${rel}`);
  return normalized;
}

function parseExcludes(file) {
  const rules = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('/') || line.includes('\\') || line.includes('..') || /[*?\[\]]/.test(line)) throw new Error(`regola exclude non sicura: ${line}`);
    const directory = line.endsWith('/');
    const rel = normalPath(directory ? line.slice(0, -1) : line);
    rules.push({ rel, directory, source: line });
  }
  return rules;
}

function matchingRule(rel, rules) {
  return rules.find((rule) => rule.directory ? (rel === rule.rel || rel.startsWith(`${rule.rel}/`)) : rel === rule.rel);
}

function parseTree(raw, label) {
  return raw.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error(`${label} ls-tree record senza path`);
    const [mode, type, blob] = record.slice(0, tab).split(' ');
    const rel = normalPath(record.slice(tab + 1));
    if (!/^[0-9]+$/.test(mode) || !/^[0-9a-f]{40}$/.test(blob) || !type) throw new Error(`${label} ls-tree record non valido: ${record}`);
    return { mode, type, blob, rel };
  });
}

function treeFromSource(source) { return parseTree(git(['ls-tree', '-r', '-z', '--full-tree', source], { encoding: 'buffer' }), 'source'); }

function objectRepo(staging) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nexuscrew-public-object-'));
  try {
    fs.cpSync(staging, repo, { recursive: true, dereference: false });
    git(['init', '--quiet', repo]);
    git(['-C', repo, 'add', '--all', '--', '.']);
    const tree = git(['-C', repo, 'write-tree']).trim();
    if (!validSha(tree)) throw new Error(`public tree ID non valido: ${tree}`);
    const epoch = Number(process.env.SOURCE_DATE_EPOCH || 0);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('SOURCE_DATE_EPOCH non valido');
    const date = `@${epoch} +0000`;
    const commit = run('git', ['-C', repo, 'commit-tree', tree, '-F', '-'], {
      input: 'nexuscrew public tree\n',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'NexusCrew Release',
        GIT_AUTHOR_EMAIL: 'release@nexuscrew.invalid',
        GIT_COMMITTER_NAME: 'NexusCrew Release',
        GIT_COMMITTER_EMAIL: 'release@nexuscrew.invalid',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    }).trim();
    if (!validSha(commit)) throw new Error(`public commit ID non valido: ${commit}`);
    return { repo, tree, commit };
  } catch (error) {
    fs.rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

// Workcode scan of one entry's text. Line-level allows (`allowLineRe`) exempt a
// whole line (URL-encoded payloads); `allowPathPrefix` is checked by the caller.
// A family may also carry its own `allowLineRe`/`allowPathPrefix`, which exempt
// only that family, so a wide allowance cannot hide a different family.
// A token neither allowed nor denied fails closed, as the rule bundle declares.
function scanWorkcodes(rel, text, workcodes, hits) {
  for (const line of text.split(/\r?\n/)) {
    if (workcodes.allowLineRe.some((re) => re.test(line))) continue;
    for (const family of workcodes.families) {
      if (family.allowPathPrefix.some((prefix) => rel.startsWith(prefix))) continue;
      if (family.allowLineRe.some((re) => re.test(line))) continue;
      for (const match of line.matchAll(family.re)) {
        const token = match[0];
        if (workcodes.allowToken.has(token) || workcodes.allowTokenRe.some((re) => re.test(token))) continue;
        const reason = workcodes.denyToken.has(token)
          ? `${family.reason}: ${token}`
          : `unclassified ${family.reason} (fail-closed): ${token}`;
        hits.push(`${rel}: ${reason}`);
      }
    }
  }
}

function scan(repo, entries, rules) {
  if (!entries.length) throw new Error('public tree vuoto');
  const seen = new Set();
  const folded = new Set();
  const hits = [];
  for (const entry of entries) {
    if (seen.has(entry.rel)) throw new Error(`path duplicato: ${entry.rel}`);
    seen.add(entry.rel);
    const key = entry.rel.toLocaleLowerCase('en-US');
    if (folded.has(key)) throw new Error(`collisione case-insensitive: ${entry.rel}`);
    folded.add(key);
    if (entry.type === 'commit' || entry.mode === '160000') throw new Error(`submodule vietato: ${entry.rel}`);
    const blob = git(['-C', repo, 'cat-file', 'blob', entry.blob], { encoding: 'buffer' });
    if (!Buffer.isBuffer(blob) || blob.length === 0) throw new Error(`blob non letto/vuoto: ${entry.rel}`);
    const binary = blob.includes(0) || !Buffer.from(blob.toString('utf8'), 'utf8').equals(blob);
    let text;
    if (binary) {
      const strings = spawnSync('strings', ['-a', '-n', '4'], { input: blob, encoding: 'utf8' });
      if (strings.error) throw new Error(`scanner binari non disponibile: ${strings.error.message}`);
      if (strings.status !== 0) throw new Error(`scanner binari exited ${strings.status}`);
      text = strings.stdout;
    } else text = blob.toString('utf8');
    for (const { re, reason } of rules.path) if (re.test(entry.rel)) hits.push(`${entry.rel}: ${reason}`);
    for (const { re, reason } of rules.text) if (re.test(text)) hits.push(`${entry.rel}: ${reason}`);
    if (!rules.workcodes.allowPathPrefix.some((prefix) => entry.rel.startsWith(prefix))) {
      scanWorkcodes(entry.rel, text, rules.workcodes, hits);
    }
  }
  if (hits.length) throw new Error(`contenuto/percorso vietato:\n  ${hits.join('\n  ')}`);
  return entries.length;
}

function writeManifest(file, value) {
  if (fs.existsSync(file)) throw new Error(`manifest già esistente: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

if (!validSha(sourceSha)) fail('source SHA deve essere il commit completo (40 hex)');
for (const [name, file] of Object.entries({ staging, excludePath, builderPath, rulesPath, verifierPath, invocationPath })) {
  if (!file || !fs.existsSync(file)) fail(`${name} mancante: ${file || '(vuoto)'}`);
}
if (!fs.statSync(staging).isDirectory()) fail(`staging non directory: ${staging}`);
if (fs.existsSync(manifestPath)) fail(`manifest già esistente: ${manifestPath}`);

let object;
try {
  const resolved = git(['rev-parse', '--verify', `${sourceSha}^{commit}`]).trim();
  if (resolved !== sourceSha) throw new Error(`source SHA risolto diversamente: ${resolved}`);
  const sourceTreeId = git(['show', '-s', '--format=%T', sourceSha]).trim();
  const sourceEntries = treeFromSource(sourceSha);
  const excludes = parseExcludes(excludePath);
  const rules = parseRules(rulesPath);
  const excludedEntries = sourceEntries.filter((entry) => matchingRule(entry.rel, excludes));
  const expected = sourceEntries.filter((entry) => !matchingRule(entry.rel, excludes));
  object = objectRepo(staging);
  const actual = parseTree(git(['-C', object.repo, 'ls-tree', '-r', '-z', '--full-tree', object.tree], { encoding: 'buffer' }), 'output');
  const expectedByPath = new Map(expected.map((entry) => [entry.rel, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.rel, entry]));
  const missing = expected.filter((entry) => !actualByPath.has(entry.rel)).map((entry) => entry.rel);
  const added = actual.filter((entry) => !expectedByPath.has(entry.rel)).map((entry) => entry.rel);
  const transformed = expected.filter((entry) => {
    const got = actualByPath.get(entry.rel);
    return got && (got.blob !== entry.blob || got.mode !== entry.mode || got.type !== entry.type);
  }).map((entry) => ({ rel: entry.rel, sourceBlob: entry.blob, outputBlob: actualByPath.get(entry.rel).blob }));
  if (missing.length || added.length || transformed.length) throw new Error(`object equation fallita: missing=${missing.length} added=${added.length} transformed=${transformed.length}`);
  const scanned = scan(object.repo, actual, rules);
  const lsTreeRaw = git(['-C', object.repo, 'ls-tree', '-r', '-z', '--full-tree', object.tree], { encoding: 'buffer' });
  const invocation = fs.readFileSync(invocationPath).toString('utf8').split('\0').filter(Boolean);
  writeManifest(manifestPath, {
    schema: 1,
    source: { repo: process.env.NEXUSCREW_SOURCE_REPO || 'DioNanos/nexuscrew', commitSha: sourceSha, sourceTreeId, ref: process.env.NEXUSCREW_SOURCE_REF || null },
    builder: { path: builderPath, blobId: hashObject(builderPath), sha256: sha256(builderPath) },
    excludeList: { path: excludePath, blobId: hashObject(excludePath), sha256: sha256(excludePath) },
    scanner: { path: rulesPath, blobId: hashObject(rulesPath), sha256: sha256(rulesPath) },
    verifier: { path: verifierPath, blobId: hashObject(verifierPath), sha256: sha256(verifierPath) },
    invocation: {
      argv: invocation,
      env: { SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH || '0', TZ: process.env.TZ || null, LC_ALL: process.env.LC_ALL || null },
      toolVersions: { git: git(['--version']).trim(), node: process.version },
    },
    policy: { deletionOnly: true, parentPolicy: 'root', schema: 1 },
    outputGit: { publicTreeId: object.tree, publicCommitId: object.commit, parents: [], pathCount: actual.length, lsTreeSha256: crypto.createHash('sha256').update(lsTreeRaw).digest('hex') },
    delta: { excludedCount: excludedEntries.length, excluded: excludedEntries.map((entry) => ({ path: entry.rel, rule: matchingRule(entry.rel, excludes).source })), unexpectedMissing: missing, unexpectedAdded: added, transformed: [] },
    checks: { scannedTreeId: object.tree, scanned, ruleBundleSha256: sha256(rulesPath), result: 'PASS', rc: 0, negativeControls: [] },
    npm: null,
    run: { runner: null, workflow: null, start: null, stop: null, exitStatus: null, artifactSha256: null, manifestSha256: null },
  });
} catch (error) {
  try { if (manifestPath && fs.existsSync(manifestPath)) fs.rmSync(manifestPath, { force: true }); } catch (_) {}
  fail(error && error.message ? error.message : String(error));
} finally {
  if (object?.repo) fs.rmSync(object.repo, { recursive: true, force: true });
}
