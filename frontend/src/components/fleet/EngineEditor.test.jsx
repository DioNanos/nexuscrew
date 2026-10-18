import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EngineEditor from './EngineEditor.jsx';
import { blankEngine } from '../../lib/fleet-forms.js';
import { t } from '../../lib/i18n.js';

const catalog = [
  { id: 'claude.native', client: 'claude', clientLabel: 'claude', provider: 'native', label: 'Anthropic', default: true, protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, rc: true },
  { id: 'claude.openrouter', client: 'claude', clientLabel: 'claude', provider: 'openrouter', label: 'OpenRouter', protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, requiresModel: true, credentialEnv: 'OPENROUTER_API_KEY', authConfigured: false, credentialSource: 'missing', credentialUsedBy: ['claude.shared', 'pi.shared'], notice: 'claude-openrouter' },
  { id: 'claude.kimi-code', client: 'claude', clientLabel: 'claude', provider: 'kimi-code', label: 'Kimi Code', protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, model: 'k3[1m]', models: ['k3[1m]'], credentialEnv: 'KIMI_API_KEY', authConfigured: false, credentialSource: 'missing', credentialUsedBy: [], notice: 'claude-kimi-code' },
  { id: 'claude.alibaba-token-plan', client: 'claude', clientLabel: 'claude', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, model: 'qwen3.8-max', models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-flash', 'glm-5.2', 'deepseek-v4-pro'], credentialEnv: 'ALIBABA_CODE_API_KEY', authConfigured: false, credentialSource: 'missing', credentialUsedBy: [], notice: 'alibaba-token-plan' },
  { id: 'claude.zai', client: 'claude', clientLabel: 'claude', provider: 'zai', label: 'Z.AI', protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, credentialEnv: true, defaultEnvKey: 'ZAI_API_KEY', authConfigured: false, credentialSource: 'missing' },
  { id: 'codex-vl.openrouter', client: 'codex-vl', clientLabel: 'codex-vl', provider: 'openrouter', label: 'OpenRouter', protocol: 'openai_responses', permissionPolicyDefault: 'standard', supportsUnsafe: true, requiresModel: true, credentialEnv: 'OPENROUTER_API_KEY', authConfigured: true, credentialSource: 'local', credentialUsedBy: ['codex.shared'], notice: 'codex-openrouter' },
  { id: 'codex-vl.alibaba-token-plan', client: 'codex-vl', clientLabel: 'codex-vl', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', protocol: 'openai_responses', permissionPolicyDefault: 'standard', supportsUnsafe: true, model: 'qwen3.8-max', models: ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash'], credentialEnv: 'ALIBABA_CODE_API_KEY', authConfigured: false, credentialSource: 'missing', credentialUsedBy: [], notice: 'alibaba-token-plan' },
  { id: 'pi.alibaba-token-plan', client: 'pi', clientLabel: 'pi', provider: 'alibaba-token-plan', label: 'Alibaba Token Plan Personal', protocol: 'openai-completions', permissionPolicyDefault: 'standard', supportsUnsafe: false, model: 'qwen3.8-max', models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-flash', 'glm-5.2', 'deepseek-v4-pro'], credentialEnv: 'ALIBABA_CODE_API_KEY', authConfigured: false, credentialSource: 'missing', credentialUsedBy: [], notice: 'alibaba-token-plan' },
  { id: 'agy.native', client: 'agy', clientLabel: 'agy', provider: 'native', label: 'Agy', protocol: 'agy_native', permissionPolicyDefault: 'standard', supportsUnsafe: true, model: '', models: [], rc: false },
  { id: 'kimi.native', client: 'kimi', clientLabel: 'kimi', provider: 'native', label: 'Kimi account (CLI login)', protocol: 'kimi_native', permissionPolicyDefault: 'standard', supportsUnsafe: true, model: '', models: [], rc: false, notice: 'kimi-native' },
];

function profileForm(id) {
  const profile = catalog.find((entry) => entry.id === id);
  return {
    ...blankEngine(), id: profile.id, client: profile.client, provider: profile.provider,
    managedModel: profile.model || (profile.requiresModel ? 'test/model' : ''),
    protocol: profile.protocol, permissionPolicy: profile.permissionPolicyDefault,
  };
}

function Harness({ initial, onSave = vi.fn(), mode = 'new', fetchModels }) {
  const [state, setState] = useState({ mode, form: initial });
  if (!state) return <div>closed</div>;
  return <EngineEditor state={state} setState={setState} busy={false} onSave={onSave} catalog={catalog} fetchModels={fetchModels} />;
}

describe('EngineEditor KEY section', () => {
  beforeEach(() => localStorage.setItem('nc_lang', 'en'));

  it('keeps fixed credentials transient, requires explicit missing-key intent and clears on provider switch', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initial={profileForm('claude.openrouter')} />);
    const key = screen.getByRole('region', { name: 'KEY' });
    expect(within(key).getByDisplayValue('OPENROUTER_API_KEY').readOnly).toBe(true);
    expect(within(key).getByText('Used by: claude.shared, pi.shared')).toBeTruthy();
    expect(within(key).getByText(/optimized for Anthropic models/)).toBeTruthy();
    const input = within(key).getByLabelText('Value for OPENROUTER_API_KEY');
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('new-password');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocorrect')).toBe('off');
    const save = screen.getByRole('button', { name: 'save' });
    expect(save.disabled).toBe(true);
    await user.type(input, 'synthetic-ui-token');
    expect(save.disabled).toBe(false);
    await user.click(within(key).getByRole('button', { name: 'reveal' }));
    expect(within(key).getByLabelText('Value for OPENROUTER_API_KEY').type).toBe('text');

    const providerSelect = container.querySelectorAll('.nc-fleet-pair select')[1];
    fireEvent.change(providerSelect, { target: { value: 'claude.kimi-code' } });
    expect(screen.getByDisplayValue('KIMI_API_KEY')).toBeTruthy();
    expect(screen.getByLabelText('Value for KIMI_API_KEY').value).toBe('');
    expect(container.innerHTML).not.toContain('synthetic-ui-token');

    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.getByText('closed')).toBeTruthy();
  });

  it('allows an explicit key-required creation and treats an existing source as keep-on-blank', async () => {
    const user = userEvent.setup();
    const first = render(<Harness initial={profileForm('claude.openrouter')} />);
    const confirmation = screen.getByText(/Explicitly create the engine without a key/).closest('label').querySelector('input');
    expect(screen.getByRole('button', { name: 'save' }).disabled).toBe(true);
    await user.click(confirmation);
    expect(screen.getByRole('button', { name: 'save' }).disabled).toBe(false);
    first.unmount();

    render(<Harness initial={profileForm('codex-vl.openrouter')} />);
    expect(screen.getByText('local store')).toBeTruthy();
    expect(screen.getByPlaceholderText('blank = keep the current source')).toBeTruthy();
    expect(screen.getByText(/beta and stateless/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'save' }).disabled).toBe(false);
  });

  it('renders all Alibaba profiles with one fixed credential and qwen3.8 default', () => {
    for (const id of ['claude.alibaba-token-plan', 'codex-vl.alibaba-token-plan', 'pi.alibaba-token-plan']) {
      const view = render(<Harness initial={profileForm(id)} />);
      const key = screen.getByRole('region', { name: 'KEY' });
      expect(within(key).getByDisplayValue('ALIBABA_CODE_API_KEY').readOnly).toBe(true);
      expect(screen.getByDisplayValue('qwen3.8-max')).toBeTruthy();
      expect(screen.getByText(/no OpenAI\/PAYG fallback/)).toBeTruthy();
      expect(view.container.querySelector('datalist option[value="qwen3.8-max"]')).toBeTruthy();
      view.unmount();
    }
  });

  it('renders Agy as a primary client with free-text model and standard/unsafe, without credential fields', () => {
    const { container } = render(<Harness initial={profileForm('agy.native')} />);
    const selects = container.querySelectorAll('.nc-fleet-pair select');
    expect(selects[0].value).toBe('agy');
    expect(selects[1].value).toBe('agy.native');
    expect(screen.getByRole('option', { name: 'unsafe · bypass approvals/sandbox' })).toBeTruthy();
    expect(container.querySelector('input[list="nc-managed-models"]')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'KEY' })).toBeNull();
  });

  it('renders native Kimi Code CLI as a distinct client with login notice and no credential fields', () => {
    const { container } = render(<Harness initial={profileForm('kimi.native')} />);
    const selects = container.querySelectorAll('.nc-fleet-pair select');
    expect(selects[0].value).toBe('kimi');
    expect(selects[1].value).toBe('kimi.native');
    // Il client nativo e' distinto dal provider "Kimi Code" dell'adattatore Claude.
    expect(screen.getByRole('option', { name: 'kimi' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'KEY' })).toBeNull();
    expect(screen.getByText(/uses the CLI login \(device code\)/)).toBeTruthy();
    expect(screen.getByText(/Distinct from the Claude Code "Kimi Code" provider/)).toBeTruthy();
    expect(screen.getByRole('option', { name: 'unsafe · bypass approvals/sandbox' })).toBeTruthy();
    expect(container.querySelector('input[list="nc-managed-models"]')).toBeTruthy();
  });

  it('exposes a credential source policy selector for fixed-credential profiles', async () => {
    const user = userEvent.setup();
    render(<Harness initial={profileForm('claude.openrouter')} />);
    const select = screen.getByRole('combobox', { name: 'credential source' });
    expect(select.value).toBe('auto');
    await user.selectOptions(select, 'nexuscrew-store');
    expect(select.value).toBe('nexuscrew-store');
  });

  it('exposes the policy selector for dynamic Z.AI (credentialEnv true), not only fixed-env providers', async () => {
    const user = userEvent.setup();
    render(<Harness initial={profileForm('claude.zai')} />);
    const select = screen.getByRole('combobox', { name: 'credential source' });
    expect(select.value).toBe('auto');
    await user.selectOptions(select, 'nexuscrew-store');
    expect(select.value).toBe('nexuscrew-store');
  });

  it('exposes the policy selector when editing a legacy Z.AI A/P engine, without surfacing A/P as creation options', async () => {
    const user = userEvent.setup();
    // A/P are NOT in the public catalog; an existing engine carries credentialProfile.
    const legacyA = { ...blankEngine(), id: 'claude.zai-a', client: 'claude', provider: 'zai', credentialProfile: 'a', managedModel: 'glm-5.2[1m]', permissionPolicy: 'unsafe', credentialSourcePolicy: 'auto' };
    render(<Harness initial={legacyA} mode="edit" />);
    const select = screen.getByRole('combobox', { name: 'credential source' });
    expect(select.value).toBe('auto');
    await user.selectOptions(select, 'nexuscrew-store');
    expect(select.value).toBe('nexuscrew-store');
    // A/P must NOT be selectable as a profile (creation catalog has no A/P)
    expect(screen.queryByRole('option', { name: 'Z.AI legacy profile' })).toBeNull();
  });
});

