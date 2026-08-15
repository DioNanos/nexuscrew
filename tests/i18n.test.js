'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('i18n: parità chiavi it/en/es, nessuna stringa vuota', async () => {
  const { DICTS } = await import('../frontend/src/lib/i18n.js');
  const keys = Object.keys(DICTS.it).sort();
  assert.ok(keys.length > 10, 'dizionario IT popolato');
  for (const lang of ['en', 'es']) {
    assert.deepEqual(Object.keys(DICTS[lang]).sort(), keys, `chiavi ${lang} = chiavi it`);
    for (const k of keys) assert.ok(DICTS[lang][k].trim(), `${lang}.${k} non vuota`);
  }
});

// La guardia sopra confronta le tre lingue FRA LORO: se una chiave manca in
// tutte e tre, la parita' e' perfetta e il test resta verde. E' esattamente
// cosi' che 'unreadable' (valore nuovo di credentialSource, 14/08) e
// 'nexuscrew-store' (preesistente) sono arrivati fino alla UI senza stringa —
// e t() su chiave assente restituisce LA CHIAVE, quindi l'utente leggeva
// `fleet-credential-source-unreadable` a schermo.
//
// Questa guardia lega invece i due lati: i valori che il BACKEND puo' produrre
// devono avere la stringa. L'ancora e' la costante esportata da managed.js, non
// una lista riscritta qui: una lista copiata a mano diverge dal codice e
// tornerebbe verde proprio quando il codice cambia.
test('i18n: ogni valore di credentialSource prodotto dal backend ha la sua stringa', async () => {
  const { DICTS } = await import('../frontend/src/lib/i18n.js');
  const { CREDENTIAL_SOURCE_VALUES } = require('../lib/fleet/managed.js');
  assert.ok(CREDENTIAL_SOURCE_VALUES.length >= 6, 'elenco valori popolato');
  const missing = [];
  for (const value of CREDENTIAL_SOURCE_VALUES) {
    for (const lang of ['it', 'en', 'es']) {
      const key = `fleet-credential-source-${value}`;
      if (!Object.prototype.hasOwnProperty.call(DICTS[lang], key)) missing.push(`${lang}.${key}`);
    }
  }
  assert.deepEqual(missing, [], `valori senza stringa: ${missing.join(', ')}`);
});

// La guardia sopra va in una direzione sola: lista -> stringa. Un audit l'ha
// rotta in un modo che va chiuso: chi aggiunge `source: 'x'` in credential()
// senza aggiornare la costante ha il test verde e la chiave tecnica a schermo.
// La lista sarebbe un contratto fra persone, non una guardia.
//
// Questa chiude il giro nell'altra direzione: legge i valori DAL CODICE di
// credential() e pretende che siano nella costante. E' una guardia sul
// sorgente, quindi vale solo finche' riconosce la forma che legge: se incontra
// un `source:` che non e' un letterale ne' una delle due forme note, FALLISCE
// invece di ignorarlo — un'analisi che non capisce cio' che legge deve fermare,
// non assolvere.
test('i18n: la costante dei credentialSource non diverge dal codice che li produce', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { CREDENTIAL_SOURCE_VALUES } = require('../lib/fleet/managed.js');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fleet', 'managed.js'), 'utf8');

  const start = src.indexOf('\nfunction credential(profile, spec, cfg, home, out) {');
  assert.ok(start > 0, 'ancora: la funzione credential() esiste con questa firma');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'ancora: la funzione ha una chiusura riconoscibile');
  const body = src.slice(start, end);

  const found = new Set();
  for (const m of body.matchAll(/source:\s*([^,}\n]+)/g)) {
    const expr = m[1].trim();
    const literal = expr.match(/^'([a-z-]+)'$/);
    if (literal) { found.add(literal[1]); continue; }
    // Le due forme non letterali ammesse, ciascuna con i valori che puo' dare.
    if (expr === 'profile.auth') { found.add('login'); found.add('none'); continue; }
    const ternary = expr.match(/^\w+\s*\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'$/);
    if (ternary) { found.add(ternary[1]); found.add(ternary[2]); continue; }
    assert.fail(`forma di \`source:\` non riconosciuta (${expr}): aggiorna questa guardia invece di lasciarla passare`);
  }

  assert.ok(found.size >= 6, `valori estratti dal codice: ${[...found].join(', ')}`);
  const notDeclared = [...found].filter((v) => !CREDENTIAL_SOURCE_VALUES.includes(v));
  assert.deepEqual(notDeclared, [], `credential() produce valori non dichiarati in CREDENTIAL_SOURCE_VALUES: ${notDeclared.join(', ')}`);
});

