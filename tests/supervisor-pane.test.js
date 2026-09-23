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
const { PANES_FMT, parsePanes, statiSupervisore, senzaSupervisore } = require('../lib/tmux/supervisor-pane.js');

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

test('SUPERVISORE MORTO con una seconda finestra VIVA: stato morto', () => {
  // E' il caso misurato: il pane marcato e' morto, l'altro pane e' vivo. Se si
  // guardasse il pane attivo della sessione, questa cella sembrerebbe viva.
  const stati = statiSupervisore('cloud-Dev\t%1\t1\t1\ncloud-Dev\t%2\t0\t\n');
  assert.equal(stati.get('cloud-Dev'), 'morto');
});

test('supervisore VIVO: stato vivo (un pane non marcato e morto non conta)', () => {
  assert.equal(statiSupervisore('cloud-Dev\t%1\t0\t1\n').get('cloud-Dev'), 'vivo');
  assert.equal(statiSupervisore('cloud-Dev\t%1\t0\t1\ncloud-Dev\t%2\t1\t\n').get('cloud-Dev'), 'vivo',
    'il supervisore e il pane MARCATO');
});

test('NESSUN marcatore: stato assente (non si sa quale pane sia il supervisore)', () => {
  assert.equal(statiSupervisore('cloud-Dev\t%1\t0\t\n').get('cloud-Dev'), 'assente');
  assert.equal(statiSupervisore('cloud-Dev\t%1\t0\t\ncloud-Dev\t%2\t0\t\n').get('cloud-Dev'), 'assente');
});

test('LA DECISIONE: morto sempre; assente solo se il file dichiara la garanzia dell\'uscita', () => {
  assert.equal(senzaSupervisore('morto', false), true, 'supervisore morto: non si legge, qualunque file');
  assert.equal(senzaSupervisore('morto', true), true);
  assert.equal(senzaSupervisore('vivo', true), false, 'supervisore vivo: si legge');
  assert.equal(senzaSupervisore('vivo', false), false);
  // Il caso che distingue due lanci diversi senza marcatore: con `exit:1` il
  // `Stop` non scadrebbe e nessuno garantisce il supervisore -> non si legge;
  // senza, vale il lettore, che fa scadere tutto a 5 minuti.
  assert.equal(senzaSupervisore('assente', true), true, 'lancio nuovo con marcatura fallita');
  assert.equal(senzaSupervisore('assente', false), false, 'lancio VECCHIO: decide il lettore, 5 minuti');
});

test('sessioni diverse si contano separatamente', () => {
  const stati = statiSupervisore([
    'cloud-A\t%1\t1\t1',   // supervisore morto
    'cloud-B\t%2\t0\t1',   // supervisore vivo
    'cloud-C\t%3\t0\t',    // nessun marcatore
  ].join('\n'));
  assert.deepEqual([...stati.entries()].sort(), [['cloud-A', 'morto'], ['cloud-B', 'vivo'], ['cloud-C', 'assente']]);
});

test('uscita vuota o senza server: nessuna sessione', () => {
  assert.equal(statiSupervisore('').size, 0);
  assert.equal(statiSupervisore('\n').size, 0);
});
