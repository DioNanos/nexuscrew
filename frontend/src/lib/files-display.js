// files-display.js — derivazione PURA della vista lista file del pannello.
// Nessuna dipendenza (funziona in node come nei test): il componente passa i
// dati della API ({name,size,mtime}) e riceve ciò che va a schermo.
//
// Il nome su disco NON si tocca mai: il file exchange lo prefissa con lo stamp
// dell'arrivo (lib/files/store.js: `YYYYMMDD-HHMM_` + nome originale
// sanitizzato) e il nome originale può a sua volta portare un secondo prefisso
// `YYYY-MM-DD_` messo dal mittente. Qui si toglie SOLO ciò che si vede: ogni
// operazione reale (download, delete, copia) continua a usare il nome completo.

// Lo stamp dell'arrivo: 8 cifre, trattino, 4 cifre, underscore. L'underscore è
// parte del prefisso: `20261014-0930-report.md` NON è un file prefissato.
// Davanti allo stamp può esserci l'indice di dedup del server (`1-`, `2-`…):
// lo stamp si toglie uguale, l'indice resta per non fondere i file gemelli.
// ( gruppo 1: dedup opzionale, gruppi 2-6: la data )
const STAMP_RE = /^(\d+-)?(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})_/;

// Sostituzione che conserva l'eventuale indice di dedup e toglie il resto.
function stripStamp(name) {
  return String(name || '').replace(STAMP_RE, '$1');
}

// Il secondo prefisso, opzionale, che il mittente può aver messo nel nome
// originale: data ISO corta + underscore.
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}_/;

// Nome VISUALIZZATO: senza lo stamp dell'arrivo e senza l'eventuale secondo
// prefisso data. Totale: un nome che diventasse vuoto (non esiste col naming
// del server, ma la funzione non può assumerlo) resta com'era.
export function fileDisplayName(name) {
  const raw = String(name || '');
  let rest = stripStamp(raw);
  rest = rest.replace(DATE_PREFIX_RE, '');
  return rest || raw;
}

// Il momento d'arrivo RICAVATO DAL NOME (lo stamp), come Date locale, oppure
// null quando il nome non lo porta. Le cifre sono validate per round-trip:
// `20261345-9999_x` non è una data che rotola in avanti, è un nome qualunque.
export function fileStampDate(name) {
  const m = STAMP_RE.exec(String(name || ''));
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d
    || date.getHours() !== h || date.getMinutes() !== mi) return null;
  return date;
}

// Il momento d'arrivo da MOSTRARE: lo stamp del nome se c'è (è quando il file
// è entrato nella scatola), altrimenti l'mtime della API.
export function fileWhen(name, mtimeMs) {
  const fromName = fileStampDate(name);
  if (fromName) return fromName;
  const ms = Number(mtimeMs);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(0);
}

// Dimensione leggibile: KB/MB come chiede il design, B per i piccoli.
export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${n} B`;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function hhmm(date) { return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`; }

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Estensione per il badge-tipo della riga: ultimo segmento dopo il punto,
// MAIUSCOLO, max 4 caratteri; nessuna estensione -> stringa vuota.
export function fileExt(name) {
  const base = fileDisplayName(name);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toUpperCase().slice(0, 4);
}

// Sottoriga mono della riga: l'ora se il file è di oggi, data breve + ora
// altrimenti. La data breve viene da Intl nella lingua dell'UI (it «12 ott»,
// en «Oct 12», es «12 oct»).
export function formatRowTime(date, now, lang) {
  const time = hhmm(date);
  if (sameDay(date, now)) return time;
  const day = new Intl.DateTimeFormat(lang || 'en', { day: 'numeric', month: 'short' }).format(date);
  return `${day} ${time}`;
}

// Etichetta del gruppo giorno: «Oggi · 14 ottobre» per oggi (la parola la
// porta il chiamante via i18n), la data estesa per gli altri giorni.
export function formatDayLabel(date, now, lang, todayWord = '') {
  const day = new Intl.DateTimeFormat(lang || 'en', { day: 'numeric', month: 'long' }).format(date);
  return sameDay(date, now) && todayWord ? `${todayWord} · ${day}` : day;
}

