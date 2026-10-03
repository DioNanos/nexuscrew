import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import UpdatePrompt from './components/UpdatePrompt.jsx'
import TokenNotice from './components/TokenNotice.jsx'
import { registerSW } from './lib/sw-update.js'
import { ensureStoragePersistence } from './lib/storage-persist.js'
import './index.css'

// Service Worker + rilevamento nuova versione (banner non invasivo in UpdatePrompt).
registerSW();
// Chiede al browser di non sfrattare lo storage (pin, ordine, token); l'esito e' visibile in Impostazioni.
ensureStoragePersistence();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <UpdatePrompt />
    <TokenNotice />
  </React.StrictMode>
)
