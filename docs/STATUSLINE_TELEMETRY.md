# Statusline → telemetria per-cella (contesto libero, tier usati)

Data: 2026-08-16 · ROADMAP R6 · snippet **scritto e documentato, NON applicato**:
`~/.claude/statusline.sh` è dell'operatore — se si rompe, lui perde la riga di
stato in ogni cella. Lo applica lui (o Dev) dopo averlo letto.

## Il contratto del file

La statusline di Claude Code riceve su stdin, a ogni aggiornamento, un JSON con:

```
.context_window.remaining_percentage     → frazione 0..1 → contesto LIBERO
.rate_limits.five_hour.used_percentage   → frazione 0..1 → tier 5h USATO
.rate_limits.seven_day.used_percentage   → frazione 0..1 → tier 7d USATO
```

Lo snippet li scrive in `~/NexusFiles/<sessione-tmux>/telemetry.json`:

```json
{
  "ts": 1786907000000,
  "contextFreePct": 71,
  "tier5hUsedPct": 33,
  "tier7dUsedPct": 8
}
```

Regole del contratto (il lettore è `lib/files/telemetry.js`, i test in
`tests/telemetry.test.js`):

- **valori INTERI 0..100, già percentuali.** La normalizzazione
  frazione→percentuale è compito dello snippet, una volta sola, qui. Il lettore
  accetta solo interi: una frazione scritta per errore (0.5 che voleva essere
  50%) viene rifiutata, non arrotondata a 1% — un numero sbagliato mostrato con
  sicurezza è il difetto che conta.
- **`ts` è epoch-ms, obbligatorio, nei DUE versi.** Oltre 5 minuti nel
  passato il dato è morto; oltre 2 minuti nel FUTURO è rotto — un orologio
  avanti lo farebbe restare «fresco» per sempre, perché la differenza
  negativa non supera mai la soglia. In entrambi i casi la riga non mostra
  nulla: un numero stantio che sembra fresco è peggio di un numero assente.
- **il VERSO è nei nomi E nelle etichette, e non si tocca**:
  `contextFreePct` è quanto RESTA, `tier*UsedPct` è quanto è STATO CONSUMATO.
  I due versi sono opposti: confonderli produce una riga che dice il
  contrario del vero. Per questo ogni etichetta della riga porta il proprio
  verso scritto («libero» / «usati»): i nomi del contratto li vede chi
  scrive il codice, l'etichetta la vede chi legge la riga.
- **celle non-Claude non scrivono nulla, mai**: codex-vl, agy, grok, shell non
  hanno questa statusline. File assente = campo assente nella riga (niente
  trattino, niente «n/d»).

## Lo snippet

Da aggiungere a `~/.claude/statusline.sh`, DOPO il punto in cui lo stdin è già
stato letto in `$input` (adatta il nome della variabile al tuo script). Il
nome della sessione passa per ambiente, mai per interpolazione nella stringa
di `node -e`:

```sh
# --- telemetria NexusCrew (contesto libero / tier usati) ---------------------
# Scrittura ATOMICA (tmp + rename, stessa directory): la UI può leggere
# mentre scriviamo e non vedrà mai un file mezzo scritto — stesso principio
# del lock delle definizioni fleet. Ogni fallitura è silenziosa: la statusline
# non deve mai rompersi per colpa della telemetria.
NC_TELE_SESSIONE="$(tmux display-message -p -t "${TMUX_PANE:-}" '#S' 2>/dev/null || true)"
if [ -n "$NC_TELE_SESSIONE" ] && [ -n "$input" ]; then
  # L'ambiente va assegnato a NODE (il processo che lo legge), non a printf:
  # `VAR=x cmd1 | cmd2` esporta solo su cmd1.
  printf '%s' "$input" | NC_TELE_SESSIONE="$NC_TELE_SESSIONE" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(raw);
        // stdin porta FRAZIONI 0..1: qui e solo qui diventano interi 0..100.
        // La normalizzazione RIFIUTA, non converte: typeof number esplicito,
        // perché `Number(null) === 0` — un campo presente-ma-null dello stdin
        // diventerebbe uno 0 perfettamente valido nel file, il lettore lo
        // accetterebbe e la riga mostrerebbe «0%» per un dato che non c'è.
        // Il difetto si sposterebbe dal lettore (che lo respinge) allo
        // scrittore (che qui non può). Campo assente = campo cancellato.
        const pct = (x) => {
          if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) return null;
          return Math.round(x * 100);
        };
        const campi = {
          ts: Date.now(),
          contextFreePct: pct(j?.context_window?.remaining_percentage),
          tier5hUsedPct: pct(j?.rate_limits?.five_hour?.used_percentage),
          tier7dUsedPct: pct(j?.rate_limits?.seven_day?.used_percentage),
        };
        for (const k of Object.keys(campi)) if (campi[k] === null) delete campi[k];
        const dir = path.join(process.env.HOME, "NexusFiles", process.env.NC_TELE_SESSIONE);
        fs.mkdirSync(dir, { recursive: true });
        const fin = path.join(dir, "telemetry.json");
        const tmp = path.join(dir, `.telemetry.json.${process.pid}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(campi) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, fin);
      } catch (_) { /* silenzio: la statusline non si rompe qui */ }
    });
  ' >/dev/null 2>&1 || true
fi
# -----------------------------------------------------------------------------
```

Note per chi applica:

- `remaining_percentage`/`used_percentage` arrivano come frazioni 0..1 (schema
  statusline di Claude Code): lo snippet moltiplica per 100. Se un domani
  arrivassero già percentuali, `pct` le rifiuta (>1) e il campo sparisce —
  degradazione, mai numero sbagliato.
- La soglia di freschezza (5 min) e il rifiuto dei non-interi vivono nel
  lettore, non qui: questo script non decide che cosa è stantio.
- Su celle che girano fuori da tmux (`$TMUX_PANE` vuoto) non scrive nulla:
  sono le celle non-Claude o sessioni senza posizione fleet.
