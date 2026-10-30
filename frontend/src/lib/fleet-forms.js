// Pure form/default/normalization helpers for the Fleet editor UI.
//
// These functions own no state and make no API calls; they transform between
// the engine/cell definition shapes served by the backend and the editable
// form state used by FleetTab and its sub-editors. Extracted verbatim from
// FleetTab.jsx so the same transformations are reused (and tested) in one
// place. Behaviour must stay byte-for-byte identical to the original inline
// definitions.

export const blankEngine = () => ({ kind: 'managed', id: 'claude.native', label: '', client: 'claude', provider: 'native', credentialProfile: '', managedModel: '', permissionPolicy: 'unsafe', credentialSourcePolicy: 'auto', displayName: '', protocol: 'anthropic_messages', baseUrl: '', envKey: '', providerId: 'nexuscrew-custom', vlBinary: '', vlConfigFile: '', vlProfile: '', effort: '', command: '', argsText: '', rc: true, promptMode: 'send-keys', promptFlag: '', submit: false, modelFlag: '', modelValue: '', envRows: [], credentialValue: '', credentialReveal: false, allowMissingCredential: false, panelUrl: '' });
export const blankCell = (engine = '') => ({ id: '', cwd: '', engine, boot: false, label: '', model: '', prompt: '', commands: {}, command: '', panelUrl: '' });
export const defaultPermission = (client) => client === 'claude' ? 'unsafe' : 'standard';
export const catalogEntry = (catalog, form) => catalog.find((p) => p.client === form.client && p.provider === form.provider && (p.credentialProfile || '') === (form.credentialProfile || ''));
export const managedLabel = (catalog, form) => catalogEntry(catalog, form)?.label || `${form.client} · ${form.provider}`;

export function engineForm(e) {
  return {
    kind: e.managed ? 'managed' : 'custom',
    id: e.id, label: e.label || '', command: e.command || '', argsText: (e.args || []).join('\n'), rc: !!e.rc,
    client: e.managed?.client || 'claude', provider: e.managed?.provider || 'native', credentialProfile: e.managed?.credentialProfile || '', managedModel: e.managed?.model || '',
    permissionPolicy: e.managed?.permissionPolicy || defaultPermission(e.managed?.client), credentialSourcePolicy: e.managed?.credentialSourcePolicy || 'auto', displayName: e.managed?.displayName || '', protocol: e.managed?.protocol || '', baseUrl: e.managed?.baseUrl || '', envKey: e.managed?.envKey || '', providerId: e.managed?.providerId || 'nexuscrew-custom', vlBinary: e.managed?.vlBinary || '', vlConfigFile: e.managed?.vlConfigFile || '', vlProfile: e.managed?.vlProfile || '', effort: e.managed?.effort || '', modelOptions: e.availableModels || e.managedInfo?.models || [], vlProfiles: e.vlProfiles || e.managedInfo?.vlProfiles || null, vlSaved: { vlBinary: e.managed?.vlBinary || '', vlConfigFile: e.managed?.vlConfigFile || '', vlProfile: e.managed?.vlProfile || '' },
    promptMode: e.promptMode || 'send-keys', promptFlag: e.promptFlag || '', submit: e.submit === 'enter',
    modelFlag: e.model?.flag || '', modelValue: e.model?.value || '',
    envRows: (e.envKeys || []).map((key) => ({ key, value: '', configured: true, remove: false })),
    credentialValue: '', credentialReveal: false, allowMissingCredential: false,
    // panelUrl vive a livello ROOT dell'engine, mai dentro managed (v.
    // lib/fleet/definitions.js parseEngine): stessa forma per managed e custom.
    panelUrl: e.panelUrl || '',
  };
}

// panelUrl: stessa asimmetria gia' in uso per label/prompt/mcp (v. saveCell in
// FleetTab.jsx). In creazione un campo vuoto e' un'INTENZIONE assente ->
// OMESSO dal payload. In modifica un campo svuotato e' un'intenzione esplicita
// -> `null`, che editEngine (lib/fleet/builtin.js) legge come "cancella la
// chiave". Confonderli manderebbe un `null` sulla prima creazione (rifiutato
// dal parser) o, peggio, lascerebbe un panelUrl vuoto indistinguibile da
// "non toccare" quando l'operatore lo svuota davvero.
function withPanelUrl(out, form, creating) {
  const panelUrl = (form.panelUrl || '').trim();
  if (creating) { if (panelUrl) out.panelUrl = panelUrl; } else out.panelUrl = panelUrl || null;
  return out;
}

