# NexusCrew VPS3-special (v0.5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estendere NexusCrew v0.4 pty-core con allegati bidirezionali (inbox/outbox per sessione), voice→testo (Web Speech + fallback whisper locale), hardening REST token-gated e deploy systemd su 127.0.0.1:41777.

**Architecture:** Il terminale PTY→WS→xterm.js resta invariato. Si aggiungono tre strati indipendenti: (1) file-exchange su `~/NexusFiles/<sessione>/{inbox,outbox}` con watcher server-side e push su WS; (2) proxy STT verso mcp-voice `127.0.0.1:3105`; (3) UI: badge outbox, FilesPanel slide-over, ComposerBar con mic.

**Tech Stack:** Node ≥18 (CommonJS in `lib/`, `node --test`), Express 4, ws, multer, React+Vite in `frontend/` (ESM).

## Global Constraints

- Bind SOLO `127.0.0.1` (assertLoopback esistente, fail-closed). Porta profilo VPS3: `41777`.
- Repo PRIVATO: push solo su remote `forge`, branch `vps3-special`. MAI npm publish, MAI push github.
- Tutti gli endpoint REST sotto `/api` richiedono `Authorization: Bearer <token>` (confronto timing-safe con `lib/auth/token.js:verify`). Static/SPA non gated.
- Nome sessione tmux validato SEMPRE con `/^[\w.@%:+-]{1,128}$/` prima di toccare filesystem o tmux.
- L'auto-paste del path NON deve MAI inviare Invio (niente `\n`/`\r` nel testo incollato).
- Suite esistente `npm test` (18 test v0.4) DEVE restare verde a ogni task.
- Lavorare in `/home/dag/Dev/20_ai-labs/nexuscrew`, branch `vps3-special`. Commit frequenti, messaggi `feat(vps3): …` / `fix(vps3): …` / `test(vps3): …`.
- Niente nuove dipendenze oltre: `multer@^2.0.0` (backend). Frontend: zero nuove dipendenze.

---

### Task 1: Config estesa (files root, upload limit, voice)

**Files:**
- Modify: `lib/config.js`
- Test: `tests/config.test.js` (append)

**Interfaces:**
- Produces: `defaults()` ritorna in più `filesRoot: string`, `maxUpload: number` (byte), `voiceUrl: string`, `voiceToken: string`, `voiceTokenFile: string`. I task 5 e 7 li consumano da `cfg`.

- [ ] **Step 1: Test fallente** — append a `tests/config.test.js`:

```js
test('defaults: profilo vps3 (files/voice)', () => {
  const d = defaults();
  assert.ok(d.filesRoot.endsWith('NexusFiles'));
  assert.equal(d.maxUpload, 100 * 1024 * 1024);
  assert.equal(d.voiceUrl, 'http://127.0.0.1:3105');
  assert.equal(d.voiceTokenFile, '/opt/mcp-voice/state/http.token');
  assert.equal(typeof d.voiceToken, 'string');
});
```

(Se il file usa import diversi, riusa lo stile già presente nel file: `const { test } = require('node:test'); const assert = require('node:assert'); const { defaults } = require('../lib/config.js');`)

- [ ] **Step 2: Verifica FAIL** — `npm test 2>&1 | tail -20` → il nuovo test fallisce (`filesRoot` undefined).

- [ ] **Step 3: Implementazione** — in `lib/config.js`, dentro `defaults()`, aggiungi dopo `readonlyDefault`:

```js
    filesRoot: process.env.NEXUSCREW_FILES_ROOT || path.join(os.homedir(), 'NexusFiles'),
    maxUpload: Number(process.env.NEXUSCREW_MAX_UPLOAD_MB || 100) * 1024 * 1024,
    voiceUrl: process.env.NEXUSCREW_VOICE_URL || 'http://127.0.0.1:3105',
    voiceToken: process.env.NEXUSCREW_VOICE_TOKEN || '',
    voiceTokenFile: process.env.NEXUSCREW_VOICE_TOKEN_FILE || '/opt/mcp-voice/state/http.token',
```

- [ ] **Step 4: Verifica PASS** — `npm test 2>&1 | tail -5` → tutto verde.
- [ ] **Step 5: Commit** — `git add lib/config.js tests/config.test.js && git commit -m "feat(vps3): config files root, upload limit, voice endpoint"`

---

### Task 2: Middleware Bearer per le REST API

**Files:**
- Create: `lib/auth/middleware.js`
- Test: `tests/rest-auth.test.js`

**Interfaces:**
- Consumes: `verify(expected, given)` da `lib/auth/token.js`.
- Produces: `requireToken(token) -> (req,res,next)` middleware Express; 401 JSON `{error:'unauthorized'}` se header assente/errato. Il task 5 lo monta su `/api`.

- [ ] **Step 1: Test fallente** — `tests/rest-auth.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { requireToken } = require('../lib/auth/middleware.js');

function listen(app) {
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}

test('requireToken: 401 senza header, 401 token errato, 200 corretto', async (t) => {
  const app = express();
  app.use('/api', requireToken('sekret'), (_req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;

  assert.equal((await fetch(`${base}/api/x`)).status, 401);
  assert.equal((await fetch(`${base}/api/x`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  const ok = await fetch(`${base}/api/x`, { headers: { authorization: 'Bearer sekret' } });
  assert.equal(ok.status, 200);
});
```

- [ ] **Step 2: Verifica FAIL** — `node --test tests/rest-auth.test.js` → FAIL (module not found).
- [ ] **Step 3: Implementazione** — `lib/auth/middleware.js`:

```js
'use strict';
const { verify } = require('./token.js');

function bearerFrom(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// 401 uniforme: nessun dettaglio su cosa è andato storto.
function requireToken(token) {
  return (req, res, next) => {
    if (verify(token, bearerFrom(req))) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
}

module.exports = { requireToken, bearerFrom };
```

- [ ] **Step 4: Verifica PASS** — `node --test tests/rest-auth.test.js` → PASS; poi `npm test` completo.
- [ ] **Step 5: Commit** — `git add lib/auth/middleware.js tests/rest-auth.test.js && git commit -m "feat(vps3): middleware Bearer timing-safe per le REST API"`

---

### Task 3: File store (inbox/outbox, sanificazione, anti-traversal)

**Files:**
- Create: `lib/files/store.js`
- Test: `tests/files-store.test.js`

**Interfaces:**
- Produces (consumate dai task 5 e 6):
  - `isValidSession(name) -> bool`
  - `sanitizeName(name) -> string` (basename, niente control char/`/`/`\`, mai vuoto, max 128)
  - `stamp(now?) -> 'YYYYMMDD-HHmm'`
  - `ensureBox(root, session, box) -> dir|null` (mkdir ricorsivo; box ∈ {inbox,outbox})
  - `saveUpload(root, session, buffer, origName, now?) -> {name, path, size}|null` (mai overwrite)
  - `listBox(root, session, box) -> [{name,size,mtime}]|null` (mtime desc; ENOENT → `[]`; sessione/box invalidi → `null`)
  - `resolveExisting(root, session, box, name) -> absPath|null` (guardia traversal)
  - `removeFile(root, session, box, name) -> bool`

- [ ] **Step 1: Test fallente** — `tests/files-store.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/files/store.js');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncfiles-')); }

