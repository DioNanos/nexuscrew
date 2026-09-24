'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  hashHook,
  chiaveHook,
  timeoutPerEvento,
  definizioneHook,
  tabellaStato,
  argomentiHookCodex,
  jsonCanonico,
  etichetta,
  gateVersione,
  gatePiattaforma,
  EVENTI_CODEX,
} = require('../lib/fleet/codex-hooks.js');

// I valori attesi qui non sono inventati: vengono dal JSON canonico e dalla
// normalizzazione letti nel sorgente di codex, e il caso SessionStart e' lo
// STESSO comando di una prova isolata su TUI reale — se il calcolo devia, la
// fiducia non combacia piu' e il client riapre il dialogo di revisione.

test('hashHook riproduce l\'hash della prova isolata su TUI', () => {
  const comando = 'printf cli-ran >> /tmp/d348-step0-15985qqx/cli-probe';
  assert.strictEqual(
    hashHook('SessionStart', comando),
    'sha256:1c196e4a186c6ba4bfd1f4a9c86e2ea8f43d0f13527f93c70001134a70e47d4b',
  );
});

test('l\'hash cambia col comando: e\' cio\' che invalida la fiducia', () => {
  const a = hashHook('SessionStart', 'printf a');
  const b = hashHook('SessionStart', 'printf b');
  assert.notStrictEqual(a, b);
});

test('SessionEnd e Interrupt hanno il timeout corto, gli altri quello standard', () => {
  assert.strictEqual(timeoutPerEvento('SessionEnd'), 1);
  assert.strictEqual(timeoutPerEvento('Interrupt'), 1);
  assert.strictEqual(timeoutPerEvento('Stop'), 600);
  assert.strictEqual(timeoutPerEvento('PreToolUse'), 600);
  assert.strictEqual(timeoutPerEvento('UserPromptSubmit'), 600);
});

test('il timeout entra nell\'hash: lo stesso comando non vale per SessionEnd', () => {
  const comando = 'printf x';
  assert.notStrictEqual(hashHook('Stop', comando), hashHook('SessionEnd', comando));
});

test('la chiave porta la fonte SessionFlags, l\'etichetta evento e gli indici', () => {
  assert.strictEqual(chiaveHook('SessionStart'), '/<session-flags>/config.toml:session_start:0:0');
  assert.strictEqual(chiaveHook('Interrupt', 0, 0), '/<session-flags>/config.toml:interrupt:0:0');
});

