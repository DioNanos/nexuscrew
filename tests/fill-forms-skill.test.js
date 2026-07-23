'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, 'skills', 'fill-forms');
const SCRIPTS = [
  'dump_docx.py',
  'fill_docx.py',
  'fill_pdf.py',
  'inspect_pdf.py',
  'prepare_signature.py',
];

function read(relative) {
  return fs.readFileSync(path.join(SKILL, relative), 'utf8');
}

test('fill-forms skill is portable, multilingual and consent bounded', () => {
  const skill = read('SKILL.md');
  const metadata = read('agents/openai.yaml');
  const reference = read('references/overlay-technique.md');
  const requirements = read('requirements.txt');
  const combined = [
    skill,
    metadata,
    reference,
    requirements,
    ...SCRIPTS.map((name) => read(`scripts/${name}`)),
  ].join('\n');

  assert.match(skill, /^---\nname: fill-forms\n/);
  assert.match(skill, /explicit language preference/);
  assert.match(skill, /language of the current request/);
  assert.match(skill, /English/);
  assert.match(skill, /Never invent/);
  assert.match(skill, /explicitly asks for insertion/);
  assert.match(skill, /Filling is not signing, sending or submitting/);
  assert.match(skill, /do not install packages automatically/);
  assert.match(skill, /Never overwrite the blank source/);
  assert.match(metadata, /default_prompt: "Use fill-forms /);
  assert.doesNotMatch(metadata, /default_prompt:.*\$|default_prompt:.* {2,}/);
  assert.match(requirements, /^PyMuPDF/m);
  assert.match(requirements, /^python-docx/m);

  assert.doesNotMatch(combined, /\/home\/|DocsHub|ACTIVE_WORK|cloud-Dev|DAG\b/);
  assert.doesNotMatch(combined, /subprocess\.check_call|pip install|requests\.|urllib\.request/);
  assert.doesNotMatch(combined, /@[a-z0-9.-]+\.[a-z]{2,}/i);
});

test('fill-forms scripts compile and expose dependency-free help', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fill-forms-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  for (const script of SCRIPTS) {
    const source = path.join(SKILL, 'scripts', script);
    const copy = path.join(fixture, script);
    fs.copyFileSync(source, copy);

    const help = spawnSync('python3', [copy, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, `${script} --help failed: ${help.stderr}`);
    assert.match(help.stdout, /usage:/i);

    const compile = spawnSync(
      'python3',
      ['-c', 'from pathlib import Path; p=Path(__import__("sys").argv[1]); compile(p.read_text(), str(p), "exec")', copy],
      { encoding: 'utf8' },
    );
    assert.equal(compile.status, 0, `${script} did not compile: ${compile.stderr}`);
  }
});