test('sanitizeName: basename, control char, mai vuoto', () => {
  assert.equal(store.sanitizeName('../../etc/passwd'), 'passwd');
  assert.equal(store.sanitizeName('a b\nc.txt'), 'a_bc.txt');
  assert.equal(store.sanitizeName('..'), 'file');
  assert.equal(store.sanitizeName(''), 'file');
  assert.ok(store.sanitizeName('x'.repeat(300)).length <= 128);
});

test('isValidSession: regex tmux', () => {
  assert.ok(store.isValidSession('claude_dev_senior'));
  assert.ok(store.isValidSession('Codex-VL_DS4P'));
  assert.ok(!store.isValidSession('../evil'));
  assert.ok(!store.isValidSession(''));
  assert.ok(!store.isValidSession('a/b'));
});

test('saveUpload: timbro, no overwrite, contenuto', () => {
  const root = tmpRoot();
  const now = new Date(2026, 6, 6, 14, 32);
  const a = store.saveUpload(root, 'sess1', Buffer.from('ciao'), 'foto.jpg', now);
  assert.equal(a.name, '20260706-1432_foto.jpg');
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'ciao');
  const b = store.saveUpload(root, 'sess1', Buffer.from('bis'), 'foto.jpg', now);
  assert.notEqual(b.name, a.name);
  assert.equal(store.saveUpload(root, '../evil', Buffer.from('x'), 'f'), null);
});

test('listBox: ordina mtime desc, ENOENT=[], invalidi=null', () => {
  const root = tmpRoot();
  assert.deepEqual(store.listBox(root, 'sess1', 'outbox'), []);
  assert.equal(store.listBox(root, 'sess1', 'trash'), null);
  assert.equal(store.listBox(root, '../evil', 'inbox'), null);
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'a');
  fs.utimesSync(path.join(dir, 'old.txt'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'b');
  const list = store.listBox(root, 'sess1', 'outbox');
  assert.equal(list[0].name, 'new.txt');
  assert.equal(list.length, 2);
});

test('resolveExisting/removeFile: traversal bloccato', () => {
  const root = tmpRoot();
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'x');
  fs.writeFileSync(path.join(root, 'sess1', 'secret.txt'), 'no');
  assert.ok(store.resolveExisting(root, 'sess1', 'outbox', 'ok.txt'));
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', '../secret.txt'), null);
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', '..'), null);
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', 'a/b.txt'), null);
  assert.equal(store.resolveExisting(root, 'sess1', 'outbox', 'manca.txt'), null);
  assert.ok(store.removeFile(root, 'sess1', 'outbox', 'ok.txt'));
  assert.ok(!fs.existsSync(path.join(dir, 'ok.txt')));
  assert.ok(!store.removeFile(root, 'sess1', 'outbox', '../secret.txt'));
});
```

- [ ] **Step 2: Verifica FAIL** — `node --test tests/files-store.test.js` → FAIL (module not found).
- [ ] **Step 3: Implementazione** — `lib/files/store.js`:

```js
'use strict';
// File exchange per sessione: <root>/<sessione>/{inbox,outbox}.
// Ogni path è derivato SOLO da input validati: sessione via regex tmux,
// nome file senza separatori. Mai overwrite in inbox.
const fs = require('node:fs');
const path = require('node:path');

const BOXES = new Set(['inbox', 'outbox']);
const SESSION_RE = /^[\w.@%:+-]{1,128}$/;

function isValidSession(name) {
  return typeof name === 'string' && SESSION_RE.test(name);
}

