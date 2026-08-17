import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../lib/i18n.js';
import './CellPopup.css';

// Il contenitore che apre SOPRA invece di portare via. Una sola implementazione
// per tre usi — anteprima di una cella, flusso live, pannello del desktop —
// perche' sono la stessa esigenza: guardare una cosa senza perdere il posto in
// cui si sta.
//
// Non sa nulla di cio' che mostra: riceve un figlio e lo monta. Chi lo apre
// decide la sorgente. Se sapesse anche cosa mostrare, il terzo uso
// richiederebbe di modificarlo — ed e' cosi' che un contenitore diventa tre
// contenitori.
//
// Cio' che sta sotto NON viene smontato: ne' la griglia, ne' il terminale, ne'
// la cella corrente. Aprire questo popup non cambia dove sei.
//
// R24 — la finestra si sposta e si ridimensiona:
//  - trascina DALLA BARRA del titolo, non da tutto il riquadro: dentro c'e'
//    un desktop remoto con cui si interagisce, e trascinare la finestra
//    mentre si clicca dentro sarebbe peggio del problema;
//  - ridimensiona dall'angolo, con un minimo sotto il quale non si scende;
//  - posizione e dimensione restano fra le aperture;
//  - doppio clic sulla barra = torna al centro: una finestra che si puo'
//    portare fuori schermo deve poter rientrare;
//  - sotto i 720px resta a schermo pieno e il trascinamento e' DISATTIVATO,
//    non solo nascosto: un handler attivo su una finestra a schermo pieno
//    sarebbe un difetto che aspetta.
//
// Il dettaglio che decide se funziona: dentro c'e' un IFRAME, e un iframe si
// mangia gli eventi del mouse — appena il cursore, trascinando, ci entra
// sopra, il movimento si pianta. Per la sola durata del drag un VELO
// trasparente copre tutto (iframe incluso): gli eventi restano nostri, e al
// rilascio il velo sparisce.

const ASSETTO_KEY = 'nc_popup_assetto';
// Minimi sensati: sotto, un pannello con dentro un desktop non e' piu' usabile.
const MIN_W = 320;
const MIN_H = 240;
// Misure di default del CSS: min(1100px, 96vw) × min(820px, 92vh).
const DEFAULT_W = 1100;
const DEFAULT_H = 820;
// La finestra non deve poter finire fuori schermo al punto da non poterla
// piu' afferrare. Due misure, DUE lati diversi — non sono la stessa costante:
// GRAB = quanto deve sporgere ORIZZONTALMENTE (bordi sinistro/destro), dove
// basta un angolo della barra da prendere col puntatore;
// TESTA = quanta barra deve restare visibile VERTICALMENTE (bordo basso:
// l'altezza della barra stessa, min-height 40 + padding) — sotto il bordo
// basso non si va mai (top >= 0), quindi in alto il vincolo e' totale.
const GRAB = 48;
const TESTA = 44;

function viewport() {
  return { vw: window.innerWidth || 1024, vh: window.innerHeight || 768 };
}

// Vincola la geometria: minimo sensato, mai piu' grande della viewport, e
// sempre almeno un pezzo di barra del titolo visibile e afferrabile.
function clampAssetto(a) {
  const { vw, vh } = viewport();
  const w = Math.max(MIN_W, Math.min(a.w, vw));
  const h = Math.max(MIN_H, Math.min(a.h, vh));
  const x = Math.max(-(w - GRAB), Math.min(a.x, vw - GRAB));
  const y = Math.max(0, Math.min(a.y, Math.max(0, vh - TESTA)));
  return { x, y, w, h };
}

