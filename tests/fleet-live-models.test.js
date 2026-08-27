'use strict';

// D10 — GUARDIA sulla configurazione REALE (2026-08-27). Un modello usato da
// una cella deve essere dichiarato per l'engine di QUELLA cella, nella union
// di: dichiarazioni `models` di fleet.json per quell'engine + lista modelli
// del profilo (managed.js CATALOG). Il difetto ricorrente (qwen3.8-max,
// deepseek-v4-pro, unsloth/Qwen3.8-27B, glm-5.3-flash) passa silenzioso perche'
// i profili non-strict non rifiutano l'id a gate; qui lo rifiutiamo noi.
//
// Perimetro dichiarato: controlliamo SOLO engine con lista modelli propria
// (esclusi custom e i provider requiresModel senza lista, tipo openrouter:
// la dichiarazione la fa l'operatore cella per cella). Il default dell'engine
// (managed.model) e' controllato con la stessa regola.
//
// Fixture per i test: env FLEET_LIVE_CONFIG (default ~/.nexuscrew/fleet.json).
// Se il file non esiste il test si salta (CI senza config non diventa rossa).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CATALOG } = require('../lib/fleet/managed.js');

const CONFIG = process.env.FLEET_LIVE_CONFIG || path.join(os.homedir(), '.nexuscrew', 'fleet.json');

function profileForEngine(engineId) {
  const dot = engineId.indexOf('.');
  if (dot <= 0) return null;
  const client = engineId.slice(0, dot);
  const provider = engineId.slice(dot + 1);
  return CATALOG.find((e) => e.client === client && e.provider === provider) || null;
}

function problemsFor(fleet) {
  const declaredByEngine = new Map();
  for (const m of (Array.isArray(fleet.models) ? fleet.models : [])) {
    if (!m || !m.id || !m.engine) continue;
    if (!declaredByEngine.has(m.engine)) declaredByEngine.set(m.engine, new Set());
    declaredByEngine.get(m.engine).add(m.id);
  }
  const problems = [];
  const check = (who, engineId, model) => {
    if (!model || typeof model !== 'string') return;
    const profile = profileForEngine(engineId);
    if (!profile || profile.custom || !Array.isArray(profile.models)) return; // fuori perimetro, dichiarato sopra
    const ok = profile.models.includes(model)
      || (declaredByEngine.get(engineId) || new Set()).has(model);
    if (!ok) problems.push(`cella "${who}" (engine ${engineId}): modello "${model}" NON dichiarato ne' in fleet.json models ne' nella lista del profilo ${profile.client}/${profile.provider}`);
  };

  for (const e of (Array.isArray(fleet.engines) ? fleet.engines : [])) {
    const model = e && e.managed && e.managed.model;
    if (!model) continue;
    const profile = profileForEngine(e.id);
    if (!profile || profile.custom || !Array.isArray(profile.models)) continue;
    const ok = profile.models.includes(model) || (declaredByEngine.get(e.id) || new Set()).has(model);
    if (!ok) problems.push(`engine "${e.id}": default managed.model "${model}" NON dichiarato ne' in fleet.json models ne' nella lista del profilo ${profile.client}/${profile.provider}`);
  }
  for (const c of (Array.isArray(fleet.cells) ? fleet.cells : [])) {
    if (!c) continue;
    const model = c.model || (c.managed && c.managed.model);
    check(c.id || '?', c.engine, model);
  }
  return problems;
}

test('D10: ogni modello usato da una cella o da un default engine e\' dichiarato per il suo engine', (t) => {
  if (!fs.existsSync(CONFIG)) return t.skip(`nessuna configurazione live (${CONFIG})`);
  const fleet = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const problems = problemsFor(fleet);
  assert.deepEqual(problems, [], `modelli usati ma non dichiarati per il loro engine:\n  ${problems.join('\n  ')}`);
});

test('D10 (fixture): un modello non dichiarato produce rosso nominando cella, engine e modello', () => {
  const fleet = {
    schemaVersion: 1,
    engines: [{ id: 'codex-vl.opencode-go', managed: { model: 'modello-inesistente' } }],
    models: [],
    cells: [
      { id: 'Probe', engine: 'codex-vl.opencode-go', model: 'glm-5.3-flash' },
      { id: 'Ok', engine: 'codex-vl.opencode-go', model: 'deepseek-v4-pro' },
    ],
  };
  const problems = problemsFor(fleet);
  assert.equal(problems.length, 2, `attesi 2 problemi (cella + default engine), trovati: ${JSON.stringify(problems)}`);
  // I default engine vengono controllati prima delle celle: [0]=engine, [1]=cella.
  // Il default incoerente deve dare verdetto (non ReferenceError: audit
  // 0314517 R3 — ramo che prima lanciava client_ is not defined).
  assert.match(problems[0], /engine "codex-vl\.opencode-go".*"modello-inesistente"/);
  assert.match(problems[1], /"Probe".*codex-vl\.opencode-go.*"glm-5\.3-flash"/);
});