function sanitizeName(name) {
  const base = path.basename(String(name || ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '_');
  const safe = /^\.+$/.test(base) ? '' : base;
  return (safe || 'file').slice(0, 128);
}

function stamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

function boxDir(root, session, box) {
  if (!isValidSession(session) || !BOXES.has(box)) return null;
  return path.join(root, session, box);
}

function ensureBox(root, session, box) {
  const dir = boxDir(root, session, box);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveUpload(root, session, buffer, origName, now = new Date()) {
  const dir = ensureBox(root, session, 'inbox');
  if (!dir) return null;
  const base = `${stamp(now)}_${sanitizeName(origName)}`;
  let name = base;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i += 1) name = `${i}-${base}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, buffer, { flag: 'wx' });
  return { name, path: full, size: buffer.length };
}

function listBox(root, session, box) {
  const dir = boxDir(root, session, box);
  if (!dir) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return []; }
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const st = fs.statSync(path.join(dir, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveExisting(root, session, box, name) {
  const dir = boxDir(root, session, box);
  if (!dir || typeof name !== 'string' || name === '' ) return null;
  if (/[\\/\u0000]/.test(name) || name === '.' || name === '..') return null;
  const full = path.join(dir, name);
  try { if (!fs.statSync(full).isFile()) return null; } catch (_) { return null; }
  return full;
}

function removeFile(root, session, box, name) {
  const full = resolveExisting(root, session, box, name);
  if (!full) return false;
  fs.unlinkSync(full);
  return true;
}

module.exports = {
  isValidSession, sanitizeName, stamp, boxDir, ensureBox,
  saveUpload, listBox, resolveExisting, removeFile, BOXES,
};
```

- [ ] **Step 4: Verifica PASS** — `node --test tests/files-store.test.js` → PASS; poi `npm test`.
- [ ] **Step 5: Commit** — `git add lib/files/store.js tests/files-store.test.js && git commit -m "feat(vps3): file store inbox/outbox con sanificazione e anti-traversal"`

---

### Task 4: Azione tmux `pastePath` (literal, senza Invio)

**Files:**
- Modify: `lib/tmux/actions.js`
- Test: `tests/actions.test.js` (append)

**Interfaces:**
- Produces: `pasteArgs(session, text) -> string[]|null` (pure) e `pasteToSession(tmuxBin, session, text) -> bool`. Il task 5 usa `pasteToSession`.

- [ ] **Step 1: Test fallente** — append a `tests/actions.test.js` (riusa lo stile import del file):

```js
test('pasteArgs: literal, -- protegge, niente newline/control', () => {
  const { pasteArgs } = require('../lib/tmux/actions.js');
  assert.deepEqual(
    pasteArgs('sess1', '/home/dag/NexusFiles/sess1/inbox/f.jpg'),
    ['send-keys', '-t', '=sess1', '-l', '--', '/home/dag/NexusFiles/sess1/inbox/f.jpg'],
  );
  assert.equal(pasteArgs('sess1', 'testo\ncon invio'), null);
  assert.equal(pasteArgs('sess1', 'testo\rcr'), null);
  assert.equal(pasteArgs('sess1', ''), null);
  assert.equal(pasteArgs('sess1', 'x'.repeat(5000)), null);
});
```

- [ ] **Step 2: Verifica FAIL** — `node --test tests/actions.test.js` → FAIL (pasteArgs undefined).
- [ ] **Step 3: Implementazione** — in `lib/tmux/actions.js` aggiungi prima di `module.exports`:

```js
const MAX_PASTE = 4096;

// Digita testo literal nella sessione, SENZA Invio: il '--' protegge testi
// che iniziano con '-'; i control char (incluso \r\n) sono rifiutati a monte
// così un paste non può mai submitare un prompt.
function pasteArgs(session, text) {
  if (typeof session !== 'string' || typeof text !== 'string') return null;
  if (!text || text.length > MAX_PASTE) return null;
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  return ['send-keys', '-t', `=${session}`, '-l', '--', text];
}

function pasteToSession(tmuxBin, session, text) {
  const args = pasteArgs(session, text);
  if (!args) return false;
  try { execFile(tmuxBin, args, () => {}); return true; }
  catch (_) { return false; }
}
```

e aggiorna l'export: `module.exports = { actionArgs, runAction, ACTIONS, pasteArgs, pasteToSession };`

- [ ] **Step 4: Verifica PASS** — `node --test tests/actions.test.js` → PASS; poi `npm test`.
- [ ] **Step 5: Commit** — `git add lib/tmux/actions.js tests/actions.test.js && git commit -m "feat(vps3): azione pastePath send-keys literal senza Invio"`

---

### Task 5: Route /api/files + hardening REST in server.js

**Files:**
- Create: `lib/files/routes.js`
- Modify: `lib/server.js`
- Modify: `package.json` (dep `multer`)
- Test: `tests/files-routes.test.js`

**Interfaces:**
- Consumes: `store` (task 3), `requireToken` (task 2), `pasteToSession` (task 4), `cfg.filesRoot/maxUpload` (task 1).
- Produces: `filesRoutes({cfg, sessionExists, paste}) -> express.Router` con `POST /upload` (multipart `session`+`file`), `GET /?session=`, `GET /download?session=&box=&name=`, `DELETE /?session=&box=&name=`. In `server.js`: router `/api` token-gated; `createServer()` ritorna in più `watcher` (il task 6 lo popola — qui è `null`).

- [ ] **Step 1: Installa multer** — `npm install multer@^2.0.0 --save` (verifica: `grep multer package.json`).

- [ ] **Step 2: Test fallente** — `tests/files-routes.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { filesRoutes } = require('../lib/files/routes.js');
const store = require('../lib/files/store.js');

function setup(t, { maxUpload = 1024 * 1024 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncroutes-'));
  const pasted = [];
  const app = express();
  app.use('/api/files', filesRoutes({
    cfg: { filesRoot: root, maxUpload },
    sessionExists: (s) => s === 'sess1',
    paste: (s, text) => { pasted.push([s, text]); return true; },
  }));
  return new Promise((res) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      t.after(() => srv.close());
      res({ root, pasted, base: `http://127.0.0.1:${srv.address().port}/api/files` });
    });
  });
}

function form(name, content) {
  const fd = new FormData();
  fd.append('session', 'sess1');
  fd.append('file', new Blob([content]), name);
  return fd;
}

test('upload: salva in inbox, incolla il path, 404 per sessione ignota', async (t) => {
  const { root, pasted, base } = await setup(t);
  const r = await fetch(`${base}/upload`, { method: 'POST', body: form('doc.txt', 'ciao') });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.name.endsWith('_doc.txt'));
  assert.equal(fs.readFileSync(j.path, 'utf8'), 'ciao');
  assert.equal(j.pasted, true);
  assert.deepEqual(pasted[0], ['sess1', j.path]);

  const fd = form('doc.txt', 'x');
  fd.set('session', 'ghost');
  assert.equal((await fetch(`${base}/upload`, { method: 'POST', body: fd })).status, 404);
});

test('upload: oltre il limite -> 413', async (t) => {
  const { base } = await setup(t, { maxUpload: 10 });
  const r = await fetch(`${base}/upload`, { method: 'POST', body: form('big.bin', 'x'.repeat(100)) });
  assert.equal(r.status, 413);
});

test('list/download/delete con guardie', async (t) => {
  const { root, base } = await setup(t);
  const dir = store.ensureBox(root, 'sess1', 'outbox');
  fs.writeFileSync(path.join(dir, 'out.txt'), 'deliverable');

  const list = await (await fetch(`${base}/?session=sess1`)).json();
  assert.equal(list.outbox[0].name, 'out.txt');
  assert.deepEqual(list.inbox, []);
  assert.equal((await fetch(`${base}/?session=../evil`)).status, 400);

  const dl = await fetch(`${base}/download?session=sess1&box=outbox&name=out.txt`);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'deliverable');
  assert.equal((await fetch(`${base}/download?session=sess1&box=outbox&name=../secret`)).status, 404);

  assert.equal((await fetch(`${base}/?session=sess1&box=outbox&name=out.txt`, { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dir, 'out.txt')));
  assert.equal((await fetch(`${base}/?session=sess1&box=outbox&name=out.txt`, { method: 'DELETE' })).status, 404);
});
```

- [ ] **Step 3: Verifica FAIL** — `node --test tests/files-routes.test.js` → FAIL (module not found).
- [ ] **Step 4: Implementazione routes** — `lib/files/routes.js`:

```js
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
    upload.single('file')(req, res, (err) => {
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
      const pasted = paste(session, saved.path);
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
```

- [ ] **Step 5: Verifica PASS route** — `node --test tests/files-routes.test.js` → PASS.
- [ ] **Step 6: Wiring in server.js** — sostituisci in `lib/server.js` il blocco `const app = express(); … app.get('*', …)` con:

```js
  const app = express();
  const distDir = path.join(__dirname, '..', 'frontend', 'dist');
  // no-store on everything (HTML+assets+API): this is a local, token-adjacent tool.
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // Tutte le /api dietro Bearer: sul loopback il gate vero è il tunnel,
  // ma il token chiude anche altri processi locali della stessa macchina.
  const api = express.Router();
  api.use(requireToken(token));
  api.get('/sessions', async (_req, res) => {
    try { res.json({ sessions: await listSessions(cfg.tmuxBin) }); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  api.get('/config', (_req, res) => res.json({ readonlyDefault: cfg.readonlyDefault }));
  api.use('/files', filesRoutes({
    cfg,
    sessionExists: (name) => sessionExists(cfg.tmuxBin, name),
    paste: (session, text) => pasteToSession(cfg.tmuxBin, session, text),
  }));
  app.use('/api', api);

  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
```

con questi import in testa al file (aggiorna quelli esistenti):

```js
const { runAction, pasteToSession } = require('./tmux/actions.js');
const { requireToken } = require('./auth/middleware.js');
const { filesRoutes } = require('./files/routes.js');
```

e cambia il `return` di `createServer` in `return { app, server, wss, cfg, token, watcher: null };`

- [ ] **Step 7: Test integrazione token-gate** — append a `tests/rest-auth.test.js`:

```js
test('createServer: /api/* gated, static libero', async (t) => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createServer } = require('../lib/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsrv-'));
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'),
    filesRoot: path.join(dir, 'files'),
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  assert.equal((await fetch(`${base}/api/files?session=x`)).status, 401);
  const ok = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
});
```

- [ ] **Step 8: Verifica PASS completa** — `npm test` → tutto verde (i 18 v0.4 + i nuovi).
- [ ] **Step 9: Commit** — `git add lib/files/routes.js lib/server.js tests/ package.json package-lock.json && git commit -m "feat(vps3): route /api/files e hardening Bearer su tutte le REST"`

---

### Task 6: Watcher outbox + push WS + summary in /api/sessions

**Files:**
- Create: `lib/files/watcher.js`
- Modify: `lib/ws/bridge.js` (hook `onAttach`)
- Modify: `lib/server.js`
- Test: `tests/watcher.test.js`

**Interfaces:**
- Consumes: `listBox` (task 3).
- Produces: `createOutboxWatcher({root, pollMs?, debounceMs?})` → `{ on(event, fn), getSummary() -> {session:{count,latest}}, close() }`; evento `'change' (session, files)`. In `bridge.js`: nuova dep opzionale `onAttach(session, ws)` chiamata a handshake riuscito. Frame WS server→client: `{type:'files', session, files:[{name,size,mtime}]}` (il task 9 lo consuma).

- [ ] **Step 1: Test fallente** — `tests/watcher.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOutboxWatcher } = require('../lib/files/watcher.js');

function waitFor(fn, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(poll, 50);
    })();
  });
}

