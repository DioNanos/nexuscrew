import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// A NEW vl.native engine is created from FleetTab's own "add" button, with the
// blank form: nothing is injected into the form. The profile list reaches it the
// way it does on a node, from the definitions the tab fetched.
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
const LEGACY = 'qwen3.8-max-preview';
const READY = {
  state: 'ready', reason: '', inventory: 'config', presetNamesResolvable: true,
  excluded: { notAssembled: 0, invalidIdentifier: 0 },
  options: [opt('zai-A-glm53', 'glm-5.3'), opt('zai-P-glm53', 'glm-5.3', 'absent'), opt(LEGACY, 'chosen-original')],
};

let vlDefault = READY;
function definitions() {
  return {
    engines: [{ id: 'claude.native', label: 'Claude Code', rc: true, managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' }, managedInfo: { configured: true } }],
    cells: [], managedCatalog: catalog,
    ...(vlDefault === undefined ? {} : { vlProfilesDefault: vlDefault }),
  };
}

async function openNewVlEngine(user) {
  render(<FleetTab token="token" readonly={false} />);
  await screen.findByText('Engines');
  const head = [...document.querySelectorAll('.nc-fleet-section-head')].find((h) => /Engines/.test(h.textContent || ''));
  await user.click(head.querySelector('button'));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(dialog.querySelectorAll('.nc-fleet-pair select')[0], { target: { value: 'vl' } });
  return dialog;
}
const options = (dialog) => [...dialog.querySelectorAll('#nc-managed-models option')].map((o) => ({ value: o.getAttribute('value'), label: o.getAttribute('label') }));
const notes = (dialog) => [...dialog.querySelectorAll('[data-vl-note]')].map((n) => n.getAttribute('data-vl-note'));
const modelInput = (dialog) => dialog.querySelector('input[list="nc-managed-models"]');

describe('FleetTab: a new vl.native engine gets the node profile list', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(api)) mock.mockReset();
    vlDefault = READY;
    api.fleetStatus.mockResolvedValue({ provider: 'builtin', capabilities: ['definitions', 'edit', 'define'], engines: [], cells: [] });
    api.fleetDefinitions.mockImplementation(async () => definitions());
    api.fleetCredentialStatus.mockResolvedValue({ credentials: [] });
    api.getRouteConfig.mockResolvedValue({ readonlyDefault: false });
    api.fleetDefineEngine.mockResolvedValue({ ok: true, activeCells: [] });
  });

  it('add engine → choose VL → A and P listed → the id is saved, exactly as typed', async () => {
    const user = userEvent.setup();
    const dialog = await openNewVlEngine(user);
    expect(options(dialog)).toEqual([
      { value: 'zai-A-glm53', label: 'glm-5.3 · zai-A-glm53' },
      { value: 'zai-P-glm53', label: 'glm-5.3 · zai-P-glm53 — key missing' },
      { value: LEGACY, label: `chosen-original · ${LEGACY}` },
    ]);
    await user.type(modelInput(dialog), LEGACY);
    await user.click(within(dialog).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(api.fleetDefineEngine).toHaveBeenCalledTimes(1));
    const def = api.fleetDefineEngine.mock.calls[0][1];
    expect(def.managed.client).toBe('vl');
    expect(def.managed.model).toBe(LEGACY);
    expect(JSON.stringify(def)).not.toContain('vlProfiles');
  });

  it('declaring a binary, a catalog or a fixed profile drops the list (it belongs to another binary or catalog); clearing it brings it back', async () => {
    const user = userEvent.setup();
    const dialog = await openNewVlEngine(user);
    expect(options(dialog)).toHaveLength(3);
    const binary = within(dialog).getByPlaceholderText('absolute path of the vl binary (empty = PATH)');
    await user.type(binary, '/opt/other/vl');
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['unsupported']);
    await user.clear(binary);
    expect(options(dialog)).toHaveLength(3);
    await user.type(within(dialog).getByPlaceholderText('shared vl profile catalog (config.toml, absolute path)'), '/opt/other/config.toml');
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['unsupported']);
  });

  it('a node with no declared profile shows a clear state and offers nothing', async () => {
    vlDefault = { state: 'none', reason: 'x', inventory: 'catalog', presetNamesResolvable: true, excluded: { notAssembled: 0, invalidIdentifier: 0 }, options: [] };
    const user = userEvent.setup();
    const dialog = await openNewVlEngine(user);
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['none']);
    expect(dialog.textContent).toMatch(/No profile is declared/);
  });

  it('a node that sent no listing (older node) says it, and the model stays a free value', async () => {
    vlDefault = undefined;
    const user = userEvent.setup();
    const dialog = await openNewVlEngine(user);
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['unavailable']);
    expect(modelInput(dialog)).toBeTruthy();
  });

  it('a node whose binary is old shows the declared old-binary note, not a list', async () => {
    vlDefault = { state: 'old', reason: 'x', options: [] };
    const user = userEvent.setup();
    const dialog = await openNewVlEngine(user);
    expect(options(dialog)).toEqual([]);
    expect(notes(dialog)).toEqual(['old']);
  });
});
