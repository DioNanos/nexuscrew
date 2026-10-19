import ChatTileView from './ChatTileView.jsx';
import { DEMO } from '../../lib/chat-fixtures.js';
import './ChatDemo.css';

function DemoTile({ fixture, label }) {
  return (
    <section className="nc-tile nc-ui0-tile" aria-label={`${fixture.label}, chat`}>
      <header className="nc-tile-head">
        <span className="nc-tile-name" title={`${fixture.label} · ${fixture.sub}`}>
          <span className="nc-dot on" />
          <b>{fixture.label}</b>
        </span>
        <small className="nc-ui0-sub">{fixture.sub}</small>
      </header>
      <div className="nc-tile-body">
        <ChatTileView
          target={fixture.target}
          events={fixture.events}
          viewer={fixture.viewer}
          label={fixture.label}
          capabilities={{ permissionPolicy: 'yolo' }}
        />
      </div>
      <span className="nc-ui0-tile-label">{label}</span>
    </section>
  );
}

// Hermetic demo surface: no App, no auth, no fetch, no WebSocket. It is
// mounted by main.jsx only when the build flag is ON and the URL asks for
// ?ui0=1.
export default function ChatDemoGrid() {
  return (
    <div className="nc-ui0-demo">
      <header className="nc-ui0-bar">
        <b>UI-0 · chat per cella</b>
        <span>fixture nc-chat/1 statiche · nessuna rete</span>
      </header>
      <main className="nc-ui0-grid">
        <DemoTile fixture={DEMO.vl} label="nodo VL remoto" />
        <DemoTile fixture={DEMO.cli} label="cella CLI locale" />
      </main>
    </div>
  );
}