test('watcher: rileva nuovo file in outbox e aggiorna summary', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncwatch-'));
  fs.mkdirSync(path.join(root, 'sess1', 'outbox'), { recursive: true });
  const w = createOutboxWatcher({ root, pollMs: 100, debounceMs: 50 });
  t.after(() => w.close());
  const events = [];
  w.on('change', (session, files) => events.push({ session, files }));

  fs.writeFileSync(path.join(root, 'sess1', 'outbox', 'report.md'), 'x');
  await waitFor(() => events.some((e) => e.session === 'sess1' && e.files.some((f) => f.name === 'report.md')));
  assert.equal(w.getSummary().sess1.count, 1);
  assert.ok(w.getSummary().sess1.latest > 0);
});

test('watcher: root inesistente non esplode, close idempotente', () => {
  const w = createOutboxWatcher({ root: '/nonexiste/nc', pollMs: 100 });
  assert.deepEqual(w.getSummary(), {});
  w.close(); w.close();
});
```

- [ ] **Step 2: Verifica FAIL** — `node --test tests/watcher.test.js` → FAIL.
- [ ] **Step 3: Implementazione** — `lib/files/watcher.js`:

```js
'use strict';
// Osserva <root>/<sessione>/outbox per tutte le sessioni presenti su disco.
// fs.watch dove disponibile (con debounce); il polling periodico è la rete
// di sicurezza che copre anche i filesystem dove fs.watch non funziona.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { listBox } = require('./store.js');

function createOutboxWatcher({ root, pollMs = 5000, debounceMs = 300 }) {
  const em = new EventEmitter();
  const watchers = new Map();
  const timers = new Map();
  const summary = {};
  let closed = false;

  function rescan(session) {
    if (closed) return;
    const files = listBox(root, session, 'outbox') || [];
    const snap = { count: files.length, latest: files.length ? files[0].mtime : 0 };
    const prev = summary[session];
    summary[session] = snap;
    if (!prev || prev.count !== snap.count || prev.latest !== snap.latest) {
      em.emit('change', session, files);
    }
  }

  function bump(session) {
    clearTimeout(timers.get(session));
    timers.set(session, setTimeout(() => rescan(session), debounceMs));
  }

  function ensureWatch(session) {
    if (watchers.has(session)) return;
    try {
      const w = fs.watch(path.join(root, session, 'outbox'), () => bump(session));
      w.on('error', () => { try { w.close(); } catch (_) {} watchers.delete(session); });
      watchers.set(session, w);
    } catch (_) { /* il polling copre */ }
  }

  function scanAll() {
    if (closed) return;
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (_) { return; }
    for (const session of names) { ensureWatch(session); rescan(session); }
  }

  scanAll();
  const timer = setInterval(scanAll, pollMs);
  if (timer.unref) timer.unref();

  return {
    on: (ev, fn) => em.on(ev, fn),
    getSummary: () => ({ ...summary }),
    close: () => {
      closed = true;
      clearInterval(timer);
      for (const t of timers.values()) clearTimeout(t);
      for (const w of watchers.values()) { try { w.close(); } catch (_) {} }
      watchers.clear();
    },
  };
}

module.exports = { createOutboxWatcher };
```

- [ ] **Step 4: Verifica PASS** — `node --test tests/watcher.test.js` → PASS.
- [ ] **Step 5: Hook onAttach nel bridge** — in `lib/ws/bridge.js`: nella destrutturazione delle deps aggiungi `onAttach = () => {}`; subito dopo `session = msg.session;` aggiungi `onAttach(session, ws);`
- [ ] **Step 6: Wiring server.js** — in `lib/server.js` dentro `createServer`:
  - dopo `const token = …` aggiungi:

```js
  const watcher = createOutboxWatcher({ root: cfg.filesRoot });
  const attachedWs = new Map(); // ws -> session (per il push dei frame files)
