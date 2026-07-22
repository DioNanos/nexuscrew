'use strict';
// Identita' tmux sicura (NexusCrew 0.8.31): mapping v2 dot-free, reverse,
// isTmuxSafeName e normalizzazione on-parse del tmuxSession legacy puntato.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  tmuxSessionForCell, cellIdFromTmuxSession, isTmuxSafeName, validTmuxName,
  parseDefinitions, loadDefinitions, atomicWrite,
} = require('../lib/fleet/definitions.js');

test('tmuxSessionForCell: id senza punto resta nello storico cloud-<id> (tmux-safe)', () => {
  assert.equal(tmuxSessionForCell('Dev'), 'cloud-Dev');
  assert.equal(tmuxSessionForCell('agy_native'), 'cloud-agy_native');
});

test('tmuxSessionForCell: id con punto -> v2 dot-free, 55 char, charset [A-Za-z0-9_-], nessun punto, <=64', () => {
  const s = tmuxSessionForCell('agy.native');
  assert.equal(s, 'cloud-v2-14-YWd5Lm5hdGl2ZQ-----------------------------');
  assert.equal(s.length, 55);
  assert.match(s, /^cloud-v2-\d{2}-[A-Za-z0-9_-]{43}$/);
  assert.ok(!s.includes('.'), 'nessun punto');
  assert.ok(s.length <= 64);
});

test('tmuxSessionForCell: iniettivo su campioni critici (agy.native vs agy_native, a.b vs a_b)', () => {
  const a = tmuxSessionForCell('agy.native');
  const b = tmuxSessionForCell('agy_native');
  assert.notEqual(a, b, 'agy.native e agy_native producono nomi distinti');
  assert.notEqual(tmuxSessionForCell('a.b'), tmuxSessionForCell('a_b'));
  assert.notEqual(tmuxSessionForCell('a.b'), tmuxSessionForCell('ab'));
});

test('tmuxSessionForCell: massimali e edge (senza punto -> cloud-<id>; con punto -> v2 55 char)', () => {
  // id SENZA punto: storico cloud-<id> (tmux-safe per costruzione)
  for (const id of ['a', 'A', 'agy_native', 'x'.repeat(32)]) {
    assert.equal(tmuxSessionForCell(id), `cloud-${id}`);
  }
  // id CON punto: v2 dot-free, 55 char, charset sicuro
  for (const id of ['a.b', 'agy.native.v2', `${'a'.repeat(31)}.`, `${'x'.repeat(31)}.`]) {
    const s = tmuxSessionForCell(id);
    assert.equal(s.length, 55, `id=${id} -> 55 char`);
    assert.ok(!s.includes('.'), `id=${id} senza punto`);
    assert.match(s, /^cloud-v2-\d{2}-[A-Za-z0-9_-]{43}$/);
  }
  // id non valido -> null
  assert.equal(tmuxSessionForCell(''), null);
  assert.equal(tmuxSessionForCell('bad space'), null);
  assert.equal(tmuxSessionForCell(`${'x'.repeat(33)}`), null);
});

test('tmuxSessionForCell: disgiunto dal namespace storico cloud-<id>', () => {
  // dopo 'cloud-' la forma v2 ha 49 char (>32 max di un id): nessun nome v2 puo'
  // essere interpretato come cloud-<id> legittimo.
  const v2 = tmuxSessionForCell('agy.native');
  const suffix = v2.slice('cloud-'.length);
  assert.ok(suffix.length > 32);
});

