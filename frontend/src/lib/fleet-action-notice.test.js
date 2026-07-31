// 0.8.47 — upActionNotice (R6): valida code+recovery come closed enum/slug e
// mappa al testo i18n LOCALE. Il recoveryText del server (nodo remoto
// federato incluso) non viene MAI mostrato.
import { describe, it, expect } from 'vitest';
import { upActionNotice } from './fleet-action-notice.js';

describe('upActionNotice', () => {
  it('actionRequired noto -> testo i18n locale, mai il testo del server', () => {
    const res = {
      ok: true, cell: 'Dev', session: 'work-kimi',
      prompt: { injected: false, delivered: false, state: 'skipped-not-ready', reason: 'skipped-not-ready' },
      actionRequired: {
        code: 'KIMI_AUTH_ACTION_REQUIRED',
        recovery: 'kimi-code-config-custom-api-key',
        recoveryText: 'TESTO REMOTO DA NON MOSTRARE',
      },
    };
    const n = upActionNotice(res);
    expect(n.code).toBe('KIMI_AUTH_ACTION_REQUIRED');
    expect(n.recovery).toBe('kimi-code-config-custom-api-key');
    expect(n.text).not.toBe('TESTO REMOTO DA NON MOSTRARE');
    expect(n.text.length).toBeGreaterThan(10);
    expect(n.text).toMatch(/\/config|\/config\)/);
  });

  it('payload remoto con code/slug ignoti o testo arbitrario -> null', () => {
    expect(upActionNotice(null)).toBeNull();
    expect(upActionNotice({})).toBeNull();
    expect(upActionNotice({ ok: true, prompt: { delivered: true } })).toBeNull();
    expect(upActionNotice({ actionRequired: { code: 'DROP TABLE', recovery: 'kimi-cli-login' } })).toBeNull();
    expect(upActionNotice({ actionRequired: { code: 'KIMI_AUTH_ACTION_REQUIRED', recovery: 'slug-arbitrario', recoveryText: 'evil' } })).toBeNull();
    expect(upActionNotice({ actionRequired: { code: 'KIMI_AUTH_ACTION_REQUIRED' } })).toBeNull();
    expect(upActionNotice({ actionRequired: { code: 'CLIENT_INTERACTION_REQUIRED', recoveryText: 'solo testo remoto' } })).toBeNull();
  });

  it('tutti gli slug noti producono testo locale non vuoto', () => {
    for (const recovery of ['kimi-code-consent-yes', 'kimi-code-config-custom-api-key', 'kimi-cli-login', 'client-terminal-dialog']) {
      const n = upActionNotice({ actionRequired: { code: 'CLIENT_INTERACTION_REQUIRED', recovery } });
      expect(n, recovery).not.toBeNull();
      expect(n.text).toBeTruthy();
      expect(n.text).not.toBe(`fleet-recovery-${recovery}`, 'chiave i18n risolta, non grezza');
    }
  });
});
