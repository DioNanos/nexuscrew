'use strict';
const { Router } = require('express');
const multer = require('multer');
const store = require('./store.js');

// Router file-exchange. Nessuno stato: tutto deriva da cfg + filesystem.
function filesRoutes({ cfg, sessionExists, paste }) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cfg.maxUpload, files: 1 },
  });

  router.post('/upload', (req, res) => {
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
      const pasted = await paste(session, saved.path);
      res.json({ ...saved, pasted });
    });
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
    const ok = store.removeFile(
      cfg.filesRoot, String(req.query.session || ''), String(req.query.box || ''), String(req.query.name || ''),
    );
    if (!ok) return res.status(404).json({ error: 'file non trovato' });
    res.json({ deleted: true });
  });

  return router;
}

module.exports = { filesRoutes };
