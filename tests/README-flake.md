# Quando il gate dà un rosso, prima di crederci

Misurato la notte del 2026-08-15, su questa macchina.

## Il fenomeno

Il gate completo produce **un rosso casuale ogni giro o quasi**. Cinque esecuzioni,
cinque insiemi di file diversi:

| esecuzione | file caduti | esito in tre giri isolati |
|---|---|---|
| 1 | `lease-audit-2a-fixes` | 9/9, 9/9, 9/9 |
| 2 | `share-reconnect` | instabile davvero → riparato |
| 3 | `fleet-cell-exec`, `lease-audit-2a-fixes` | 9/9 entrambi |
| 4 | `federation`, `fleet-causes` | 10/10 e 17/17 |
| 5 | `fleet-cell-exec` (due test) | 9/9 |

Tutti i file caduti hanno la stessa forma: **avviano processi figli e misurano
tempi** — supervisori, tmux finti, socket, attese di stato.

## La causa, per quanto misurata

La macchina ha **sei core e un load di base sopra sette**, con la flotta di celle
attiva: è satura prima ancora che il gate parta. I test con soglie temporali sono
tarati su una macchina libera, e quando non la trovano cadono.

Il runner limita già la concorrenza (vedi `run-isolated.js`), il che riduce la
contesa che il gate aggiunge di suo — ma non quella che trova.

**Quello che NON è**: non è il diff in lavorazione. In cinque esecuzioni su
cinque, i file caduti erano verdi in isolamento, e in due casi la stessa
instabilità è stata riprodotta su `develop` puro e su una baseline nuda da chi
lavorava a un'altra fetta.

## La procedura

Un rosso nel gate completo **non è una regressione finché non lo hai confermato**:

1. Esegui il file caduto **da solo, tre volte**.
2. Tre verdi → è contesa: dichiaralo e prosegui, citando i tre giri.
3. Anche un solo rosso isolato → è tuo: quello va riparato.

Non alzare un limite per far sparire un rosso. Ma se un test misura un tempo
**senza asserire nulla sul tempo**, allora la soglia stretta non protegge niente
e va ricalibrata — è quello che è stato fatto per `share-reconnect`, con la
ragione scritta accanto.

## Il debito che resta

Le soglie dei file elencati sopra vanno riviste una per una, come è stato fatto
per `share-reconnect`: attesa guidata dall'evento, limite generoso, e nessuna
asserzione che dipenda dalla velocità. Finché non è fatto, vale la procedura.

## Il debito pagato: i cinque file della notte (2026-08-16)

I cinque file che in una nottata hanno prodotto rossi da contesa (`nodes-tunnel`,
`live-host-bridge`, `pair-route-stages`, `reverse-slot-listeners`,
`cell-lease-proof`) sono stati riscritti sul criterio «aspetta la proprietà, non
il tempo». Nessun timeout alzato, nessuna asserzione allentata: ogni test
toccato è stato visto rosso con la proprietà rotta prima di essere dichiarato
equivalente. Tre forme, caso per caso:

- **Attesa di condizione osservabile, senza budget** (`nodes-tunnel`: stato su
  disco, pidfile, processo vivo; `live-host-bridge` orfana: l'evento
  `thread/stop` nel daemon finto; `cell-lease-proof`: `recv` senza timeout). La
  condizione o arriva — per quanto ci metta questa macchina — o non arriva mai.
  Un test appeso è un fallimento del gate: lo ferma lo stall-watchdog di
  `run-isolated.js`, che resta l'UNICO bound necessario.
- **Veleno infinito** (`live-host-bridge`: daemon che non risponde mai,
  hub muto sulla GET del ponte). La bounded-ness diventa la risoluzione stessa:
  niente più soglie `elapsed` da ricalibrare a ogni notte di carico.
- **La risposta è la bounded-ness** (`pair-route-stages` join half-open): la
  richiesta o risponde col suo timeout strutturato, o il test pende.
- Dove il tempo È la proprietà (scadenze, grace), l'orologio era già iniettato
  (`now` nelle factory): quei test non flakavano e non sono stati toccati.

La proprietà negativa di `nodes-tunnel` («vivo ma non ready») ora aspetta che il
supervisor abbia RI-provato il forward (il sidecar `transport-probing` viene
riscritto a ogni probe fallito: `updatedAt` avanza) prima di asserire: la
finestra fissa di 400ms dava al supervisor un'occasione che dipendeva dal
carico, non dalla proprietà.

`reverse-slot-listeners`: gli esiti legittimi di un upgrade sono tutti eventi
(risposta o chiusura); il timer di budget 4000ms tagliava risposte legittime
lente.

La procedura qui sopra resta valida per ogni rosso nuovo: prima tre giri
isolati, poi la diagnosi.
