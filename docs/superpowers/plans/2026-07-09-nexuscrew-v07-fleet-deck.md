# NexusCrew v0.7 "Fleet Deck" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** griglia desktop multi-sessione stile Claude Code + logica fleet (celle on/off/engine/key/boot) nella UI + mobile restyle stile app Claude — NexusCrew come pannello unico della flotta.

**Architecture:** server Express+WS esistente (loopback, Bearer) esteso con modulo `lib/fleet/` (shell serializzato sul binario `fleet`, feature-detected con trust check) e lifecycle sessioni tmux guardato; frontend React/Vite esteso con griglia a colonne (flex, zero dipendenze nuove), sidebar unificata flotta+tmux, mobile restyle. Spec: `docs/superpowers/specs/2026-07-09-nexuscrew-v07-fleet-deck-design.md` (7 finding audit Codex integrati).

**Tech Stack:** Node ≥18 (CommonJS in `lib/`, `node --test`), Express, ws, tmux ≥3.4 (target `=name:`), React 18 + Vite (ESM in `frontend/src/`), xterm.

## Global Constraints

- ZERO nuove dipendenze npm (né runtime né frontend). Griglia = flex + DnD nativo.
- Tutte le nuove route sotto `/api` ereditano `requireToken` (Bearer timing-safe) — montare DENTRO il router `api` in `lib/server.js`.
- execFile SEMPRE con argomenti array, MAI stringhe shell.
- Target tmux SEMPRE exact-match `=name` (has-session/kill) o `=name:` (comandi pane/window) — tmux 3.4.
- Guardia kill INDIPENDENTE dal registry fleet: `/^cloud-/` sempre 409 (audit F2).
- NIENTE `cmd` libero nella create: solo `preset` allowlistato (audit F1).
- `fleet` disponibile solo se binario trusted + schema `kind:"ai-fleet"` (audit F3).
- Preview: max 240 char, strip ANSI/control, mai in log/errori (audit F7).
- Suite `node --test tests/` deve restare 0 fail; commit frequenti su `develop` (Forge), stile messaggi: `feat(fleet)|feat(grid)|feat(ui)|fix|docs|test`.
- Comandi fleet nei test SOLO contro fake fixture, MAI il binario reale (audit F5).
- File CSS: un `.css` per componente, import in testa al `.jsx` (pattern esistente).

## Assegnazione chunk (orchestrazione crew)

| Chunk | Worker | Task | Dipendenze |
|---|---|---|---|
| 0 | **Coordinator (Fable)** | Task 0 (`fleet status --json`, fuori repo) | — |
| A | **GLM key A** (server) | A1–A7 | Task 0 (solo A2+: il contratto JSON è nel piano, si lavora su fixture) |
| B | **GLM key P** (frontend desktop) | B1–B5 | B1/B2/B4 subito (modello puro + client); B3/B5 dopo gate A |
| C | **GLM key P** (mobile) | C1–C2 | gate B |
| D | **Coordinator** | D1 release chores + smoke VPS3 | gate A+B+C |

Gate per chunk: coordinator audita il diff + suite verde prima di sbloccare il chunk successivo. Mockup Claude Design/DesignSync: coordinator, prima di B3/B4 (solo estetica: il comportamento è già fissato qui).

---

### Task 0: `fleet status --json` (coordinator — file FUORI repo: `~/.local/bin/fleet`)

**Files:**
- Modify: `~/.local/bin/fleet` (righe 110–133 `cmd_status`, riga 149 dispatch)

**Interfaces:**
- Produces: output JSON su stdout per `fleet status --json`, contratto (audit F4):
  `{"schemaVersion":1,"kind":"ai-fleet","cells":[{"cell":str,"tmuxSession":str,"engine":str,"active":bool,"boot":bool,"tmux":bool,"rc":str,"key":str}]}`
  (`rc`/`key` stringa vuota quando non applicabili). La tabella umana resta il default.

- [ ] **Step 1: aggiungi `cmd_status_json` dopo `cmd_status` (riga ~133)**

```bash
cmd_status_json() {
  printf '{"schemaVersion":1,"kind":"ai-fleet","cells":['
  local first=1 cell u eng ac en tm ab eb rc key
  for cell in $AIFLEET_CELLS; do
    u="$(unit_of "$cell")"; eng="$(cell_engine "$cell")"
    ac="$(systemctl --user is-active "$u" 2>/dev/null)"
    en="$(systemctl --user is-enabled "$u" 2>/dev/null)"
    if /usr/bin/tmux has-session -t "=$(sess_of "$cell")" 2>/dev/null; then tm=true; else tm=false; fi
    [ "$ac" = active ] && ab=true || ab=false
    [ "$en" = enabled ] && eb=true || eb=false
    if [ "$eng" = native ]; then rc="$(cell_rc "$cell")"; else rc=""; fi
    case "$eng" in
      glm)   key="$(cell_glm_key "$cell")" ;;
      glm-a) key=A ;;
      glm-p) key=P ;;
      *)     key="" ;;
    esac
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"cell":"%s","tmuxSession":"%s","engine":"%s","active":%s,"boot":%s,"tmux":%s,"rc":"%s","key":"%s"}' \
      "$cell" "$(sess_of "$cell")" "$eng" "$ab" "$eb" "$tm" "$rc" "$key"
  done
  printf ']}\n'
}
```

- [ ] **Step 2: dispatch** — sostituisci la riga `status)  cmd_status ;;` con:

```bash
  status)
    case "${2:-}" in
      --json) cmd_status_json ;;
      "")     cmd_status ;;
      *) echo "fleet status: argomento sconosciuto '$2'" >&2; exit 2 ;;
    esac ;;
```

- [ ] **Step 3: verifica**

Run: `fleet status --json | python3 -m json.tool >/dev/null && echo JSON_OK && fleet status --json | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['kind']=='ai-fleet' and d['schemaVersion']==1 and len(d['cells'])==7; print('SCHEMA_OK')"`
Expected: `JSON_OK` + `SCHEMA_OK`. Poi `fleet status` (senza flag) → tabella invariata.

- [ ] **Step 4: copia il nuovo script anche in `tests/fixtures/` del repo** (serve ai task A come riferimento, NON viene eseguito nei test)

```bash
mkdir -p ~/Dev/20_ai-labs/nexuscrew/tests/fixtures
cp ~/.local/bin/fleet ~/Dev/20_ai-labs/nexuscrew/tests/fixtures/fleet-reference.sh
```

(commit incluso nel primo commit del chunk A)

---

### Task A1: fixture fake-fleet + `lib/fleet/exec.js` (coda serializzata + timeout)

**Files:**
- Create: `tests/fixtures/fake-fleet.sh` (eseguibile)
- Create: `lib/fleet/exec.js`
- Test: `tests/fleet-exec.test.js`

**Interfaces:**
- Produces: `createFleetExec(bin, {timeoutMs=15000}) -> { run(args: string[]): Promise<string> }` — esegue `execFile(bin, args)`, UNA alla volta (coda FIFO), risolve con stdout, rigetta con `Error` che include stderr; timeout → rigetta `Error('fleet timeout')`.

- [ ] **Step 1: scrivi la fixture `tests/fixtures/fake-fleet.sh`**

```bash
#!/bin/sh
# fake-fleet — simulatore per i test NexusCrew. Modalità via FAKE_FLEET_MODE:
#   ok (default) | invalid-json | wrong-kind | future-schema | slow | fail
case "${FAKE_FLEET_MODE:-ok}" in
  invalid-json)  echo 'not json at all'; exit 0 ;;
  wrong-kind)    echo '{"schemaVersion":1,"kind":"other","cells":[]}'; exit 0 ;;
  future-schema) echo '{"schemaVersion":99,"kind":"ai-fleet","cells":[]}'; exit 0 ;;
  slow)          sleep 5; echo '{}'; exit 0 ;;
  fail)          echo 'boom: cella non valida' >&2; exit 2 ;;
esac
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
{"schemaVersion":1,"kind":"ai-fleet","cells":[
 {"cell":"Dev","tmuxSession":"cloud-Dev","engine":"glm","active":true,"boot":true,"tmux":true,"rc":"","key":"A"},
 {"cell":"Trading","tmuxSession":"cloud-Trading","engine":"native","active":false,"boot":false,"tmux":false,"rc":"Cloud_Trading","key":""},
 {"cell":"SysAdmin","tmuxSession":"cloud-SysAdmin","engine":"native","active":true,"boot":true,"tmux":false,"rc":"Cloud_Sys_Admin","key":""}
]}
EOF
  exit 0
fi
# up/down/engine/boot: echo degli argomenti (i test verificano il passthrough)
echo "fake-fleet:$*"
```

Run: `chmod +x tests/fixtures/fake-fleet.sh`

