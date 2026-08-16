import { describe, it, expect } from 'vitest';
import {
  blankEngine, blankCell, buildEngine, engineForm,
} from './fleet-forms.js';

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

// --- panelUrl: il campo che rende attivabile il pannello (0.9.1 punto 3) ---
// Nessun form lo scriveva: il backend lo valida, l'app lo legge per mostrare
// il bottone, il backup lo conserva — ma senza un gesto per impostarlo la
// funzione non esiste. Qui la serializzazione form -> def, con l'asimmetria
// gia' in uso per label/prompt/mcp: in creazione un campo vuoto e' OMESSO
// (nessuna intenzione), in modifica un campo svuotato manda `null` (il
// backend lo legge come "cancella", v. lib/fleet/builtin.js editCell/editEngine).
describe('fleet-forms panelUrl serialization', () => {
  it('blankCell parte con panelUrl vuoto (opt-in, mai un default inventato)', () => {
    expect(blankCell('claude.native').panelUrl).toBe('');
  });

  it('engineForm legge panelUrl dall engine esistente (root-level, non dentro managed)', () => {
    const withUrl = engineForm({ id: 'x', panelUrl: 'https://127.0.0.1:6901', managed: { client: 'claude', provider: 'native' } });
    expect(withUrl.panelUrl).toBe('https://127.0.0.1:6901');
    const senza = engineForm({ id: 'y', managed: { client: 'claude', provider: 'native' } });
    expect(senza.panelUrl).toBe('');
  });

  it('buildEngine (managed, creazione): panelUrl valorizzato -> root-level, MAI dentro managed', () => {
    const form = { ...blankEngine(), panelUrl: 'https://127.0.0.1:6901' };
    const engine = buildEngine(form, true);
    expect(engine.panelUrl).toBe('https://127.0.0.1:6901');
    expect(engine.managed.panelUrl).toBeUndefined();
  });

  it('buildEngine (managed, creazione): panelUrl vuoto -> OMESSO, non null (nessuna intenzione dichiarata)', () => {
    const engine = buildEngine({ ...blankEngine(), panelUrl: '' }, true);
    expect(Object.prototype.hasOwnProperty.call(engine, 'panelUrl')).toBe(false);
  });

  it('buildEngine (managed, modifica): panelUrl svuotato -> null (cancella, come editEngine se aspetta)', () => {
    const engine = buildEngine({ ...blankEngine(), panelUrl: '' }, false);
    expect(engine.panelUrl).toBeNull();
  });

  it('buildEngine (managed, modifica): panelUrl valorizzato -> il valore, non null', () => {
    const engine = buildEngine({ ...blankEngine(), panelUrl: 'http://localhost:6901' }, false);
    expect(engine.panelUrl).toBe('http://localhost:6901');
  });

  it('buildEngine (custom): stessa asimmetria creazione/modifica del ramo managed', () => {
    const base = { ...blankEngine(), kind: 'custom', command: '/bin/true', argsText: '', envRows: [] };
    expect(buildEngine({ ...base, panelUrl: 'https://[::1]:6901' }, true).panelUrl).toBe('https://[::1]:6901');
    expect(Object.prototype.hasOwnProperty.call(buildEngine({ ...base, panelUrl: '' }, true), 'panelUrl')).toBe(false);
    expect(buildEngine({ ...base, panelUrl: '' }, false).panelUrl).toBeNull();
  });
});