export function buildEngine(form, creating, catalog = []) {
  if (form.kind === 'managed') {
    const managed = {
      client: form.client, provider: form.provider,
      model: form.client === 'shell' ? '' : (form.managedModel || ''),
      permissionPolicy: form.client === 'shell' ? 'standard' : (form.permissionPolicy || defaultPermission(form.client)),
    };
    if (form.credentialProfile) managed.credentialProfile = form.credentialProfile;
    // 'auto' is the default and stays ABSENT from the serialized spec, so legacy
    // engines migrate no-op; only environment|nexuscrew-store are persisted.
    if (form.credentialSourcePolicy && form.credentialSourcePolicy !== 'auto') managed.credentialSourcePolicy = form.credentialSourcePolicy;
    // vl engine fields. Included only when non-empty, in create AND edit:
    // the managed object is rebuilt wholesale on every save, so an empty field
    // must OMIT the key (a null value would be rejected by the managed-spec
    // validator — omission is how a vl field is cleared from the UI).
    if (form.client === 'vl') {
      for (const key of ['vlBinary', 'vlConfigFile', 'vlProfile', 'effort']) {
        const value = (form[key] || '').trim();
        if (value) managed[key] = value;
      }
    }
    const profile = catalogEntry(catalog, form);
    if (profile?.credentialEnv === true) managed.envKey = form.envKey;
    if (form.provider === 'custom') Object.assign(managed, { displayName: form.displayName, protocol: form.protocol, baseUrl: form.baseUrl, envKey: form.envKey, providerId: form.providerId });
    return withPanelUrl({
      ...(creating ? { id: form.id } : {}), label: form.label || managedLabel(catalog, form), rc: !!form.rc,
      managed,
    }, form, creating);
  }
  const out = {
    ...(creating ? { id: form.id } : {}), label: form.label || form.id, rc: !!form.rc,
    command: form.command, args: form.argsText.split('\n').filter((x) => x !== ''), promptMode: form.promptMode,
  };
  if (form.modelFlag) out.model = { flag: form.modelFlag, value: form.modelValue || '' };
  if (form.promptMode === 'flag') out.promptFlag = form.promptFlag;
  // submit e' l'opt-in F4 del singolo Enter: esiste SOLO con send-keys e SOLO
  // col valore 'enter'. Il backend rifiuta ogni altra combinazione (v.
  // lib/fleet/definitions.js parseEngine): qui si serializza solo l'intenzione
  // valida, e chi passa a promptMode 'flag' deve cancellare la chiave (v.
  // saveEngine in FleetTab.jsx, come per promptFlag).
  if (form.promptMode === 'send-keys' && form.submit) out.submit = 'enter';
  if (creating) out.env = Object.fromEntries(form.envRows.filter((r) => !r.remove && r.key).map((r) => [r.key, r.value]));
  return withPanelUrl(out, form, creating);
}

// ---- vl.native: the model choice is the profile list of the node -------------
//
// The engine and the cell editors show, for `vl.native`, the profiles of the node
// that runs the cell — read by the server from the binary that will run — as
// `<model> · <profile id>`. What is saved and passed is the profile ID. Two
// profiles with one model are two options; a profile with no key stays in the
// list, marked, and the operator decides (the launch names what is missing).
// The built-in presets are never added to the list.

export const vlProfilesReady = (vlProfiles) => !!vlProfiles && vlProfiles.state === 'ready' && Array.isArray(vlProfiles.options);

// Which listing a vl.native FORM may show. The list a saved engine carries was
// read for ITS binary, catalog and fixed profile; a new engine has none and takes
// the node's default listing (`definitions().vlProfilesDefault`), which belongs to
// the default binary and the operator's catalog. Whenever the form declares a
// binary, a catalog or a fixed profile that is not the one the listing was read
// for, the listing is NOT reused: it would describe another binary or catalog.
//   loading      the node's definitions are still being read;
//   unavailable  the node did not provide a listing (older node, or an error);
//   unsupported  the form declares binary/catalog/fixed profile: no list here.
// True while the form still declares the binary, catalog file and fixed profile
// of the engine it was loaded from: the listing and the model inventory the node
// read for THAT engine (form.vlProfiles, form.modelOptions) still describe this
// form. When false they were read for another binary or catalog, and none of
// them may be offered here (see vlFormProfiles and modelDatalistOptions).
export function vlFormSavedValues(form) {
  if (!form) return true;
  const saved = form.vlSaved || { vlBinary: '', vlConfigFile: '', vlProfile: '' };
  return (form.vlBinary || '').trim() === saved.vlBinary
    && (form.vlConfigFile || '').trim() === saved.vlConfigFile
    && (form.vlProfile || '').trim() === saved.vlProfile;
}