function leggiAssetto() {
  try {
    const raw = window.localStorage.getItem(ASSETTO_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw);
    if (!a || ![a.x, a.y, a.w, a.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    // Una posizione salvata puo' essere nata su una viewport piu' grande:
    // rientra prima ancora di aprire.
    return clampAssetto(a);
  } catch (_) { return null; }
}

function salvaAssetto(a) {
  try { window.localStorage.setItem(ASSETTO_KEY, JSON.stringify(a)); } catch (_) { /* memoria piena o assente: la posizione non vale un crash */ }
}

function usaMobile() {
  const [mobile, setMobile] = useState(() => (
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(max-width: 720px)');
    const aggiorna = (e) => setMobile(!!(e && e.matches));
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', aggiorna);
      return () => mq.removeEventListener('change', aggiorna);
    }
    return undefined;
  }, []);
  return mobile;
}

export default function CellPopup({ title, subtitle, onClose, children }) {
  const boxRef = useRef(null);
  const primaRef = useRef(null);
  const mobile = usaMobile();
  const [assetto, setAssetto] = useState(() => (mobile ? null : leggiAssetto()));
  // Il drag attivo vive in un ref: i listener di window lo leggono senza
  // ricrearsi a ogni render. { mode, startX, startY, base }.
  const dragRef = useRef(null);
  // Il velo sopra l'iframe esiste SOLO mentre il drag e' in corso.
  const [velo, setVelo] = useState(false);

  const chiudi = useCallback(() => { if (onClose) onClose(); }, [onClose]);

  useEffect(() => {
    // Esc chiude: e' il gesto che chi apre un popup si aspetta, e senza di
    // esso su desktop resta solo il bersaglio piccolo della X.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); chiudi(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [chiudi]);

  useEffect(() => {
    // Il fuoco entra nel popup all'apertura: senza, i tasti continuerebbero ad
    // andare al terminale sottostante, che e' ancora vivo e in ascolto.
    const el = primaRef.current;
    if (el && typeof el.focus === 'function') el.focus();
  }, []);

  // La geometria di partenza quando la finestra e' ancora centrata dal CSS:
  // le misure del foglio di stile, calcolate — non lette dal layout, che non
  // serve e non c'e' ovunque (test).
  const assettoDaCentro = () => {
    const { vw, vh } = viewport();
    const w = Math.min(DEFAULT_W, Math.floor(vw * 0.96));
    const h = Math.min(DEFAULT_H, Math.floor(vh * 0.92));
    return clampAssetto({ x: Math.round((vw - w) / 2), y: Math.round((vh - h) / 2), w, h });
  };

  const iniziaDrag = (mode) => (e) => {
    if (mobile) return; // schermo pieno: il trascinamento e' proprio spento
    if (e.button !== 0) return;
    // La X chiude, non trascina.
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('.nc-popup-chiudi')) return;
    e.preventDefault();
    const base = assetto || assettoDaCentro();
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, base };
    setAssetto(base);
    setVelo(true);
  };

  useEffect(() => {
    if (!velo) return undefined;
    // I listener stanno su WINDOW, non sulla barra: il puntatore esce subito
    // dall'elemento mentre si trascina, e gli eventi devono continuare ad
    // arrivare. Il velo fa l'altra meta' del lavoro: nei browser veri impedisce
    // all'iframe di catturare il puntatore quando il cursore ci passa sopra.
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === 'move') {
        setAssetto(clampAssetto({ ...d.base, x: d.base.x + dx, y: d.base.y + dy }));
      } else {
        setAssetto(clampAssetto({ ...d.base, w: d.base.w + dx, h: d.base.h + dy }));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      setVelo(false);
      setAssetto((a) => { if (a) salvaAssetto(a); return a; });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [velo]);

  // Doppio clic sulla barra: torna al centro. Una finestra che si puo'
  // portare in giro deve poter rientrare.
  const ricentra = () => {
    if (mobile) return;
    dragRef.current = null;
    setVelo(false);
    setAssetto(null);
    try { window.localStorage.removeItem(ASSETTO_KEY); } catch (_) {}
  };

  // La viewport si rimpicciolisce (rotazione, finestra del browser ridotta):
  // una posizione salvata che ora sta fuori rientra invece di sparire.
  useEffect(() => {
    if (mobile) return undefined;
    const onResize = () => setAssetto((a) => (a ? clampAssetto(a) : a));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mobile]);

  // Ritorno da mobile a desktop: la geometria salvata torna (riclampata).
  useEffect(() => {
    if (!mobile) setAssetto((a) => a || leggiAssetto());
  }, [mobile]);

  const inPosizione = !!(assetto && !mobile);
  return (
    <div
      className="nc-popup-velo"
      // Il clic FUORI chiude; quello dentro no. Senza il confronto sul target,
      // un clic partito nel corpo e finito sul velo chiuderebbe il popup —
      // succede selezionando testo, ed e' il modo piu' rapido di far perdere
      // quello che si stava leggendo.
      onMouseDown={(e) => { if (e.target === e.currentTarget) chiudi(); }}
      role="presentation"
    >
      <div
        className={inPosizione ? 'nc-popup nc-popup-libera' : 'nc-popup'}
        style={inPosizione ? { left: assetto.x, top: assetto.y, width: assetto.w, height: assetto.h } : undefined}
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || t('panel')}
      >
        <header
          className="nc-popup-testa"
          onMouseDown={iniziaDrag('move')}
          onDoubleClick={ricentra}
          title={t('popup-drag-hint')}
        >
          <span className="nc-popup-titolo">
            {title}
            {subtitle ? <small className="nc-popup-sub">{subtitle}</small> : null}
          </span>
          <button type="button" ref={primaRef} className="nc-popup-chiudi" onClick={chiudi} title={t('close')} aria-label={t('close')}>✕</button>
        </header>
        <div className="nc-popup-corpo">{children}</div>
        {!mobile && (
          <div
            className="nc-popup-angolo"
            onMouseDown={iniziaDrag('resize')}
            title={t('popup-resize-hint')}
            role="presentation"
          />
        )}
      </div>
      {velo && <div className="nc-popup-velo-drag" role="presentation" />}
    </div>
  );
}
