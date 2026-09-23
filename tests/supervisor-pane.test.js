'use strict';
// Qual e' il pane del SUPERVISORE di una cella, e se e' vivo.
//
// Il caso che questi test tengono chiuso e' stato MISURATO con tmux vero:
// `#{pane_dead}` di `list-sessions` riguarda il pane ATTIVO della sessione, e
// con una seconda finestra viva selezionata dice «vivo» anche quando il pane del
// supervisore e' morto — cosi' lo `Stop` con `exit:1` di un'ora prima tornava
// «ferma».
const { test } = require('node:test');
const assert = require('node:assert');
const { PANES_FMT, parsePanes, sessioniSenzaSupervisore } = require('../lib/tmux/supervisor-pane.js');

test('il formato chiede il pane, il suo pane_dead e il marcatore', () => {
  assert.match(PANES_FMT, /#\{session_name\}/);
  assert.match(PANES_FMT, /#\{pane_id\}/);
  assert.match(PANES_FMT, /#\{pane_dead\}/);
  assert.match(PANES_FMT, /#\{@nc_supervisor\}/);
});

test('parsePanes legge quattro campi, con righe vuote ignorate', () => {
  const out = parsePanes('cloud-Dev\t%1\t0\t1\n\ncloud-Dev\t%2\t1\t\n');
  assert.deepEqual(out, [
    { session: 'cloud-Dev', paneId: '%1', dead: false, marked: true },
    { session: 'cloud-Dev', paneId: '%2', dead: true, marked: false },
  ]);
});

test('SUPERVISORE MORTO con una seconda finestra VIVA: la sessione e senza supervisore', () => {
  // E' il caso misurato: il pane marcato e' morto, l'altro pane e' vivo. Se si
  // guardasse il pane attivo della sessione, questa cella sembrerebbe viva.
  const morte = sessioniSenzaSupervisore('cloud-Dev\t%1\t1\t1\ncloud-Dev\t%2\t0\t\n');
  assert.ok(morte.has('cloud-Dev'), 'il pane del supervisore e morto');
});

test('supervisore VIVO: la sessione non entra fra quelle senza supervisore', () => {
  assert.equal(sessioniSenzaSupervisore('cloud-Dev\t%1\t0\t1\n').has('cloud-Dev'), false);
  // anche con altre finestre attorno
  assert.equal(sessioniSenzaSupervisore('cloud-Dev\t%1\t0\t1\ncloud-Dev\t%2\t1\t\n').has('cloud-Dev'), false,
    'un pane NON marcato e morto non conta: il supervisore e quello marcato');
});

test('NESSUN marcatore (cella lanciata prima di questa versione): senza supervisore', () => {
  // Non si sa quale dei suoi pani sia il supervisore, quindi non si afferma
  // niente sul suo stato: la sessione entra qui e la UI dice «non verificato».
  assert.equal(sessioniSenzaSupervisore('cloud-Dev\t%1\t0\t\n').has('cloud-Dev'), true);
  assert.equal(sessioniSenzaSupervisore('cloud-Dev\t%1\t0\t\ncloud-Dev\t%2\t0\t\n').has('cloud-Dev'), true,
    'due pani vivi e nessun marcatore restano non identificabili');
});

test('sessioni diverse si contano separatamente', () => {
  const morte = sessioniSenzaSupervisore([
    'cloud-A\t%1\t1\t1',   // supervisore morto
    'cloud-B\t%2\t0\t1',   // supervisore vivo
    'cloud-C\t%3\t0\t',    // nessun marcatore
  ].join('\n'));
  assert.deepEqual([...morte].sort(), ['cloud-A', 'cloud-C']);
});

test('uscita vuota o senza server: nessuna sessione, nessuna morte', () => {
  assert.deepEqual([...sessioniSenzaSupervisore('')], []);
  assert.deepEqual([...sessioniSenzaSupervisore('\n')], []);
});
