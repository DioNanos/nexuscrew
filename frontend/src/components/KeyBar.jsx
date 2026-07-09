import { useState } from 'react';
import './KeyBar.css';
// Layout stile Termux extra-keys (richiesta DAG 2026-07-09): due righe piatte,
// tasti uniformi senza bordi. Le azioni NexusCrew (window/pane/scroll/detach)
// vivono nel menu ☰. send(seq): byte grezzi nel pty. action(name): comando
// tmux server-side (la nav NON si emula con prefix key client-side).
const PREFIX = '\x02';   // C-b — solo scroll/detach
const ESC = '\x1b';
const NAV = [
  { label: '↑', seq: ESC + '[A' }, { label: '↓', seq: ESC + '[B' },
  { label: 'PGUP', seq: ESC + '[5~' }, { label: 'PGDN', seq: ESC + '[6~' },
];

export default function KeyBar({ send, action, ctrlArmed = false, onCtrl }) {
  const [copy, setCopy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [altArmed, setAltArmed] = useState(false);

  // ALT sticky: il prossimo tasto della barra esce come ESC+seq (Meta).
  const emit = (seq) => {
    if (altArmed) { send(ESC + seq); setAltArmed(false); } else send(seq);
  };
  const Bk = (label, seq, after) => (
    <button key={label} onMouseDown={(e) => { e.preventDefault(); emit(seq); if (after) after(); }}>{label}</button>
  );
  const Ba = (label, name) => (
    <button key={label} onMouseDown={(e) => { e.preventDefault(); action(name); setMenu(false); }}>{label}</button>
  );

  if (copy) {
    return (
      <div className="nc-keybar copy">
        <span className="tag">copy-mode</span>
        {NAV.map((k) => Bk(k.label, k.seq))}
        {Bk('ESCI (q)', 'q', () => setCopy(false))}
      </div>
    );
  }
  return (
    <div className="nc-keybar termux">
      {menu && (
        <div className="nc-keymenu">
          {Ba('←WIN', 'prev-window')}
          {Ba('WIN→', 'next-window')}
          {Ba('⬅PANE', 'pane-left')}
          {Ba('PANE➡', 'pane-right')}
          {Bk('SCROLL', PREFIX + '[', () => { setCopy(true); setMenu(false); })}
          {Bk('⌃C', '\x03', () => setMenu(false))}
          {Bk('DETACH', PREFIX + 'd', () => setMenu(false))}
        </div>
      )}
      <div className="row">
        {Bk('ESC', ESC)}
        <button key="menu" className={menu ? 'armed' : ''}
          onMouseDown={(e) => { e.preventDefault(); setMenu((v) => !v); }}>☰</button>
        {Bk('/', '/')}
        {Bk('—', '-')}
        {Bk('HOME', ESC + '[H')}
        {Bk('↑', ESC + '[A')}
        {Bk('END', ESC + '[F')}
        {Bk('PGUP', ESC + '[5~')}
      </div>
      <div className="row">
        {Bk('⇥', '\t')}
        <button key="ctrl" className={ctrlArmed ? 'armed' : ''}
          onMouseDown={(e) => { e.preventDefault(); if (onCtrl) onCtrl(); }}>CTRL</button>
        <button key="alt" className={altArmed ? 'armed' : ''}
          onMouseDown={(e) => { e.preventDefault(); setAltArmed((v) => !v); }}>ALT</button>
        {Bk('←', ESC + '[D')}
        {Bk('↓', ESC + '[B')}
        {Bk('→', ESC + '[C')}
        {Bk('PGDN', ESC + '[6~')}
      </div>
    </div>
  );
}
