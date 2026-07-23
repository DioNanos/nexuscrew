'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('MCP companion catalog is bounded, optional and points to public repositories', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp-companions.json'), 'utf8'));
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.kind, 'nexuscrew-mcp-companions');
  assert.deepEqual(catalog.policy, {
    optional: true,
    discoverToolsFirst: true,
    recommendOnlyForRequestedCapability: true,
    automaticInstall: false,
    automaticConfiguration: false,
  });

  assert.deepEqual(catalog.companions.map(({ id }) => id), ['memory', 'msa', 'crew', 'mail']);
  for (const companion of catalog.companions) {
    assert.match(companion.repository, /^https:\/\/github\.com\/DioNanos\/[a-z0-9-]+$/);
    assert.equal(companion.installation, `${companion.repository}#install`);
    assert.equal(companion.license, 'Apache-2.0');
    assert.ok(companion.capabilities.length > 0);
    assert.ok(companion.primaryTools.length > 0);
    assert.match(companion.bundledSkill, /^skills\/[a-z0-9-]+\/SKILL\.md$/);
    assert.ok(fs.existsSync(path.join(ROOT, companion.bundledSkill)));
    assert.equal(Object.hasOwn(companion, 'credentials'), false);
  }
});

test('package ships the companion guide, catalog and generic multilingual skills', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('MCP_COMPANIONS.md'));
  assert.ok(pkg.files.includes('mcp-companions.json'));
  assert.ok(pkg.files.includes('skills/'));

  const guide = fs.readFileSync(path.join(ROOT, 'MCP_COMPANIONS.md'), 'utf8');
  const nexusSkill = fs.readFileSync(path.join(ROOT, 'skills/nexuscrew-agent/SKILL.md'), 'utf8');

  for (const repo of ['mcp-memory-rs', 'mcp-vl-msa-rs', 'mcp-crewd-rs', 'mcp-email-rs']) {
    assert.match(guide, new RegExp(`https://github\\.com/DioNanos/${repo}`));
  }
  for (const name of ['memory', 'vl-msa', 'crew', 'mail-assistant']) {
    const skill = fs.readFileSync(path.join(ROOT, `skills/${name}/SKILL.md`), 'utf8');
    const agentMetadata = fs.readFileSync(
      path.join(ROOT, `skills/${name}/agents/openai.yaml`),
      'utf8',
    );
    assert.match(skill, /explicit language preference/);
    assert.match(skill, /language of the current request/);
    assert.match(skill, /English/);
    assert.doesNotMatch(skill, /\/home\/|@[a-z0-9.-]+\.[a-z]{2,}/i);
    assert.match(agentMetadata, new RegExp(`default_prompt: "Use ${name} `));
    assert.doesNotMatch(agentMetadata, /default_prompt:.*\$|default_prompt:.* {2,}/);
  }
  const mailSkill = fs.readFileSync(path.join(ROOT, 'skills/mail-assistant/SKILL.md'), 'utf8');
  assert.match(mailSkill, /language of the email thread/);
  assert.match(mailSkill, /Do not install or configure it without consent/);
  assert.match(nexusSkill, /Discover the tools already exposed/);
  assert.match(nexusSkill, /Ask before installing software/);
});
