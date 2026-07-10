// Rilevamento "nuova versione" basato sul ciclo di vita del Service Worker.
//
// main.jsx chiama registerSW(); UpdatePrompt.jsx legge isUpdateNeeded()/subscribe
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
// Vero solo dopo applyUpdate(): evita un reload spurio al primo claim del SW.
let reloadOnControllerChange = false;

function dispatch() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT));
}

export function isUpdateNeeded() {
  return needRefresh;
}

export function subscribeUpdate(cb) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}

function setNeedRefresh(v) {
  if (needRefresh === v) return;
  needRefresh = v;
  dispatch();
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
