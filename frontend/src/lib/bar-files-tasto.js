// frontend/src/lib/bar-files-tasto.js — le opzioni PER DISPOSITIVO dei tasti
// diretti della barra della vista singola: cartella (file), tastiera e
// pannello AI Desktop.
//
// Vive qui, e non in App.jsx, perche' la legge la barra (App) e le scrive la
// scheda Impostazioni → input: un modulo condiviso evita il ciclo
// App → SettingsPanel → App.
//
// Default (decisione dell'operatore sulla PR #7): cartella e tastiera ACCESI, AI Desktop
// SPENTO. Il default vale SOLO per chi non ha mai salvato la chiave: un valore
// gia' salvato ('on'/'off'), in un senso o nell'altro, si rispetta — chi aveva
// spento il tasto file prima del cambio non se lo ritrova in barra.
// L'opzione dice solo se il tasto ESISTE: lo stato del pannello resta in App
// (`files`, `showComposer`, `showPanel`).
export const BAR_FILES_TASTO = 'nc_bar_files_button';
export const BAR_TASTIERA_TASTO = 'nc_bar_keyboard_button';
export const BAR_PANNELLO_TASTO = 'nc_bar_panel_button';

function leggiTasto(key, defaultOn) {
  try {
    const v = localStorage.getItem(key);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch (_) { /* private mode: vale il default */ }
  return defaultOn;
}

function scriviTasto(key, on) {
  try { localStorage.setItem(key, on ? 'on' : 'off'); } catch (_) { /* private mode */ }
}

export function leggiFilesTasto() {
  return leggiTasto(BAR_FILES_TASTO, true);
}

export function scriviFilesTasto(on) {
  scriviTasto(BAR_FILES_TASTO, on);
}

export function leggiTastieraTasto() {
  return leggiTasto(BAR_TASTIERA_TASTO, true);
}

export function scriviTastieraTasto(on) {
  scriviTasto(BAR_TASTIERA_TASTO, on);
}

export function leggiPannelloTasto() {
  return leggiTasto(BAR_PANNELLO_TASTO, false);
}

export function scriviPannelloTasto(on) {
  scriviTasto(BAR_PANNELLO_TASTO, on);
}