test('jsonCanonico ordina le chiavi e non mette spazi', () => {
  assert.strictEqual(jsonCanonico({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.strictEqual(jsonCanonico({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('la definizione dell\'hook e\' un array con un handler di tipo command', () => {
  assert.strictEqual(
    definizioneHook('Stop', 'printf x'),
    'hooks.Stop=[{hooks=[{type="command",command="printf x"}]}]',
  );
});

test('lo stato e\' una TABELLA inline, non un path puntato', () => {
  const tabella = tabellaStato([{ chiave: '/<session-flags>/config.toml:stop:0:0', hash: 'sha256:abc' }]);
  assert.strictEqual(tabella, 'hooks.state={"/<session-flags>/config.toml:stop:0:0"={trusted_hash="sha256:abc"}}');
  // La forma che NON funziona col parser di -c: la chiave contiene punti.
  assert.ok(!tabella.includes('hooks.state./'));
});

test('argomentiHookCodex produce una definizione per evento e una sola tabella di stato', () => {
  const args = argomentiHookCodex(['Stop', 'SessionEnd'], (e) => `node hook.js --event ${e}`);
  const tabelle = args.filter((a) => a.startsWith('hooks.state='));
  assert.strictEqual(tabelle.length, 1);
  assert.strictEqual(args.filter((a) => a.startsWith('hooks.') && a !== tabelle[0]).length, 2);
  // ogni definizione e' preceduta dal suo `-c`
  assert.strictEqual(args.filter((a) => a === '-c').length, 3);
  // entrambe le chiavi sono nella tabella, ciascuna col PROPRIO hash
  assert.ok(tabelle[0].includes('/<session-flags>/config.toml:stop:0:0'));
  assert.ok(tabelle[0].includes('/<session-flags>/config.toml:session_end:0:0'));
});

test('una lista vuota non produce argomenti', () => {
  assert.deepStrictEqual(argomentiHookCodex([], () => 'x'), []);
  assert.deepStrictEqual(argomentiHookCodex(['Stop'], () => null), []);
});

// Un caso per OGNI evento iniettato: etichetta, chiave e hash. Se un evento
// perde la sua etichetta o eredita quella di un altro, la chiave dello stato
// non combacia e quel singolo hook resta non fidato — con la cella che si
// ferma sul dialogo di revisione.
test('ogni evento iniettato ha etichetta, chiave e hash propri', () => {
  const attesi = {
    SessionStart: 'session_start',
    UserPromptSubmit: 'user_prompt_submit',
    PreToolUse: 'pre_tool_use',
    PostToolUse: 'post_tool_use',
    Stop: 'stop',
    Interrupt: 'interrupt',
    SessionEnd: 'session_end',
  };
  assert.deepStrictEqual([...EVENTI_CODEX].sort(), Object.keys(attesi).sort());
  const hash = new Set();
  for (const [evento, label] of Object.entries(attesi)) {
    assert.strictEqual(etichetta(evento), label, `etichetta di ${evento}`);
    assert.strictEqual(chiaveHook(evento), `/<session-flags>/config.toml:${label}:0:0`, `chiave di ${evento}`);
    hash.add(hashHook(evento, 'printf x'));
  }
  assert.strictEqual(hash.size, Object.keys(attesi).length, 'gli hash devono essere distinti fra eventi');
});

test('gli argomenti coprono tutti gli eventi con la loro definizione', () => {
  const args = argomentiHookCodex(EVENTI_CODEX, (e) => `node h.js --event ${e}`);
  for (const evento of EVENTI_CODEX) {
    assert.ok(args.some((a) => a.startsWith(`hooks.${evento}=`)), `manca la definizione di ${evento}`);
  }
  assert.strictEqual(args.filter((a) => a.startsWith('hooks.state=')).length, 1, 'una sola tabella di stato');
});

// ── Guardia di versione ───────────────────────────────────────────────
// La fiducia dell'hook dipende dall'hash di UNA versione: su una versione non
// provata non si inietta niente, perche' il costo dell'errore non e' un hook
// che non parte ma una cella BLOCCATA su un dialogo che nessuno vede.

test('la guardia accetta le versioni provate', () => {
  const cfg = { codexVersionProbe: (bin) => (bin.endsWith('codex') ? 'codex-cli 0.156.1' : 'codex-cli 0.155.1') };
  assert.deepStrictEqual(gateVersione('codex', '/tmp/finto/bin/codex', cfg), { ok: true, versione: '0.156.1' });
  assert.deepStrictEqual(gateVersione('codex-vl', '/tmp/finto/bin/codex-vl', cfg), { ok: true, versione: '0.155.1' });
  // Anche 0.156.1 del fork e' provata (il binario del merge recente stampa
  // «codex-cli 0.156.1», misurato sul gate del binario): accettata uguale.
  const vl156 = { codexVersionProbe: () => 'codex-cli 0.156.1' };
  assert.deepStrictEqual(gateVersione('codex-vl', '/tmp/finto/bin/codex-vl', vl156), { ok: true, versione: '0.156.1' });
  // E una versione qualunque del fork resta fuori: la fiducia e' per hash
  // esatto, mai per prefisso.
  const g = gateVersione('codex-vl', '/tmp/finto/bin/codex-vl', { codexVersionProbe: () => 'codex-cli 0.9.9' });
  assert.strictEqual(g.ok, false);
  assert.match(g.reason, /non provata/);
});

test('il client sceglie l\'elenco, il binario e\' cio\' che si esegue', () => {
  // Il probe riceve il SECONDO argomento. Se il gate eseguisse il nome del
  // client — che e' il difetto chiuso qui — questa asserzione cadrebbe.
  let visto = null;
  const cfg = { codexVersionProbe: (bin) => { visto = bin; return 'codex-cli 0.156.1'; } };
  assert.deepStrictEqual(gateVersione('codex', '/tmp/altrove/codex', cfg), { ok: true, versione: '0.156.1' });
  assert.strictEqual(visto, '/tmp/altrove/codex');
});

test('una versione non provata NON inietta, e lo dice', () => {
  const g = gateVersione('codex', '/tmp/finto/bin/codex', { codexVersionProbe: () => 'codex-cli 0.157.0' });
  assert.strictEqual(g.ok, false);
  assert.match(g.reason, /non provata/);
});

test('una versione non determinabile NON inietta, e lo dice', () => {
  const g = gateVersione('codex', '/tmp/finto/bin/codex', { codexVersionProbe: () => null });
  assert.strictEqual(g.ok, false);
  assert.match(g.reason, /non determinabile/);
});

test('un binario non risolto NON inietta, e lo dice', () => {
  // Nessun binario risolto per la cella: non c'e' niente da interrogare, e
  // non si inietta — il fail-closed della guardia vale anche qui.
  const g = gateVersione('codex', '', {});
  assert.strictEqual(g.ok, false);
  assert.match(g.reason, /non risolto/);
});

test('un output non riconoscibile NON inietta', () => {
  const g = gateVersione('codex', '/tmp/finto/bin/codex', { codexVersionProbe: () => 'comando sconosciuto' });
  assert.strictEqual(g.ok, false);
  assert.match(g.reason, /non riconosciuta/);
});

test('un client non gestito NON inietta', () => {
  assert.strictEqual(gateVersione('pi', '/tmp/finto/bin/pi', {}).ok, false);
});

// La chiave di fiducia e il quoting degli hook sono Unix: dove il client ne
// calcola una diversa, iniettare aprirebbe il dialogo che la guardia evita.

test('il gate di piattaforma: linux e darwin si\', win32 e termux no', () => {
  assert.strictEqual(gatePiattaforma({ platform: 'linux', env: {} }).ok, true);
  assert.strictEqual(gatePiattaforma({ platform: 'darwin', env: {} }).ok, true);

  const win = gatePiattaforma({ platform: 'win32', env: {} });
  assert.strictEqual(win.ok, false);
  assert.match(win.reason, /win32/);

  const android = gatePiattaforma({ platform: 'android', env: {} });
  assert.strictEqual(android.ok, false);
  assert.match(android.reason, /termux/);

  // Termux si riconosce anche dal layout, non solo da `process.platform`:
  // e' lo stesso criterio che usa il launcher.
  const daPrefisso = gatePiattaforma({ platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } });
  assert.strictEqual(daPrefisso.ok, false);
  assert.match(daPrefisso.reason, /termux/);
});
