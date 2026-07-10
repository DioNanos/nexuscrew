import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import UpdatePrompt from './components/UpdatePrompt.jsx'
import { registerSW } from './lib/sw-update.js'
import './index.css'

// Service Worker + rilevamento nuova versione (banner non invasivo in UpdatePrompt).
registerSW();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <UpdatePrompt />
  </React.StrictMode>
)
