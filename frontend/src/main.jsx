import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import UpdatePrompt from './components/UpdatePrompt.jsx'
import TokenNotice from './components/TokenNotice.jsx'
import { registerSW } from './lib/sw-update.js'
import { ensureStoragePersistence } from './lib/storage-persist.js'
import ChatDemoGrid from './components/chat/ChatDemoGrid.jsx'
import { ui0ChatEnabled, ui0DemoRequested } from './lib/ui0-chat-demo.js'
import './index.css'

// UI-0 demo: a hermetic surface that needs no auth, no service worker and
// no network. It is reachable only with the build flag ON and ?ui0=1.
const ui0Demo = ui0DemoRequested(window.location.search) && ui0ChatEnabled();

if (!ui0Demo) {
  // Service Worker + rilevamento nuova versione (banner non invasivo in UpdatePrompt).
  registerSW();
  // Chiede al browser di non sfrattare lo storage (pin, ordine, token); l'esito e' visibile in Impostazioni.
  ensureStoragePersistence();
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {ui0Demo ? (
      <ChatDemoGrid />
    ) : (
      <>
        <App />
        <UpdatePrompt />
        <TokenNotice />
      </>
    )}
  </React.StrictMode>
)
