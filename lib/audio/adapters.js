'use strict';
// lib/audio/adapters.js — adapter TTS NATIVI a livello di nodo.
//
// Un adapter fa due cose e non una di piu': dichiarare se il nodo puo' parlare
// (probe di capability, senza emettere suono) e avviare la sintesi di un
// enunciato. Non decide ACL, non decide consenso, non conosce la federazione.
//
// Onesta' su cosa prova un exit code. `exit 0` significa che il binario e'
// terminato senza errore, NON che una persona ha sentito qualcosa: il sink puo'
// essere nullo, il volume a zero, le cuffie staccate, il servizio Termux:API
// assente. Per questo l'adapter conferma soltanto l'AVVIO della sintesi e non
// promette mai udibilita'. La verifica fisica resta un test manuale autorizzato.
//
// Il testo passa da STDIN, non da argv. Un argomento di comando e' leggibile da
// qualunque processo locale con `ps`: mettere l'enunciato nell'argv sarebbe una
// fuga di contenuto verso utenti non autorizzati sulla stessa macchina. Dove il
// binario non supporta stdin (spd-say) il limite viene dichiarato nel descrittore
// dell'adapter invece di essere ignorato.
//
// Tutta l'esecuzione passa da un seam (`spawnImpl`): i test coprono argv, stdin,
// watchdog e stop senza mai riprodurre audio.
const path = require('node:path');
const fsDefault = require('node:fs');
const { spawn: spawnDefault } = require('node:child_process');

// Vita massima di un enunciato: oltre questa soglia il processo viene terminato.
// Serve a impedire che un binario bloccato tenga occupato il canale audio del
// nodo per sempre (un enunciato e' <= 320 caratteri: 30s sono larghi).
const UTTERANCE_TIMEOUT_MS = 30 * 1000;
// Finestra di grazia dopo lo spawn: se il processo muore entro questo tempo con
// errore, la sintesi non e' partita davvero.
const START_GRACE_MS = 250;

// Stessa forma corretta in lib/cli/path.js: il discriminante e' CHI ha
// fallito, non "c'e' stata un'eccezione". ENOENT ("il path non c'e' qui")
// e' legittimo, si continua a cercare; ogni altro errore (EACCES — sul file
// O sulla directory che lo contiene, ELOOP, ENOTDIR) significa "non sono
// riuscito a verificarlo", non "non c'e'".
function probeBin(fsImpl, file) {
  try {
    const st = fsImpl.statSync(file);
    if (!st.isFile()) return { status: 'absent' };
    fsImpl.accessSync(file, fsDefault.constants.X_OK);
    return { status: 'found', path: file };
  } catch (e) {
    if (e.code === 'ENOENT') return { status: 'absent' };
    return { status: 'blocked', path: file, code: e.code || e.constructor.name };
  }
}

function isExecutable(fsImpl, file) {
  return probeBin(fsImpl, file).status === 'found';
}

// Ricerca bounded nel PATH: nessuna shell, nessun glob, nessun fallback su cwd.
function lookupBin(name, { env = process.env, fsImpl = fsDefault } = {}) {
  if (!name || name.includes('/')) return null;
  const raw = String(env.PATH || '');
  if (!raw) return null;
  for (const dir of raw.split(path.delimiter).filter(Boolean).slice(0, 64)) {
    const candidate = path.join(dir, name);
    if (isExecutable(fsImpl, candidate)) return candidate;
  }
  return null;
}

// Come lookupBin, ma riporta anche le entry del PATH dove la verifica e'
// fallita per un motivo diverso da "non c'e' qui" — usata da detectAdapter
// per non scegliere in silenzio un adapter con proprieta' diverse (es.
// testo in argv invece che stdin, vedi 'spd-say') quando il preferito era
// presente ma irraggiungibile, non assente.
function resolveBin(name, { env = process.env, fsImpl = fsDefault } = {}) {
  if (!name || name.includes('/')) return { path: null, blocked: [] };
  const raw = String(env.PATH || '');
  if (!raw) return { path: null, blocked: [] };
  const blocked = [];
  for (const dir of raw.split(path.delimiter).filter(Boolean).slice(0, 64)) {
    const r = probeBin(fsImpl, path.join(dir, name));
    if (r.status === 'found') return { path: r.path, blocked };
    if (r.status === 'blocked') blocked.push(r);
  }
  return { path: null, blocked };
}

