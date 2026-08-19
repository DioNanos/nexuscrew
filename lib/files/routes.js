'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Router } = require('express');
const multer = require('multer');
const store = require('./store.js');
const { pasteArgs } = require('../tmux/actions.js');

// Router file-exchange. Nessuno stato: tutto deriva da cfg + filesystem.
// notifier (opzionale, MCP bridge): emette la notify di consegna file outbox.
function filesRoutes({ cfg, sessionExists, paste, notifier, readonly = () => false }) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cfg.maxUpload, files: 1 },
  });

  router.post('/upload', (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: upload bloccato' });
    upload.single('file')(req, res, async (err) => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: err.message });
      }
      const session = String((req.body && req.body.session) || '');
      if (!req.file) return res.status(400).json({ error: 'file mancante' });
      if (!store.isValidSession(session) || !sessionExists(session)) {
        return res.status(404).json({ error: 'sessione tmux inesistente' });
      }
      const saved = store.saveUpload(cfg.filesRoot, session, req.file.buffer, req.file.originalname);
      // paste=false (tasto allegati del composer): il client appende il path al
      // testo del composer — niente scrittura PTY. Default = incolla (FilesPanel).
      const wantPaste = String((req.body && req.body.paste) || '') !== 'false';
      // R31-A2: paste RICHIESTO ma non riuscito non e' un 200 con pasted:false —
      // tre cause collassavano in quell'unica etichetta muta (non richiesto /
      // tmux non ha ricevuto / testo respinto) e nessuno, risposta o UI, poteva
      // accorgersene. Il vocabolario e' quello del ramo answer degli ask
      // (lib/notify/routes.js): «paste fallito» si dice non-200 + error, col
      // codice che nomina il soggetto giusto (502 valle raggiunto, 500 rifiuto
      // nostro). Il file resta nella risposta: e' salvato in inbox, e' la
      // consegna alla PTY che non e' avvenuta — la causa vera va detta, non
      // nascosta dietro un OK.
      if (!wantPaste) return res.json({ ...saved, pasted: false });
      // Testo respinto a monte: pasteArgs e' la FONTE UNICA del rifiuto (la usa
      // pasteToSession). Il nome upload e' sanitizzato: se scatta, la causa e'
      // il filesRoot di configurazione (control char) o un path oltre i 4096
      // char. Rifiuto noto PRIMA di tmux: la PTY non va neanche tentata.
      // 500, non 502 (rilievo audit su d6c47c6): qui il valle NON e' stato
      // contattato — a rifiutare siamo noi, per configurazione nostra. 502
      // affermerebbe «il servizio a monte non risponde» e sveglierebbe un
      // allarme su un tmux che sta benissimo. La coppia di codici e'
      // informazione: 502 = raggiunto ma non ha preso; 500 = mai tentato.
      if (!pasteArgs(session, saved.path)) {
        return res.status(500).json({
          error: 'paste fallito: path non incollabile (control char o oltre 4096 char)',
          ...saved,
          pasted: false,
        });
      }
      const pasted = await paste(session, saved.path);
      if (!pasted) {
        return res.status(502).json({
          error: `paste fallito: sessione "${session}" non raggiungibile`,
          ...saved,
          pasted: false,
        });
      }
      res.json({ ...saved, pasted });
    });
  });

  // Consegna deliverable dal MCP bridge (nc_send_file): copia un file locale
  // nell'outbox della sessione mittente. Path sorgente fail-closed: stringa
  // assoluta, realpath ESISTENTE sotto HOME (i symlink si risolvono PRIMA del
  // check: un link che esce da HOME viene rifiutato), file regolare.
  // F3 (audit): gated READONLY — la copia e' una scrittura su disco; il gate
  // sta PRIMA di ogni altro check (nessun probe di sessione/path in READONLY).
  const bridgeReadonly = () => (cfg.readonlyDefault === true || process.env.NEXUSCREW_READONLY === '1');
  router.post('/outbox', express.json({ limit: '8kb' }), (req, res) => {
    try {
      if (bridgeReadonly()) {
        return res.status(403).json({ error: 'READONLY: consegna file bloccata' });
      }
      const b = req.body || {};
      const session = String(b.session || '');
      if (!store.isValidSession(session) || !sessionExists(session)) {
        return res.status(404).json({ error: 'sessione tmux inesistente' });
      }
      if (typeof b.path !== 'string' || !path.isAbsolute(b.path)) {
        return res.status(400).json({ error: 'path deve essere assoluto' });
      }
      if (b.caption !== undefined && (typeof b.caption !== 'string' || b.caption.length > 500)) {
        return res.status(400).json({ error: 'caption deve essere una stringa (max 500)' });
      }
      const home = cfg.home || os.homedir();
      let src;
      try { src = fs.realpathSync(b.path); } catch (_) {
        return res.status(404).json({ error: 'file sorgente inesistente' });
      }
      const homeReal = fs.realpathSync(home);
      if (src !== homeReal && !src.startsWith(homeReal + path.sep)) {
        return res.status(400).json({ error: 'path fuori da HOME' });
      }
      if (!fs.statSync(src).isFile()) {
        return res.status(400).json({ error: 'path non e\' un file regolare' });
      }
      const saved = store.saveDeliverable(cfg.filesRoot, session, src);
      if (!saved) return res.status(400).json({ error: 'sessione invalida' });
      // Notify best-effort (il badge outbox lo genera comunque il watcher).
      if (notifier) {
        notifier.emit({
          title: `file da ${session}`,
          body: b.caption ? `${saved.name} — ${b.caption}` : saved.name,
          session,
          lang: 'it',
        }).catch(() => {});
      }
      res.json({ name: saved.name, box: 'outbox', size: saved.size });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  router.get('/', (req, res) => {
    const session = String(req.query.session || '');
    if (!store.isValidSession(session)) return res.status(400).json({ error: 'sessione invalida' });
    res.json({
      session,
      inbox: store.listBox(cfg.filesRoot, session, 'inbox'),
      outbox: store.listBox(cfg.filesRoot, session, 'outbox'),
    });
  });

  router.get('/download', (req, res) => {
    const full = store.resolveExisting(
      cfg.filesRoot, String(req.query.session || ''), String(req.query.box || 'outbox'), String(req.query.name || ''),
    );
    if (!full) return res.status(404).json({ error: 'file non trovato' });
    res.download(full);
  });

  router.delete('/', (req, res) => {
    if (readonly()) return res.status(403).json({ error: 'READONLY: eliminazione file bloccata' });
    const ok = store.removeFile(
      cfg.filesRoot, String(req.query.session || ''), String(req.query.box || ''), String(req.query.name || ''),
    );
    if (!ok) return res.status(404).json({ error: 'file non trovato' });
    res.json({ deleted: true });
  });

  return router;
}

module.exports = { filesRoutes };
