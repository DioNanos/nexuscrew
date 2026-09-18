import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createFleetBackup, parseFleetBackup, MAX_ENGINES, MAX_MODELS } from './fleet-backup.js';

// La fonte del cap e' il backend (CAPS.MAX_ENGINES in lib/fleet/definitions.js,
// modulo node-only che il bundle non puo' importare). La copia frontend in
// fleet-backup.js e' vigilata qui: se qualcuno cambia una delle due costanti
// senza l'altra, questo test e' rosso PRIMA che il bundle spedisca un parse
// che rifiuta i propri export (difetto 0.9.16: copia a 24, backend a 100).
const require = createRequire(import.meta.url);
const { CAPS } = require('../../../lib/fleet/definitions.js');

const engine = (n) => ({
  id: `eng-${n}`, label: `Engine ${n}`, rc: true,
  command: '/bin/true', args: [], promptMode: 'flag', promptFlag: '--append-system-prompt',
});
const engines = (n) => Array.from({ length: n }, (_, i) => engine(i));
const cells = [{ id: 'Ops', cwdRel: 'Dev', engine: 'eng-0', prompt: '' }];
const backupWith = (n) => createFleetBackup(
  cells, new Set(['Ops']), engines(n), new Set(engines(n).map((e) => e.id)),
  new Date('2026-08-28T00:00:00Z'),
);

describe('fleet backup engine cap — parita\' col backend e frontiera 24/25/100/101', () => {
  it('la copia frontend del cap coincide con CAPS.MAX_ENGINES del backend', () => {
    expect(MAX_ENGINES).toBe(CAPS.MAX_ENGINES);
  });

  it.each([24, 25, 100])('round-trip export→parse con %i engine', (n) => {
    const backup = backupWith(n);
    expect(backup.engines).toHaveLength(n);
    const parsed = parseFleetBackup(JSON.stringify(backup));
    expect(parsed.ok).toBe(true);
    expect(parsed.engines).toHaveLength(n);
  });

  it('rifiuta 101 engine con messaggio esplicito del cap', () => {
    const backup = backupWith(101);
    expect(backup.engines).toHaveLength(101);
    const parsed = parseFleetBackup(JSON.stringify(backup));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('invalid-format');
    expect(parsed.detail).toContain('101');
    expect(parsed.detail).toContain(`cap ${MAX_ENGINES}`);
  });
});

// Il cap dei modelli dichiarati segue la stessa regola degli engine: la fonte
// è il backend, la copia frontend è vigilata qui prima che il bundle spedisca
// un parse che rifiuta i propri export.
describe('fleet backup model cap — parità col backend e frontiera 64/65/128/129', () => {
  // I modelli dichiarati viaggiano col PROFILO dell'engine (client.provider),
  // quindi il fixture è un engine managed: senza `managed` il create non
  // esporterebbe nessun modello (declaredModelsFor è fail-closed).
  const managedEngine = { ...engine(0), managed: { client: 'claude', provider: 'alibaba-token-plan' } };
  const model = (n) => ({ id: `m-${n}`, engine: 'claude.alibaba-token-plan' });
  const backupWithModels = (n) => createFleetBackup(
    cells, new Set(['Ops']), [managedEngine], new Set(['eng-0']),
    new Date('2026-08-28T00:00:00Z'),
    Array.from({ length: n }, (_, i) => model(i)),
  );

  it('la copia frontend del cap coincide con CAPS.MAX_MODELS del backend', () => {
    expect(MAX_MODELS).toBe(CAPS.MAX_MODELS);
    expect(MAX_MODELS).toBe(128);
  });

  it.each([64, 65, 128])('round-trip export→parse con %i modelli dichiarati', (n) => {
    const backup = backupWithModels(n);
    const parsed = parseFleetBackup(JSON.stringify(backup));
    expect(parsed.ok).toBe(true);
    expect(parsed.models).toHaveLength(n);
  });

  it('rifiuta 129 modelli', () => {
    const backup = backupWithModels(128);
    const raw = JSON.parse(JSON.stringify(backup));
    raw.models.push(model(128));
    const parsed = parseFleetBackup(JSON.stringify(raw));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('invalid-model');
  });
});
