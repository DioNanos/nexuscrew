import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// La versione del pacchetto entra nel bundle: il frontend la confronta con
// /api/config e mostra il banner "aggiorna" se la tab ha un bundle stantio.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: { __NC_BUILD_VERSION__: JSON.stringify(pkg.version) },
  server: {
    proxy: {
      '/api': 'http://localhost:41820',
      '/health': 'http://localhost:41820'
    }
  },
  build: {
    outDir: 'dist'
  }
})
