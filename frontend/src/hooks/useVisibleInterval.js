import { useEffect } from 'react';

// Interval che si sospende quando il documento e' nascosto e riparte con un
// giro immediato alla riapparsa (cadenza adattiva). Una finestra lasciata in
// secondo piano non genera traffico; chi torna trova uno stato fresco, non
// l'ultimo scatto di prima. La funzione deve essere stabile (useCallback):
// l'effect dipende da lei.
export default function useVisibleInterval(fn, ms) {
  useEffect(() => {
    if (typeof document === 'undefined' || !document.addEventListener) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    }
    let id = null;
    const visibile = () => document.visibilityState !== 'hidden';
    const ferma = () => { if (id !== null) { clearInterval(id); id = null; } };
    const avvia = () => { if (id === null && visibile()) id = setInterval(fn, ms); };
    const onVisibility = () => {
      if (visibile()) { ferma(); fn(); avvia(); } else ferma();
    };
    avvia();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      ferma();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fn, ms]);
}
