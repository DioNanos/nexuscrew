// Ciclo di vita di un riquadro terminale: quali stati esistono, e i due soli
// motivi per cui il terminale si ricrea.
//
// Modello puro: niente React, niente fetch, tempo iniettato.
//
// Il contratto, in una riga: il terminale si ricrea SOLO quando c'e' la prova
// che la sessione e' finita e poi tornata, oppure quando la stessa posizione
// espone una sessione con identita' diversa fra due letture autorevoli. Una
// lettura fallita, un nodo giu', un owner rimosso dalla topologia NON sono
// prove di assenza: in quei casi la presenza resta IGNOTA, il buffer xterm
// sopravvive, e il recupero lo fa il socket con il suo snapshot.

// I tre stati di presenza. Il quarto asse — la salute dell'owner — sta
// separato apposta: dice se la POSIZIONE e' viva, non se la sessione e' viva.
export const PRESENZA = {
  PRESENTE: 'presente-verificata',
  ASSENTE: 'assente-verificata',
  IGNOTA: 'ignota',
};

export const OWNER = {
  OK: 'ok',
  NON_DISPONIBILE: 'non-disponibile',
  RIMOSSO: 'rimosso',
};

// Perche' la presenza e' ignota. Dato, non frase: il testo si compone al
// confine UI, dove si sa abbastanza per scriverlo.
export const CAUSA = {
  LETTURA_NON_VERIFICABILE: 'lettura-non-verificabile',
  OWNER_NON_DISPONIBILE: 'owner-non-disponibile',
  OWNER_RIMOSSO: 'owner-rimosso',
  LOCALE_NON_VERIFICATO: 'lettura-locale-non-verificata',
};

// I due soli motivi di ricreazione.
export const MOTIVO = {
  RITORNO: 'ritorno-dopo-assenza',
  IDENTITA: 'identita-cambiata',
};

// Oltre questa soglia il riquadro DICHIARA che il dato non e' verificato.
// Non e' un'assenza: il terminale resta montato, il buffer resta, l'avviso si
// posa sopra. Il numero e' una soglia di lettura, non di vita della sessione.
export const TETTO_NON_VERIFICATO_MS = 60000;

function gruppoDi(node, nodeGroups) {
  if (!node || !Array.isArray(nodeGroups)) return null;
  return nodeGroups.find((c) => Array.isArray(c?.route) && c.route.join('/') === node) || null;
}

// `created` di tmux sono secondi epoch. Assente o non numerico = identita' NON
// confrontabile (proxy che non lo porta, sessione senza il campo), non identita'
// vuota: la differenza conta, perche' un confronto fra due `null` non e' un
// cambio di identita' e non deve ricreare niente.
function identitaDi(sessione) {
  const v = sessione && sessione.created;
  return Number.isFinite(v) && v > 0 ? v : null;
}

// Lo stato esplicito di un tile. `lastVerifiedAt` e' l'istante dell'ultima
// lettura AUTOREVOLE per quella posizione: serve solo al tetto, e non si
// rinnova quando il dato arriva dalla cache.
export function tileLifecycle({
  tileKey, node, nodeGroups, sessionsAlive,
  localVerified = true, localIdentita = null, lastVerifiedAt = null, nowMs = 0,
} = {}) {
  const gruppo = gruppoDi(node, nodeGroups);
  let presenza;
  let owner = OWNER.OK;
  let causa = null;
  let identita = null;

  if (!node) {
    // Tile locale: nessun gruppo per-nodo, l'unica lettura e' quella del nodo
    // su cui gira la UI. Vale la stessa regola degli owner remoti — una
    // lettura caduta non e' una prova di assenza.
    if (!localVerified) {
      presenza = PRESENZA.IGNOTA;
      causa = CAUSA.LOCALE_NON_VERIFICATO;
    } else if (!sessionsAlive || sessionsAlive.has(tileKey)) {
      presenza = PRESENZA.PRESENTE;
      identita = identitaDi({ created: localIdentita });
    } else {
      presenza = PRESENZA.ASSENTE;
    }
  } else if (!gruppo) {
    // L'owner non e' nella topologia: NON prova che tmux sia finito. La
    // ricomparsa dell'owner non deve generare — e non genera, perche' da
    // IGNOTA non si sale a PRESENTE con una ricreazione.
    presenza = PRESENZA.IGNOTA;
    owner = OWNER.RIMOSSO;
    causa = CAUSA.OWNER_RIMOSSO;
  } else if (gruppo.status !== 'up') {
    presenza = PRESENZA.IGNOTA;
    owner = OWNER.NON_DISPONIBILE;
    causa = gruppo.cause || CAUSA.OWNER_NON_DISPONIBILE;
  } else if (gruppo.inventoryPartial === true) {
    // L'owner risponde ma la lettura delle SUE sessioni non e' autorevole:
    // l'inventario puo' essere completo mentre l'elenco sessioni e' degradato.
    presenza = PRESENZA.IGNOTA;
    causa = CAUSA.LETTURA_NON_VERIFICABILE;
  } else if (!sessionsAlive || sessionsAlive.has(tileKey)) {
    presenza = PRESENZA.PRESENTE;
    const sessione = Array.isArray(gruppo.sessions)
      ? gruppo.sessions.find((s) => s && s.key === tileKey)
      : null;
    identita = identitaDi(sessione);
  } else {
    presenza = PRESENZA.ASSENTE;
  }

  const oltreIlTetto = presenza === PRESENZA.IGNOTA
    && Number.isFinite(lastVerifiedAt)
    && Number.isFinite(nowMs)
    && nowMs - lastVerifiedAt > TETTO_NON_VERIFICATO_MS;

  return {
    presenza,
    owner,
    causa,
    identita: presenza === PRESENZA.PRESENTE ? identita : null,
    verificata: presenza !== PRESENZA.IGNOTA,
    oltreIlTetto,
  };
}

