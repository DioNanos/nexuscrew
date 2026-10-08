'use strict';
// lib/live-host/reserved.js — il nome `Live` appartiene alla Live.
//
// Una cella con quel nome (in qualunque grafia) si scambierebbe con la voce di
// directory della Live. Il divieto vale alla scrittura e il nome e' filtrato
// in uscita, cosi' una definizione gia' presente non puo' sovrapporsi.

function isReservedLiveName(id) {
  return typeof id === 'string' && id.toLowerCase() === 'live';
}

module.exports = { isReservedLiveName };
