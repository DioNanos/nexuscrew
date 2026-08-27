import { describe, expect, it } from 'vitest';
import {
  hostRenderState, HOST_DESIGNATED, HOST_THREAD_PRESENT, HOST_THREAD_ACTIVE, HOST_THREAD_UNKNOWN,
} from './host-designation.js';

const cell = { key: 'cloud-Alfa', value: { cell: 'Alfa' } };

describe('hostRenderState — stato del thread distinto dalla designazione', () => {
  it.each([
    ['absent', HOST_DESIGNATED],
    ['present', HOST_THREAD_PRESENT],
    ['active', HOST_THREAD_ACTIVE],
    ['unknown', HOST_THREAD_UNKNOWN],
  ])('threadStatus %s produce lo stato UI dedicato', (threadStatus, expected) => {
    expect(hostRenderState({ hostCell: 'Alfa', threadStatus, item: cell })).toBe(expected);
  });

  it('assenza del threadStatus non diventa thread assente', () => {
    expect(hostRenderState({ hostCell: 'Alfa', item: cell })).toBe(HOST_THREAD_UNKNOWN);
  });
});