- [ ] **Step 2: scrivi il test fallente `tests/fleet-exec.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createFleetExec } = require('../lib/fleet/exec.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-fleet.sh');

test('run: stdout risolto, argomenti passati', async () => {
  const fx = createFleetExec(FAKE);
  const out = await fx.run(['up', 'Dev', '--engine', 'glm']);
  assert.match(out, /fake-fleet:up Dev --engine glm/);
});

test('run: errori includono stderr', async () => {
  const fx = createFleetExec(FAKE);
  process.env.FAKE_FLEET_MODE = 'fail';
  await assert.rejects(() => fx.run(['up', 'Nope']), /boom: cella non valida/);
  delete process.env.FAKE_FLEET_MODE;
});

test('run: serializzato FIFO (mai due in volo)', async () => {
  const fx = createFleetExec(FAKE);
  const order = [];
  await Promise.all([
    fx.run(['a']).then(() => order.push('a')),
    fx.run(['b']).then(() => order.push('b')),
    fx.run(['c']).then(() => order.push('c')),
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('run: timeout', async () => {
  const fx = createFleetExec(FAKE, { timeoutMs: 300 });
  process.env.FAKE_FLEET_MODE = 'slow';
  await assert.rejects(() => fx.run(['status']), /fleet timeout/);
  delete process.env.FAKE_FLEET_MODE;
});
```

- [ ] **Step 3: verifica che fallisca** — Run: `node --test tests/fleet-exec.test.js` → Expected: FAIL `Cannot find module '../lib/fleet/exec.js'`

- [ ] **Step 4: implementa `lib/fleet/exec.js`**

```js
'use strict';
const { execFile } = require('node:child_process');

// Esecutore serializzato del binario fleet: UNA invocazione alla volta
// (fleet tocca systemd/tmux reali: due comandi concorrenti = stato incoerente),
// timeout duro, stderr propagato nell'errore. Argomenti SEMPRE array (no shell).
function createFleetExec(bin, { timeoutMs = 15000 } = {}) {
  let chain = Promise.resolve();

  function exec(args) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
        if (err) {
          if (err.killed || err.signal === 'SIGKILL') return reject(new Error('fleet timeout'));
          return reject(new Error(`fleet ${args.join(' ')} failed: ${String(stderr || err.message).trim()}`));
        }
        resolve(String(stdout));
      });
    });
  }

  function run(args) {
    const next = chain.then(() => exec(args));
    // la coda non si spezza sugli errori (catch), ma il chiamante li vede
    chain = next.catch(() => {});
    return next;
  }

  return { run };
}

module.exports = { createFleetExec };
```

- [ ] **Step 5: verifica che passi** — Run: `node --test tests/fleet-exec.test.js` → Expected: 4 pass / 0 fail

- [ ] **Step 6: commit**

```bash
git add tests/fixtures/fake-fleet.sh tests/fixtures/fleet-reference.sh tests/fleet-exec.test.js lib/fleet/exec.js
git commit -m "feat(fleet): executor serializzato con timeout + fixture fake-fleet"
```

---

### Task A2: `lib/fleet/index.js` — detect trusted, status con cache e degraded, comandi

**Files:**
- Create: `lib/fleet/index.js`
- Modify: `lib/config.js` (baseDefaults + envOverrides)
- Test: `tests/fleet.test.js`

**Interfaces:**
- Consumes: `createFleetExec` (A1).
- Produces: `createFleet(cfg) -> Promise<Fleet>` dove `Fleet =`
  - `available: boolean`
  - `status(): Promise<{available:true, cells:[{cell,tmuxSession,engine,active,boot,tmux,rc,key,degraded:boolean}]}>` (cache 2s)
  - `up(cell,{engine,boot})`, `down(cell,{boot})`, `engine(cell,eng)`, `boot(cell,enabled)`: `Promise<{ok:true}>`, errori con `.status` http-like (400 input invalido, 502 fleet fallito)
  - `isCellSession(name): boolean` — true se `name` è la tmuxSession di una cella nota (per la guardia kill, A4)
- Config nuova: `fleetEnabled` (default `true`, env `NEXUSCREW_FLEET=0` → false), `fleetBin` (default `path.join(os.homedir(),'.local','bin','fleet')`, env `NEXUSCREW_FLEET_BIN`).

- [ ] **Step 1: aggiungi la config** — in `lib/config.js` `baseDefaults()` aggiungi dopo `voiceTokenFile: null,`:

```js
    fleetEnabled: true,
    fleetBin: path.join(os.homedir(), '.local', 'bin', 'fleet'),
```

e in `envOverrides()` prima del `return e;`:

```js
  if (process.env.NEXUSCREW_FLEET) e.fleetEnabled = process.env.NEXUSCREW_FLEET !== '0';
  if (process.env.NEXUSCREW_FLEET_BIN) e.fleetBin = process.env.NEXUSCREW_FLEET_BIN;
```

- [ ] **Step 2: scrivi il test fallente `tests/fleet.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFleet } = require('../lib/fleet/index.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-fleet.sh');
const cfg = (over = {}) => ({ fleetEnabled: true, fleetBin: FAKE, ...over });

test('detect: disabled / binario assente / symlink / world-writable / schema estraneo → unavailable', async (t) => {
  assert.equal((await createFleet(cfg({ fleetEnabled: false }))).available, false);
  assert.equal((await createFleet(cfg({ fleetBin: '/nonexistent/fleet' }))).available, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfleet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const link = path.join(dir, 'fleet-link');
  fs.symlinkSync(FAKE, link);
  assert.equal((await createFleet(cfg({ fleetBin: link }))).available, false, 'symlink rifiutato');

  const ww = path.join(dir, 'fleet-ww');
  fs.copyFileSync(FAKE, ww); fs.chmodSync(ww, 0o777);
  assert.equal((await createFleet(cfg({ fleetBin: ww }))).available, false, 'world-writable rifiutato');

  for (const mode of ['invalid-json', 'wrong-kind', 'future-schema']) {
    process.env.FAKE_FLEET_MODE = mode;
    assert.equal((await createFleet(cfg())).available, false, `schema ${mode} rifiutato`);
  }
  delete process.env.FAKE_FLEET_MODE;
});

test('status: celle con degraded calcolato + cache', async () => {
  const fleet = await createFleet(cfg());
  assert.equal(fleet.available, true);
  const st = await fleet.status();
  const by = Object.fromEntries(st.cells.map((c) => [c.cell, c]));
  assert.equal(by.Dev.degraded, false);            // active+tmux
  assert.equal(by.Trading.degraded, false);        // inactive+no tmux
  assert.equal(by.SysAdmin.degraded, true);        // active MA tmux morto
  assert.equal(fleet.isCellSession('cloud-Dev'), true);
  assert.equal(fleet.isCellSession('worker-1'), false);
});

test('comandi: passthrough argomenti + validazioni', async () => {
  const fleet = await createFleet(cfg());
  await fleet.up('Dev', { engine: 'glm-a', boot: true });   // ok
  await fleet.down('Dev', {});                              // ok
  await fleet.engine('Dev', 'native');                      // ok
  await fleet.boot('Dev', false);                           // ok
  await assert.rejects(() => fleet.up('NotACell', {}), (e) => e.status === 400);
  await assert.rejects(() => fleet.engine('Dev', 'rm -rf'), (e) => e.status === 400);
});
```

- [ ] **Step 3: verifica FAIL** — Run: `node --test tests/fleet.test.js` → Expected: FAIL (modulo assente)

- [ ] **Step 4: implementa `lib/fleet/index.js`**