```

  - in `api.get('/sessions', …)` arricchisci la risposta:

```js
  api.get('/sessions', async (_req, res) => {
    try {
      const sessions = await listSessions(cfg.tmuxBin);
      const sum = watcher.getSummary();
      res.json({ sessions: sessions.map((s) => ({ ...s, outbox: sum[s.name] || { count: 0, latest: 0 } })) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
```

  - nel blocco `wss.on('connection', …)` aggiungi la dep e la pulizia:

```js
      onAttach: (sess) => attachedWs.set(ws, sess),
```
(dentro le deps di `bindWs`) e dopo il `bindWs(…)`: `ws.on('close', () => attachedWs.delete(ws));`

  - dopo il blocco `wss.on('connection', …)` aggiungi:

```js
  watcher.on('change', (session, files) => {
    for (const [client, sess] of attachedWs) {
      if (sess === session && client.readyState === 1) {
        try { client.send(JSON.stringify({ type: 'files', session, files })); } catch (_) {}
      }
    }
  });
```

  - import in testa: `const { createOutboxWatcher } = require('./files/watcher.js');` e `return { app, server, wss, cfg, token, watcher };`
  - in `start()`: chiudi il watcher quando il server chiude: `server.on('close', () => watcher.close());` — per farlo, `start()` deve destrutturare anche `watcher` da `createServer(opts)`.
- [ ] **Step 7: Verifica PASS completa** — `npm test` → tutto verde.
- [ ] **Step 8: Commit** — `git add lib/files/watcher.js lib/ws/bridge.js lib/server.js tests/watcher.test.js && git commit -m "feat(vps3): watcher outbox, push WS files e summary in /api/sessions"`

---

### Task 7: Proxy STT /api/voice/transcribe → mcp-voice

**Files:**
- Create: `lib/voice/transcribe.js`
- Modify: `lib/server.js`
- Test: `tests/voice.test.js`

**Interfaces:**
- Consumes: `cfg.voiceUrl/voiceToken/voiceTokenFile` (task 1).
- Produces: `transcribe(cfg, audioBuffer, {language?, fetchImpl?}) -> Promise<{text,…}>` (throw con `.status` su errore); endpoint `POST /api/voice/transcribe` body raw audio → `{text}` | `{error}` (429/502/400). Il task 10 lo consuma dal frontend. Upstream reale: `POST {voiceUrl}/v1/audio/transcriptions` JSON `{file:<base64>, language}` con `Authorization: Bearer <token da /opt/mcp-voice/state/http.token>`.

- [ ] **Step 1: Test fallente** — `tests/voice.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcribe, loadVoiceToken } = require('../lib/voice/transcribe.js');

function cfgWithToken(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvoice-'));
  const file = path.join(dir, 'http.token');
  fs.writeFileSync(file, 'voice_test\n');
  return { voiceUrl: 'http://127.0.0.1:9', voiceToken: '', voiceTokenFile: file };
}

test('loadVoiceToken: env vince, poi file, poi null', (t) => {
  const cfg = cfgWithToken(t);
  assert.equal(loadVoiceToken(cfg), 'voice_test');
  assert.equal(loadVoiceToken({ ...cfg, voiceToken: 'dalla-env' }), 'dalla-env');
  assert.equal(loadVoiceToken({ voiceToken: '', voiceTokenFile: '/manca' }), null);
});

test('transcribe: successo con upstream mock', async (t) => {
  const cfg = cfgWithToken(t);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ text: 'ciao mondo', provider: 'whisper-local' }) };
  };
  const out = await transcribe(cfg, Buffer.from('AUDIO'), { language: 'it', fetchImpl });
  assert.equal(out.text, 'ciao mondo');
  assert.ok(calls[0].url.endsWith('/v1/audio/transcriptions'));
  assert.equal(calls[0].opts.headers.authorization, 'Bearer voice_test');
  assert.equal(JSON.parse(calls[0].opts.body).file, Buffer.from('AUDIO').toString('base64'));
});

test('transcribe: errori con status', async (t) => {
  const cfg = cfgWithToken(t);
  await assert.rejects(() => transcribe(cfg, Buffer.alloc(0)), (e) => e.status === 400);
  await assert.rejects(
    () => transcribe(cfg, Buffer.from('x'), { fetchImpl: async () => { throw new Error('conn'); } }),
    (e) => e.status === 502,
  );
  await assert.rejects(
    () => transcribe(cfg, Buffer.from('x'), { fetchImpl: async () => ({ ok: false, status: 500 }) }),
    (e) => e.status === 502,
  );
  await assert.rejects(
    () => transcribe({ voiceToken: '', voiceTokenFile: '/manca' }, Buffer.from('x')),
    (e) => e.status === 502,
  );
});
```

- [ ] **Step 2: Verifica FAIL** — `node --test tests/voice.test.js` → FAIL.
- [ ] **Step 3: Implementazione** — `lib/voice/transcribe.js`:

```js
'use strict';
// Proxy STT verso mcp-voice (127.0.0.1:3105). Il token voice resta lato
// server: il browser non lo vede mai. L'audio non lascia la macchina.
const fs = require('node:fs');

