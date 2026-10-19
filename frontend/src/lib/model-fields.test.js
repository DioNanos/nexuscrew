import { describe, expect, it } from 'vitest';
import { modelPatchFromValues } from './model-fields.js';

// La conversione che usano ENTRAMBI i percorsi di scrittura (dichiarazione e
// «rendilo mio»): numeri tipizzati, booleani a tre stati, vuoto che non scrive.
describe('modelPatchFromValues', () => {
  it('types the limits and omits an empty one', () => {
    expect(modelPatchFromValues({ contextWindow: '131072', maxTokens: '' })).toEqual({ contextWindow: 131072 });
  });

  it('rejects a non-empty out-of-range limit instead of dropping it silently', () => {
    expect(() => modelPatchFromValues({ contextWindow: '1000' })).toThrow();
    expect(() => modelPatchFromValues({ contextWindow: '512', maxTokens: '4096' })).toThrow();
  });

  it('keeps `false` as a value and an empty boolean as an absence', () => {
    expect(modelPatchFromValues({ tools: 'false', vision: false, reasoning: '' }))
      .toEqual({ tools: false, vision: false });
    expect(modelPatchFromValues({ tools: '', vision: undefined, reasoning: null })).toEqual({});
  });

  it('types a true coming from a dialog select', () => {
    expect(modelPatchFromValues({ tools: 'true', vision: true })).toEqual({ tools: true, vision: true });
  });
});