```js
'use strict';
const fs = require('node:fs');
const { createFleetExec } = require('./exec.js');

const ENGINES = new Set(['native', 'glm', 'glm-a', 'glm-p', 'ollama', 'ollama-cloud', 'codex-vl']);
const STATUS_TTL_MS = 2000;

// Trust boundary sul binario (audit F3): regular file, NO symlink,
// eseguibile dall'owner, NON world-writable.
function binTrusted(bin) {
  try {
    const st = fs.lstatSync(bin);
    if (!st.isFile()) return false;                 // lstat: un symlink NON è file
    if (!(st.mode & 0o100)) return false;           // owner-executable
    if (st.mode & 0o002) return false;              // world-writable
    return true;
  } catch (_) { return false; }
}

function parseStatus(raw) {
  let d;
  try { d = JSON.parse(raw); } catch (_) { return null; }
  if (!d || d.kind !== 'ai-fleet' || d.schemaVersion !== 1 || !Array.isArray(d.cells)) return null;
  return d.cells.map((c) => ({
    cell: String(c.cell || ''), tmuxSession: String(c.tmuxSession || ''),
    engine: String(c.engine || ''), active: c.active === true, boot: c.boot === true,
    tmux: c.tmux === true, rc: String(c.rc || ''), key: String(c.key || ''),
    degraded: (c.active === true) !== (c.tmux === true),   // unit e tmux in disaccordo
  })).filter((c) => c.cell && c.tmuxSession);
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

async function createFleet(cfg = {}) {
  const off = { available: false, isCellSession: () => false };
  if (cfg.fleetEnabled === false) return off;
  const bin = cfg.fleetBin;
  if (!bin || !binTrusted(bin)) return off;

  const fx = createFleetExec(bin);
  let cells;
  try { cells = parseStatus(await fx.run(['status', '--json'])); } catch (_) { return off; }
  if (!cells) return off;                            // schema estraneo → feature spenta

  let cache = { at: Date.now(), cells };
  const sessions = () => new Set(cache.cells.map((c) => c.tmuxSession));

  async function status() {
    if (Date.now() - cache.at > STATUS_TTL_MS) {
      const fresh = parseStatus(await fx.run(['status', '--json']));
      if (fresh) cache = { at: Date.now(), cells: fresh };
    }
    return { available: true, cells: cache.cells };
  }

  function assertCell(cell) {
    if (!cache.cells.some((c) => c.cell === cell)) throw httpError(400, `cella sconosciuta: ${cell}`);
  }
  function assertEngine(eng) {
    if (!ENGINES.has(eng)) throw httpError(400, `engine non valido: ${eng}`);
  }
  async function cmd(args) {
    try { await fx.run(args); } catch (e) { throw httpError(502, e.message); }
    cache = { at: 0, cells: cache.cells };           // invalida: il prossimo status rilegge
    return { ok: true };
  }

  return {
    available: true,
    status,
    up: (cell, { engine, boot } = {}) => {
      assertCell(cell); if (engine != null) assertEngine(engine);
      const a = ['up', cell]; if (engine) a.push('--engine', engine); if (boot) a.push('--boot');
      return cmd(a);
    },
    down: (cell, { boot } = {}) => {
      assertCell(cell);
      const a = ['down', cell]; if (boot) a.push('--boot');
      return cmd(a);
    },
    engine: (cell, eng) => { assertCell(cell); assertEngine(eng); return cmd(['engine', cell, eng]); },
    boot: (cell, enabled) => { assertCell(cell); return cmd([enabled ? 'boot' : 'noboot', cell]); },
    isCellSession: (name) => sessions().has(name),
  };
}

module.exports = { createFleet, parseStatus, binTrusted };
```

- [ ] **Step 5: verifica PASS** — Run: `node --test tests/fleet.test.js tests/config.test.js` → Expected: tutti pass (config.test.js resta verde con le chiavi nuove)

- [ ] **Step 6: commit**

```bash
git add lib/fleet/index.js lib/config.js tests/fleet.test.js
git commit -m "feat(fleet): createFleet — trust check binario, status --json con cache e degraded, comandi validati"
```

---

### Task A3: route `/api/fleet/*` in server.js

**Files:**
- Create: `lib/fleet/routes.js`
- Modify: `lib/server.js` (require + `createFleet` in `createServer`, mount router, estendi `/api/config`)
- Test: `tests/fleet-routes.test.js`

**Interfaces:**
- Consumes: `createFleet(cfg)` (A2).
- Produces: router Express montato su `api.use('/fleet', …)`:
  - `GET /api/fleet/status` → 200 `{available:false}` oppure `{available:true, cells:[…]}`
  - `POST /api/fleet/up|down|engine|boot` (JSON body) → 200 `{ok:true}` | 400 | 404 (fleet unavailable) | 502
- `createServer` diventa **async** (deve attendere `createFleet`)? NO — per non toccare i consumer: `createFleet` parte in `createServer` e il router attende la promise internamente (`fleetP`).

- [ ] **Step 1: test fallente `tests/fleet-routes.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-fleet.sh');

function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncflr-'));
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'), ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token });
  }));
}
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('fleet unavailable: status {available:false}, comandi 404', async (t) => {
  const { base, token } = await boot(t, { fleetEnabled: false });
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.deepEqual(st, { available: false });
  const up = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev' }) });
  assert.equal(up.status, 404);
});

test('fleet available: status celle, up ok, cella ignota 400, Bearer richiesto', async (t) => {
  const { base, token } = await boot(t, { fleetBin: FAKE });
  assert.equal((await fetch(`${base}/api/fleet/status`)).status, 401);
  const st = await (await fetch(`${base}/api/fleet/status`, { headers: H(token) })).json();
  assert.equal(st.available, true);
  assert.equal(st.cells.length, 3);
  const up = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Dev', engine: 'glm-a', boot: true }) });
  assert.deepEqual(await up.json(), { ok: true });
  const bad = await fetch(`${base}/api/fleet/up`, { method: 'POST', headers: H(token), body: JSON.stringify({ cell: 'Nope' }) });
  assert.equal(bad.status, 400);
});
```

- [ ] **Step 2: FAIL** — Run: `node --test tests/fleet-routes.test.js` → Expected: FAIL (404 su /api/fleet/status con token)

- [ ] **Step 3: implementa `lib/fleet/routes.js`**

```js
'use strict';
const express = require('express');

// Router /api/fleet — fleetP è una Promise<Fleet> (createServer non diventa
// async): ogni handler attende la resolve; unavailable → 404 sui comandi.
function fleetRoutes(fleetP) {
  const r = express.Router();
  r.use(express.json({ limit: '4kb' }));

  const guard = (fn) => async (req, res) => {
    try {
      const fleet = await fleetP;
      if (!fleet.available) return res.status(404).json({ error: 'fleet non disponibile' });
      res.json(await fn(fleet, req.body || {}));
    } catch (e) {
      res.status(e.status || 500).json({ error: String(e.message || e) });
    }
  };

  r.get('/status', async (_req, res) => {
    try {
      const fleet = await fleetP;
      if (!fleet.available) return res.json({ available: false });
      res.json(await fleet.status());
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
  r.post('/up', guard((f, b) => f.up(String(b.cell || ''), { engine: b.engine, boot: !!b.boot })));
  r.post('/down', guard((f, b) => f.down(String(b.cell || ''), { boot: !!b.boot })));
  r.post('/engine', guard((f, b) => f.engine(String(b.cell || ''), String(b.engine || ''))));
  r.post('/boot', guard((f, b) => f.boot(String(b.cell || ''), b.enabled === true)));
  return r;
}

module.exports = { fleetRoutes };
```

- [ ] **Step 4: wire in `lib/server.js`** — dopo `const { transcribe } = …` aggiungi:

```js
const { createFleet } = require('./fleet/index.js');
const { fleetRoutes } = require('./fleet/routes.js');
```

dentro `createServer`, dopo `const attachedWs = new Map();`:

```js
  const fleetP = createFleet(cfg);                  // async, non blocca il boot
```

dopo `api.use('/files', …)`:

```js
  api.use('/fleet', fleetRoutes(fleetP));
```

e nel return finale aggiungi `fleetP`: `return { app, server, wss, cfg, token, watcher, fleetP };`

- [ ] **Step 5: PASS** — Run: `node --test tests/fleet-routes.test.js tests/rest-auth.test.js` → Expected: tutti pass

- [ ] **Step 6: commit**

```bash
git add lib/fleet/routes.js lib/server.js tests/fleet-routes.test.js
git commit -m "feat(fleet): route /api/fleet (status/up/down/engine/boot) dietro Bearer"
```

---

### Task A4: lifecycle sessioni — create con preset allowlist, kill con denylist

**Files:**
- Create: `lib/tmux/lifecycle.js`
- Test: `tests/lifecycle.test.js`

**Interfaces:**
- Produces:
  - `PRESETS`: `{ shell: null, claude: ['claude'], 'codex-vl': ['codex-vl'], pi: ['pi'] }` (estendibile via `cfg.sessionPresets`: mappa `name -> string[]`, validata)
  - `validSessionName(name): boolean` — `/^[\w.-]{1,64}$/` e NON inizia con `-`
  - `resolveCwd(cwd, home): string|null` — `fs.realpathSync` di entrambi; null se non-dir o fuori da home (audit F1)
  - `isProtectedSession(name, isCellSession): boolean` — `/^cloud-/i` SEMPRE, più `isCellSession(name)` (audit F2)
  - `createSession(tmuxBin, {name, cwd, preset}, {home, presets}): Promise<void>` (rigetta `Error` con `.status`)
  - `killSession(tmuxBin, name): Promise<boolean>` — `kill-session -t =name`, false se inesistente

