import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { openTerminalSocket } from '../lib/ws-client.js';
import './Terminal.css';

export default function Terminal({ session, token, readonly, takeSize, sendRef, actionRef, ctrlRef, setCtrlArmed, onFiles, fontSize = 13 }) {
  const hostRef = useRef(null);
  const apiRef = useRef(null);        // {term, fit, sock} per lo zoom senza riconnettere
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  // Zoom: cambia solo il font e rifitta — la connessione resta viva.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.term.options.fontSize = fontSize;
    api.fit.fit();
    api.sock.resize(api.term.cols, api.term.rows);
  }, [fontSize]);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true, fontSize: fontSizeRef.current, scrollback: 1000,
      theme: { background: '#0a0e0a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    const dec = new TextDecoder();

    let sock;
    try {
      sock = openTerminalSocket({
        session, token, readonly, takeSize, onFiles,
        cols: term.cols, rows: term.rows,
        onData: (bytes) => term.write(dec.decode(bytes)),
        onExit: () => term.write('\r\n\x1b[33m[sessione finita]\x1b[0m\r\n'),
      });
    } catch (e) {
      term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
      return () => term.dispose();
    }
    apiRef.current = { term, fit, sock };
    if (sendRef) sendRef.current = (seq) => sock.sendInput(seq);     // tasti grezzi (KeyBar)
    if (actionRef) actionRef.current = (name) => sock.action(name);  // nav window/pane (KeyBar)

    const onData = term.onData((d) => {
      if (readonly) return;
      // sticky Ctrl: fold the next single character into its control code (a-z/@-_).
      if (ctrlRef && ctrlRef.current && d.length === 1) {
        const c = d.charCodeAt(0);
        let code = c;
        if (c >= 97 && c <= 122) code = c - 96;        // a-z -> ^A..^Z
        else if (c >= 64 && c <= 95) code = c - 64;    // @A-Z[\]^_ -> ^@..^_
        else if (c === 32) code = 0;                   // space -> ^@
        d = String.fromCharCode(code);
        ctrlRef.current = false;
        if (setCtrlArmed) setCtrlArmed(false);
      }
      sock.sendInput(d);
    });
    // Cronologia col gesto: drag verticale (dito) e rotella → copy-mode
    // server-side. Dito verso il basso = storia più vecchia (scroll-up).
    // Il drag col MOUSE resta selezione testo. Grazie a copy-mode -e, il
    // gesto opposto fino in fondo riporta al vivo.
    const host = hostRef.current;
    const STEP = 24; // px per tick di scroll (3 righe tmux)
    let touchY = null, touchX = null, acc = 0, vertical = null;
    const onTouchStart = (e) => {
      if (e.touches.length !== 1) { touchY = null; return; }
      touchY = e.touches[0].clientY; touchX = e.touches[0].clientX; acc = 0; vertical = null;
    };
    const onTouchMove = (e) => {
      if (touchY === null || e.touches.length !== 1) return;
      // preventDefault SUBITO, non dopo la soglia: al primo touchmove il
      // browser decide tra native scroll e JS — se non blocchi qui, parte il
      // pan nativo e i preventDefault successivi vengono ignorati.
      e.preventDefault(); e.stopPropagation();
      const t = e.touches[0];
      if (vertical === null && (Math.abs(t.clientY - touchY) > 8 || Math.abs(t.clientX - touchX) > 8)) {
        vertical = Math.abs(t.clientY - touchY) > Math.abs(t.clientX - touchX);
      }
      if (!vertical) return;
      acc += t.clientY - touchY; touchY = t.clientY;
      while (acc >= STEP) { sock.action('scroll-up'); acc -= STEP; }
      while (acc <= -STEP) { sock.action('scroll-down'); acc += STEP; }
    };
    const onTouchEnd = () => { touchY = null; };
    let wheelAcc = 0;
    const onWheel = (e) => {
      e.preventDefault(); e.stopPropagation();
      wheelAcc += e.deltaY;
      while (wheelAcc <= -STEP) { sock.action('scroll-up'); wheelAcc += STEP; }
      while (wheelAcc >= STEP) { sock.action('scroll-down'); wheelAcc -= STEP; }
    };
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    host.addEventListener('touchend', onTouchEnd, { passive: true });
    host.addEventListener('wheel', onWheel, { passive: false, capture: true });

    const onResize = () => { fit.fit(); sock.resize(term.cols, term.rows); };
    window.addEventListener('resize', onResize);
    // the soft keyboard opening/closing changes the visible height without firing
    // window 'resize' on some mobile browsers — track the visualViewport too.
    const vv = window.visualViewport;
    if (vv) { vv.addEventListener('resize', onResize); vv.addEventListener('scroll', onResize); }

    return () => {
      apiRef.current = null;
      onData.dispose();
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove, { capture: true });
      host.removeEventListener('touchend', onTouchEnd);
      host.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('resize', onResize);
      if (vv) { vv.removeEventListener('resize', onResize); vv.removeEventListener('scroll', onResize); }
      sock.close();
      term.dispose();
    };
  }, [session, token, readonly, takeSize, sendRef, actionRef, ctrlRef, setCtrlArmed, onFiles]);

  return <div className="nc-terminal" ref={hostRef} />;
}
