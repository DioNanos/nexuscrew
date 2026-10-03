import { describe, expect, it } from 'vitest';
import { parseBootstrapHash } from './fragment.js';

describe('parseBootstrapHash: deviceId del link show', () => {
  const at = (hash) => parseBootstrapHash({ hash, origin: 'http://x', pathname: '/', search: '' });
  it('legge token e device dal fragment e ripulisce l\'URL', () => {
    const r = at(`#token=T&device=${'ab'.repeat(16)}`);
    expect(r.token).toBe('T'); expect(r.device).toBe('ab'.repeat(16)); expect(r.nextUrl).toBe('/');
  });
  it('un device non valido o assente viene ignorato', () => {
    expect(at('#token=T&device=zz').device).toBe('');
    expect(at('#token=T').device).toBe('');
    expect(at('').device).toBe('');
  });
});