// Stato che il consumatore conserva fra un campione e l'altro. Separato dal
// campione: il campione e' cio' che si sa ADESSO, lo stato e' cio' che si e'
// visto PRIMA — e la generazione dipende dalla differenza fra i due.
export function initialTileRuntime() {
  return { presenza: null, identita: null };
}

// L'unico punto in cui una generazione nasce. Ritorna l'incremento (0 o 1) e
// il motivo, cosi' chi chiama non deve dedurlo.
//
// Lo stato conservato e' l'ultimo stato VERIFICATO, non l'ultimo campione:
// IGNOTA non e' un cambiamento di stato, e' l'assenza di una risposta. Se la
// sovrascrivesse, un buco di lettura in mezzo a un ciclo di vita vero
// (sessione finita, lettura caduta per qualche giro, sessione ricreata)
// farebbe perdere la ricreazione — cioe' l'errore opposto e speculare a
// quello che questa funzione esiste per evitare.
export function advanceTileRuntime(previous, sample) {
  const prev = previous && typeof previous === 'object' ? previous : initialTileRuntime();
  if (!sample || sample.presenza === PRESENZA.IGNOTA) {
    return { runtime: { presenza: prev.presenza, identita: prev.identita }, generazione: 0, motivo: null };
  }
  const presente = sample.presenza === PRESENZA.PRESENTE;
  let motivo = null;

  if (presente) {
    if (prev.presenza === PRESENZA.ASSENTE) {
      // (a) assenza VERIFICATA, poi ritorno.
      motivo = MOTIVO.RITORNO;
    } else if (prev.presenza === PRESENZA.PRESENTE
      && prev.identita !== null && sample.identita !== null
      && prev.identita !== sample.identita) {
      // (b) stessa posizione, identita' diversa, entrambe le letture
      // autorevoli. Con `created` mancante da una delle due parti non si
      // confronta: una ricreazione nello stesso secondo, o senza il campo,
      // non e' distinguibile — limite dichiarato, non silenzioso.
      motivo = MOTIVO.IDENTITA;
    }
  }

  return {
    runtime: {
      presenza: sample.presenza,
      identita: presente ? (sample.identita === undefined ? null : sample.identita) : null,
    },
    generazione: motivo ? 1 : 0,
    motivo,
  };
}

// Compatibilita': la domanda booleana «questo tile e' da considerare vivo?».
// Vero per presente E per ignota — l'ignoto non e' un'assenza. Il consumatore
// che ha bisogno dei quattro stati usa `tileLifecycle` direttamente.
export function sessionPresenceForTile(input) {
  return tileLifecycle(input).presenza !== PRESENZA.ASSENTE;
}

// Incremento della generazione nella forma storica (booleani). Resta per i
// consumatori che non hanno ancora lo stato esplicito.
export function nextTerminalGeneration(previousAlive, alive, generation) {
  return !previousAlive && alive ? generation + 1 : generation;
}
