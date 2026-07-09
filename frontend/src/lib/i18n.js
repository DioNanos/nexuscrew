// i18n IT/EN/ES, zero dipendenze. Dizionari piatti a chiavi kebab.
// IT = source of truth (stringhe attuali). Modulo PURO (niente React: i test node
// lo importano senza deps frontend) — l'hook reattivo sta in hooks/useLang.js.
// Guard localStorage/window per funzionare anche in node (test).

const LANGS = ['it', 'en', 'es'];
// Default: lingua del browser se supportata, altrimenti EN (pubblico).
// Il valore salvato in localStorage (nc_lang) vince sempre.
function detectLang() {
  try {
    const nav = (typeof navigator !== 'undefined' && navigator.language) || '';
    const two = String(nav).slice(0, 2).toLowerCase();
    return LANGS.includes(two) ? two : 'en';
  } catch (_) { return 'en'; }
}
const DEFAULT_LANG = detectLang();
const LANG_KEY = 'nc_lang';
const EVENT = 'nc-lang';

function safeLocal() {
  return (typeof localStorage !== 'undefined') ? localStorage : null;
}

export const DICTS = {
  it: {
    'update-available': 'nuova versione {v} disponibile',
    'reload': 'ricarica',
    'grid-empty': 'trascina qui una sessione dalla sidebar, o doppio-clic per la vista singola',
    'pin': 'fissa in cima',
    'sessions': 'sessioni',
    'new-session': 'nuova sessione',
    'new': 'nuova',
    'fleet': 'Flotta',
    'fleet-tmux': 'flotta tmux',
    'other-sessions': 'Altre sessioni',
    'files': 'file',
    'refresh': 'aggiorna',
    'filter-placeholder': 'filtra sessioni…',
    'loading-fleet': 'carico la flotta…',
    'no-sessions': 'nessuna sessione tmux viva — la flotta parte al boot (systemd)',
    'no-match': 'nessuna sessione contiene "{q}"',
    'copy-url': 'clicca per copiare l\'URL',
    'ssh-only': 'solo tunnel SSH/VPN',
    'new-files-outbox': 'nuovi file in outbox',
    'terminate': 'termina',
    'terminate-confirm': 'Terminare la sessione "{name}"?',
    'cell-on': 'tmux vivo',
    'cell-off': 'spenta',
    'cell-degraded': 'degradata: unit attiva, tmux morto',
    'power-on': 'accendi',
    'power-off': 'spegni',
    'state-on': 'accesa',
    'state-off': 'spenta',
    'engine': 'Engine',
    'boot-persist': 'avvia al boot',
    'remove-boot': 'togli anche dal boot',
    'no-remote-control': '⚠ engine non native: niente remote-control',
    'cancel': 'annulla',
    'name': 'nome',
    'name-invalid': 'nome non valido: a-zA-Z0-9._- max 64, senza \'-\' iniziale',
    'cwd': 'cwd',
    'preset': 'preset',
    'preset-2x2': 'griglia 2×2',
    'preset-columns': 'colonne',
    'preset-equalize': 'equalizza',
    'collapse': 'comprimi',
    'expand': 'espandi',
    'create': 'crea',
    'auth-prompt': 'Incolla il token (stampato dal server):',
    'remember-device': 'ricorda su questo device',
    'zoom-out': 'testo più piccolo',
    'zoom-in': 'testo più grande',
    'composer': 'composer',
    'windows': '{n} finestre',
    'empty-files': 'vuota',
    'upload': 'carica',
    'no-sessions-short': 'nessuna sessione',
    'composer-placeholder': 'scrivi o detta…',
    'voice': 'voice',
    'send': 'invia',
    'close': 'chiudi',
    'lang-label': 'lingua',
  },
  en: {
    'update-available': 'new version {v} available',
    'reload': 'reload',
    'grid-empty': 'drag a session here from the sidebar, or double-click for single view',
    'pin': 'pin to top',
    'sessions': 'sessions',
    'new-session': 'new session',
    'new': 'new',
    'fleet': 'Fleet',
    'fleet-tmux': 'tmux fleet',
    'other-sessions': 'Other sessions',
    'files': 'files',
    'refresh': 'refresh',
    'filter-placeholder': 'filter sessions…',
    'loading-fleet': 'loading fleet…',
    'no-sessions': 'no live tmux sessions — the fleet starts at boot (systemd)',
    'no-match': 'no session matches "{q}"',
    'copy-url': 'click to copy URL',
    'ssh-only': 'SSH/VPN tunnel only',
    'new-files-outbox': 'new files in outbox',
    'terminate': 'terminate',
    'terminate-confirm': 'Terminate session "{name}"?',
    'cell-on': 'tmux alive',
    'cell-off': 'off',
    'cell-degraded': 'degraded: unit active, tmux dead',
    'power-on': 'power on',
    'power-off': 'power off',
    'state-on': 'running',
    'state-off': 'stopped',
    'engine': 'Engine',
    'boot-persist': 'start at boot',
    'remove-boot': 'also remove from boot',
    'no-remote-control': '⚠ non-native engine: no remote-control',
    'cancel': 'cancel',
    'name': 'name',
    'name-invalid': 'invalid name: a-zA-Z0-9._- max 64, no leading \'-\'',
    'cwd': 'cwd',
    'preset': 'preset',
    'preset-2x2': '2×2 grid',
    'preset-columns': 'columns',
    'preset-equalize': 'equalize',
    'collapse': 'collapse',
    'expand': 'expand',
    'create': 'create',
    'auth-prompt': 'Paste the token (printed by the server):',
    'remember-device': 'remember on this device',
    'zoom-out': 'smaller text',
    'zoom-in': 'bigger text',
    'composer': 'composer',
    'windows': '{n} windows',
    'empty-files': 'empty',
    'upload': 'upload',
    'no-sessions-short': 'no sessions',
    'composer-placeholder': 'type or dictate…',
    'voice': 'voice',
    'send': 'send',
    'close': 'close',
    'lang-label': 'language',
  },
  es: {
    'update-available': 'nueva versi\u00f3n {v} disponible',
    'reload': 'recargar',
    'grid-empty': 'arrastra aqu\u00ed una sesi\u00f3n desde la barra lateral, o doble clic para vista \u00fanica',
    'pin': 'fijar arriba',
    'sessions': 'sesiones',
    'new-session': 'nueva sesión',
    'new': 'nueva',
    'fleet': 'Flota',
    'fleet-tmux': 'flota tmux',
    'other-sessions': 'Otras sesiones',
    'files': 'archivos',
    'refresh': 'actualizar',
    'filter-placeholder': 'filtrar sesiones…',
    'loading-fleet': 'cargando flota…',
    'no-sessions': 'sin sesiones tmux vivas — la flota arranca en el boot (systemd)',
    'no-match': 'ninguna sesión coincide con «{q}»',
    'copy-url': 'clic para copiar la URL',
    'ssh-only': 'solo túnel SSH/VPN',
    'new-files-outbox': 'archivos nuevos en outbox',
    'terminate': 'terminar',
    'terminate-confirm': '¿Terminar la sesión «{name}»?',
    'cell-on': 'tmux activo',
    'cell-off': 'apagada',
    'cell-degraded': 'degradada: unit activa, tmux muerto',
    'power-on': 'encender',
    'power-off': 'apagar',
    'state-on': 'encendida',
    'state-off': 'apagada',
    'engine': 'Motor',
    'boot-persist': 'iniciar en el boot',
    'remove-boot': 'quitar también del boot',
    'no-remote-control': '⚠ motor no native: sin remote-control',
    'cancel': 'cancelar',
    'name': 'nombre',
    'name-invalid': 'nombre inválido: a-zA-Z0-9._- máx 64, sin \'-\' inicial',
    'cwd': 'cwd',
    'preset': 'preset',
    'preset-2x2': 'cuadrícula 2×2',
    'preset-columns': 'columnas',
    'preset-equalize': 'igualar',
    'collapse': 'contraer',
    'expand': 'expandir',
    'create': 'crear',
    'auth-prompt': 'Pega el token (impreso por el servidor):',
    'remember-device': 'recordar en este dispositivo',
    'zoom-out': 'texto más pequeño',
    'zoom-in': 'texto más grande',
    'composer': 'composer',
    'windows': '{n} ventanas',
    'empty-files': 'vacía',
    'upload': 'subir',
    'no-sessions-short': 'sin sesiones',
    'composer-placeholder': 'escribe o dicta…',
    'voice': 'voz',
    'send': 'enviar',
    'close': 'cerrar',
    'lang-label': 'idioma',
  },
};

export function getLang() {
  const ls = safeLocal();
  const v = ls ? ls.getItem(LANG_KEY) : null;
  return LANGS.includes(v) ? v : DEFAULT_LANG;
}

export function setLang(lang) {
  const ls = safeLocal();
  if (ls) { try { ls.setItem(LANG_KEY, lang); } catch (_) { /* quota/privacy */ } }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

// t(key): dict corrente -> fallback IT -> chiave stessa.
export function t(key) {
  const lang = getLang();
  const cur = DICTS[lang] || DICTS[DEFAULT_LANG];
  if (Object.prototype.hasOwnProperty.call(cur, key)) return cur[key];
  if (Object.prototype.hasOwnProperty.call(DICTS[DEFAULT_LANG], key)) return DICTS[DEFAULT_LANG][key];
  return key;
}

export function subscribeLang(cb) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

export const LANGUAGES = LANGS;