function loadVoiceToken(cfg) {
  if (cfg.voiceToken) return cfg.voiceToken;
  try {
    const t = fs.readFileSync(cfg.voiceTokenFile, 'utf8').trim();
    return t || null;
  } catch (_) { return null; }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function transcribe(cfg, audioBuffer, { language = 'it', fetchImpl = fetch } = {}) {
  if (!audioBuffer || audioBuffer.length === 0) throw httpError(400, 'audio mancante');
  const token = loadVoiceToken(cfg);
  if (!token) throw httpError(502, 'STT non disponibile (token voice mancante)');
  let r;
  try {
    r = await fetchImpl(`${cfg.voiceUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ file: audioBuffer.toString('base64'), language }),
    });
  } catch (_) { throw httpError(502, 'STT non disponibile (mcp-voice giù)'); }
  if (!r.ok) throw httpError(502, `STT errore upstream (${r.status})`);
  return r.json();
}

module.exports = { loadVoiceToken, transcribe };
```

- [ ] **Step 4: Endpoint in server.js** — nel router `api` (dopo il mount di `/files`):

```js
  api.post('/voice/transcribe',
    express.raw({ type: () => true, limit: '25mb' }),
    async (req, res) => {
      try {
        const out = await transcribe(cfg, req.body, { language: String(req.query.language || 'it') });
        res.json({ text: out.text || '' });
      } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
    });
```

import: `const { transcribe } = require('./voice/transcribe.js');`

- [ ] **Step 5: Verifica PASS** — `node --test tests/voice.test.js` → PASS; `npm test` completo.
- [ ] **Step 6: Commit** — `git add lib/voice/transcribe.js lib/server.js tests/voice.test.js && git commit -m "feat(vps3): proxy STT verso mcp-voice, token lato server"`

---

### Task 8: Frontend — apiFetch, Bearer su SessionList, badge outbox

**Files:**
- Create: `frontend/src/lib/api.js`
- Modify: `frontend/src/components/SessionList.jsx`
- Modify: `frontend/src/components/SessionList.css` (append)
- Modify: `frontend/src/App.jsx` (prop `token` a SessionList)

**Interfaces:**
- Produces: `apiFetch(path, token, opts?) -> Promise<Response>` (aggiunge `Authorization: Bearer`). Consumata dai task 9 e 10. Chiave localStorage `nc_seen_<sessione>` = ultimo `outbox.latest` visto (il task 9 la aggiorna alla lettura).

- [ ] **Step 1: api.js** — `frontend/src/lib/api.js`:

```js
// fetch con Bearer: tutte le /api del server lo richiedono.
export function apiFetch(path, token, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
}

export const seenKey = (session) => `nc_seen_${session}`;
```

- [ ] **Step 2: SessionList con token + badge** — sostituisci `frontend/src/components/SessionList.jsx` con:

```jsx
import { useEffect, useState } from 'react';
import { apiFetch, seenKey } from '../lib/api.js';
import './SessionList.css';

export default function SessionList({ onPick, token }) {
  const [sessions, setSessions] = useState([]);
  const [err, setErr] = useState(null);

  async function refresh() {
    try {
      const r = await apiFetch('/api/sessions', token);
      const j = await r.json();
      if (j.error) { setErr(j.error); setSessions([]); }
      else { setErr(null); setSessions(j.sessions || []); }
    } catch (e) { setErr(String(e)); }
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="nc-sessions">
      <header>tmux sessions <button onClick={refresh}>↻</button></header>
      {err && <div className="nc-err">{err}</div>}
      {sessions.map((s) => {
        const seen = Number(localStorage.getItem(seenKey(s.name)) || 0);
        const fresh = s.outbox && s.outbox.count > 0 && s.outbox.latest > seen;
        return (
          <button key={s.name} className="nc-session" onClick={() => onPick(s.name)}>
            <span className={s.attached ? 'dot on' : 'dot'} />
            <b>{s.name}</b><small>{s.windows}w</small>
            {fresh && <span className="nc-badge" title="nuovi file in outbox">{s.outbox.count}</span>}
          </button>
        );
      })}
      {!err && sessions.length === 0 && <div className="nc-empty">nessuna sessione viva</div>}
    </div>
  );
}
```

- [ ] **Step 3: CSS badge** — append a `frontend/src/components/SessionList.css`:

```css
.nc-badge {
  margin-left: auto;
  background: #2e7d32;
  color: #fff;
  border-radius: 10px;
  padding: 0 7px;
  font-size: 11px;
  line-height: 18px;
}
```

- [ ] **Step 4: App.jsx** — passa il token: `if (!session) return <SessionList onPick={setSession} token={token} />;`
- [ ] **Step 5: Build** — `cd frontend && npm install && npm run build && cd ..` → exit 0, nessun errore.
- [ ] **Step 6: Commit** — `git add frontend/src && git commit -m "feat(vps3): apiFetch Bearer, badge outbox in SessionList"`

---

### Task 9: Frontend — FilesPanel (inbox/outbox, upload/download/delete)

**Files:**
- Create: `frontend/src/components/FilesPanel.jsx`
- Create: `frontend/src/components/FilesPanel.css`
- Modify: `frontend/src/lib/ws-client.js` (frame `files`)
- Modify: `frontend/src/components/Terminal.jsx` (prop `onFiles`)
- Modify: `frontend/src/App.jsx` (toggle 📁, stato filesEvent)

**Interfaces:**
- Consumes: `apiFetch/seenKey` (task 8); REST `/api/files*` (task 5); frame WS `{type:'files', session, files}` (task 6).
- Produces: `<FilesPanel session token filesEvent onClose />`; `openTerminalSocket` accetta `onFiles(msg)`; `<Terminal onFiles={fn} …/>`.

- [ ] **Step 1: ws-client frame files** — in `frontend/src/lib/ws-client.js`: firma `openTerminalSocket({ session, token, cols, rows, readonly = false, onData, onExit, onFiles })` e nel ramo string di `onmessage` aggiungi dopo il check `exit`:

```js
      if (msg.type === 'files' && onFiles) onFiles(msg);
```

- [ ] **Step 2: Terminal pass-through** — in `frontend/src/components/Terminal.jsx`: aggiungi `onFiles` alle prop del componente, passala a `openTerminalSocket({ …, onFiles })`, e aggiungila all'array deps dello `useEffect`.

- [ ] **Step 3: FilesPanel** — `frontend/src/components/FilesPanel.jsx`:

```jsx
import { useEffect, useRef, useState } from 'react';
import { apiFetch, seenKey } from '../lib/api.js';
import './FilesPanel.css';

const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}M` : n > 1024 ? `${(n / 1024).toFixed(0)}K` : `${n}B`);

export default function FilesPanel({ session, token, filesEvent, onClose }) {
  const [box, setBox] = useState('outbox');
  const [data, setData] = useState({ inbox: [], outbox: [] });
  const [busy, setBusy] = useState('');
  const fileInput = useRef(null);

  async function refresh() {
    try {
      const r = await apiFetch(`/api/files?session=${encodeURIComponent(session)}`, token);
      const j = await r.json();
      if (j.error) { setBusy(j.error); return; }
      setData(j);
      const latest = j.outbox[0] ? j.outbox[0].mtime : 0;
      localStorage.setItem(seenKey(session), String(latest));
    } catch (e) { setBusy(String(e)); }
  }
  useEffect(() => { refresh(); }, [session]);
  useEffect(() => { if (filesEvent && filesEvent.session === session) refresh(); }, [filesEvent]);

  async function uploadFiles(files) {
    for (const f of files) {
      setBusy(`carico ${f.name}…`);
      const fd = new FormData();
      fd.append('session', session);
      fd.append('file', f);
      try {
        const r = await apiFetch('/api/files/upload', token, { method: 'POST', body: fd });
        const j = await r.json();
        setBusy(j.error ? `errore: ${j.error}` : '');
      } catch (e) { setBusy(String(e)); }
    }
    refresh();
  }

  async function download(name) {
    const r = await apiFetch(
      `/api/files/download?session=${encodeURIComponent(session)}&box=${box}&name=${encodeURIComponent(name)}`, token,
    );
    if (!r.ok) { setBusy('errore download'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  async function del(name) {
    await apiFetch(
      `/api/files?session=${encodeURIComponent(session)}&box=${box}&name=${encodeURIComponent(name)}`, token,
      { method: 'DELETE' },
    );
    refresh();
  }

  return (
    <div className="nc-files">
      <header>
        <b>{session}</b>
        <button onClick={onClose}>✕</button>
      </header>
      <nav>
        <button className={box === 'outbox' ? 'on' : ''} onClick={() => setBox('outbox')}>outbox</button>
        <button className={box === 'inbox' ? 'on' : ''} onClick={() => setBox('inbox')}>inbox</button>
        <button className="up" onClick={() => fileInput.current && fileInput.current.click()}>+ carica</button>
        <input
          type="file" multiple ref={fileInput} style={{ display: 'none' }}
          onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
        />
      </nav>
      {busy && <div className="nc-busy">{busy}</div>}
      <ul>
        {data[box].map((f) => (
          <li key={f.name}>
            <span className="name" onClick={() => download(f.name)}>{f.name}</span>
            <small>{fmtSize(f.size)}</small>
            <button onClick={() => del(f.name)} title="elimina">🗑</button>
          </li>
        ))}
        {data[box].length === 0 && <li className="empty">vuota</li>}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: CSS** — `frontend/src/components/FilesPanel.css`:

```css
.nc-files {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(340px, 90vw);
  background: var(--bg, #111511);
  border-left: 1px solid #2a332a;
  display: flex; flex-direction: column;
  z-index: 30;
}
.nc-files header { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; border-bottom: 1px solid #2a332a; }
.nc-files nav { display: flex; gap: 6px; padding: 8px 10px; }
.nc-files nav button { flex: 0 0 auto; padding: 4px 10px; border-radius: 6px; }
.nc-files nav button.on { background: #2e7d32; color: #fff; }
.nc-files nav .up { margin-left: auto; }
.nc-files ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.nc-files li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #1c231c; }
.nc-files li .name { flex: 1; cursor: pointer; overflow-wrap: anywhere; }
.nc-files li.empty { opacity: 0.5; justify-content: center; }
.nc-busy { padding: 4px 10px; font-size: 12px; color: #e0a030; }
```

- [ ] **Step 5: App.jsx wiring** — sostituisci `frontend/src/App.jsx` con:

```jsx
import { useRef, useState } from 'react';
import SessionList from './components/SessionList.jsx';
import Terminal from './components/Terminal.jsx';
import KeyBar from './components/KeyBar.jsx';
import FilesPanel from './components/FilesPanel.jsx';
import ComposerBar from './components/ComposerBar.jsx';
import './App.css';

// token from the fragment (#token=...), so it never lands in the server logs.
// Default sessionStorage (non-persistent); localStorage only when "remember" is set.
function readToken() {
  const hash = location.hash.replace(/^#/, '');
  const m = hash.match(/(?:^|&)token=([^&]+)/);
  if (m) {
    const t = decodeURIComponent(m[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
    return t;
  }
  return sessionStorage.getItem('nc_token') || localStorage.getItem('nc_token') || '';
}

export default function App() {
  const [session, setSession] = useState(null);
  const [token, setToken] = useState(readToken());
  const [remember, setRemember] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [filesEvent, setFilesEvent] = useState(null);
  const sendRef = useRef(() => {});
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const toggleCtrl = () => { ctrlRef.current = !ctrlRef.current; setCtrlArmed(ctrlRef.current); };

  if (!token) {
    return (
      <div className="nc-auth">
        <p>Incolla il token (stampato dal server):</p>
        <input onChange={(e) => setToken(e.target.value.trim())} placeholder="token" />
        <label>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> ricorda su questo device
        </label>
        <button onClick={() => { (remember ? localStorage : sessionStorage).setItem('nc_token', token); }}>ok</button>
      </div>
    );
  }
  if (!session) return <SessionList onPick={setSession} token={token} />;
  return (
    <div className="nc-app">
      <header className="nc-bar">
        <button onClick={() => setSession(null)}>‹ sessioni</button><b>{session}</b>
        <span className="nc-bar-right">
          <button onClick={() => setShowComposer((v) => !v)} title="composer">💬</button>
          <button onClick={() => setShowFiles((v) => !v)} title="file">📁</button>
        </span>
      </header>
      <div className="nc-termwrap">
        <Terminal session={session} token={token} readonly={false} sendRef={sendRef} actionRef={actionRef}
          ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed} onFiles={setFilesEvent} />
      </div>
      {showComposer && (
        <ComposerBar send={(seq) => sendRef.current(seq)} token={token} />
      )}
      <KeyBar send={(seq) => sendRef.current(seq)} action={(name) => actionRef.current(name)}
        ctrlArmed={ctrlArmed} onCtrl={toggleCtrl} />
      {showFiles && (
        <FilesPanel session={session} token={token} filesEvent={filesEvent} onClose={() => setShowFiles(false)} />
      )}
    </div>
  );
}
```

e append a `frontend/src/App.css`:

```css
.nc-bar-right { margin-left: auto; display: flex; gap: 4px; }
```

**NOTA:** questo App.jsx importa `ComposerBar` (task 10). Per buildare alla fine di QUESTO task, crea prima uno stub `frontend/src/components/ComposerBar.jsx`:

```jsx
export default function ComposerBar() { return null; }
```

(il task 10 lo sostituisce con l'implementazione vera; lo stub evita build rotte tra i due commit).

- [ ] **Step 6: Build** — `cd frontend && npm run build && cd ..` → exit 0.
- [ ] **Step 7: Commit** — `git add frontend/src && git commit -m "feat(vps3): FilesPanel inbox/outbox con push WS e download"`

---

### Task 10: Frontend — ComposerBar con voice (Web Speech + fallback whisper)

**Files:**
- Modify (sostituisci lo stub): `frontend/src/components/ComposerBar.jsx`
- Create: `frontend/src/components/ComposerBar.css`

**Interfaces:**
- Consumes: `send(seq)` (scrive byte grezzi nel PTY via sendRef), `apiFetch` (task 8), `POST /api/voice/transcribe` (task 7).
- Produces: `<ComposerBar send token />`.

- [ ] **Step 1: Implementazione** — `frontend/src/components/ComposerBar.jsx`:

```jsx
import { useRef, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import './ComposerBar.css';

// Composer: testo multilinea + microfono. Il testo va nel PTY come input
// literal; l'Invio è esplicito (bottone ➤). Voice: Web Speech se c'è,
// altrimenti registra e trascrive server-side (whisper locale, l'audio
// non lascia la VPS).
export default function ComposerBar({ send, token }) {
  const [text, setText] = useState('');
  const [rec, setRec] = useState(false);
  const [err, setErr] = useState('');
  const recognitionRef = useRef(null);
  const mediaRef = useRef(null);

  function submit() {
    const t = text.replace(/[\r\n]+$/, '');
    if (!t) return;
    send(t);
    send('\r');
    setText('');
  }

  function stopVoice() {
    if (recognitionRef.current) recognitionRef.current.stop();
    if (mediaRef.current) mediaRef.current.stop();
    setRec(false);
  }

  async function startVoice() {
    setErr('');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      const r = new SR();
      r.lang = 'it-IT'; r.continuous = false; r.interimResults = true;
      const base = text ? `${text} ` : '';
      r.onresult = (ev) => {
        const t = Array.from(ev.results).map((x) => x[0].transcript).join('');
        setText(base + t);
      };
      r.onend = () => setRec(false);
      r.onerror = (e) => { setErr(`voice: ${e.error || 'errore'}`); setRec(false); };
      recognitionRef.current = r;
      r.start();
      setRec(true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRec(false);
        setErr('trascrivo…');
        try {
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          const r = await apiFetch('/api/voice/transcribe', token, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: blob,
          });
          const j = await r.json();
          if (j.error) setErr(j.error);
          else { setErr(''); setText((prev) => prev + (prev ? ' ' : '') + (j.text || '')); }
        } catch (e) { setErr(String(e)); }
      };
      mediaRef.current = { stop: () => mr.state !== 'inactive' && mr.stop() };
      mr.start();
      setRec(true);
    } catch (_) {
      setErr('microfono non disponibile');
      setRec(false);
    }
  }

  return (
    <div className="nc-composer">
      {err && <div className="nc-composer-err">{err}</div>}
      <div className="nc-composer-row">
        <textarea
          rows={2} value={text} placeholder="scrivi o detta…"
          onChange={(e) => setText(e.target.value)}
        />
        <button className={rec ? 'mic on' : 'mic'} onClick={rec ? stopVoice : startVoice} title="voice">🎤</button>
        <button className="go" onClick={submit} title="invia">➤</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CSS** — `frontend/src/components/ComposerBar.css`:

```css
.nc-composer { border-top: 1px solid #2a332a; padding: 6px 8px; background: var(--bg, #111511); }
.nc-composer-row { display: flex; gap: 6px; align-items: flex-end; }
.nc-composer textarea {
  flex: 1; resize: none; background: #0a0e0a; color: #d8e0d8;
  border: 1px solid #2a332a; border-radius: 8px; padding: 6px 8px;
  font: 13px/1.4 inherit;
}
.nc-composer .mic.on { background: #b02a2a; color: #fff; }
.nc-composer-err { font-size: 12px; color: #e0a030; padding-bottom: 4px; }
```

- [ ] **Step 3: Build** — `cd frontend && npm run build && cd ..` → exit 0.
- [ ] **Step 4: Commit** — `git add frontend/src && git commit -m "feat(vps3): ComposerBar con voice WebSpeech + fallback whisper locale"`

---

### Task 11: Versione, unit systemd, deploy locale

**Files:**
- Modify: `package.json` (version)
- Create: `deploy/nexuscrew.service`
- Create: `~/.config/systemd/user/nexuscrew.service` (copia installata, fuori repo)

**Interfaces:**
- Produces: servizio `nexuscrew.service` attivo su `127.0.0.1:41777` al boot.

- [ ] **Step 1: Version bump** — in `package.json`: `"version": "0.5.0-vps3.1"`.
- [ ] **Step 2: Unit file** — `deploy/nexuscrew.service`:

```ini
[Unit]
Description=NexusCrew VPS3 — browser tmux client (127.0.0.1:41777, solo tunnel SSH/VPN)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/dag/Dev/20_ai-labs/nexuscrew
Environment=NEXUSCREW_PORT=41777
Environment=PATH=/home/dag/.local/bin:/home/dag/.nvm/versions/node/v24.10.0/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/dag/.nvm/versions/node/v24.10.0/bin/node bin/nexuscrew.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

- [ ] **Step 3: Build finale + suite** — `npm test && cd frontend && npm run build && cd ..` → tutto verde.
- [ ] **Step 4: Installa e avvia**:

```bash
cp deploy/nexuscrew.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now nexuscrew.service
systemctl --user status nexuscrew.service --no-pager | head -8
```

Expected: `active (running)`.

- [ ] **Step 5: Verifica porta e gate**:

```bash
ss -tlnp | grep 41777                                   # LISTEN solo su 127.0.0.1
TOKEN=$(cat ~/.nexuscrew/token)
curl -s http://127.0.0.1:41777/api/config               # -> {"error":"unauthorized"}
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:41777/api/config   # -> {"readonlyDefault":false}
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:41777/api/sessions | head -c 300  # lista flotta con campo outbox
```

- [ ] **Step 6: Commit** — `git add package.json deploy/ && git commit -m "feat(vps3): unit systemd, porta 41777, versione 0.5.0-vps3.1"`

---

### Task 12: Smoke end-to-end, convenzione flotta, push Forge

**Files:**
- Modify: `docs/CURRENT_STATE.md`
- Create (fuori repo): riga convenzione in `~/.claude/CLAUDE.md`

- [ ] **Step 1: Smoke file-exchange via curl** (senza browser):

```bash
TOKEN=$(cat ~/.nexuscrew/token)
BASE=http://127.0.0.1:41777
# scegli una sessione viva della flotta
S=$(curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/sessions | python3 -c "import json,sys; print(json.load(sys.stdin)['sessions'][0]['name'])")
# upload -> inbox + auto-paste nella sessione (senza Invio)
echo "smoke $(date +%s)" > /tmp/user/1000/nc-smoke.txt 2>/dev/null || echo "smoke" > "$HOME/nc-smoke.txt"
curl -s -H "Authorization: Bearer $TOKEN" -F "session=$S" -F "file=@$HOME/nc-smoke.txt" $BASE/api/files/upload
ls ~/NexusFiles/$S/inbox/                                # file timbrato presente
tmux capture-pane -p -t "=$S" | tail -3                  # path visibile nel prompt della sessione
# outbox -> lista + download
echo "deliverable di prova" > ~/NexusFiles/$S/outbox/prova.txt
sleep 6
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/files?session=$S" | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/files/download?session=$S&box=outbox&name=prova.txt"
```

Expected: upload 200 con `pasted:true`, path nel pane, outbox listata, download col contenuto.

- [ ] **Step 2: Smoke voice** (se mcp-voice ha un sample):

```bash
# genera 1s di silenzio wav e trascrivilo: deve rispondere 200 con testo (anche vuoto), NON 502
python3 - <<'EOF'
import struct, wave
w = wave.open('/tmp/nc-silence.wav', 'w')
w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(struct.pack('<8000h', *([0]*8000)))
w.close()
EOF
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/octet-stream" \
  --data-binary @/tmp/nc-silence.wav $BASE/api/voice/transcribe
```

- [ ] **Step 3: Convenzione flotta** — aggiungi a `~/.claude/CLAUDE.md`, in coda alla sezione MCP PRIMARI:

```markdown
## NEXUSCREW FILE EXCHANGE

Deliverable file per DAG (report, immagini, export): scrivi/copia il file in
`~/NexusFiles/<nome-sessione-tmux>/outbox/` — appare nella UI NexusCrew con badge.
I file che DAG ti manda arrivano in `~/NexusFiles/<nome-sessione-tmux>/inbox/`
(il path ti viene incollato nel prompt).
```

- [ ] **Step 4: Aggiorna docs/CURRENT_STATE.md** — sostituisci il contenuto con lo stato v0.5: linea `0.5.0-vps3.1` privata (branch `vps3-special`, no npm), feature (files, voice, Bearer, systemd 41777), esito smoke.
- [ ] **Step 5: Push Forge**:

```bash
git add docs/CURRENT_STATE.md && git commit -m "docs(vps3): stato v0.5 vps3-special dopo smoke"
git push -u forge vps3-special
```

- [ ] **Step 6: Verifica finale** — `npm test` verde, `systemctl --user is-active nexuscrew` → `active`, branch pushato (`git ls-remote forge vps3-special`).
