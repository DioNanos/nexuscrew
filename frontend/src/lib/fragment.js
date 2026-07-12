// frontend/src/lib/fragment.js — parsing del fragment di bootstrap (#token=,
// #pair=) PURO: nessun side effect su location/history/localStorage, così è
// testabile in Node. Estrae token e pairingUrl ricostruito e produce l'URL
// "scrubbed" (fragment sensibile rimosso, path/query preservati). App.jsx
// applica i side effect usando questi valori.
//
// Il fragment #pair e' un invite one-time (sensibile): dopo averlo acquisito va
// rimosso dalla address bar (history.replaceState) senza rompere la condivisione
// esplicita del link (pathname + search restano intatti).

export function parseBootstrapHash({ hash = '', origin = '', pathname = '', search = '' } = {}) {
  const clean = String(hash || '').replace(/^#/, '');
  const nextUrl = `${pathname || ''}${search || ''}`;
  if (!clean) return { token: '', pair: '', nextUrl };
  const params = new URLSearchParams(clean);
  const token = params.get('token') || '';
  const pairRaw = params.get('pair') || '';
  const pair = pairRaw ? `${origin || ''}${pathname || ''}#pair=${pairRaw}` : '';
  // nextUrl: il fragment (token/pair) e' sensibile -> rimosso; path+query preservati
  // (la condivisione esplicita del link non si rompe).
  return { token, pair, nextUrl };
}
