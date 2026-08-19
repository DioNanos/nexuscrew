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

  // R27 #3: /fleet/up risponde readinessDegraded:true quando la cella vl parte
  // senza marcatore di prontezza (DEC1: degrada e procede). Quel risultato non
  // doveva sparire: la UI diceva solo «attiva» e l'incarico finiva in un
  // terminale che non elabora. Il booleano viaggia anche da un nodo remoto
  // federato, quindi qui si accetta SOLO true esatto e il testo è i18n locale.
  it('readinessDegraded true -> avviso i18n locale, non silenzio', () => {
    const n = upActionNotice({ ok: true, cell: 'Dev', session: 'work-vl', readinessDegraded: true });
    expect(n).not.toBeNull();
    expect(n.code).toBe('READINESS_DEGRADED');
    expect(n.text).toBeTruthy();
    expect(n.text.length).toBeGreaterThan(10);
    expect(n.text).not.toBe('fleet-readiness-degraded', 'chiave i18n risolta, non grezza');
  });

  it('readinessDegraded assente o non-true -> null (nessun falso degrado)', () => {
    expect(upActionNotice({ ok: true, cell: 'Dev', session: 's' })).toBeNull();
    expect(upActionNotice({ ok: true, readinessDegraded: false })).toBeNull();
    expect(upActionNotice({ ok: true, readinessDegraded: 'evil' })).toBeNull();
  });

  it('actionRequired vince su readinessDegraded: entrambi presenti -> recovery, non degrado', () => {
    const n = upActionNotice({
      ok: true,
      readinessDegraded: true,
      actionRequired: { code: 'KIMI_AUTH_ACTION_REQUIRED', recovery: 'kimi-cli-login' },
    });
    expect(n.code).toBe('KIMI_AUTH_ACTION_REQUIRED');
  });
});