export function vlFormProfiles(form, vlDefault, loading) {
  if (!form || form.client !== 'vl' || form.provider !== 'native') return null;
  if (vlFormSavedValues(form) && form.vlProfiles) return form.vlProfiles;
  const cur = { vlBinary: (form.vlBinary || '').trim(), vlConfigFile: (form.vlConfigFile || '').trim(), vlProfile: (form.vlProfile || '').trim() };
  if (!cur.vlBinary && !cur.vlConfigFile && !cur.vlProfile) {
    if (loading) return { state: 'loading', options: [] };
    if (vlDefault && typeof vlDefault === 'object' && vlDefault.state) return vlDefault;
    return { state: 'unavailable', options: [] };
  }
  return { state: 'unsupported', options: [] };
}

export function modelDatalistOptions(values, vlProfiles, t) {
  // Not a vl.native form (another client, or a vl variant that is not native):
  // the plain model list is the datalist, as it has always been.
  if (!vlProfiles) return [...new Set((values || []).filter(Boolean))].map((value) => ({ value, label: undefined }));
  // A node with no declared profile offers nothing: the built-in presets are not
  // its list, and the raw model ids are not profile ids.
  if (vlProfiles.state === 'none') return [];
  if (vlProfilesReady(vlProfiles)) {
    return vlProfiles.options.map((o) => ({
      value: o.value,
      label: o.key === 'absent' ? `${o.label} — ${t('fleet-vl-key-absent')}` : o.label,
    }));
  }
  // An old binary (no profile capability) keeps the legacy plain model list:
  // those models were read for the very binary the state is about, so they are
  // its own — and the caller keeps them out of `values` once the form declares
  // another binary, catalog or fixed profile (v. EngineEditor). Any other state
  // (unsupported, unavailable, invalid, loading, …) would offer a list read for
  // another binary or catalog than the one now in the form: nothing is offered,
  // and vlProfileNotes says which state the form is in.
  if (vlProfiles.state === 'old') {
    return [...new Set((values || []).filter(Boolean))].map((value) => ({ value, label: undefined }));
  }
  return [];
}

// What the node would make of the typed value, decided the way the runtime
// decides it: the exact profile id, else the model of exactly one profile.
export function vlSelectorStatus(vlProfiles, value) {
  if (!vlProfilesReady(vlProfiles) || !value) return { state: 'none' };
  const options = vlProfiles.options;
  const byId = options.find((o) => o.value === value);
  if (byId) return { state: 'profile', profile: byId.value, key: byId.key };
  const byModel = options.filter((o) => o.model === value);
  if (byModel.length === 1) return { state: 'model', profile: byModel[0].value, key: byModel[0].key };
  if (byModel.length > 1) return { state: 'ambiguous', ids: byModel.map((o) => o.value) };
  return { state: 'unknown' };
}

// Notes under the model input, as [{ id, text }] — an empty list when there is
// nothing to say. `t` is the i18n function.
export function vlProfileNotes(vlProfiles, value, t) {
  if (!vlProfiles) return [];
  if (vlProfiles.state === 'old') return [{ id: 'old', text: t('fleet-vl-old-binary') }];
  if (vlProfiles.state === 'invalid') return [{ id: 'invalid', text: t('fleet-vl-inventory-invalid') }];
  if (vlProfiles.state === 'none') return [{ id: 'none', text: t('fleet-vl-none-declared') }];
  if (vlProfiles.state === 'loading') return [{ id: 'loading', text: t('fleet-vl-loading') }];
  if (vlProfiles.state === 'unavailable') return [{ id: 'unavailable', text: t('fleet-vl-unavailable') }];
  if (vlProfiles.state === 'unsupported') return [{ id: 'unsupported', text: t('fleet-vl-unsupported') }];
  if (!vlProfilesReady(vlProfiles)) return [];
  const notes = [];
  const status = vlSelectorStatus(vlProfiles, value);
  if (status.state === 'unknown') notes.push({ id: 'unknown', text: t('fleet-vl-selector-unknown') });
  if (status.state === 'ambiguous') notes.push({ id: 'ambiguous', text: t('fleet-vl-selector-ambiguous').replace('{ids}', status.ids.join(', ')) });
  if ((status.state === 'profile' || status.state === 'model') && status.key === 'absent') notes.push({ id: 'key', text: t('fleet-vl-key-absent-help') });
  const excluded = vlProfiles.excluded ? (vlProfiles.excluded.notAssembled || 0) + (vlProfiles.excluded.invalidIdentifier || 0) : 0;
  if (excluded > 0) notes.push({ id: 'excluded', text: t('fleet-vl-excluded').replace('{n}', String(excluded)) });
  return notes;
}