- [ ] **Step 1: test fallente `tests/lifecycle.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validSessionName, resolveCwd, isProtectedSession, buildCreateArgs,
} = require('../lib/tmux/lifecycle.js');

test('validSessionName', () => {
  assert.equal(validSessionName('worker-glm.1'), true);
  assert.equal(validSessionName('-flag'), false);
  assert.equal(validSessionName('a b'), false);
  assert.equal(validSessionName('x'.repeat(65)), false);
  assert.equal(validSessionName(''), false);
});

test('resolveCwd: dentro home ok, symlink-escape e fuori-home rifiutati', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nchome-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncout-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const inside = path.join(home, 'proj'); fs.mkdirSync(inside);
  assert.equal(resolveCwd(inside, home), fs.realpathSync(inside));
  assert.equal(resolveCwd(outside, home), null);
  const link = path.join(home, 'esc'); fs.symlinkSync(outside, link);
  assert.equal(resolveCwd(link, home), null, 'symlink verso fuori-home rifiutato');
  assert.equal(resolveCwd(path.join(home, 'missing'), home), null);
});

test('isProtectedSession: cloud-* SEMPRE, anche senza registry (F2)', () => {
  const noFleet = () => false;
  assert.equal(isProtectedSession('cloud-Dev', noFleet), true);
  assert.equal(isProtectedSession('cloud-qualunque', noFleet), true);
  assert.equal(isProtectedSession('CLOUD-x', noFleet), true);
  assert.equal(isProtectedSession('worker-1', noFleet), false);
  assert.equal(isProtectedSession('worker-1', (n) => n === 'worker-1'), true);
});

test('buildCreateArgs: preset allowlist, niente cmd libero (F1)', () => {
  assert.deepEqual(buildCreateArgs('w1', '/home/x/p', 'shell', {}),
    ['new-session', '-d', '-s', 'w1', '-c', '/home/x/p']);
  assert.deepEqual(buildCreateArgs('w1', '/home/x/p', 'claude', {}),
    ['new-session', '-d', '-s', 'w1', '-c', '/home/x/p', 'claude']);
  assert.equal(buildCreateArgs('w1', '/home/x/p', 'rm -rf /', {}), null);
  assert.deepEqual(
    buildCreateArgs('w1', '/p', 'glm', { glm: ['claude', '--model', 'glm-5.2'] }),
    ['new-session', '-d', '-s', 'w1', '-c', '/p', 'claude', '--model', 'glm-5.2']);
  assert.equal(buildCreateArgs('w1', '/p', 'evil', { evil: 'stringa-non-array' }), null);
});
```

- [ ] **Step 2: FAIL** — Run: `node --test tests/lifecycle.test.js` → Expected: FAIL (modulo assente)

- [ ] **Step 3: implementa `lib/tmux/lifecycle.js`**

```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Preset allowlistati (audit F1): il client sceglie un NOME, mai un comando.
// Estendibili da config.json `sessionPresets` (name -> array argv di stringhe).
const PRESETS = { shell: null, claude: ['claude'], 'codex-vl': ['codex-vl'], pi: ['pi'] };

const NAME_RE = /^[\w.-]{1,64}$/;
function validSessionName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.startsWith('-');
}

// cwd reale sotto la home reale (audit F1): realpath su ENTRAMBI, così un
// symlink dentro home che punta fuori viene rifiutato.
function resolveCwd(cwd, home) {
  try {
    const real = fs.realpathSync(cwd);
    const realHome = fs.realpathSync(home);
    if (!fs.statSync(real).isDirectory()) return null;
    if (real !== realHome && !real.startsWith(realHome + path.sep)) return null;
    return real;
  } catch (_) { return null; }
}

// Denylist kill INDIPENDENTE dal registry (audit F2): qualunque cloud-* è
// protetta anche con fleet assente/rotto; in più le tmuxSession del registry.
function isProtectedSession(name, isCellSession) {
  if (/^cloud-/i.test(String(name))) return true;
  try { return !!isCellSession(name); } catch (_) { return false; }
}

function presetArgv(preset, extra) {
  const table = { ...PRESETS };
  for (const [k, v] of Object.entries(extra || {})) {
    if (NAME_RE.test(k) && Array.isArray(v) && v.every((s) => typeof s === 'string')) table[k] = v;
  }
  if (!Object.prototype.hasOwnProperty.call(table, preset)) return undefined;
  return table[preset];
}

// Pure: argomenti tmux per la create, o null se input invalido.
function buildCreateArgs(name, realCwd, preset, extraPresets) {
  if (!validSessionName(name) || typeof realCwd !== 'string' || !realCwd) return null;
  const argv = presetArgv(String(preset || 'shell'), extraPresets);
  if (argv === undefined) return null;
  const base = ['new-session', '-d', '-s', name, '-c', realCwd];
  return argv ? [...base, ...argv] : base;
}

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

function createSession(tmuxBin, { name, cwd, preset }, { home, presets } = {}) {
  return new Promise((resolve, reject) => {
    if (!validSessionName(name)) return reject(httpError(400, 'nome sessione non valido'));
    const real = resolveCwd(String(cwd || home), home);
    if (!real) return reject(httpError(400, 'cwd non valida (deve esistere sotto la home)'));
    const args = buildCreateArgs(name, real, preset, presets);
    if (!args) return reject(httpError(400, 'preset non in allowlist'));
    execFile(tmuxBin, args, (err, _o, stderr) => {
      if (err) {
        if (/duplicate session/i.test(stderr || '')) return reject(httpError(409, 'sessione già esistente'));
        return reject(httpError(500, `tmux new-session failed: ${String(stderr || err.message).trim()}`));
      }
      resolve();
    });
  });
}

function killSession(tmuxBin, name) {
  return new Promise((resolve, reject) => {
    execFile(tmuxBin, ['kill-session', '-t', `=${name}`], (err, _o, stderr) => {
      if (err) {
        if (/can't find session|no server running/i.test(stderr || '')) return resolve(false);
        return reject(httpError(500, `tmux kill-session failed: ${String(stderr || err.message).trim()}`));
      }
      resolve(true);
    });
  });
}

module.exports = { PRESETS, validSessionName, resolveCwd, isProtectedSession, buildCreateArgs, createSession, killSession };
```

- [ ] **Step 4: PASS** — Run: `node --test tests/lifecycle.test.js` → Expected: 4 pass

- [ ] **Step 5: commit**

```bash
git add lib/tmux/lifecycle.js tests/lifecycle.test.js
git commit -m "feat(sessions): lifecycle con preset allowlist, realpath cwd e denylist cloud-* (audit F1/F2)"
```

---

### Task A5: route POST/DELETE `/api/sessions` in server.js

**Files:**
- Modify: `lib/server.js` (dopo la `api.get('/sessions', …)` esistente)
- Test: `tests/sessions-routes.test.js`

**Interfaces:**
- Consumes: `createSession/killSession/isProtectedSession` (A4), `fleetP` (A3), `sessionExists` (già in server.js).
- Produces:
  - `POST /api/sessions` `{name, cwd?, preset?}` → 201 `{created:true, name}` | 400 | 409 | 500
  - `DELETE /api/sessions/:name` → 200 `{killed:true}` | 404 | **409 per protette (ANCHE con fleet unavailable)**
- Config nuova: `sessionPresets` (default `{}`) letta da config.json — NESSUNA env.

- [ ] **Step 1: test fallente `tests/sessions-routes.test.js`** — usa un tmux FINTO da fixture per non toccare il server tmux reale:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');

// tmux finto: registra le chiamate su file e simula duplicate/missing session.
const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');

function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsl-'));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const { server, token, watcher } = createServer({
    tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    tmuxBin: FAKE_TMUX, fleetEnabled: false, ...over,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, dir });
  }));
}
const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('create: 201 con preset shell, 400 nome/preset invalidi', async (t) => {
  const { base, token } = await boot(t);
  const home = os.homedir();
  const ok = await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'w1', cwd: home, preset: 'shell' }) });
  assert.equal(ok.status, 201);
  assert.deepEqual(await ok.json(), { created: true, name: 'w1' });
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: '-bad', cwd: home }) })).status, 400);
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST', headers: H(token), body: JSON.stringify({ name: 'w2', cwd: home, preset: 'rm -rf' }) })).status, 400);
});

