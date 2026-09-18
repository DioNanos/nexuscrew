#!/usr/bin/env node
'use strict';
// lib/fleet/cell-hold.js — placeholder inerte per l'avvio staged del pane Fleet.
// (tmux-safe identity rules: no interactive shell)
//
// Resta in attesa finche' `respawn-pane -k` non lo sostituisce con il vero client
// (cell-exec). Crea il pane e la finestra in modo deterministico cosi' il runtime
// puo' armare `remain-on-exit` window-local PRIMA di lanciare il child reale:
// cio' impedisce a un child rapido di chiudere la sessione durante il setup. La
// normalizzazione dei punti nei nomi tmux e gestita separatamente dal mapping v2.
//
// Constraints: NO interactive shell, NO user rc/alias/plugin sourcing,
// NO sensitive data, NO interpreted arguments. Direct argv
// (process.execPath + absolute path of this file), purely blocking. It is not
// the real cell command: command/env/prompt/payload broker never appear
// in the tmux argv.
//
// Uscita silenziosa sul segnale di terminazione inviato da respawn-pane -k.

setInterval(() => {}, 60000);
