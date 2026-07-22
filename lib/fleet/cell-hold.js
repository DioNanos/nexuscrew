#!/usr/bin/env node
'use strict';
// lib/fleet/cell-hold.js — placeholder inerte per l'avvio staged del pane Fleet.
// (NexusCrew 0.8.31 — design piano §3.3: identita tmux sicura)
//
// Resta in attesa finche' `respawn-pane -k` non lo sostituisce con il vero client
// (cell-exec). Crea il pane e la finestra in modo deterministico cosi' il runtime
// puo' armare `remain-on-exit` window-local PRIMA di lanciare il child reale:
// cio' impedisce a un child rapido di chiudere la sessione durante il setup. La
// normalizzazione dei punti nei nomi tmux e gestita separatamente dal mapping v2.
//
// Vincoli (piano §3.3): NESSUNA shell interattiva, NESSUN rc/alias/plugin utente,
// NESSUN dato sensibile, NESSUN argomento interpretato. argv diretto
// (process.execPath + path assoluto di questo file), puramente bloccante. Non e'
// il comando reale della cella: command/env/prompt/payload broker non appaiono
// mai nell'argv tmux.
//
// Uscita silenziosa sul segnale di terminazione inviato da respawn-pane -k.

setInterval(() => {}, 60000);
