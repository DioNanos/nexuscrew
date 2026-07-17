// Pure form/default/normalization helpers for the Fleet editor UI.
//
// These functions own no state and make no API calls; they transform between
// the engine/cell definition shapes served by the backend and the editable
// form state used by FleetTab and its sub-editors. Extracted verbatim from
// FleetTab.jsx so the same transformations are reused (and tested) in one
// place. Behaviour must stay byte-for-byte identical to the original inline
// definitions.

export const blankEngine = () => ({ kind: 'managed', id: 'claude.native', label: '', client: 'claude', provider: 'native', credentialProfile: '', managedModel: '', permissionPolicy: 'unsafe', displayName: '', protocol: 'anthropic_messages', baseUrl: '', envKey: '', providerId: 'nexuscrew-custom', command: '', argsText: '', rc: true, promptMode: 'send-keys', promptFlag: '', modelFlag: '', modelValue: '', envRows: [], credentialValue: '', credentialReveal: false, allowMissingCredential: false });
export const blankCell = (engine = '') => ({ id: '', cwd: '', engine, boot: false, model: '', prompt: '' });
export const defaultPermission = (client) => client === 'claude' ? 'unsafe' : 'standard';
export const catalogEntry = (catalog, form) => catalog.find((p) => p.client === form.client && p.provider === form.provider && (p.credentialProfile || '') === (form.credentialProfile || ''));
export const managedLabel = (catalog, form) => catalogEntry(catalog, form)?.label || `${form.client} · ${form.provider}`;

export function engineForm(e) {
  return {
    kind: e.managed ? 'managed' : 'custom',
    id: e.id, label: e.label || '', command: e.command || '', argsText: (e.args || []).join('\n'), rc: !!e.rc,
    client: e.managed?.client || 'claude', provider: e.managed?.provider || 'native', credentialProfile: e.managed?.credentialProfile || '', managedModel: e.managed?.model || '',
    permissionPolicy: e.managed?.permissionPolicy || defaultPermission(e.managed?.client), displayName: e.managed?.displayName || '', protocol: e.managed?.protocol || '', baseUrl: e.managed?.baseUrl || '', envKey: e.managed?.envKey || '', providerId: e.managed?.providerId || 'nexuscrew-custom', modelOptions: e.availableModels || e.managedInfo?.models || [],
    promptMode: e.promptMode || 'send-keys', promptFlag: e.promptFlag || '',
    modelFlag: e.model?.flag || '', modelValue: e.model?.value || '',
    envRows: (e.envKeys || []).map((key) => ({ key, value: '', configured: true, remove: false })),
    credentialValue: '', credentialReveal: false, allowMissingCredential: false,
  };
}

export function buildEngine(form, creating, catalog = []) {
  if (form.kind === 'managed') {
    const managed = { client: form.client, provider: form.provider, model: form.managedModel || '', permissionPolicy: form.permissionPolicy || defaultPermission(form.client) };
    if (form.credentialProfile) managed.credentialProfile = form.credentialProfile;
    const profile = catalogEntry(catalog, form);
    if (profile?.credentialEnv === true) managed.envKey = form.envKey;
    if (form.provider === 'custom') Object.assign(managed, { displayName: form.displayName, protocol: form.protocol, baseUrl: form.baseUrl, envKey: form.envKey, providerId: form.providerId });
    return {
      ...(creating ? { id: form.id } : {}), label: form.label || managedLabel(catalog, form), rc: !!form.rc,
      managed,
    };
  }
  const out = {
    ...(creating ? { id: form.id } : {}), label: form.label || form.id, rc: !!form.rc,
    command: form.command, args: form.argsText.split('\n').filter((x) => x !== ''), promptMode: form.promptMode,
  };
  if (form.modelFlag) out.model = { flag: form.modelFlag, value: form.modelValue || '' };
  if (form.promptMode === 'flag') out.promptFlag = form.promptFlag;
  if (creating) out.env = Object.fromEntries(form.envRows.filter((r) => !r.remove && r.key).map((r) => [r.key, r.value]));
  return out;
}
