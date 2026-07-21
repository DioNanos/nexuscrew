import { useState } from 'react';
import { CR } from '../lib/composer-input.js';
import './KeyBar.css';
// Layout stile Termux extra-keys. Di default (expanded=false) si mostra una
// riga ridotta con i tasti essenziali per il caso d'uso mobile: toggle espandi,
// menu ☰, frecce ↑↓←→ per navigare le scelte multiple dei TUI, e ■Enter per
// confermarle (send(CR) diretto, affidabile anche quando l'Enter della soft
// keyboard non viene catturato da xterm). Il toggle espande le due righe
// complete "com'è ora" (ESC/HOME/END/PGUP/TAB/CTRL/ALT/PGDN…). Le azioni
// NexusCrew (window/pane/scroll/detach) vivono nel menu ☰. send(seq): byte
// grezzi nel pty. action(name): comando tmux server-side.
const PREFIX = '\x02';   // C-b — solo scroll/detach
const ESC = '\x1b';
const NAV = [
  { label: '↑', seq: ESC + '[A' }, { label: '↓', seq: ESC + '[B' },
  { label: 'PGUP', seq: ESC + '[5~' }, { label: 'PGDN', seq: ESC + '[6~' },
];

export default function KeyBar({ send, action, ctrlArmed = false, onCtrl, onKeyboard, selectionMode = false, onSelectionMode }) {
  const [copy, setCopy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Tasti che agiscono sul terminale (send(seq)): chiudono la soft keyboard
  // facendo blur dell'elemento attivo, così scorrendo le scelte di un TUI con
  // le frecce la schermata risposte resta visibile e non viene coperta dalla
  // tastiera del ComposerBar. Il ⌨ (apre il composer), CTRL/ALT (sticky),
  // toggle e menu sono UI locale e non fanno blur.
  const blurActive = () => {
    const el = document.activeElement;
    if (el && typeof el.blur === 'function' && el !== document.body) el.blur();
  };
  // ALT sticky: il prossimo tasto della barra esce come ESC+seq (Meta).
  const emit = (seq) => {
    if (altArmed) { send(ESC + seq); setAltArmed(false); } else send(seq);
  };
  const Bk = (label, seq, after) => (
    <button key={label} onMouseDown={(e) => { e.preventDefault(); blurActive(); emit(seq); if (after) after(); }}>{label}</button>
  );
  const Ba = (label, name) => (
    <button key={label} onMouseDown={(e) => { e.preventDefault(); blurActive(); action(name); setMenu(false); }}>{label}</button>
  );
  // ■Enter: sempre CR puro, ignora ALT sticky — la conferma di una selezione
  // multipla deve essere prevedibile (niente Meta+Enter inavvertito). Non usa
  // emit() di proposito. blurActive() chiude la tastiera prima di confermare.
  const Enter = () => (
    <button key="enter" className="enter" aria-label="Enter"
      onMouseDown={(e) => { e.preventDefault(); blurActive(); send(CR); }}>{'■'}</button>
  );
  const Toggle = () => (
    <button key="expand" className={`expand${expanded ? ' armed' : ''}`}
      aria-label={expanded ? 'restringi comandi' : 'espandi comandi'}
      onMouseDown={(e) => { e.preventDefault(); setExpanded((v) => !v); }}>{expanded ? '⊟' : '⊞'}</button>
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
  const menuEl = menu && (
    <div className="nc-keymenu">
      {Ba('←WIN', 'prev-window')}
      {Ba('WIN→', 'next-window')}
      {Ba('⬅PANE', 'pane-left')}
      {Ba('PANE➡', 'pane-right')}
      {Bk('SCROLL', PREFIX + '[', () => { setCopy(true); setMenu(false); })}
      <button className={selectionMode ? 'armed' : ''} onMouseDown={(e) => { e.preventDefault(); onSelectionMode?.(!selectionMode); setMenu(false); }}>SELECT</button>
      {Bk('⌃C', '\x03', () => setMenu(false))}
      {Bk('DETACH', PREFIX + 'd', () => setMenu(false))}
    </div>
  );
  const menuBtn = (
    <button key="menu" className={menu ? 'armed' : ''}
      onMouseDown={(e) => { e.preventDefault(); setMenu((v) => !v); }}>☰</button>
  );

  if (!expanded) {
    // Vista ridotta: toggle + ☰ + frecce ↑↓←→ + ■Enter.
    return (
      <div className="nc-keybar termux">
        {menuEl}
        <div className="row">
          <Toggle />
          {menuBtn}
          {Bk('↑', ESC + '[A')}
          {Bk('↓', ESC + '[B')}
          {Bk('←', ESC + '[D')}
          {Bk('→', ESC + '[C')}
          <Enter />
        </div>
      </div>
    );
  }
  // Vista espansa: due righe complete "com'è ora" + Toggle in testa + ■Enter in coda alla prima riga.
  return (
    <div className="nc-keybar termux">
      {menuEl}
      <div className="row">
        <Toggle />
        {Bk('ESC', ESC)}
        {menuBtn}
        {Bk('/', '/')}
        {Bk('—', '-')}
        {Bk('HOME', ESC + '[H')}
        {Bk('↑', ESC + '[A')}
        {Bk('END', ESC + '[F')}
        {Bk('PGUP', ESC + '[5~')}
        <Enter />
      </div>
      <div className="row">
        {Bk('⇥', '\t')}
        <button key="kbd"
          onMouseDown={(e) => { e.preventDefault(); if (onKeyboard) onKeyboard(); }}>⌨</button>
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