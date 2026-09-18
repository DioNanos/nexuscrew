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
let snapshot = Object.freeze({ needed: false, kind: null, version: '', browserVersion: '' });
// Vero solo dopo applyUpdate(): evita un reload spurio al primo claim del SW.
let reloadOnControllerChange = false;

function dispatch() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT));
}

function rebuildSnapshot() {
  const next = serverIssue || (needRefresh ? { kind: 'reload', version: '', browserVersion: '' } : null);
  snapshot = Object.freeze({
    needed: !!next,
    kind: next?.kind || null,
    version: next?.version || '',
    browserVersion: next?.browserVersion || '',
  });
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

// Session storage carries two facts, both scoped to the life of the tab:
//  - that an automatic anti-cache reload was already attempted for a pair of
//    versions — the guard that makes the automatic reload loop-safe;
//  - that the user closed the banner for a given triple of versions.
const AUTO_KEY = 'nc-auto-reload';
// Second guard, independent of the storage: the address bar. `reloadWithoutCache`
// reloads the same URL, and a query parameter is the one piece of state a reload
// cannot lose — unlike sessionStorage in some Android WebViews and PWA shells,
// which accept the write and forget it at the next load.
const RELOAD_PARAM = 'nc-reload';

function globalLocation() {
  try { return typeof location !== 'undefined' ? location : null; } catch (_) { return null; }
}

function globalHistory() {
  try { return typeof history !== 'undefined' ? history : null; } catch (_) { return null; }
}

// The marker a reload attempt leaves behind: the pair of versions it was made
// for, so a different pair is not blocked by an older attempt.
export function reloadAttemptFromUrl(locationLike) {
  const loc = locationLike === undefined ? globalLocation() : locationLike;
  if (!loc || typeof loc.search !== 'string') return null;
  try { return new URLSearchParams(loc.search).get(RELOAD_PARAM); } catch (_) { return null; }
}

export function rememberReloadAttemptInUrl(marker, { location: locationLike, history: historyLike } = {}) {
  const loc = locationLike === undefined ? globalLocation() : locationLike;
  const hist = historyLike === undefined ? globalHistory() : historyLike;
  if (!loc || !hist || typeof hist.replaceState !== 'function') return false;
  try {
    const params = new URLSearchParams(loc.search || '');
    params.set(RELOAD_PARAM, marker);
    hist.replaceState(hist.state ?? null, '', `${loc.pathname || '/'}?${params.toString()}${loc.hash || ''}`);
    return true;
  } catch (_) { return false; }
}

// Called when the versions are aligned: the marker has done its job and must not
// survive in a link the user copies or reloads later.
export function clearReloadAttemptInUrl({ location: locationLike, history: historyLike } = {}) {
  const loc = locationLike === undefined ? globalLocation() : locationLike;
  const hist = historyLike === undefined ? globalHistory() : historyLike;
  if (!loc || !hist || typeof hist.replaceState !== 'function') return false;
  try {
    const params = new URLSearchParams(loc.search || '');
    if (!params.has(RELOAD_PARAM)) return false;
    params.delete(RELOAD_PARAM);
    const query = params.toString();
    hist.replaceState(hist.state ?? null, '', `${loc.pathname || '/'}${query ? `?${query}` : ''}${loc.hash || ''}`);
    return true;
  } catch (_) { return false; }
}
const DISMISS_KEY = 'nc-update-dismissed';

function memoriaDiSessione() {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; }
  catch (_) { return null; } // storage denied (private mode, iframe): degrades to the banner
}

// Identity of a detection: the three versions it was computed from. What the
// user closed is remembered under this key, so a different triple is news again.
function tripleKey(serverVersion, uiVersion, browserVersion) {
  return [serverVersion, uiVersion, browserVersion].map((v) => v || '').join('|');
}

let lastTriple = null;

// Which mismatch, if any, this triple describes.
//
// `install` is reported only when the package on disk is newer than BOTH the
// interface being served and the one running: when the running bundle already is
// that package there is nothing to install, and naming its version would name
// the version in use — the very defect this classification exists to prevent.
function classify(serverVersion, uiVersion, browserVersion) {
  const browser = browserVersion || '';
  if (serverVersion && uiVersion && serverVersion !== uiVersion && serverVersion !== browser)
    return { kind: 'install', version: serverVersion, browserVersion: browser };
  if (uiVersion && browser && uiVersion !== browser)
    return { kind: 'stale', version: uiVersion, browserVersion: browser };
  return null;
}

