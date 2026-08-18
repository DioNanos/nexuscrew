// R34 — selectionUiPolicy: la modalita' della UI di selezione segue l'ORIGINE
// del gesto, non il device. Regola approvata da Dev: selezione nata da un gesto
// touch → maniglie + lente; nata dal mouse → nessuna delle due (il mouse ha la
// selezione nativa e Shift+click); origine ignota → touch (conservativo: se la
// rilevazione fallisce su un telefono togliere le maniglie rende la selezione
// irregolabile; sul desktop mostrarle e' solo brutto).
import { describe, expect, it } from 'vitest';
import { selectionUiPolicy } from './selection-handles.js';

describe('R34 — selectionUiPolicy: la modalita\' segue il gesto', () => {
  it('origine touch: maniglie e lente accese', () => {
    expect(selectionUiPolicy('touch')).toEqual({ handles: true, magnifier: true });
  });
  it('origine mouse: niente maniglie, niente lente', () => {
    expect(selectionUiPolicy('mouse')).toEqual({ handles: false, magnifier: false });
  });
  it('origine ignota (null/undefined): conservativo touch — le affordance restano', () => {
    expect(selectionUiPolicy(null)).toEqual({ handles: true, magnifier: true });
    expect(selectionUiPolicy(undefined)).toEqual({ handles: true, magnifier: true });
  });
});