// Stessa forma, seconda famiglia: i codici di errore del backup finiscono in
// `fleet-backup-<codice>`. Due di essi (i modelli, aggiunti dopo) non avevano
// stringa in nessuna lingua da quando esistono — nessuno se n'era accorto
// perche' nessuna guardia legava i codici alle chiavi. Trovata dall'audit.
test('i18n: ogni codice di errore del backup ha la sua stringa, e la lista non diverge dal codice', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { DICTS } = await import('../frontend/src/lib/i18n.js');
  const { BACKUP_ERROR_CODES } = await import('../frontend/src/lib/fleet-backup.js');
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'lib', 'fleet-backup.js'), 'utf8');

  const produced = new Set([...src.matchAll(/\berror:\s*'([a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(produced.size >= 6, `codici estratti dal codice: ${[...produced].join(', ')}`);
  const notDeclared = [...produced].filter((v) => !BACKUP_ERROR_CODES.includes(v));
  assert.deepEqual(notDeclared, [], `codici prodotti ma non dichiarati: ${notDeclared.join(', ')}`);

  const missing = [];
  for (const code of BACKUP_ERROR_CODES) {
    for (const lang of ['it', 'en', 'es']) {
      const key = `fleet-backup-${code}`;
      if (!Object.prototype.hasOwnProperty.call(DICTS[lang], key)) missing.push(`${lang}.${key}`);
    }
  }
  assert.deepEqual(missing, [], `codici senza stringa: ${missing.join(', ')}`);
});

test('i18n: t() fallback su IT e su chiave', async () => {
  const { t, DICTS } = await import('../frontend/src/lib/i18n.js');
  assert.equal(t('__missing__'), '__missing__');
  assert.ok(DICTS.it.sessions);
});

// Fino alla 0.8.47 questo aiuto diceva che trascinare non fa scorrere i TUI a
// schermo intero, e il test fissava quella frase. Dalla 0.8.48 non e' piu' vero:
// un'applicazione che segue il mouse riceve i report della rotella e scorre da
// se'. Il testo e' stato corretto, e con lui questa guardia.
//
// LIMITE, dichiarato perche' la prima stesura affermava il contrario: questa
// guardia vincola il VOCABOLARIO, non la semantica. Protegge dalla deriva e
// dalla cancellazione — se qualcuno riscrive l'aiuto smettendo di nominare i due
// casi, o vi rimette l'affermazione vecchia, cade. NON protegge da una
// riscrittura che nomina i due casi per NEGARLI: «e' falso che un'app che segue
// il mouse scorre da se'...» passerebbe. Un test su prosa non puo' fare di
// meglio senza diventare fragile, e fingere che lo faccia e' peggio che
// ammetterlo. Rilievo di un audit indipendente, con esempi avversari a prova.
test('i18n: alternateScreen distingue chi scorre da se\' da chi naviga la storia tmux', async () => {
  const { DICTS } = await import('../frontend/src/lib/i18n.js');
  const it = DICTS.it['alternate-screen-help'];
  const en = DICTS.en['alternate-screen-help'];
  const es = DICTS.es['alternate-screen-help'];
  assert.match(it, /segue il mouse.*scorre da s/i);
  assert.match(it, /storia di tmux/i);
  assert.match(en, /tracks the mouse.*scrolls on its own/i);
  assert.match(en, /tmux scrollback/i);
  assert.match(es, /sigue el rat.n.*se desplaza sola/i);
  assert.match(es, /historial de tmux/i);
  // La vecchia affermazione non deve tornare in nessuna lingua: era falsa.
  for (const text of [it, en, es]) {
    assert.ok(!/non scorre i TUI|does not scroll full-screen|no desplaza los TUI/i.test(text),
      'l\'aiuto non deve tornare a negare uno scorrimento che ora avviene');
  }
});
