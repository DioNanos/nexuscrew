# NexusCrew v0.7.3 — Window Management Implementation Plan

> **For agentic workers:** eseguire i task in ordine, TDD dove indicato, un commit per task. Base: `develop`. Scope deciso da DAG 2026-07-09: drop zone direzionali + sidebar collassabile/ridimensionabile + preset/snap. **NIENTE float mode.**

**Goal:** trascinare le finestre con più possibilità (affiancate laterali ovunque, non solo impilate), sidebar riducibile, preset di layout e snap dei divisori.

**Architecture:** solo frontend. `grid-model.js` resta la source of truth pura (nuovo helper direzionale, TDD). GridView aggiunge quadrant-detection + anteprima; Sidebar diventa collassabile/ridimensionabile; toolbar preset in GridView. Zero dipendenze nuove.

## Global Constraints

- ZERO dipendenze npm nuove. Suite `npm test` resta verde (149+N). Build vite exit 0.
- localStorage: chiavi nuove `nc_side_w` (num px), `nc_side_min` ('1'|''), layout resta `nc_grid_v1`.
- Non toccare: server (`lib/`), Terminal/ws-client, vincoli IME mobile.
- git add SOLO dei path toccati; messaggi commit come da task.

---

### Task W1: grid-model — drop direzionale (TDD)

**Files:** Modify `frontend/src/lib/grid-model.js` · Test: append a `tests/grid-model.test.js`

**Interfaces (Produces):**
- `dropForQuadrant(layout, colIdx, rowIdx, quadrant)` — quadrant ∈ `'left'|'right'|'top'|'bottom'`;
  ritorna il descrittore drop per add/moveTile: left→`{col:colIdx}` (nuova colonna PRIMA),
  right→`{col:colIdx+1}` (DOPO), top→`{col:colIdx,row:rowIdx}`, bottom→`{col:colIdx,row:rowIdx+1}`.
  Input invalidi (col/row fuori range, quadrant ignoto) → `null`.
- `equalize(layout)` — tutti i width/height a 1 (nuovo layout).
- `toGrid2x2(layout)` — ridistribuisce le sessioni esistenti (ordine attuale via `sessions()`) su 2 colonne bilanciate (⌈n/2⌉ + resto), pesi 1. n===0 → layout vuoto invariato.
- `toColumns(layout)` — una colonna per sessione, pesi 1.

- [ ] Step 1: test fallenti (append al file esistente):

```js
test('dropForQuadrant: mapping direzionale + invalidi', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  l = m.addTile(l, 'a', 'end'); l = m.addTile(l, 'b', { col: 0, row: 1 });
  assert.deepEqual(m.dropForQuadrant(l, 0, 0, 'left'), { col: 0 });
  assert.deepEqual(m.dropForQuadrant(l, 0, 0, 'right'), { col: 1 });
  assert.deepEqual(m.dropForQuadrant(l, 0, 1, 'top'), { col: 0, row: 1 });
  assert.deepEqual(m.dropForQuadrant(l, 0, 1, 'bottom'), { col: 0, row: 2 });
  assert.equal(m.dropForQuadrant(l, 9, 0, 'left'), null);
  assert.equal(m.dropForQuadrant(l, 0, 0, 'diag'), null);
});

test('equalize / toGrid2x2 / toColumns', async () => {
  const m = await mod();
  let l = m.emptyLayout();
  for (const s of ['a','b','c','d','e']) l = m.addTile(l, s, 'end');
  l = m.resizeColumn(l, 0, 3);
  assert.ok(m.equalize(l).columns.every((c) => c.width === 1));
  const g = m.toGrid2x2(l);
  assert.equal(g.columns.length, 2);
  assert.deepEqual(g.columns.map((c) => c.tiles.length), [3, 2]);
  assert.deepEqual(m.sessions(g), ['a','b','c','d','e']);
  const cols = m.toColumns(l);
  assert.equal(cols.columns.length, 5);
  assert.deepEqual(m.toGrid2x2(m.emptyLayout()), m.emptyLayout());
});
```

- [ ] Step 2: `node --test tests/grid-model.test.js` → FAIL → implementa (funzioni pure, stile del file: clone + return nuovo layout) → PASS.
- [ ] Step 3: commit `feat(grid): dropForQuadrant + preset equalize/2x2/columns (model, TDD)`

### Task W2: GridView — quadrant detection + anteprima + toolbar preset + snap divisori

**Files:** Modify `frontend/src/components/GridView.jsx` + `GridView.css`

**Comportamento:**
- Su `dragOver` di un tile: quadrante dal puntatore vs bounding box (fasce: left/right = 28% laterali; altrimenti top/bottom per metà). Stato drag = `{col,row,quadrant}`; classe anteprima sul tile: `drop-left|drop-right|drop-top|drop-bottom` (overlay ::after semitrasparente sulla metà interessata — feedback chiaro PRIMA del rilascio).
- `onDrop`: usa `dropForQuadrant`; drop su sfondo griglia/oltre le colonne resta `{col:ncols}` (coda).
- **Toolbar** compatta in alto a destra della griglia (visibile se ≥1 tile): `⊞ 2×2` → `toGrid2x2`, `▥ colonne` → `toColumns`, `◫ equalizza` → `equalize`. Title localizzati (chiavi i18n nuove nei 3 dizionari: 'preset-2x2','preset-columns','preset-equalize').
- **Snap divisori**: in startColResize/startRowResize, se il peso risultante mappa una frazione entro ±3% di 25/50/75% dello spazio del binomio interessato → scatta al valore esatto. Implementa con helper puro `snapFraction(f)` esportato da grid-model (test: `snapFraction(0.51)→0.5`, `0.27→0.25`, `0.60→0.60`).
- Verifica manuale divisori: SE il resize coi divisori risulta rotto nel browser, fixare qui (nota: i listener window devono staccarsi su pointerup — già previsto — e i pesi aggiornarsi live).

- [ ] Step 1: implementa. Step 2: `npx vite build` exit 0. Step 3: commit `feat(grid): drop zone direzionali con anteprima, toolbar preset, snap divisori`

### Task W3: Sidebar collassabile + ridimensionabile

**Files:** Modify `frontend/src/components/Sidebar.jsx` + `Sidebar.css`, `frontend/src/App.jsx` (solo wiring larghezza)

**Comportamento:**
- Bordo destro della sidebar = maniglia drag (6px, `cursor: col-resize`, pointer events come i divisori griglia): larghezza 180–480px, persistita `nc_side_w`.
- Bottone collassa in testa (⟨/⟩): modalità mini 48px — solo dot colorati delle celle (title = nome) e iniziali delle sessioni; click/drag restano attivi; stato `nc_side_min`.
- i18n: chiavi 'collapse','expand' nei 3 dizionari.

- [ ] Step 1: implementa. Step 2: build exit 0 + `node --test tests/i18n.test.js` PASS (parità chiavi!). Step 3: commit `feat(ui): sidebar collassabile e ridimensionabile (larghezza persistita)`

### Task W4: chiusura

- [ ] `npm test` completo 0 fail; build exit 0; commit finale eventuali residui.
- REPORT: commit hash per task, esiti, deviazioni.

**Gate coordinator (NON del worker):** verifica Playwright su servizio live — drag nei 4 quadranti con anteprima, preset, snap, collapse/resize sidebar, regressione click/drag celle — POI bump 0.7.3, publish npm/GitHub/live.
