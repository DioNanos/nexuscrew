import { useState } from 'react';

// Local preview only: no submit, no upload, no STT, no history fetch. Buttons
// are inert by construction (no handlers) and the text never leaves the tile.
export default function ChatComposerPreview({ label = '', running = false, demo = true }) {
  const [text, setText] = useState('');
  return (
    <div className="nc-chat-composer" data-demo={demo ? '1' : undefined}>
      <div className="nc-chat-pill">
        <button type="button" className="nc-chat-icon" aria-label="Allega" disabled title="demo">＋</button>
        <label className="nc-chat-input">
          <span className="nc-chat-sr">Messaggio{label ? ` per ${label}` : ''}</span>
          <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Scrivi…" />
        </label>
        <button type="button" className="nc-chat-icon" aria-label="Cronologia messaggi" disabled title="demo">↺</button>
        <button type="button" className="nc-chat-icon" aria-label="Detta a voce" disabled title="demo">🎙</button>
      </div>
      {running ? (
        <button type="button" className="nc-chat-send" aria-label="Ferma il turno" disabled title="demo: nessuna chiamata reale">■</button>
      ) : (
        <button type="button" className="nc-chat-send" aria-label="Invia" disabled title="demo: nessuna chiamata reale">↑</button>
      )}
    </div>
  );
}
