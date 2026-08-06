# NexusCrew Current State

Updated: 2026-08-06

> Documento **interno**, escluso dal pacchetto npm e dal repo pubblico.
> È uno snapshot: invecchia. Le fonti vive sono `git log`, `npm view
> @mmmbuto/nexuscrew dist-tags` e la suite. Se questo file e il runtime
> divergono, ha ragione il runtime — questa riga esiste perché il file è
> rimasto fermo un mese mentre la linea avanzava di cinquanta versioni.

## Linea corrente — `0.8.52-rc.*`

- npm: `rc` → `0.8.52-rc.20` · `latest` → `0.8.51`. Il tag `latest` si muove
  solo su release stabili, mai su una rc.
- Forge `develop` è la linea di lavoro; GitHub `main` è la linea sanificata e
  si muove solo su decisione esplicita.
- Deploy su unit systemd user, loopback, raggiungibile solo via tunnel SSH o
  VPN.

### Cosa ha portato la serie rc.16 → rc.20 (2026-08-06)

- **Permessi per-cella (NC-E)**: un peer federato può essere ristretto alle
  celle concesse — `nexuscrew nodes cells <nodo> all|none|Cell1,Cell2`. Lo
  scope è deciso in un punto solo, in testa al router `/api`, e vale sia per
  gli elenchi sia per le azioni, compreso l'attach al terminale. Audit
  indipendente: APPROVE.
- **Diagnostica del rifiuto Share**: quando l'hub rifiuta un'attivazione lascia
  un record `SHARE_CHANNEL_REFUSED` con nodo, codice tipizzato e porta tentata.
  Prima il rifiuto non veniva scritto da nessuna parte.
- **`nexuscrew nodes test` senza argomento**: prova tutti i peer e dichiara
  quali risultano condivisi mentre il canale inverso non risponde. «Share
  attivo» è stato desiderato, non una verifica.
- Correzioni: duplicazione delle celle nel CellSwitcher, invito admin/ospite,
  notifiche federate, banner di versione, due leak di nomi di cella (`/decks`,
  `/diagnostics/logs`).

## Convenzione flotta

Deliverable per l'operatore → `~/NexusFiles/<sessione>/outbox/`.

## Decisioni di sicurezza accettate dall'owner

- **Token ricordato dal fragment** (`readToken()`, commit `e3d0f73`): un token
  arrivato via `#token=…` viene salvato in `localStorage` senza chiedere
  conferma. Scelta esplicita dell'owner (2026-07-06): istanza single-user,
  loopback, dietro tunnel controllato dall'utente.
  **Rivalutazione chiusa il 2026-08-06**: la nota precedente diceva «da
  rivalutare se questa linea confluisse nella release pubblica». È confluita, e
  la rivalutazione è di fatto già stata fatta altrove — `docs/SECURITY.md`
  documenta pubblicamente il comportamento e avverte di trattare il link
  completo come una credenziale e di non aprirlo su un dispositivo condiviso.
  Rotazione: rimuovere `~/.nexuscrew/token` e riavviare il servizio.

## Storia, in breve

Le linee precedenti restano nella storia di git e nei documenti di release.
In sintesi: `0.5.x` fu la linea privata VPS3-special (scambio file
bidirezionale, voce→testo, tutte le REST dietro Bearer); `0.6.0` la portable su
Termux/Linux/Mac; `0.7.x` il Fleet Deck (griglia desktop, celle in UI, mobile a
gruppi, i18n) e il primo repo pubblico con storia rifatta e sanificata; da
`0.8.x` federazione fra hub, deck, VL micro-node e permessi per-cella.

## Aperti

- UI per impostare lo scope celle: oggi si fa solo da CLI.
- Ricevute di consegna fra celle: `submitted` conferma il trasporto, non la
  presa in carico. Disegno scritto, non ancora approvato.
- TTS in UI: endpoint pronto, non esposto.
