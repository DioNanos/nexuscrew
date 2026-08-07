// Rilevamento "nuova versione" basato sul ciclo di vita del Service Worker.
//
// main.jsx chiama registerSW(); UpdatePrompt.jsx legge getUpdateState()/subscribe
// e, al click, chiama applyUpdate(). Modulo puro: sicuro dove 'serviceWorker' non
// esiste (test node, SSR) — non registra nulla e non accede a navigator/window.
//
// Due casi d'uso coperti:
//  - SW in stato "waiting" (sw.js SENZA skipWaiting): applyUpdate() gli manda
//    {type:'SKIP_WAITING'} poi ricarica al controllerchange.
//  - SW che si auto-attiva (l'attuale sw.js HA skipWaiting in install): non c'è
//    mai un worker waiting, quindi applyUpdate() ricarica subito per prendere
//    il bundle aggiornato. Il rilevamento (updatefound -> installed + controller)
//    funziona identico in entrambi i casi.

const SW_URL = '/sw.js';
const EVT = 'nc-sw-update';

let registration = null;
let needRefresh = false;
let serverIssue = null;
let snapshot = Object.freeze({ needed: false, kind: null, version: '' });
// Vero solo dopo applyUpdate(): evita un reload spurio al primo claim del SW.
let reloadOnControllerChange = false;

function dispatch() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT));
}

function rebuildSnapshot() {
  const next = serverIssue || (needRefresh ? { kind: 'reload', version: '' } : null);
  snapshot = Object.freeze({ needed: !!next, kind: next?.kind || null, version: next?.version || '' });
}

export function getUpdateState() {
  return snapshot;
}

export function subscribeUpdate(cb) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}

function setNeedRefresh(v) {
  if (needRefresh === v) return;
  needRefresh = v;
  rebuildSnapshot();
  dispatch();
}

// Marcatore di un tentativo gia' fatto, per versione. Vive in sessionStorage:
// muore con la scheda, che e' esattamente la vita del ciclo che deve impedire.
const AUTO_KEY = 'nc-auto-reload';

function memoriaDiSessione() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; }
  catch (_) { return null; } // storage negato (private mode, iframe): si degrada a banner
}

export function reportServerVersions(serverVersion, uiVersion, browserVersion, opts = {}) {
  let next = null;
  if (serverVersion && uiVersion && serverVersion !== uiVersion) next = { kind: 'install', version: serverVersion };
  else if (uiVersion && browserVersion && uiVersion !== browserVersion) next = { kind: 'reload', version: uiVersion };
  const same = JSON.stringify(next) === JSON.stringify(serverIssue);
  serverIssue = next; rebuildSnapshot();
  if (!same) dispatch();

  const store = opts.storage === undefined ? memoriaDiSessione() : opts.storage;
  if (!next) {
    // Versioni allineate: si dimentica il tentativo, cosi' il prossimo
    // disallineamento potra' di nuovo risolversi da solo.
    try { store && store.removeItem(AUTO_KEY); } catch (_) { /* best-effort */ }
    return;
  }
  // SI RICARICA DA SOLI, e solo per `reload`.
  //
  // `reload` significa: il server serve un bundle piu' nuovo di quello che
  // questo browser sta eseguendo. E' esattamente lo stato in cui resta una PWA
  // aperta dopo che il nodo si e' aggiornato da solo — e finora l'unica uscita
  // era chiudere e riaprire l'app, perche' il banner andava premuto e per un
  // difetto del service worker (0.8.52) non funzionava nemmeno.
  //
  // `install` NON si tocca: li' il pacchetto sul server e' piu' nuovo della UI
  // che serve, e nessun ricaricamento lo cambia. Ricaricare in quel caso
  // girerebbe a vuoto.
  //
  // IL TESTO NON SI PERDE: la bozza del composer e' gia' persistita in
  // localStorage e ricaricata al mount. Verificato prima di rendere il
  // ricaricamento automatico — senza quella persistenza questa scelta avrebbe
  // portato via cio' che l'operatore stava scrivendo.
  //
  // LA GUARDIA CONTRO IL CICLO e' la parte che rende la cosa accettabile: se
  // dopo il ricaricamento il disallineamento resta identico, NON si riprova.
  // Un ciclo di ricaricamenti rende l'app inutilizzabile, che e' molto peggio
  // di un banner da premere: il ripiego e' proprio il banner di prima.
  if (next.kind !== 'reload') return;
  // Senza memoria di sessione (modalita' privata, iframe, storage negato) non
  // si puo' ricordare il tentativo, quindi non si puo' impedire il ciclo — e
  // senza quella garanzia l'automatismo non si fa. Si degrada al banner, che e'
  // il comportamento di prima e resta corretto.
  if (!store) return;
  const marcatore = `${uiVersion}|${browserVersion}`;
  try {
    if (store.getItem(AUTO_KEY) === marcatore) return; // gia' provato: resta il banner
    store.setItem(AUTO_KEY, marcatore);
  } catch (_) { return; }
  (opts.applyImpl || applyUpdate)();
}

function watchInstallingWorker(worker) {
  worker.addEventListener('statechange', () => {
    // 'installed' con un controller attivo = c'è già una versione in esecuzione
    // e ne è appena arrivata una nuova (in waiting o già auto-attivata).
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      setNeedRefresh(true);
    }
  });
}

export function registerSW() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  // Ricarica SOLO se l'utente ha accettato l'aggiornamento (applyUpdate imposta
  // il flag). Il controllerchange del primo install/claim non deve reloadare.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadOnControllerChange) location.reload();
  });

  navigator.serviceWorker.register(SW_URL).then((reg) => {
    registration = reg;

    // Un SW può essere già in waiting dal caricamento precedente (tab riaperta).
    if (reg.waiting) setNeedRefresh(true);

    reg.addEventListener('updatefound', () => {
      const inst = reg.installing;
      if (inst) watchInstallingWorker(inst);
    });

    // Re-check periodico: confronta il SW registrato con quello in rete.
    setInterval(() => { reg.update().catch(() => {}); }, 60 * 60 * 1000);
  }).catch(() => { /* SW off / context non sicuro: best-effort */ });
}

export function applyUpdate() {
  reloadOnControllerChange = true;
  setNeedRefresh(false);
  const waiting = registration && registration.waiting;
  if (waiting) {
    // SW in stato waiting: ordiniamo l'attivazione; il controllerchange
    // (registrato in registerSW) farà il reload.
    waiting.postMessage({ type: 'SKIP_WAITING' });
    // Fallback di sicurezza se il controllerchange non arriva entro 4s.
    setTimeout(() => location.reload(), 4000);
  } else {
    // Nessun waiting (sw.js ha skipWaiting in install): il nuovo SW è già attivo,
    // ricarichiamo per prendere il bundle aggiornato.
    location.reload();
  }
}