test('cellIdFromTmuxSession: round-trip v2 e cloud-<id> sicuro; null su non canonico', () => {
  assert.equal(cellIdFromTmuxSession(tmuxSessionForCell('agy.native')), 'agy.native');
  assert.equal(cellIdFromTmuxSession(tmuxSessionForCell('a.b')), 'a.b');
  assert.equal(cellIdFromTmuxSession(tmuxSessionForCell('Dev')), 'Dev');
  assert.equal(cellIdFromTmuxSession('cloud-Dev'), 'Dev');
  assert.equal(cellIdFromTmuxSession('jarvis'), null);
  assert.equal(cellIdFromTmuxSession('cloud-v2-99-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), null);
});

test('isTmuxSafeName: ammette nomi senza punto, rifiuta punti e forme non valide', () => {
  assert.equal(isTmuxSafeName('cloud-Dev'), true);
  assert.equal(isTmuxSafeName('cloud-v2-14-YWd5Lm5hdGl2ZQ-----------------------------'), true);
  assert.equal(isTmuxSafeName('cloud-agy.native'), false, 'punto rifiutato');
  assert.equal(isTmuxSafeName('-leading'), false);
  assert.equal(isTmuxSafeName(''), false);
  // validTmuxName resta permissivo (parsing legacy): distinto da isTmuxSafeName
  assert.equal(validTmuxName('cloud-agy.native'), true);
  assert.equal(isTmuxSafeName('cloud-agy.native'), false);
});

test('parseCell normalizza il tmuxSession legacy puntato al safe (migra, non scarta)', () => {
  const safe = tmuxSessionForCell('agy.native');
  // override legacy esplicito cloud-agy.native -> normalizzato a safe
  const legacy = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'agy.native', managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id: 'agy.native', cwd: '/h/x', engine: 'agy.native', tmuxSession: 'cloud-agy.native' }],
  });
  assert.ok(legacy);
  assert.equal(legacy.cells[0].tmuxSession, safe, 'legacy normalizzato a v2');
  // nessun override (derivato) -> safe
  const derived = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'agy.native', managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' } }],
    cells: [{ id: 'agy.native', cwd: '/h/x', engine: 'agy.native' }],
  });
  assert.equal(derived.cells[0].tmuxSession, safe);
});

test('parseCell: legacy custom puntato leggibile per migrazione, ma strict write lo rifiuta', () => {
  const engine = { id: 'agy.native', managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' } };
  const raw = { schemaVersion: 1, engines: [engine], cells: [{ id: 'agy.native', cwd: '/h/x', engine: 'agy.native', tmuxSession: 'foo.bar' }] };
  const legacy = parseDefinitions(raw);
  assert.ok(legacy, 'lettura legacy ammessa per consentire la migrazione');
  assert.equal(legacy.cells[0].tmuxSession, tmuxSessionForCell('agy.native'));
  assert.equal(legacy.legacyTmuxSessions.get('agy.native'), 'foo.bar');
  assert.equal(parseDefinitions(raw, { allowLegacyTmuxNames: false }), null,
    'percorso di scrittura strict rifiuta il nuovo override puntato');
  assert.equal(parseDefinitions({ schemaVersion: 1, engines: [engine], cells: [{ id: 'agy.native', cwd: '/h/x', engine: 'agy.native', tmuxSession: 'cloud-Other' }] }), null, 'alias cloud-* altrui');
  const custom = parseDefinitions({ schemaVersion: 1, engines: [engine], cells: [{ id: 'agy.native', cwd: '/h/x', engine: 'agy.native', tmuxSession: 'my-safe-session' }] });
  assert.equal(custom.cells[0].tmuxSession, 'my-safe-session', 'override custom senza punto ammesso');
});

test('parseCell: id senza punto invariato (sessioni esistenti non rinominate)', () => {
  const d = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'claude.native', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: 'Dev', cwd: '/h/x', engine: 'claude.native' }],
  });
  assert.equal(d.cells[0].tmuxSession, 'cloud-Dev');
});

test('load legacy -> atomicWrite del modello migrato persiste safe; write diretto puntato e rifiutato', () => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync('/tmp/nc-sess-');
  try {
    const p = `${dir}/fleet.json`;
    const raw = {
      schemaVersion: 1,
      engines: [{ id: 'agy.native', managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' } }],
      cells: [{ id: 'agy.native', cwd: dir, engine: 'agy.native', tmuxSession: 'cloud-agy.native' }],
    };
    fs.writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    const parsed = loadDefinitions(p);
    assert.equal(parsed.cells[0].tmuxSession, tmuxSessionForCell('agy.native'));
    assert.equal(parsed.legacyTmuxSessions.get('agy.native'), 'cloud-agy.native');
    atomicWrite(p, parsed);
    const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(onDisk.cells[0].tmuxSession, tmuxSessionForCell('agy.native'), 'scritto safe su disco');
    assert.throws(() => atomicWrite(`${dir}/new.json`, raw), /definizioni fleet non valide/,
      'un nuovo write puntato non puo entrare nello store');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
