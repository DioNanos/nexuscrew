# FIX_AUDIT — NexusCrew 0.9.55, UI sadoc (branch `feature/pr-sadoc-0955-c`)

Referto dei fix per area. Ogni voce porta file:riga e lo stato del
bottone/tasto a cui si riferisce.

## B4 — bottone «seconda finestra» (affiancata) nella lista celle

Difetto (screenshot DAG dal telefono, cassetto «Cells»): il bottone che
affianca la cella al lato B mostrava un **quadrato nero pieno** su ogni riga,
anche nello stato attivo (riga con bordo verde): l'icona dentro non si vedeva.

Causa: l'SVG inline nel bottone non aveva attributi di tratto. In SVG il
`<rect>` di default ha `fill: black`, quindi il rettangolo dell'icona si
riempiva di nero e copriva il disegno; la `<line>` senza `stroke` non
compariva per niente. Il CSS del bottone era già corretto (44 px, bordo
sottile, stati on/disabled): il difetto era solo il disegno.

Fix:
- icona `splitView` («finestra divisa», pannello destro) nel set unico stroke
  `fill="none" stroke="currentColor" strokeWidth=2` di Icon.jsx:
  `frontend/src/components/Icon.jsx:163`
- il bottone usa l'icona del set invece dell'SVG inline senza attributi:
  `frontend/src/components/CellSwitcher.jsx:641`
- stato hover (bordo e tratto un gradino più chiari, coerenti col «⋯»
  accanto), oltre a normale/attivo/disabilitato già presenti:
  `frontend/src/components/CellSwitcher.css:145`
- guardia anti-regressione nel test del bottone: l'SVG deve avere
  `fill="none"` e `stroke="currentColor"` (un fill di default tornava il
  quadrato nero): `frontend/src/components/CellSwitcher.test.jsx:700`

Stati verificati sul build a 390 px (harness con componenti reali):
normale (grigio, come il «⋯»), attivo/affiancata (tratto verde dentro il
bordo verde), disabilitato «YOU ARE HERE» (opacità .38, icona leggibile),
hover (bordo e tratto più chiari). Area tocco invariata 44×44, aria-label
invariata (`cell-switcher-side-add` / `cell-switcher-side-remove`).

Screenshot: `lista_celle_bottone_split_prima.png` (stato di
develop 5f02f40: il bottone è identico) e `lista_celle_bottone_split_dopo.png`
in `~/NexusFiles/cloud-Dev/outbox/pr-sadoc-c/`.

Test: `CellSwitcher.test.jsx` 31/31 verdi (vitest, home isolata).