// Descrittori di piattaforma. `stdin:true` = il testo non tocca argv.
// L'ordine dentro ogni piattaforma e' una preferenza dichiarata, non casuale:
// prima chi accetta stdin.
const DESCRIPTORS = Object.freeze([
  {
    id: 'termux-tts-speak',
    platforms: ['android'],
    bin: 'termux-tts-speak',
    stdin: true,
    args: ({ lang }) => (lang ? ['-l', lang] : []),
    limits: 'richiede Termux:API installato e il permesso audio; Doze puo\' sospendere il processo',
  },
  {
    id: 'say',
    platforms: ['darwin'],
    bin: 'say',
    stdin: true,
    // `-f -` legge l'enunciato da stdin: il testo non entra in argv.
    args: ({ voice }) => [...(voice ? ['-v', voice] : []), '-f', '-'],
    limits: 'richiede una sessione GUI con CoreAudio disponibile; udibilita\' non provata dall\'exit code',
  },
  {
    id: 'espeak-ng',
    platforms: ['linux'],
    bin: 'espeak-ng',
    stdin: true,
    args: ({ lang }) => (lang ? ['-v', lang] : []),
    limits: 'richiede un sink audio reale; su un host senza uscita (sink null) l\'exit code resta 0 senza suono',
  },
  {
    id: 'spd-say',
    platforms: ['linux'],
    bin: 'spd-say',
    stdin: false,
    // spd-say non legge stdin: il testo finisce in argv ed e' visibile in `ps`.
    // Preferito solo se espeak-ng manca, e il limite e' dichiarato.
    args: ({ lang, text }) => [...(lang ? ['-l', lang] : []), '--', text],
    limits: 'il testo passa in argv (visibile a `ps` sulla stessa macchina); richiede speech-dispatcher attivo e un sink reale',
  },
]);

// detectAdapter(): probe puramente locale e senza suono. Ritorna il primo
// descrittore disponibile per la piattaforma, con il path risolto.
function detectAdapter({ platform = process.platform, env = process.env, fsImpl = fsDefault, descriptors = DESCRIPTORS } = {}) {
  // Termux si presenta come 'android' o come 'linux' con PREFIX Termux: il
  // secondo caso e' quello reale su Android, quindi va riconosciuto.
  const termux = typeof env.PREFIX === 'string' && env.PREFIX.includes('com.termux');
  const key = termux ? 'android' : platform;
  // Un candidato precedente "bloccato" (presente ma irraggiungibile: permessi,
  // symlink rotto) non e' un'assenza: se il descrittore scelto e' un fallback
  // con proprieta' diverse (es. spd-say: testo in argv invece che stdin), chi
  // legge il risultato deve poterlo sapere invece di credere a un'assenza
  // genuina. Il caso "nessun descrittore trovato affatto" resta `null`
  // com'era: cambiare quella shape romperebbe createAdapter(null) altrove
  // per un guadagno che oggi nessun chiamante consumerebbe (nessuno dei due
  // call site ha un canale di log in questo punto).
  const precededByBlocked = [];
  for (const d of descriptors) {
    if (!d.platforms.includes(key)) continue;
    const r = resolveBin(d.bin, { env, fsImpl });
    if (r.path) {
      return precededByBlocked.length
        ? { ...d, bin: r.path, platform: key, installed: true, precededByBlocked }
        : { ...d, bin: r.path, platform: key, installed: true };
    }
    if (r.blocked.length) precededByBlocked.push({ id: d.id, blocked: r.blocked });
  }
  return null;
}

