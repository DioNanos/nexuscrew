// frontend/src/lib/bar-files-tasto.js — l'opzione PER DISPOSITIVO del tasto
// «File della cella» nella barra della vista singola.
//
// Vive qui, e non in App.jsx, perche' la legge la barra (App) e la scrive la
// scheda Impostazioni → input: un modulo condiviso evita il ciclo
// App → SettingsPanel → App.
//
// Semantica invariata rispetto a prima: spenta di default, la accende
// l'operatore. Dice se il tasto ESISTE sul telefono; lo stato del pannello
// resta in App (`files`). Sul desktop l'opzione non si applica: li' il tasto
// c'e' sempre, perche' il menu ⋯ non c'e' piu' e sarebbe l'unica via al
// pannello.
export const BAR_FILES_TASTO = 'nc_bar_files_button';

export function leggiFilesTasto() {
  try { return localStorage.getItem(BAR_FILES_TASTO) === 'on'; } catch (_) { return false; }
}

export function scriviFilesTasto(on) {
  try { localStorage.setItem(BAR_FILES_TASTO, on ? 'on' : 'off'); } catch (_) { /* private mode */ }
}
