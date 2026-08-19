// frontend/src/lib/desktop.js — il criterio DESKTOP condiviso (R34).
// Estratto da App.jsx (dove e' nato) perche' il criterio deve esistere in un
// posto solo: schermo largo E puntatore fine. Non lo user-agent (mentre il
// tablet resta touch), non la sola larghezza (il telefono in landscape supera
// i 1024px CSS ma ha pointer:coarse).
// Uso: default di LAYOUT (griglia, sidebar, densita'). La UI di selezione del
// terminale NON si appoggia qui: segue l'origine del gesto (selectionOrigin in
// Terminal.jsx) — sul laptop touch-screen il device non puo' decidere, decide
// il gesto.
import { useEffect, useState } from 'react';

export const MQ_DESKTOP = '(min-width:1024px) and (pointer:fine)';

// Desktop = schermo largo E puntatore fine (mouse). Risponde al cambio (resize/rotate).
export function useDesktop() {
  const [d, setD] = useState(() => window.matchMedia(MQ_DESKTOP).matches);
  useEffect(() => {
    const mq = window.matchMedia(MQ_DESKTOP);
    const h = (e) => setD(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return d;
}
