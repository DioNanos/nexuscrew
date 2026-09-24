import { useCallback, useEffect, useRef, useState } from 'react';

// Notice d'azione del roster (avvio in corso, degradi, sessione già attiva).
// Vivono per conto loro, FUORI dal ciclo di refresh: un refresh riuscito
// azzera gli errori di lettura del roster e si porterebbe via la notice
// prima che l'operatore la legga. Auto-clear dopo ACTION_NOTICE_MS.
export const ACTION_NOTICE_MS = 10000;

export default function useActionNotice() {
  const [notice, setNotice] = useState(null);
  const timer = useRef(null);
  const showActionNotice = useCallback((text) => {
    if (typeof text !== 'string' || !text) return;
    if (timer.current) clearTimeout(timer.current);
    setNotice(text);
    timer.current = setTimeout(() => setNotice(null), ACTION_NOTICE_MS);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { notice, showActionNotice };
}