function isDismissed(store, key) {
  if (!store) return false;
  try { return store.getItem(DISMISS_KEY) === key; } catch (_) { return false; }
}

// The user closed the banner: hide it now and remember the detection, so the
// same triple does not bring it back while this tab lives.
export function dismissUpdate(opts = {}) {
  const store = opts.storage === undefined ? memoriaDiSessione() : opts.storage;
  if (lastTriple && store) {
    try { store.setItem(DISMISS_KEY, lastTriple); } catch (_) { /* best-effort */ }
  }
  // A service-worker detection answers to the same gesture: the user saw it.
  needRefresh = false;
  serverIssue = null;
  rebuildSnapshot();
  dispatch();
}

export function reportServerVersions(serverVersion, uiVersion, browserVersion, opts = {}) {
  const store = opts.storage === undefined ? memoriaDiSessione() : opts.storage;
  const browser = browserVersion || '';
  const key = tripleKey(serverVersion, uiVersion, browser);
  lastTriple = key;

  const detected = classify(serverVersion, uiVersion, browser);
  // A banner the user closed stays closed for the same three versions.
  let next = isDismissed(store, key) ? null : detected;

  if (next && next.kind === 'stale') {
    // ONE silent, anti-cache reload per session. Coming back here with the same
    // pair means the reload did not help — a bundle still cached by the PWA or
    // by a proxy, or a node updated on disk and not restarted. There is nothing
    // to announce, so from here on the banner is a DIAGNOSIS of the mismatch and
    // of what to do about it, never a "new version" claim.
    //
    // The attempt is recorded BEFORE the reload: the other way round, a fast
    // reload would find no marker and the automation would be unguarded.
    const marker = `${uiVersion}|${browser}`;
    // TWO guards, and the order matters. The URL one is read first because it
    // depends on nothing: if the address bar already carries this pair, the
    // attempt was made and a rewrite of the store cannot change that. The store
    // is then the second opinion — and the reason it still gates the FIRST
    // reload is that a context without session storage (private mode, iframe)
    // has no way to remember anything of its own.
    const urlTried = reloadAttemptFromUrl(opts.location) === marker;
    let canReload = false;
    if (!urlTried && store && store.getItem(AUTO_KEY) !== marker) {
      try { store.setItem(AUTO_KEY, marker); } catch (_) { /* storage denied */ }
      canReload = store.getItem(AUTO_KEY) === marker;
    }
    if (canReload) {
      // Written before the reload, like the store marker: the next load must be
      // able to see the attempt even if the store forgets it.
      rememberReloadAttemptInUrl(marker, { location: opts.location, history: opts.history });
      (opts.applyImpl || reloadWithoutCache)();
      next = null; // the reload is the answer: nothing to show
    }
    // With no session store AND no URL the attempt cannot be remembered, so it
    // cannot be made loop-safe: the diagnostic banner is what is left.
  }

  const same = JSON.stringify(next) === JSON.stringify(serverIssue);
  serverIssue = next; rebuildSnapshot();
  if (!same) dispatch();

  if (!detected) {
    // Aligned: forget the attempt, so a later mismatch can resolve itself again —
    // in the store and in the address bar, without reloading.
    try { store && store.removeItem(AUTO_KEY); } catch (_) { /* best-effort */ }
    clearReloadAttemptInUrl({ location: opts.location, history: opts.history });
  }
}

// Reload that first asks for a fresh copy of the document and of the version
// file: a reload served from the HTTP cache or from the service worker would put
// the same bundle back on screen — the loop this module exists to avoid. Best
// effort and bounded: a slow network must not hold the reload hostage.
const REVALIDATE_TIMEOUT_MS = 1200;

async function revalidate(url) {
  if (typeof fetch !== 'function') return;
  try {
    await Promise.race([
      fetch(url, { cache: 'reload' }),
      new Promise((resolve) => setTimeout(resolve, REVALIDATE_TIMEOUT_MS)),
    ]);
  } catch (_) { /* offline or blocked: the reload still happens */ }
}

export async function reloadWithoutCache() {
  try { if (registration) await registration.update(); } catch (_) { /* best-effort */ }
  if (typeof location !== 'undefined') {
    await revalidate(location.pathname);
    await revalidate('/version.json');
    location.reload();
  }
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
