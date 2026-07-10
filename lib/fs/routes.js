'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');

const MAX_ENTRIES = 500;

// Router /api/fs — sfoglia SOLO directory, confinato alla home (o root passata).
// Serve al folder-picker del dialog "new session": il browser non può sfogliare
// il filesystem del server, quindi lo fa il server, dietro lo stesso Bearer di
// tutte le /api. Policy symlink: realpath; se la risoluzione esce dalla root
// (symlink verso fuori) → 403. Niente file, niente contenuti: solo nomi di dir.
function fsRoutes({ home }) {
  const r = express.Router();

  r.get('/dirs', async (req, res) => {
    try {
      const root = await fsp.realpath(home);
      const q = typeof req.query.path === 'string' && req.query.path ? req.query.path : root;
      if (q.includes('\0')) return res.status(400).json({ error: 'path non valido' });
      let real;
      try { real = await fsp.realpath(path.resolve(root, q)); } catch (_) {
        return res.status(404).json({ error: 'directory inesistente' });
      }
      if (real !== root && !real.startsWith(root + path.sep)) {
        return res.status(403).json({ error: 'fuori dalla home' });
      }
      let entries;
      try { entries = await fsp.readdir(real, { withFileTypes: true }); } catch (e) {
        if (e.code === 'ENOTDIR') return res.status(404).json({ error: 'non è una directory' });
        if (e.code === 'EACCES') return res.status(403).json({ error: 'permesso negato' });
        throw e;
      }
      const showHidden = req.query.hidden === '1';
      const names = [];
      for (const d of entries) {
        if (!showHidden && d.name.startsWith('.')) continue;
        if (d.isDirectory()) { names.push(d.name); continue; }
        if (d.isSymbolicLink()) {                    // symlink: solo se risolve a una dir
          try { if ((await fsp.stat(path.join(real, d.name))).isDirectory()) names.push(d.name); } catch (_) { /* rotto: skip */ }
        }
      }
      const dirs = names.sort((a, b) => a.localeCompare(b)).slice(0, MAX_ENTRIES);
      res.json({
        path: real,
        parent: real === root ? null : path.dirname(real),
        home: root,
        dirs,
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  return r;
}

module.exports = { fsRoutes };
