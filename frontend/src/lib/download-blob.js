// Salvataggio di un blob su disco (download dei file, export diagnostica).
//
// Contratto voluto, valido per ogni «scarica blob» dell'app:
// 1. l'anchor è attaccato al document.body prima del click e rimosso subito
//    dopo: il click programmatico su un anchor detached è meno affidabile su
//    alcuni engine mobile;
// 2. l'object URL si revoca SOLO dopo un ritardo, mai in modo sincrono col
//    click: a.click() ritorna prima che il download manager del browser
//    dereferenzia il blob:, e una revoca immediata vince la gara uccidendo il
//    download in silenzio (Chromium 41380177, sensibile soprattutto da
//    mobile/PWA, dove un download partito e morto così può lasciare la coda
//    della web app bloccata finché non la si riavvia). Stesso ritardo
//    prudente dell'anteprima file (PREVIEW_URL_TTL_MS in FilesPanel.jsx).
export const DOWNLOAD_URL_TTL_MS = 60_000;

export function saveBlobAs(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
}
