import { useState } from 'react';
import './KeyBar.css';
// send(seq): raw bytes into the pty (keys + copy-mode). action(name): server-side
// tmux command (window/pane nav). Nav must NOT be emulated with client-side prefix
// keys (it depends on the host's bindings); it runs server-side instead.
const PREFIX = '\x02';   // C-b (configurable) — used only for scroll/detach
const ESC = '\x1b';
// In copy-mode keys go WITHOUT prefix (the mode handles them directly).
const NAV = [
  { label: '↑', seq: ESC + '[A' }, { label: '↓', seq: ESC + '[B' },
  { label: 'PgUp', seq: ESC + '[5~' }, { label: 'PgDn', seq: ESC + '[6~' },
];

export default function KeyBar({ send, action, ctrlArmed = false, onCtrl }) {
  const [copy, setCopy] = useState(false);
  const Bk = (label, seq, after) => (
    <button key={label} onMouseDown={(e) => { e.preventDefault(); send(seq); if (after) after(); }}>{label}</button>
  );
  const Ba = (label, name) => (
    <button key={label} onMouseDown={(e) => { e.preventDefault(); action(name); }}>{label}</button>
  );
  if (copy) {
    return (
      <div className="nc-keybar copy">
        <span className="tag">copy-mode</span>
        {NAV.map((k) => Bk(k.label, k.seq))}
        {Bk('esci (q)', 'q', () => setCopy(false))}
      </div>
    );
  }
  return (
    <div className="nc-keybar">
      {Bk('esc', ESC)}
      {Bk('tab', '\t')}
      <button key="ctrl" className={ctrlArmed ? 'armed' : ''}
        onMouseDown={(e) => { e.preventDefault(); if (onCtrl) onCtrl(); }}>ctrl</button>
      {Bk('⌃C', '\x03')}
      {Bk('←', ESC + '[D')}
      {Bk('↑', ESC + '[A')}
      {Bk('↓', ESC + '[B')}
      {Bk('→', ESC + '[C')}
      {Bk('scroll', PREFIX + '[', () => setCopy(true))}
      {Ba('←win', 'prev-window')}
      {Ba('win→', 'next-window')}
      {Ba('⬅pane', 'pane-left')}
      {Ba('pane➡', 'pane-right')}
      {Bk('detach', PREFIX + 'd')}
    </div>
  );
}