// --- panelUrl: fa da default per le celle che lo usano (0.9.1 punto 3) -----
describe('EngineEditor panelUrl', () => {
  it('espone un campo scrivibile per panelUrl, che finisce nel form (managed)', () => {
    const setState = vi.fn();
    const state = { mode: 'edit', form: profileForm('claude.native') };
    render(<EngineEditor state={state} setState={setState} busy={false} onSave={vi.fn()} catalog={catalog} />);
    const field = screen.getByPlaceholderText(t('fleet-panel-url'));
    fireEvent.change(field, { target: { value: 'https://127.0.0.1:6901' } });
    const patched = setState.mock.calls.at(-1)[0];
    const form = typeof patched === 'function' ? patched(state).form : patched.form;
    expect(form.panelUrl).toBe('https://127.0.0.1:6901');
  });

  it('un panelUrl NON-loopback mostra il messaggio che spiega perche', () => {
    const state = { mode: 'edit', form: { ...profileForm('claude.native'), panelUrl: 'http://172.17.0.2:6901' } };
    render(<EngineEditor state={state} setState={vi.fn()} busy={false} onSave={vi.fn()} catalog={catalog} />);
    expect(screen.getByText(t('fleet-panel-url-invalid'))).toBeTruthy();
  });

  it('un panelUrl loopback valido non mostra alcun errore', () => {
    const state = { mode: 'edit', form: { ...profileForm('claude.native'), panelUrl: 'https://127.0.0.1:6901' } };
    render(<EngineEditor state={state} setState={vi.fn()} busy={false} onSave={vi.fn()} catalog={catalog} />);
    expect(screen.queryByText(t('fleet-panel-url-invalid'))).toBeNull();
  });
});

