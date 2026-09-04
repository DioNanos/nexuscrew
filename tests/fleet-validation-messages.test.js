'use strict';

// Un rifiuto di validazione senza causa produce «definizioni fleet non
// valide: validazione fallita» — l'operatore sa che NON va bene, non sa COSA.
// I validatori nominati di normalizeManagedSpec riportano ora campo, valore e
// regola tramite il sink `onIssue`, e atomicWrite li incolla nel messaggio
// finale. Quattro casi rossi (uno per regola) + il caso verde.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

function baseDoc(overrides = {}) {
  const managed = {
    client: 'codex-vl', provider: 'custom', providerId: 'zai_p',
    displayName: 'Zai P', baseUrl: 'https://api.z.ai/api/v1',
    envKey: 'ZAI_API_KEY_P', protocol: 'openai_responses', model: 'glm-5.3',
    ...overrides,
  };
  return { schemaVersion: 1, engines: [{ id: 'codex-vl.zai-p', label: 'Zai P', managed }], cells: [] };
}

function collect(defs) {
  const issues = [];
  const parsed = parseDefinitions(defs, { onIssue: (i) => issues.push(i) });
  return { parsed, issues };
}

test('rejects a provider id with a dot and reports field, value, and rule', () => {
  const { parsed, issues } = collect(baseDoc({ providerId: 'codex-vl.zai-a' }));
  assert.equal(parsed, null, 'providerId con punto e\' rifiutato');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'providerId');
  assert.equal(issues[0].value, 'codex-vl.zai-a');
  assert.match(issues[0].rule, /consentito .*\^\[a-z\]/);
});

test('rejects an invalid environment key and reports field, value, and rule', () => {
  const { parsed, issues } = collect(baseDoc({ envKey: '9 ZAI BAD' }));
  assert.equal(parsed, null);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'envKey');
  assert.equal(issues[0].value, '9 ZAI BAD');
  assert.match(issues[0].rule, /consentito/);
});

test('rejects an undeclared model and reports where it must be declared', () => {
  // Il gate strictModels conta sui profili che lo dichiarano (es.
  // alibaba-token-plan); il custom codex-vl non e' strict, quindi il caso usa
  // un profilo strict vero.
  const doc = { schemaVersion: 1, engines: [{ id: 'codex-vl.atp', label: 'Atp', managed: {
    client: 'codex-vl', provider: 'alibaba-token-plan', model: 'glm-mai-visto',
  } }], cells: [] };
  const { parsed, issues } = collect(doc);
  assert.equal(parsed, null);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'model');
  assert.equal(issues[0].value, 'glm-mai-visto');
  assert.match(issues[0].rule, /non dichiarato|"models"/);
});

test('rejects an unsupported protocol and reports the allowed protocols', () => {
  const { parsed, issues } = collect(baseDoc({ protocol: 'chat_completions' }));
  assert.equal(parsed, null);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'protocol');
  assert.equal(issues[0].value, 'chat_completions');
  assert.match(issues[0].rule, /non supportato.*openai_responses/);
});

test('accepts a valid definition without issues', () => {
  const { parsed, issues } = collect(baseDoc());
  assert.ok(parsed, 'la definizione valida passa');
  assert.deepEqual(issues, [], 'nessuna issue su un documento valido');
});

test('atomicWrite reports the validation cause in its thrown message', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d143-'));
  try {
    const target = path.join(dir, 'fleet.json');
    assert.throws(
      () => atomicWrite(target, baseDoc({ providerId: 'codex-vl.zai-a' })),
      (e) => {
        assert.match(e.message, /definizioni fleet non valide/);
        assert.match(e.message, /providerId "codex-vl\.zai-a"/);
        assert.match(e.message, /consentito/);
        return true;
      },
      'il messaggio finale nomina campo, valore e regola');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