// createAdapter(): wrappa un descrittore in un adapter eseguibile.
//   speak({text, lang, voice}) -> { started:boolean, reason?, kill() }
// `started` e' un ack di AVVIO, non di ascolto. Il watchdog termina l'enunciato
// oltre `timeoutMs`; `kill()` e' lo stop locale sovrano e non richiede rete.
function createAdapter(descriptor, {
  spawnImpl = spawnDefault,
  timeoutMs = UTTERANCE_TIMEOUT_MS,
  graceMs = START_GRACE_MS,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!descriptor) return null;
  return {
    id: descriptor.id,
    platform: descriptor.platform || null,
    installed: descriptor.installed === true,
    limits: descriptor.limits,
    stdinText: descriptor.stdin === true,
    // Metadati bounded: nessuna enumerazione di voci di sistema nell'MVP, cosi'
    // la capability non diventa un canale di fingerprinting della macchina.
    languages: [],
    voices: [],
    speak({ text, lang = '', voice = '' } = {}) {
      const args = descriptor.args({ lang, voice, text });
      let child;
      try {
        child = spawnImpl(descriptor.bin, args, {
          stdio: [descriptor.stdin ? 'pipe' : 'ignore', 'ignore', 'ignore'],
        });
      } catch (e) {
        return { started: false, reason: 'adapter-spawn-failed' };
      }
      // `spawn()` restituisce un ChildProcess anche quando l'eseguibile non
      // esiste, ma in quel caso `pid` e' indefinito e arriva un `error`
      // asincrono. Non trattare quell'oggetto come una sintesi partita: e' il
      // modo piu' comune per trasformare ENOENT in un falso `spoken`.
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
        return { started: false, reason: 'adapter-spawn-failed' };
      }
      let failed = null;
      const startedAt = now();
      let startTimer = null;
      let settleStart = null;
      const start = new Promise((resolve) => {
        let settled = false;
        settleStart = (result) => {
          if (settled) return;
          settled = true;
          if (startTimer) { clearTimeoutImpl(startTimer); startTimer = null; }
          resolve(result);
        };
      });
      const failStart = (reason) => {
        failed = reason;
        settleStart({ started: false, reason });
      };
      child.once('error', () => failStart('adapter-spawn-failed'));
      // Il solo PID prova che il kernel ha accettato lo spawn; l'evento `spawn`
      // prova che il processo e' realmente partito. Aspettiamo una breve grazia
      // per intercettare un errore d'avvio immediato, senza pretendere di
      // dedurre l'udibilita' dall'exit code.
      child.once('spawn', () => {
        startTimer = setTimeoutImpl(() => settleStart({ started: true }), Math.max(0, graceMs));
        if (startTimer && typeof startTimer.unref === 'function') startTimer.unref();
      });
      if (descriptor.stdin && child.stdin) {
        // Un EPIPE qui significa che il binario e' morto prima di leggere: va
        // trattato come mancato avvio, non ignorato.
        child.stdin.on('error', () => failStart('adapter-stdin-failed'));
        try { child.stdin.end(`${text}\n`); } catch (_) { failStart('adapter-stdin-failed'); }
      }
      const watchdog = setTimeoutImpl(() => {
        try { child.kill('SIGTERM'); } catch (_) {}
      }, timeoutMs);
      if (typeof watchdog.unref === 'function') watchdog.unref();
      const done = new Promise((resolve) => {
        child.on('close', (code, signal) => {
          clearTimeoutImpl(watchdog);
          // Un processo che termina prima della grazia puo' comunque aver
          // iniziato davvero se esce pulito; un errore/non-zero invece non e'
          // un ack di sintesi. Risolviamo `start` prima di `done`, cosi' la
          // coda registra prima l'eventuale spoken e solo poi libera la slot.
          if (!failed) {
            if (code === 0) settleStart({ started: true });
            else failStart('adapter-start-failed');
          }
          resolve({ code, signal, runtimeMs: Math.max(0, now() - startedAt) });
        });
      });
      return {
        // La coda mantiene il receipt `accepted` finche' `start` non attesta
        // l'avvio. Il booleano qui dice solo che esiste un processo verificabile
        // da attendere, non che la voce sia gia' partita.
        started: true,
        start,
        done,
        kill: () => { clearTimeoutImpl(watchdog); try { child.kill('SIGTERM'); } catch (_) {} },
      };
    },
  };
}

// describeAdapter(): metadati redatti per la capability. Mai il path del binario
// (rivelerebbe il layout del filesystem a un peer), solo l'id logico.
function describeAdapter(adapter) {
  if (!adapter) return { adapter: null, installed: false, liveness: 'unavailable', voices: [], languages: [] };
  return {
    adapter: adapter.id,
    installed: adapter.installed === true,
    // 'ready' dice che un adapter esiste e il binario e' eseguibile. NON dice
    // che il nodo e' udibile: la distinzione e' esplicita nel campo `limits`.
    liveness: adapter.installed === true ? 'ready' : 'unknown',
    voices: [],
    languages: [],
    ...(adapter.limits ? { limits: adapter.limits } : {}),
  };
}

module.exports = {
  DESCRIPTORS, detectAdapter, createAdapter, describeAdapter, lookupBin,
  UTTERANCE_TIMEOUT_MS, START_GRACE_MS,
};
