import { describe, it, expect } from 'vitest';
import {
  blankEngine, blankCell, buildEngine, engineForm,
  modelDatalistOptions, vlSelectorStatus, vlProfileNotes, vlProfilesReady, vlFormProfiles,
} from './fleet-forms.js';
import { DICTS } from './i18n.js';

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

// ---- vl.native: the model choice is the node's profile list ------------------

const option = (value, model, key = 'present') => ({ value, label: `${model} · ${value}`, model, provider: 'anthropic-bearer', contextWindow: 1000000, maxOutputTokens: 131072, source: 'config', key });
const READY = {
  state: 'ready', inventory: 'config', presetNamesResolvable: true,
  excluded: { notAssembled: 0, invalidIdentifier: 0 },
  options: [option('zai-A-glm53', 'glm-5.3'), option('zai-P-glm53', 'glm-5.3', 'absent'), option('a-opus', 'claude-opus-5-5')],
};
const tt = (key) => key;

describe('vl.native profile choice', () => {
  it('lists the profiles as `<model> · <id>`, A and P apart, and nothing else', () => {
    const list = modelDatalistOptions(['ignored-raw-model'], READY, tt);
    expect(list.map((o) => o.value)).toEqual(['zai-A-glm53', 'zai-P-glm53', 'a-opus']);
    expect(list[0].label).toBe('glm-5.3 · zai-A-glm53');
    expect(list[1].label).toBe('glm-5.3 · zai-P-glm53 — fleet-vl-key-absent');
    expect(list.some((o) => o.value === 'ignored-raw-model')).toBe(false);
    expect(new Set(list.map((o) => o.value)).size).toBe(3);
  });

  it('keeps the plain list for an engine with no ready inventory', () => {
    for (const vl of [null, undefined, { state: 'old', options: [] }, { state: 'invalid', options: [] }, { state: 'unsupported', options: [] }]) {
      const list = modelDatalistOptions(['m1', 'm2', 'm1'], vl, tt);
      expect(list).toEqual([{ value: 'm1', label: undefined }, { value: 'm2', label: undefined }]);
    }
    expect(vlProfilesReady(READY)).toBe(true);
    expect(vlProfilesReady({ state: 'ready' })).toBe(false);
  });

  it('judges the typed value as the runtime does: id first, then one model, else ambiguity', () => {
    expect(vlSelectorStatus(READY, 'zai-P-glm53')).toMatchObject({ state: 'profile', profile: 'zai-P-glm53', key: 'absent' });
    expect(vlSelectorStatus(READY, 'claude-opus-5-5')).toMatchObject({ state: 'model', profile: 'a-opus' });
    expect(vlSelectorStatus(READY, 'glm-5.3')).toEqual({ state: 'ambiguous', ids: ['zai-A-glm53', 'zai-P-glm53'] });
    expect(vlSelectorStatus(READY, 'zai')).toEqual({ state: 'unknown' });
    expect(vlSelectorStatus(READY, '')).toEqual({ state: 'none' });
    expect(vlSelectorStatus(null, 'x')).toEqual({ state: 'none' });
  });

  it('explains what the operator needs to know and nothing more', () => {
    const ids = (value, vl = READY) => vlProfileNotes(vl, value, tt).map((n) => n.id);
    expect(ids('zai-A-glm53')).toEqual([]);
    expect(ids('zai-P-glm53')).toEqual(['key']);
    expect(ids('glm-5.3')).toEqual(['ambiguous']);
    expect(ids('ghost')).toEqual(['unknown']);
    expect(ids('')).toEqual([]);
    expect(ids('a-opus', { ...READY, excluded: { notAssembled: 1, invalidIdentifier: 1 } })).toEqual(['excluded']);
    expect(vlProfileNotes({ ...READY, excluded: { notAssembled: 1, invalidIdentifier: 1 } }, 'a-opus', (k) => (k === 'fleet-vl-excluded' ? '{n} out' : k))[0].text).toBe('2 out');
    expect(ids('x', { state: 'old', options: [] })).toEqual(['old']);
    expect(ids('x', { state: 'invalid', options: [] })).toEqual(['invalid']);
    expect(ids('x', null)).toEqual([]);
  });

  it('saves the profile id as the engine model', () => {
    const form = { ...blankEngine(), id: 'vl.native', client: 'vl', provider: 'native', managedModel: 'zai-P-glm53', permissionPolicy: 'standard', protocol: 'vl_native' };
    expect(buildEngine(form, true).managed.model).toBe('zai-P-glm53');
    // the listing is a view: it never reaches the saved engine
    const saved = buildEngine({ ...form, vlProfiles: READY }, true);
    expect(JSON.stringify(saved)).not.toContain('vlProfiles');
  });

  it('carries the listing from the engine into the form', () => {
    const form = engineForm({ id: 'vl.native', label: 'vl', managed: { client: 'vl', provider: 'native', model: 'a-opus', permissionPolicy: 'standard' }, vlProfiles: READY });
    expect(form.vlProfiles).toBe(READY);
    const fromInfo = engineForm({ id: 'vl.native', label: 'vl', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' }, managedInfo: { vlProfiles: READY } });
    expect(fromInfo.vlProfiles).toBe(READY);
  });

  it('has its sentences in every language', () => {
    for (const lang of Object.keys(DICTS)) {
      for (const key of ['fleet-vl-key-absent', 'fleet-vl-key-absent-help', 'fleet-vl-selector-unknown', 'fleet-vl-selector-ambiguous', 'fleet-vl-excluded', 'fleet-vl-old-binary', 'fleet-vl-inventory-invalid', 'fleet-vl-none-declared', 'fleet-vl-loading', 'fleet-vl-unavailable', 'fleet-vl-unsupported']) {
        expect(DICTS[lang][key], `${lang}:${key}`).toBeTruthy();
      }
      expect(DICTS[lang]['fleet-vl-excluded']).toContain('{n}');
      expect(DICTS[lang]['fleet-vl-selector-ambiguous']).toContain('{ids}');
    }
  });
});

// ---- the list of a vl.native FORM: a new engine, and a form that changes what the list belongs to

describe('vl.native form listing', () => {
  const vlForm = (extra = {}) => ({ ...blankEngine(), client: 'vl', provider: 'native', ...extra });
  const NONE = { state: 'none', reason: 'x', options: [] };

  it('is null for anything that is not vl.native', () => {
    expect(vlFormProfiles({ ...blankEngine() }, READY, false)).toBeNull();
    expect(vlFormProfiles(vlForm({ provider: 'anthropic' }), READY, false)).toBeNull();
    expect(vlFormProfiles(null, READY, false)).toBeNull();
  });

  it('a NEW engine takes the node default listing, without it being injected in the form', () => {
    const form = vlForm();
    expect(form.vlProfiles).toBeUndefined();
    expect(vlFormProfiles(form, READY, false)).toBe(READY);
    expect(vlFormProfiles(form, NONE, false)).toBe(NONE);
  });

  it('says loading while the node is read, and unavailable when the node gave nothing', () => {
    expect(vlFormProfiles(vlForm(), undefined, true)).toEqual({ state: 'loading', options: [] });
    expect(vlFormProfiles(vlForm(), undefined, false)).toEqual({ state: 'unavailable', options: [] });
    expect(vlFormProfiles(vlForm(), {}, false)).toEqual({ state: 'unavailable', options: [] });
  });

  it('a declared binary, catalog or fixed profile never reuses the default listing (it belongs to another binary or catalog)', () => {
    for (const extra of [{ vlBinary: '/opt/other/vl' }, { vlConfigFile: '/opt/other/config.toml' }, { vlProfile: 'work' }]) {
      expect(vlFormProfiles(vlForm(extra), READY, false)).toEqual({ state: 'unsupported', options: [] });
    }
    expect(vlFormProfiles(vlForm({ vlBinary: '  ' }), READY, false)).toBe(READY);
  });

  it('a saved engine keeps its own listing while binary, catalog and profile are the saved ones', () => {
    const saved = engineForm({ id: 'vl.native', label: 'vl', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', vlBinary: '/opt/vl/bin/vl' }, managedInfo: { vlProfiles: READY } });
    expect(saved.vlSaved).toEqual({ vlBinary: '/opt/vl/bin/vl', vlConfigFile: '', vlProfile: '' });
    expect(vlFormProfiles(saved, NONE, false)).toBe(READY);
    expect(vlFormProfiles({ ...saved, vlBinary: '/opt/vl/bin/other' }, NONE, false)).toEqual({ state: 'unsupported', options: [] });
    expect(vlFormProfiles({ ...saved, vlConfigFile: '/opt/c.toml' }, NONE, false)).toEqual({ state: 'unsupported', options: [] });
    expect(vlFormProfiles({ ...saved, vlProfile: 'work' }, NONE, false)).toEqual({ state: 'unsupported', options: [] });
    // clearing the declared binary hands the form to the node default, not to the stale list
    expect(vlFormProfiles({ ...saved, vlBinary: '' }, NONE, false)).toBe(NONE);
  });

  it('a node with no declared profile offers nothing and says so; the new states have a note', () => {
    expect(modelDatalistOptions(['anthropic', 'zai'], NONE, tt)).toEqual([]);
    const id = (vl) => vlProfileNotes(vl, 'x', tt).map((n) => n.id);
    expect(id(NONE)).toEqual(['none']);
    expect(id({ state: 'loading', options: [] })).toEqual(['loading']);
    expect(id({ state: 'unavailable', options: [] })).toEqual(['unavailable']);
    expect(id({ state: 'unsupported', options: [] })).toEqual(['unsupported']);
  });
});