test('kill: 409 su cloud-* ANCHE con fleet unavailable (F2), 200 su generica, 404 su assente', async (t) => {
  const { base, token } = await boot(t);
  assert.equal((await fetch(`${base}/api/sessions/cloud-Dev`, { method: 'DELETE', headers: H(token) })).status, 409);
  assert.equal((await fetch(`${base}/api/sessions/w1`, { method: 'DELETE', headers: H(token) })).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/ghost`, { method: 'DELETE', headers: H(token) })).status, 404);
});
```

- [ ] **Step 2: scrivi la fixture `tests/fixtures/fake-tmux.sh`** (eseguibile, `chmod +x`):

```bash
#!/bin/sh
# fake-tmux — logga le chiamate e simula gli esiti che servono ai test route.
echo "$*" >> "${FAKE_TMUX_LOG:-/dev/null}"
case "$1" in
  new-session)  exit 0 ;;
  kill-session)
    case "$*" in *"=ghost"*) echo "can't find session ghost" >&2; exit 1 ;; esac
    exit 0 ;;
  has-session)
    case "$*" in *"=ghost"*) exit 1 ;; esac
    exit 0 ;;
  list-sessions) exit 0 ;;
  *) exit 0 ;;
esac
```

- [ ] **Step 3: FAIL** — Run: `node --test tests/sessions-routes.test.js` → Expected: FAIL (404 sulle route nuove)

- [ ] **Step 4: implementa in `lib/server.js`** — require in testa (accanto agli altri `./tmux/`):

```js
const { createSession, killSession, isProtectedSession } = require('./tmux/lifecycle.js');
```

dopo la `api.get('/sessions', …)` esistente:

```js
  api.post('/sessions', express.json({ limit: '4kb' }), async (req, res) => {
    try {
      const { name, cwd, preset } = req.body || {};
      await createSession(cfg.tmuxBin, { name, cwd, preset },
        { home: require('node:os').homedir(), presets: cfg.sessionPresets });
      res.status(201).json({ created: true, name });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
  api.delete('/sessions/:name', async (req, res) => {
    const name = String(req.params.name || '');
    try {
      const fleet = await fleetP;
      if (isProtectedSession(name, fleet.isCellSession)) {
        return res.status(409).json({ error: 'sessione di cella: usa fleet down' });
      }
      const killed = await killSession(cfg.tmuxBin, name);
      if (!killed) return res.status(404).json({ error: 'sessione inesistente' });
      res.json({ killed: true });
    } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
  });
```

(nota: `require('node:os')` è già importato in config — in server.js aggiungi `const os = require('node:os');` in testa e usa `os.homedir()`; `cfg.sessionPresets` default: aggiungi `sessionPresets: {}` in `baseDefaults()` di `lib/config.js`.)

- [ ] **Step 5: PASS** — Run: `node --test tests/sessions-routes.test.js tests/rest-auth.test.js` → Expected: tutti pass

- [ ] **Step 6: commit**

```bash
git add lib/server.js lib/config.js tests/sessions-routes.test.js tests/fixtures/fake-tmux.sh
git commit -m "feat(sessions): POST/DELETE /api/sessions con guardie (409 cloud-* sempre)"
```

---

### Task A6: arricchimento sessioni — activity, cmd, preview sampler

**Files:**
- Modify: `lib/tmux/list.js` (FMT + parse)
- Create: `lib/tmux/preview.js`
- Modify: `lib/server.js` (GET /api/sessions arricchita)
- Test: `tests/preview.test.js` + aggiorna `tests/list.test.js`

**Interfaces:**
- Consumes: `listSessions` esistente.
- Produces:
  - `listSessions` ritorna in più `activity: number` (epoch sec) e `cmd: string` (pane_current_command attivo)
  - `createPreviewSampler(tmuxBin, {ttlMs=3000, maxLen=240, timeoutMs=1500, maxConcurrent=4}) -> { get(session): Promise<string|null>, close() }`
  - `GET /api/sessions` → ogni sessione ha anche `{activity, cmd, preview}` (preview può mancare: best-effort)
  - `sanitizePreview(raw): string` — strip ANSI/control, trim, tronca a 240 (esportata per test)

- [ ] **Step 1: estendi FMT in `lib/tmux/list.js`**

```js
const FMT = "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}\t#{session_activity}\t#{pane_current_command}";
```

e in `parseSessions` la riga di split/oggetto diventa:

```js
      const [name, attached, windows, created, activity, cmd] = line.split('\t');
      return {
        name,
        attached: attached === '1',
        windows: Number(windows),
        created: Number(created),
        activity: Number(activity) || 0,
        cmd: cmd || '',
      };
```

- [ ] **Step 2: aggiorna `tests/list.test.js`** — nel test esistente di `parseSessions` estendi la riga fixture con due campi (`…\t1751990000\tclaude`) e asserisci `activity === 1751990000` e `cmd === 'claude'`. Run: `node --test tests/list.test.js` → PASS.

- [ ] **Step 3: test fallente `tests/preview.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizePreview } = require('../lib/tmux/preview.js');

test('sanitizePreview: strip ANSI + control, trim, cap 240 (F7)', () => {
  assert.equal(sanitizePreview('\x1b[32mPROMOTE done\x1b[0m  '), 'PROMOTE done');
  assert.equal(sanitizePreview('a\x07b\x00c'), 'abc');
  assert.equal(sanitizePreview('x'.repeat(500)).length, 240);
  assert.equal(sanitizePreview('   '), '');
  assert.equal(sanitizePreview(null), '');
});

test('sampler: cache TTL e null su errore', async (t) => {
  const path = require('node:path');
  const { createPreviewSampler } = require('../lib/tmux/preview.js');
  // fake-tmux stampa "line-<n>" incrementale a ogni capture-pane (vedi fixture)
  process.env.FAKE_TMUX_LOG = '/dev/null';
  const s = createPreviewSampler(path.join(__dirname, 'fixtures', 'fake-tmux-capture.sh'), { ttlMs: 200 });
  t.after(() => s.close());
  const p1 = await s.get('any');
  assert.equal(await s.get('any'), p1, 'entro TTL: stesso valore dalla cache');
  await new Promise((r) => setTimeout(r, 250));
  assert.notEqual(await s.get('any'), p1, 'dopo TTL: ricampionato');
  assert.equal(await s.get('__fail__'), null, 'errore → null, mai throw');
});
```

- [ ] **Step 4: fixture `tests/fixtures/fake-tmux-capture.sh`** (`chmod +x`):

```bash
#!/bin/sh
# Simula capture-pane con output che cambia a ogni chiamata (contatore su file).
case "$*" in *"__fail__"*) echo "can't find pane" >&2; exit 1 ;; esac
C="/tmp/nc-fake-capture-count.$PPID"
n=$(cat "$C" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$C"
printf '\n\nline-%s\n' "$n"
```

- [ ] **Step 5: FAIL poi implementa `lib/tmux/preview.js`**

```js
'use strict';
const { execFile } = require('node:child_process');

const MAX_LEN = 240;

// Strip ANSI (CSI/OSC) e control char via charCode — niente escape regex nel
// sorgente (v. NOTE in lib/files/store.js sul write-layer).
function sanitizePreview(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  let i = 0;
  while (i < raw.length && out.length < MAX_LEN + 1) {
    const c = raw.charCodeAt(i);
    if (c === 0x1b) {                                   // ESC: salta la sequenza
      const n = raw.charCodeAt(i + 1);
      if (n === 0x5b) {                                 // CSI: fino a byte finale 0x40-0x7e
        i += 2; while (i < raw.length && (raw.charCodeAt(i) < 0x40 || raw.charCodeAt(i) > 0x7e)) i += 1;
        i += 1; continue;
      }
      if (n === 0x5d) {                                 // OSC: fino a BEL o ESC\
        i += 2; while (i < raw.length && raw.charCodeAt(i) !== 0x07 && raw.charCodeAt(i) !== 0x1b) i += 1;
        i += (raw.charCodeAt(i) === 0x1b) ? 2 : 1; continue;
      }
      i += 2; continue;                                 // altre ESC-seq corte
    }
    if (c <= 0x1f || c === 0x7f) { i += 1; continue; }  // control char
    out += raw[i]; i += 1;
  }
  return out.trim().slice(0, MAX_LEN);
}

// Sampler con cache per sessione, concorrenza limitata e timeout: la preview è
// best-effort — errori → null, MAI nel log (audit F7).
function createPreviewSampler(tmuxBin, { ttlMs = 3000, timeoutMs = 1500, maxConcurrent = 4 } = {}) {
  const cache = new Map();        // session -> {at, value}
  let inFlight = 0;
  const waiters = [];

  const acquire = () => new Promise((res) => {
    if (inFlight < maxConcurrent) { inFlight += 1; res(); } else waiters.push(res);
  });
  const release = () => { inFlight -= 1; const w = waiters.shift(); if (w) { inFlight += 1; w(); } };

  function capture(session) {
    return new Promise((resolve) => {
      execFile(tmuxBin, ['capture-pane', '-p', '-t', `=${session}:`], { timeout: timeoutMs, killSignal: 'SIGKILL' },
        (err, stdout) => {
          if (err) return resolve(null);
          const lines = String(stdout).split('\n');
          for (let i = lines.length - 1; i >= 0; i -= 1) {
            const s = sanitizePreview(lines[i]);
            if (s) return resolve(s);
          }
          resolve('');
        });
    });
  }

  async function get(session) {
    const hit = cache.get(session);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    await acquire();
    try {
      const value = await capture(session);
      cache.set(session, { at: Date.now(), value });
      return value;
    } finally { release(); }
  }

  return { get, close: () => cache.clear() };
}

module.exports = { sanitizePreview, createPreviewSampler };
```

Run: `node --test tests/preview.test.js` → Expected: 2 pass

- [ ] **Step 6: wire in `lib/server.js`** — require `createPreviewSampler`, crea `const previews = createPreviewSampler(cfg.tmuxBin);` accanto al watcher; nella `api.get('/sessions')` sostituisci il mapping con:

```js
      const sessions = await listSessions(cfg.tmuxBin);
      const sum = watcher.getSummary();
      const enriched = await Promise.all(sessions.map(async (s) => ({
        ...s,
        outbox: sum[s.name] || { count: 0, latest: 0 },
        preview: await previews.get(s.name),
      })));
      res.json({ sessions: enriched });
```

e registra `server.on('close', () => previews.close());` accanto alla close del watcher. Aggiungi anche una riga in `tests/bridge.test.js`: nel test di attach esistente, invia `takeSize:false` nel frame e verifica che l'attach resti ok (regressione handshake, audit F6 lato server).

- [ ] **Step 7: suite completa** — Run: `node --test tests/` → Expected: 0 fail (126 + nuovi)

- [ ] **Step 8: commit**

```bash
git add lib/tmux/list.js lib/tmux/preview.js lib/server.js tests/preview.test.js tests/list.test.js tests/bridge.test.js tests/fixtures/fake-tmux-capture.sh
git commit -m "feat(sessions): activity+cmd+preview best-effort (cap 240, strip ANSI, cache 3s)"
```

---

### Task A7: gate chunk A (coordinator)

- [ ] Suite completa `node --test tests/` verde; `npm run -s build` frontend exit 0 (nessun cambio atteso, sanity).
- [ ] Audit coordinator del diff chunk A (guardie F1/F2/F3/F4/F7 presenti, niente scope creep).
- [ ] Push `develop` Forge. Sblocco chunk B3/B5.

---

### Task B1: `takeSize` in ws-client e Terminal + refs per-tile

**Files:**
- Modify: `frontend/src/lib/ws-client.js`
- Modify: `frontend/src/components/Terminal.jsx`

**Interfaces:**
- Produces: `openTerminalSocket({ …, takeSize })` — incluso nel frame attach SOLO se `takeSize !== undefined`; `<Terminal takeSize={false} …/>` lo inoltra. I refs (`sendRef/actionRef/ctrlRef`) sono GIÀ per-istanza (prop): la griglia passerà refs distinti per tile — nessun singleton da rompere (audit F6).

- [ ] **Step 1: ws-client** — firma: `export function openTerminalSocket({ session, token, cols, rows, readonly = false, takeSize, onData, onExit, onFiles })` e l'onopen diventa:

```js
  ws.onopen = () => {
    const frame = { type: 'attach', session, token, cols, rows, readonly };
    if (takeSize !== undefined) frame.takeSize = takeSize;
    ws.send(JSON.stringify(frame));
  };
```

- [ ] **Step 2: Terminal** — aggiungi `takeSize` alle props e passalo a `openTerminalSocket({ session, token, readonly, takeSize, onFiles, … })`; aggiungi `takeSize` all'array deps dello `useEffect` principale.

- [ ] **Step 3: verifica** — Run: `cd frontend && npx vite build` → exit 0. Verifica manuale server-side: `lib/ws/bridge.js:39` legge già `takeSize` dal frame (nessun cambio server).

- [ ] **Step 4: commit** — `git add frontend/src/lib/ws-client.js frontend/src/components/Terminal.jsx && git commit -m "feat(grid): prop takeSize esposta fino all'handshake attach (F6)"`

---

### Task B2: grid-model puro (TDD via node --test)

**Files:**
- Create: `frontend/src/lib/grid-model.js` (ESM puro, ZERO import React)
- Test: `tests/grid-model.test.js` (node --test con dynamic import)

**Interfaces:**
- Produces (tutte pure, ritornano un NUOVO layout):
  - `emptyLayout() -> {columns: []}`; colonna = `{width:number, tiles:[{session:string, height:number}]}` (width/height = pesi flex relativi, default 1)
  - `addTile(layout, session, drop)` con `drop = {col:number} | {col:number, row:number} | 'end'` — `{col}` inserisce NUOVA colonna a quell'indice; `{col,row}` splitta nella colonna; `'end'` = nuova colonna in coda. Sessione già presente → layout invariato. Cap 9 tile → invariato.
  - `removeTile(layout, session)` — rimuove; colonna vuota → rimossa; pesi restanti invariati (flex ridistribuisce da solo)
  - `moveTile(layout, session, drop)` — remove + add atomico
  - `sessions(layout) -> string[]`
  - `resizeColumn(layout, colIdx, width)` / `resizeTile(layout, colIdx, rowIdx, height)` — clamp min 0.2
  - `normalize(raw) -> layout` — valida/ripara input da localStorage (garbage → emptyLayout)

- [ ] **Step 1: test fallente `tests/grid-model.test.js`**

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/grid-model.js');

test('addTile: nuova colonna, split in colonna, dedup, cap 9', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  l = m.addTile(l, 'a', 'end');
  l = m.addTile(l, 'b', 'end');
  assert.equal(l.columns.length, 2);
  l = m.addTile(l, 'c', { col: 0, row: 1 });          // split sotto 'a'
  assert.deepEqual(l.columns[0].tiles.map((t) => t.session), ['a', 'c']);
  assert.equal(m.addTile(l, 'a', 'end'), l, 'dedup: layout invariato');
  for (const s of ['d','e','f','g','h','i']) l = m.addTile(l, s, 'end');
  assert.equal(m.sessions(l).length, 9);
  assert.equal(m.addTile(l, 'z', 'end'), l, 'cap 9');
});

test('removeTile: colonna vuota sparisce; moveTile atomico', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  l = m.addTile(l, 'a', 'end'); l = m.addTile(l, 'b', 'end');
  l = m.removeTile(l, 'a');
  assert.equal(l.columns.length, 1);
  l = m.addTile(l, 'c', { col: 0, row: 1 });
  l = m.moveTile(l, 'c', { col: 1 });
  assert.deepEqual(l.columns.map((c) => c.tiles.map((t) => t.session)), [['b'], ['c']]);
});

test('resize clamp + normalize ripara garbage', async () => {
  const m = await mod();
  let l = m.addTile(m.emptyLayout(), 'a', 'end');
  l = m.resizeColumn(l, 0, 0.05);
  assert.equal(l.columns[0].width, 0.2);
  assert.deepEqual(m.normalize(null), m.emptyLayout());
  assert.deepEqual(m.normalize({ columns: 'x' }), m.emptyLayout());
  const ok = m.normalize({ columns: [{ width: 2, tiles: [{ session: 'a', height: 1 }] }] });
  assert.equal(ok.columns[0].tiles[0].session, 'a');
});
```

- [ ] **Step 2: FAIL** — Run: `node --test tests/grid-model.test.js` → Expected: FAIL (modulo assente)

- [ ] **Step 3: implementa `frontend/src/lib/grid-model.js`**

```js
// Modello puro della griglia a colonne (stile Claude Code desktop):
// columns[] di tiles[]; width/height = pesi flex relativi. Nessun React qui.
const MAX_TILES = 9;
const MIN_W = 0.2;

export function emptyLayout() { return { columns: [] }; }

export function sessions(layout) {
  return layout.columns.flatMap((c) => c.tiles.map((t) => t.session));
}

const clone = (l) => ({ columns: l.columns.map((c) => ({ width: c.width, tiles: c.tiles.map((t) => ({ ...t })) })) });

export function addTile(layout, session, drop) {
  if (sessions(layout).includes(session)) return layout;
  if (sessions(layout).length >= MAX_TILES) return layout;
  const l = clone(layout);
  const tile = { session, height: 1 };
  if (drop === 'end') { l.columns.push({ width: 1, tiles: [tile] }); return l; }
  if (drop && typeof drop.col === 'number' && typeof drop.row === 'number' && l.columns[drop.col]) {
    l.columns[drop.col].tiles.splice(drop.row, 0, tile); return l;
  }
  if (drop && typeof drop.col === 'number') {
    const at = Math.max(0, Math.min(l.columns.length, drop.col));
    l.columns.splice(at, 0, { width: 1, tiles: [tile] }); return l;
  }
  l.columns.push({ width: 1, tiles: [tile] });
  return l;
}

export function removeTile(layout, session) {
  const l = clone(layout);
  for (const c of l.columns) c.tiles = c.tiles.filter((t) => t.session !== session);
  l.columns = l.columns.filter((c) => c.tiles.length > 0);
  return l;
}

export function moveTile(layout, session, drop) {
  if (!sessions(layout).includes(session)) return layout;
  return addTile(removeTile(layout, session), session, drop);
}

export function resizeColumn(layout, colIdx, width) {
  const l = clone(layout);
  if (l.columns[colIdx]) l.columns[colIdx].width = Math.max(MIN_W, Number(width) || 1);
  return l;
}

export function resizeTile(layout, colIdx, rowIdx, height) {
  const l = clone(layout);
  const t = l.columns[colIdx] && l.columns[colIdx].tiles[rowIdx];
  if (t) t.height = Math.max(MIN_W, Number(height) || 1);
  return l;
}

// Ripara input da localStorage: qualunque garbage → layout valido.
export function normalize(raw) {
  if (!raw || !Array.isArray(raw.columns)) return emptyLayout();
  const columns = raw.columns
    .map((c) => ({
      width: Math.max(MIN_W, Number(c && c.width) || 1),
      tiles: (Array.isArray(c && c.tiles) ? c.tiles : [])
        .filter((t) => t && typeof t.session === 'string' && t.session)
        .map((t) => ({ session: t.session, height: Math.max(MIN_W, Number(t.height) || 1) })),
    }))
    .filter((c) => c.tiles.length > 0);
  const seen = new Set();
  for (const c of columns) c.tiles = c.tiles.filter((t) => !seen.has(t.session) && seen.add(t.session));
  return { columns: columns.filter((c) => c.tiles.length > 0) };
}
```

- [ ] **Step 4: PASS** — Run: `node --test tests/grid-model.test.js` → Expected: 3 pass

- [ ] **Step 5: commit** — `git add frontend/src/lib/grid-model.js tests/grid-model.test.js && git commit -m "feat(grid): modello colonne puro con add/remove/move/resize/normalize (TDD)"`

---

### Task B3: client API fleet/sessions + Sidebar + dialoghi

**Files:**
- Modify: `frontend/src/lib/api.js` (aggiungi helper)
- Create: `frontend/src/components/Sidebar.jsx` + `Sidebar.css`
- Create: `frontend/src/components/PowerSheet.jsx` + `PowerSheet.css`
- Create: `frontend/src/components/NewSessionDialog.jsx` + `NewSessionDialog.css`

**Interfaces:**
- Consumes: `GET/POST /api/fleet/*`, `POST/DELETE /api/sessions` (A3/A5), `apiFetch(path, token, opts?)` esistente in `api.js` (estendere per method/body JSON se serve).
- Produces:
  - `api.js`: `fleetStatus(token)`, `fleetUp(token,{cell,engine,boot})`, `fleetDown(token,{cell,boot})`, `fleetEngine(token,{cell,engine})`, `fleetBoot(token,{cell,enabled})`, `createSession(token,{name,cwd,preset})`, `killSession(token,name)` — tutte ritornano il JSON o throw con `error`
  - `<Sidebar sessions cells onPick onAddTile onPower onKill onNew activeSessions/>`:
    gruppo "Flotta" (una card per cella: dot pieno se `tmux`, ⚠ se `degraded`, badge `engine·key`, ⏻ per accendere/spegnere → apre PowerSheet), gruppo "Altre sessioni" (card: dot attached, preview 1 riga, badge outbox, tempo relativo da `activity`, menu ⋯ → termina con conferma), bottone `[+ nuova sessione]` → NewSessionDialog. Le card di sessioni VIVE sono draggabili (`draggable` + `onDragStart` con `dataTransfer.setData('text/nc-session', name)`) e cliccabili (onPick = vista singola / add al grid su desktop).
  - `<PowerSheet cell onConfirm onClose/>`: per cella spenta → engine picker (radio: native/glm/glm-a/glm-p/ollama/ollama-cloud/codex-vl) + checkbox boot + conferma `fleet up`; per cella accesa → conferma `fleet down` (+ checkbox "togli dal boot"). Vincolo mostrato: engine ≠ native → nota "niente remote-control".
  - `<NewSessionDialog presets onCreate onClose/>`: input nome (validato `^[\w.-]{1,64}$`), input cwd (default `~`), select preset (da `/api/config` estesa — vedi Step 1), submit → `createSession`.

- [ ] **Step 1: esponi i preset in `/api/config`** (modifica server, 1 riga — chunk A già mergiato): in `lib/server.js` la route config diventa:

```js
  api.get('/config', (_req, res) => res.json({
    readonlyDefault: cfg.readonlyDefault, version: VERSION,
    bind: cfg.bind, port: cfg.port,
    presets: ['shell', 'claude', 'codex-vl', 'pi', ...Object.keys(cfg.sessionPresets || {})],
  }));
```

(attenzione a preservare `bind`/`port` già presenti dal commit `95a0dfd`.)

- [ ] **Step 2: helper in `frontend/src/lib/api.js`** — aggiungi:

```js
async function jsonFetch(path, token, opts = {}) {
  const r = await apiFetch(path, token, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
export const fleetStatus = (t) => jsonFetch('/api/fleet/status', t);
export const fleetUp = (t, b) => jsonFetch('/api/fleet/up', t, { method: 'POST', body: b });
export const fleetDown = (t, b) => jsonFetch('/api/fleet/down', t, { method: 'POST', body: b });
export const fleetEngine = (t, b) => jsonFetch('/api/fleet/engine', t, { method: 'POST', body: b });
export const fleetBoot = (t, b) => jsonFetch('/api/fleet/boot', t, { method: 'POST', body: b });
export const createSession = (t, b) => jsonFetch('/api/sessions', t, { method: 'POST', body: b });
export const killSession = (t, name) => jsonFetch(`/api/sessions/${encodeURIComponent(name)}`, t, { method: 'DELETE' });
```

(verifica la firma reale di `apiFetch` in `frontend/src/lib/api.js` e adattala se non accetta `opts`.)

- [ ] **Step 3: implementa i tre componenti.** Pattern grafico: riusa le classi/toni di `SessionList.css` (dot verde, card scure). Il polling è del genitore (App/Workspace): Sidebar è presentazionale + callback. Le card cella mostrano: nome cella, `engine·key` (es. `glm·A`), dot: pieno verde = tmux vivo, vuoto = spenta, giallo ⚠ = degraded (`title` col dettaglio). Tempo relativo: helper locale `rel(epochSec)` → `'ora' | 'Nm' | 'Nh' | 'Ng'`.

- [ ] **Step 4: build** — Run: `cd frontend && npx vite build` → exit 0.

- [ ] **Step 5: commit** — `git add frontend/src lib/server.js && git commit -m "feat(ui): sidebar unificata flotta+sessioni, PowerSheet, NewSessionDialog"`

---

### Task B4: GridView + GridTile + integrazione desktop in App

**Files:**
- Create: `frontend/src/components/GridView.jsx` + `GridView.css`
- Create: `frontend/src/components/GridTile.jsx` + `GridTile.css`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: `grid-model.js` (B2), `Terminal` con `takeSize` (B1), `Sidebar` (B3), `ComposerBar`, `FilesPanel`, `KeyBar` esistenti.
- Produces:
  - `<GridView layout onLayoutChange token sessionsAlive focusSession onFocus onOpenSingle/>` — render colonne flex (`flex-grow = width`), tile flex (`flex-grow = height`); divisori verticali/orizzontali (div 6px, `onPointerDown` + move = aggiorna pesi via `resizeColumn/resizeTile`, commit su pointerup); drop zone: durante `dragover` calcola target (`{col}` se entro 40px dal bordo colonna/area vuota, `{col,row}` sopra un tile) e mostra indicator (`outline` CSS); `drop` → `onLayoutChange(addTile/moveTile(…))`.
  - `<GridTile session token focused onFocus onClose onOpenSingle/>` — header (nome, dot, azioni ⌨/📁/↗/✕) + `<Terminal takeSize={false} fontSize={11} …/>` con refs PROPRI (`useRef` locali per tile), ComposerBar toggle, FilesPanel overlay assoluto nel tile. `cursorBlink` non è una prop di Terminal: NON toccarlo (il costo è accettabile; ottimizzazione futura).
  - App: `const isDesktop = matchMedia('(min-width:1024px) and (pointer:fine)').matches` (stato con listener) — desktop: layout `nc-workspace` = Sidebar + GridView + overlay vista singola quando `session != null` (la vista singola attuale resta INTATTA come overlay/route); mobile: flusso attuale. Layout persistito: `localStorage nc_grid_v1` con `normalize()` al load, sessioni morte filtrate con `sessionsAlive`.

- [ ] **Step 1: implementa GridTile** (header ~30px: `nc-tile-head`; corpo relativo con Terminal assoluto; footer ComposerBar condizionale). Ogni tile crea i SUOI `sendRef/actionRef/ctrlRef` con `useRef` (audit F6: mai condivisi).
- [ ] **Step 2: implementa GridView** (flex row di colonne; ogni colonna flex column di tile; divisori; DnD come da interfaccia; stato drag-indicator locale).
- [ ] **Step 3: integra in App** (vista `grid` default desktop; card sidebar click = add al grid, doppio click/↗ = vista singola overlay; `nc_grid_v1` load/save).
- [ ] **Step 4: build + smoke manuale** — Run: `cd frontend && npx vite build` → exit 0. Smoke con `node bin/nexuscrew.js serve` su porta di test + browser: drag 2 sessioni, split, resize, chiudi, reload (layout persiste), typing nel tile a fuoco, composer, file panel.
- [ ] **Step 5: commit** — `git add frontend/src && git commit -m "feat(grid): griglia a colonne con drag&drop, divisori, focus, persistenza layout"`

---

### Task B5: gate chunk B (coordinator)

- [ ] `node --test tests/` verde + build frontend exit 0.
- [ ] Audit coordinator: F6 (refs per-tile, takeSize), UX drag, nessuna dipendenza nuova (`git diff develop -- frontend/package.json` vuoto).
- [ ] Mockup/verifica estetica con Claude Design se non già fatto prima di B3.
- [ ] Push `develop` Forge. Sblocco chunk C.

---

### Task C1: mobile restyle — home a gruppi, card ricche, FAB

**Files:**
- Modify: `frontend/src/components/SessionList.jsx` + `SessionList.css`

**Interfaces:**
- Consumes: `fleetStatus/…/killSession` (B3 api.js), `PowerSheet`, `NewSessionDialog` (B3 — riusati identici).
- Produces: home mobile con: titolo grande stile app Claude; gruppo **Flotta** (celle: vive per prime, spente con ⏻; card = nome, `engine·key`, dot/⚠, tempo relativo `rel(activity)`, preview 1 riga ellissata, badge outbox); gruppo **Altre sessioni** (card come sopra senza engine/key, menu ⋯ → "termina" con `confirm()`); **FAB** `+ nuova sessione` fisso bottom-right → NewSessionDialog. Il filtro esistente resta (`total > 8`). Ordinamento esistente per rilevanza conservato dentro ciascun gruppo. Polling: aggiungi `fleetStatus` accanto a `refresh()` nello stesso interval (4s), `available:false` → gruppo Flotta assente (portable pulita).

- [ ] **Step 1: implementa** (mantieni `relevance()`, `seenKey`, footer endpoint intatti).
- [ ] **Step 2: build + smoke mobile** — `npx vite build` exit 0; smoke con viewport mobile nel browser (DevTools): gruppi, FAB, power sheet, preview.
- [ ] **Step 3: commit** — `git commit -am "feat(ui): home mobile a gruppi flotta/sessioni, card ricche, FAB nuova sessione"`

---

### Task C2: vista singola mobile — rifinitura

**Files:**
- Modify: `frontend/src/App.jsx` (header vista singola), `frontend/src/App.css`

**Interfaces:**
- Produces: header vista singola con nome centrato + sottotitolo stato (`engine·key` se cella, `attached · Nm` altrimenti), transizione slide-in CSS (`transform 0.2s`), back invariato. NIENTE cambi a KeyBar/ComposerBar/Terminal (il vincolo IME resta).

- [ ] **Step 1: implementa** (solo markup header + css; dati da `/api/sessions` + `/api/fleet/status` già in polling).
- [ ] **Step 2: build** — exit 0. **Step 3: commit** — `git commit -am "feat(ui): vista singola mobile rifinita (header stato, transizioni)"`

---

### Task C3: i18n IT / EN / ES (richiesta DAG 2026-07-09, zero dipendenze)

**Files:**
- Create: `frontend/src/lib/i18n.js`
- Modify: tutti i componenti con stringhe UI (`App.jsx`, `SessionList.jsx`, `Sidebar.jsx`, `PowerSheet.jsx`, `NewSessionDialog.jsx`, `FilesPanel.jsx`, `ComposerBar.jsx`, `KeyBar.jsx` — testi visibili e `title=`)
- Test: `tests/i18n.test.js`

**Interfaces:**
- Produces: `frontend/src/lib/i18n.js` (ESM puro):
  - `const DICTS = { it: {...}, en: {...}, es: {...} }` — chiavi piatte kebab (`'sessions'`, `'new-session'`, `'terminate-confirm'`, `'fleet'`, `'other-sessions'`, `'files'`, `'boot-persist'`, `'no-remote-control'`, …). IT = stringhe attuali (source of truth), EN/ES tradotte.
  - `getLang(): 'it'|'en'|'es'` — localStorage `nc_lang`, default `'it'`, fallback su valore ignoto
  - `setLang(lang)` — persiste + `window.dispatchEvent(new Event('nc-lang'))`
  - `t(key): string` — dict corrente, fallback IT, fallback key stessa
  - hook `useLang()` — `useSyncExternalStore` su evento `nc-lang`, ritorna `[lang, setLang]`
- Picker lingua: `IT · EN · ES` nel footer della home mobile e in fondo alla sidebar desktop (bottone testo, lingua attiva evidenziata).
- La data/tempo relativo (`rel()`) resta numerica (nessuna localizzazione necessaria).

- [ ] **Step 1: test fallente `tests/i18n.test.js`** — parità chiavi tra le 3 lingue:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('i18n: parità chiavi it/en/es, nessuna stringa vuota', async () => {
  const { DICTS } = await import('../frontend/src/lib/i18n.js');
  const keys = Object.keys(DICTS.it).sort();
  assert.ok(keys.length > 10, 'dizionario IT popolato');
  for (const lang of ['en', 'es']) {
    assert.deepEqual(Object.keys(DICTS[lang]).sort(), keys, `chiavi ${lang} = chiavi it`);
    for (const k of keys) assert.ok(DICTS[lang][k].trim(), `${lang}.${k} non vuota`);
  }
});

test('i18n: t() fallback su IT e su chiave', async () => {
  const { t, DICTS } = await import('../frontend/src/lib/i18n.js');
  assert.equal(t('__missing__'), '__missing__');
  assert.ok(DICTS.it.sessions);
});
```

- [ ] **Step 2: FAIL** — `node --test tests/i18n.test.js` → modulo assente
- [ ] **Step 3: implementa `i18n.js`** (DICTS con TUTTE le stringhe estratte dai componenti; `getLang/setLang/t/useLang` come da interfaccia; guard `typeof localStorage !== 'undefined'` per il test node)
- [ ] **Step 4: sostituisci le stringhe nei componenti con `t('…')`** + picker lingua (footer home + sidebar)
- [ ] **Step 5: PASS + build** — `node --test tests/i18n.test.js` verde; `npx vite build` exit 0; smoke: switch lingua live senza reload
- [ ] **Step 6: commit** — `git add frontend/src tests/i18n.test.js && git commit -m "feat(i18n): UI multilingua IT/EN/ES, picker persistito, zero deps"`

---

### Task D1: release chores + smoke VPS3 (coordinator)

- [ ] Bump `package.json` → `0.7.0` (root; allinea `frontend/package.json` se versionata) + `CHANGELOG.md` + `docs/CURRENT_STATE.md` (sezione v0.7 Fleet Deck).
- [ ] Rebuild `frontend/dist/` committata (`npx vite build` + `git add frontend/dist`) — distribuzione git-clone self-contained (pattern portable).
- [ ] Suite completa + push develop Forge.
- [ ] Smoke VPS3 su servizio reale (41777): gate 401/200; `/api/fleet/status` reale (7 celle); griglia con 2+ sessioni vive; create+kill di `nc-smoke-test` (generica); ⏻ cella: SOLO con OK esplicito DAG su cella disposable (audit F5) — altrimenti skip dichiarato.
- [ ] `memory_write dev_state` + `memory_append dev_log` + doc status in DocsHub `projects/nexuscrew/` (nuovo file `2026-07-XX_v07_fleet_deck_status.md`).

---

## Self-review (fatta)

- **Coverage spec**: §1 registry/detect→A2/A6, trust F3→A2, contratto F4→Task 0+A2, §2 API→A3/A5/A6, F1/F2→A4/A5, F7→A6, §3 griglia→B1/B2/B4, composer per-tile→B4, sidebar→B3, §4 mobile→C1/C2, §5 sicurezza→guardie nei task A, §6 testing→test per task + gates, fake fleet F5→A1/D1, versione 0.7.0→D1. Nessun gap.
- **Placeholder**: nessun TBD/TODO; i task B3/B4 hanno interfacce esatte + pattern, codice componenti delegato con contratti completi (props e comportamenti enumerati).
- **Coerenza tipi**: `createFleet(cfg)` async ovunque (`fleetP` in server); `isCellSession` usato in A5 come definito in A2; `grid-model` API identica tra B2 e B4; `takeSize` B1↔B4; `apiFetch` da verificare in B3 Step 2 (nota esplicita nel task).
