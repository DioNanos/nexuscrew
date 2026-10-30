import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// An EDITED vl.native engine: the list a saved engine carries was read for ITS
// binary, catalog and fixed profile. While the form changes any of them the
// datalist must not keep offering that list (the audit's R2: the old profile
// ids stayed visible through the modelOptions fallback). Back at the saved
// values, the node's own list is the datalist again. Other clients keep the
// plain model list they have always had.
const api = vi.hoisted(() => ({
  fleetStatus: vi.fn(), fleetDefinitions: vi.fn(), fleetDefineEngine: vi.fn(), fleetEditEngine: vi.fn(),
  fleetRemoveEngine: vi.fn(), fleetDefineCell: vi.fn(), fleetEditCell: vi.fn(), fleetRemoveCell: vi.fn(),
  fleetRestart: vi.fn(), fleetUp: vi.fn(), fleetDown: vi.fn(), fleetImportCell: vi.fn(),
  fleetRestoreCells: vi.fn(), fleetRestoreEngines: vi.fn(), fleetCredentialStatus: vi.fn(),
  fleetSetCredential: vi.fn(), fleetRemoveCredential: vi.fn(), getRouteConfig: vi.fn(),
}));

vi.mock('../lib/api.js', () => api);

import FleetTab from './FleetTab.jsx';

const catalog = [
  { id: 'claude.native', client: 'claude', clientLabel: 'Claude Code', provider: 'native', label: 'Anthropic', default: true, protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, rc: true },
  { id: 'vl.native', client: 'vl', clientLabel: 'vl', provider: 'native', label: 'VL', default: true, protocol: 'vl_native', permissionPolicyDefault: 'standard', supportsUnsafe: false, model: '', models: [], rc: false },
];

const opt = (value, model, key = 'present') => ({ value, label: `${model} · ${value}`, model, provider: 'anthropic-bearer', contextWindow: null, maxOutputTokens: null, source: 'config', key });
const SAVED_READY = {
  state: 'ready', reason: '', inventory: 'config', presetNamesResolvable: true,
  excluded: { notAssembled: 0, invalidIdentifier: 0 },
  options: [opt('zai-A-glm53', 'glm-5.3'), opt('zai-P-glm53', 'glm-5.3', 'absent'), opt('a-opus', 'claude-opus-5-5')],
};

let vlDefault = SAVED_READY;
let runtimeEngines = [];
let definitionEngines = [];
function definitions() {
  return { engines: definitionEngines, cells: [], managedCatalog: catalog, ...(vlDefault === undefined ? {} : { vlProfilesDefault: vlDefault }) };
}

async function openEdit(user, engineId) {
  render(<FleetTab token="token" readonly={false} />);
  await screen.findByText('Engines');
  const item = [...document.querySelectorAll('.nc-fleet-item')].find((i) => i.textContent.includes(engineId));
  await user.click(within(item).getByRole('button', { name: 'edit' }));
  return screen.getByRole('dialog');
}
const options = (dialog) => [...dialog.querySelectorAll('#nc-managed-models option')].map((o) => ({ value: o.getAttribute('value'), label: o.getAttribute('label') }));
const values = (dialog) => options(dialog).map((o) => o.value);
const notes = (dialog) => [...dialog.querySelectorAll('[data-vl-note]')].map((n) => n.getAttribute('data-vl-note'));
const input = (dialog, placeholder) => within(dialog).getByPlaceholderText(placeholder);

describe('FleetTab: editing a saved vl.native engine never offers another binary\'s or catalog\'s list', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(api)) mock.mockReset();
    vlDefault = SAVED_READY;
    // the node reports the saved engine's own inventory as its model list:
    // these are exactly the ids the fallback used to keep offering
    runtimeEngines = [
      { id: 'vl.native', models: ['zai-A-glm53', 'zai-P-glm53', 'a-opus'], vlProfiles: SAVED_READY },
      { id: 'claude.native', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
    ];
    definitionEngines = [
      { id: 'claude.native', label: 'Claude Code', rc: true, managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' }, managedInfo: { configured: true } },
      { id: 'vl.native', label: 'VL', rc: false, managed: { client: 'vl', provider: 'native', model: 'zai-A-glm53', permissionPolicy: 'standard' }, managedInfo: { configured: true, models: [], vlProfiles: SAVED_READY } },
    ];
    api.fleetStatus.mockImplementation(async () => ({ provider: 'builtin', capabilities: ['definitions', 'edit', 'define'], engines: runtimeEngines, cells: [] }));
    api.fleetDefinitions.mockImplementation(async () => definitions());
    api.fleetCredentialStatus.mockResolvedValue({ credentials: [] });
    api.getRouteConfig.mockResolvedValue({ readonlyDefault: false });
    api.fleetEditEngine.mockResolvedValue({ ok: true, activeCells: [] });
  });

  it('editing binary, catalog or profile drops the saved ids; back at the saved values the node list returns', async () => {
    const user = userEvent.setup();
    const dialog = await openEdit(user, 'vl.native');
    expect(values(dialog)).toEqual(['zai-A-glm53', 'zai-P-glm53', 'a-opus']);

    const binary = input(dialog, 'absolute path of the vl binary (empty = PATH)');
    await user.type(binary, '/opt/other/vl');
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['unsupported']);
    await user.clear(binary);
    expect(values(dialog)).toEqual(['zai-A-glm53', 'zai-P-glm53', 'a-opus']);

    const configFile = input(dialog, 'shared vl profile catalog (config.toml, absolute path)');
    await user.type(configFile, '/opt/other/config.toml');
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['unsupported']);
    await user.clear(configFile);
    expect(values(dialog)).toEqual(['zai-A-glm53', 'zai-P-glm53', 'a-opus']);

    const profile = input(dialog, 'vl profile (-p)');
    await user.type(profile, 'work');
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['unsupported']);
    await user.clear(profile);
    expect(values(dialog)).toEqual(['zai-A-glm53', 'zai-P-glm53', 'a-opus']);
    expect(notes(dialog)).toEqual([]);
  });

  it('an old node default does not resurrect the inventory of a cleared custom binary', async () => {
    const OLD = { state: 'old', reason: 'no profile capability', options: [] };
    vlDefault = OLD;
    // a saved engine with its own binary, whose listing is old: the raw models
    // the runtime still reports for it are that binary's own (legacy behaviour)
    runtimeEngines = [{ id: 'vl.native', models: ['raw-old-model'], vlProfiles: OLD }];
    definitionEngines = [
      { id: 'vl.native', label: 'VL', rc: false, managed: { client: 'vl', provider: 'native', model: 'raw-old-model', permissionPolicy: 'standard', vlBinary: '/opt/vl/custom' }, managedInfo: { configured: true, models: [], vlProfiles: OLD } },
    ];
    const user = userEvent.setup();
    const dialog = await openEdit(user, 'vl.native');
    expect(values(dialog)).toEqual(['raw-old-model']);
    expect(notes(dialog)).toEqual(['old']);
    // clearing the declared binary: the node default is old too, but the saved
    // engine's models were read for the binary just removed — not offered
    await user.clear(input(dialog, 'absolute path of the vl binary (empty = PATH)'));
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['old']);
  });

  it('another client keeps the plain model list it has always had', async () => {
    const user = userEvent.setup();
    const dialog = await openEdit(user, 'claude.native');
    expect(values(dialog)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(dialog.querySelector('[data-vl-note]')).toBeNull();
  });
});
