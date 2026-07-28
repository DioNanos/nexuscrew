import { describe, it, expect } from 'vitest';
import { blankEngine, buildEngine, engineForm } from './fleet-forms.js';

describe('fleet-forms credentialSourcePolicy serialization', () => {
  it('buildEngine omits credentialSourcePolicy when auto (legacy no-op)', () => {
    const form = { ...blankEngine(), credentialSourcePolicy: 'auto' };
    const engine = buildEngine(form, true);
    expect(engine.managed.credentialSourcePolicy).toBeUndefined();
  });

  it('buildEngine persists credentialSourcePolicy when environment|nexuscrew-store', () => {
    expect(buildEngine({ ...blankEngine(), credentialSourcePolicy: 'nexuscrew-store' }, true).managed.credentialSourcePolicy).toBe('nexuscrew-store');
    expect(buildEngine({ ...blankEngine(), credentialSourcePolicy: 'environment' }, true).managed.credentialSourcePolicy).toBe('environment');
  });

  it('engineForm reads managed.credentialSourcePolicy (default auto when absent)', () => {
    const withPolicy = engineForm({ id: 'x', managed: { client: 'claude', provider: 'zai', permissionPolicy: 'unsafe', credentialSourcePolicy: 'nexuscrew-store' } });
    expect(withPolicy.credentialSourcePolicy).toBe('nexuscrew-store');
    const legacy = engineForm({ id: 'y', managed: { client: 'claude', provider: 'zai', permissionPolicy: 'unsafe' } });
    expect(legacy.credentialSourcePolicy).toBe('auto');
  });

  it('blankEngine defaults credentialSourcePolicy to auto', () => {
    expect(blankEngine().credentialSourcePolicy).toBe('auto');
  });
});