// Data completa del foglio azioni: «14 ottobre 2026, 09:30».
export function formatFullWhen(date, lang) {
  const day = new Intl.DateTimeFormat(lang || 'en', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  return `${day}, ${hhmm(date)}`;
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Tipi di cui il browser sa fare un'anteprima in linea dalla route di
// download autenticata (blob + object URL): immagini, pdf, testo. Per ogni
// altro tipo la voce Anteprima del foglio azioni è omessa.
const PREVIEWABLE = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'SVG', 'PDF', 'TXT', 'MD', 'JSON']);
export function isPreviewable(name) {
  return PREVIEWABLE.has(fileExt(name));
}

// Tipi che possono essere NAVIGATI come documento in una scheda nuova
// (object URL + window.open): immagini raster, pdf, testo. L'SVG è escluso:
// aperto come documento un SVG non fidato esegue i propri script ed event
// handler nell'origine dell'app che ha creato il blob, cosa che dentro un
// <img> non avviene. Gli SVG si scaricano, oppure restano nella miniatura
// <img> del dettaglio desktop (isPreviewable li tiene per quello).
const OPENABLE = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'PDF', 'TXT', 'MD', 'JSON']);
export function isOpenable(name) {
  return OPENABLE.has(fileExt(name));
}

// Il MIME effettivo del blob — quello del Content-Type della risposta, non
// quello suggerito dal nome — decide se la navigazione è sicura. Fail closed
// su tutto ciò che non è esplicitamente nella lista: SVG e HTML inclusi
// (eseguirebbero script), MIME assente o insolito incluso.
const NAVIGABLE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'application/pdf', 'text/plain', 'text/markdown', 'application/json',
]);
export function isNavigableMime(type) {
  const base = String(type || '').split(';')[0].trim().toLowerCase();
  return NAVIGABLE_MIME.has(base);
}

// Classificazione per i filtri a pillola del pannello desktop
// (Tutti / Documenti / Immagini): sull'estensione del nome VISUALIZZATO,
// perché è quella che l'utente legge. «altro» non ha pillola: resta solo
// in «Tutti».
const IMAGE_EXTS = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'SVG', 'BMP', 'ICO', 'AVIF', 'HEIC']);
const DOC_EXTS = new Set(['TXT', 'MD', 'JSON', 'PDF', 'CSV', 'LOG', 'HTML', 'HTM', 'XML', 'YML', 'YAML', 'DOC', 'DOCX', 'ODT', 'RTF', 'XLS', 'XLSX', 'PPT', 'PPTX']);
export function fileKind(name) {
  const ext = fileExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (DOC_EXTS.has(ext)) return 'document';
  return 'other';
}

// Conteggio dei DOPPIONI PER NOME VISUALIZZATO: quante righe della lista
// mostrano lo stesso nome dopo lo strip dei prefissi (l'originale e la copia
// timbrata di una consegna, due upload dello stesso documento). Pura: riceve
// la lista della API, ritorna una Map displayName -> occorrenze; la vista
// marca «×N» le righe il cui conteggio supera 1. Chiave sul solo nome
// visualizzato, non sulla size: è ciò che l'utente percepisce come doppio.
export function duplicateCounts(files) {
  const counts = new Map();
  for (const f of files || []) {
    const key = fileDisplayName(f && f.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// Raggruppamento per giorno in ordine recente, con i file di ogni giorno
// ordinati dal più recente. Pura: l'ordine d'ingresso non conta.
export function groupFilesByDay(files, now, lang, todayWord = '') {
  const withWhen = (files || []).map((f) => ({ ...f, when: fileWhen(f.name, f.mtime) }));
  withWhen.sort((a, b) => b.when - a.when || String(a.name).localeCompare(String(b.name)));
  const groups = [];
  const byKey = new Map();
  for (const f of withWhen) {
    const key = dayKey(f.when);
    let g = byKey.get(key);
    if (!g) {
      g = { key, when: f.when, label: formatDayLabel(f.when, now, lang, todayWord), files: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.files.push(f);
  }
  return groups;
}
