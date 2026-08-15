import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// La versione del pacchetto entra nel bundle: il frontend la confronta con
// /api/config e mostra il banner "aggiorna" se la tab ha un bundle stantio.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react(), {
    name: 'nexuscrew-version-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version: pkg.version })}\n` })
    }
  }],
  define: { __NC_BUILD_VERSION__: JSON.stringify(pkg.version) },
  server: {
    proxy: {
      '/api': 'http://localhost:41820',
      '/health': 'http://localhost:41820'
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    clearMocks: true,
    // Il timeout serve solo a non appendersi: NESSUN test di questo pacchetto
    // asserisce QUANTO IN FRETTA un componente risponde, solo CHE risponda
    // (userEvent/render su jsdom). I 5s di default sono tarati su una macchina
    // scarica: con la flotta attiva (sei core, load >7) il gate produceva rossi
    // casuali su file diversi a ogni giro — stesso fenomeno e stessa cura dei
    // limiti backend (tests/README-flake.md, modello c15faea). 20s con la
    // ragione scritta accanto; nessuna asserzione indebolita.
    testTimeout: 20000
  },
  build: {
    outDir: 'dist'
  }
})
