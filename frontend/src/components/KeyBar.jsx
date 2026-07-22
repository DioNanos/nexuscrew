import { useState } from 'react';
import Icon from './Icon.jsx';
import { dismissVirtualKeyboard } from '../lib/virtual-keyboard.js';
import './KeyBar.css';
// Layout stile Termux extra-keys: due righe piatte,
// tasti uniformi senza bordi. Le azioni NexusCrew (window/pane/scroll/detach)
// vivono nel menu ☰. send(seq): byte grezzi nel pty. action(name): comando
// tmux server-side (la nav NON si emula con prefix key client-side).
const PREFIX = '\x02';   // C-b — solo scroll/detach
const ESC = '\x1b';
const NAV = [
  { label: '↑', seq: ESC + '[A' }, { label: '↓', seq: ESC + '[B' },
  { label: 'PGUP', seq: ESC + '[5~' }, { label: 'PGDN', seq: ESC + '[6~' },
];

export default function KeyBar({
  send, action, ctrlArmed = false, onCtrl, onKeyboard, selectionMode = false,
  onSelectionMode, keepKeyboardClosed = true, showEnter = true,
}) {
  const [copy, setCopy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [altArmed, setAltArmed] = useState(false);

  // ALT sticky: il prossimo tasto della barra esce come ESC+seq (Meta).
  const emit = (seq) => {
    if (altArmed) { send(ESC + seq); setAltArmed(false); } else send(seq);
  };
  const run = (fn) => {
    if (keepKeyboardClosed) dismissVirtualKeyboard();
    fn();
  };
  // pointerdown mantiene il gesto diretto (PTY/clipboard/micro UI) senza dare
  // focus al button. Il click detail=0 conserva attivazione tastiera/screen reader
  // senza duplicare il pointer click successivo.
  const press = (fn) => ({
    onPointerDown: (e) => { e.preventDefault(); run(fn); },
    onClick: (e) => { if (e.detail === 0) run(fn); },
  });
  const Bk = (label, seq, after) => (
    <button type="button" key={label} {...press(() => { emit(seq); if (after) after(); })}>{label}</button>
  );
  const Ba = (label, name) => (
    <button type="button" key={label} {...press(() => { action(name); setMenu(false); })}>{label}</button>
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
          <button type="button" className={selectionMode ? 'armed' : ''}
            {...press(() => { onSelectionMode?.(!selectionMode); setMenu(false); })}>SELECT</button>
          {Bk('⌃C', '\x03', () => setMenu(false))}
          {Bk('DETACH', PREFIX + 'd', () => setMenu(false))}
        </div>
      )}
      <div className={`nc-keygrid${showEnter ? '' : ' no-enter'}`}>
        <div className="nc-keyrows">
          <div className="row">
            {Bk('ESC', ESC)}
            <button type="button" key="menu" className={menu ? 'armed' : ''}
              {...press(() => setMenu((v) => !v))}>☰</button>
            {Bk('/', '/')}
            {Bk('—', '-')}
            {Bk('HOME', ESC + '[H')}
            {Bk('↑', ESC + '[A')}
            {Bk('END', ESC + '[F')}
            {Bk('PGUP', ESC + '[5~')}
          </div>
          <div className="row">
            {Bk('⇥', '\t')}
            <button type="button" key="kbd" {...press(() => { if (onKeyboard) onKeyboard(); })}>⌨</button>
            <button type="button" key="ctrl" className={ctrlArmed ? 'armed' : ''}
              {...press(() => { if (onCtrl) onCtrl(); })}>CTRL</button>
            <button type="button" key="alt" className={altArmed ? 'armed' : ''}
              {...press(() => setAltArmed((v) => !v))}>ALT</button>
            {Bk('←', ESC + '[D')}
            {Bk('↓', ESC + '[B')}
            {Bk('→', ESC + '[C')}
            {Bk('PGDN', ESC + '[6~')}
          </div>
        </div>
        {showEnter && (
          <button type="button" className="nc-enter-key" aria-label="ENTER" title="ENTER"
            {...press(() => emit('\r'))}>
            <Icon name="enter" size={24} />
          </button>
        )}
      </div>
    </div>
  );
}