// --- modelli dinamici (lotto 3a): «puoi usare questi» ------------------------
// Il fetcher è SEMPRE un fake iniettato: nessun provider vero, mai.
const DISCOVERY = {
  engine: 'claude.kimi-code', supported: true, source: 'api', status: 'api',
  stale: false, error: '', fetchedAt: 1, cap: 128,
  models: [
    { id: 'k3[1m]', contextWindow: 1048576, fieldSources: { contextWindow: 'user' }, inApi: true },
    { id: 'k3', contextWindow: 262144, tools: true, fieldSources: { contextWindow: 'public', tools: 'api' }, inApi: true },
    { id: 'kimi-for-coding', maxTokens: 8192, fieldSources: { maxTokens: 'backup' }, inApi: false },
  ],
};

describe('EngineEditor model discovery section', () => {
  beforeEach(() => localStorage.setItem('nc_lang', 'en'));

  it('lists the usable models with the per-field provenience, discrete', async () => {
    const fetchModels = vi.fn().mockResolvedValue(DISCOVERY);
    render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={fetchModels} />);
    expect(fetchModels).toHaveBeenCalledWith('claude.kimi-code', false);
    const section = await screen.findByRole('region', { name: 'Models' });
    expect(within(section).getByText('You can use these')).toBeTruthy();
    // Provenienza di ogni campo: etichetta piccola + tooltip.
    expect(within(section).getByTitle('source: user')).toBeTruthy();
    expect(within(section).getByTitle('source: API')).toBeTruthy();
    expect(within(section).getByTitle('source: catalog')).toBeTruthy();
    expect(within(section).getByTitle('source: backup')).toBeTruthy();
    expect(within(section).getByText('context: 1048576')).toBeTruthy();
    expect(within(section).getByText('context: 262144')).toBeTruthy();
    expect(within(section).getByText('tools: true')).toBeTruthy();
    expect(within(section).getByText('output: 8192')).toBeTruthy();
    // Il tetto resta dichiarato: si attivano solo i modelli scelti.
    expect(within(section).getByText(/within the 128-model-per-engine cap/)).toBeTruthy();
  });

  it('marks a model missing from the APIs in RED, still selectable and provable', async () => {
    const fetchModels = vi.fn().mockResolvedValue(DISCOVERY);
    const { container } = render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={fetchModels} />);
    await screen.findByRole('region', { name: 'Models' });
    const row = container.querySelector('.nc-fleet-model-row.nc-model-not-in-api');
    expect(row).toBeTruthy();
    expect(within(row).getByText('not available in the APIs')).toBeTruthy();
    // Nessun blocco: il modello resta impostabile come modello dell'engine.
    const pick = within(row).getByRole('button', { name: 'Use model kimi-for-coding' });
    expect(pick.disabled).toBe(false);
    await userEvent.setup().click(pick);
    expect(screen.getByDisplayValue('kimi-for-coding')).toBeTruthy();
  });

  it('the update button re-fetches with refresh=1 and shows the fresh result', async () => {
    const user = userEvent.setup();
    const fetchModels = vi.fn()
      .mockResolvedValueOnce(DISCOVERY)
      .mockResolvedValueOnce({ ...DISCOVERY, models: [{ id: 'fresh-1', inApi: true }] });
    render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={fetchModels} />);
    await screen.findByRole('region', { name: 'Models' });
    await user.click(screen.getByRole('button', { name: 'Update models' }));
    expect(await screen.findByText('fresh-1')).toBeTruthy();
    expect(fetchModels).toHaveBeenNthCalledWith(2, 'claude.kimi-code', true);
  });

  it('stale data and a network failure are one line each and never block the editor', async () => {
    const stale = { ...DISCOVERY, source: 'cache', stale: true, error: 'network error' };
    const { unmount } = render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={vi.fn().mockResolvedValue(stale)} />);
    expect(await screen.findByText('Stale data: showing the last successful fetch')).toBeTruthy();
    unmount();
    render(<Harness initial={profileForm('agy.native')} fetchModels={vi.fn().mockRejectedValue(new Error('offline'))} />);
    expect(await screen.findByText(/the editor stays usable/)).toBeTruthy();
    // L'editor resta pienamente usabile: il campo modello e il salvataggio non
    // si bloccano (agy: nessun gate di credenziale, quindi save abilitato).
    expect(screen.getByPlaceholderText('default model (optional)').disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'save' }).disabled).toBe(false);
  });

  it('an engine without an HTTP listing says so, and without fetchModels the section stays hidden', async () => {
    render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={vi.fn().mockResolvedValue({ engine: 'claude.kimi-code', supported: false, source: 'unsupported', models: [] })} />);
    expect(await screen.findByText('This engine does not expose a model listing')).toBeTruthy();
    // Senza fetcher (nodo senza capability) la sezione non appare e nulla crasha.
    const bare = render(<Harness initial={profileForm('kimi.native')} />);
    expect(bare.container.querySelector('.nc-fleet-models')).toBeNull();
  });
});
