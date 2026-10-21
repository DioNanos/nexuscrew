import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EngineEditor from './EngineEditor.jsx';
import { blankEngine, buildEngine } from '../../lib/fleet-forms.js';
import { t, DICTS } from '../../lib/i18n.js';

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
  { id: 'vl.native', client: 'vl', clientLabel: 'vl', provider: 'native', label: 'VL', protocol: 'vl_native', permissionPolicyDefault: 'standard', supportsUnsafe: false, model: '', models: [], rc: false },
];

function profileForm(id) {
  const profile = catalog.find((entry) => entry.id === id);
  return {
    ...blankEngine(), id: profile.id, client: profile.client, provider: profile.provider,
    managedModel: profile.model || (profile.requiresModel ? 'test/model' : ''),
    protocol: profile.protocol, permissionPolicy: profile.permissionPolicyDefault,
  };
}

function Harness({ initial, onSave = vi.fn(), mode = 'new', fetchModels, onSetModelValue, onForm }) {
  const [state, setState] = useState({ mode, form: initial });
  if (!state) return <div>closed</div>;
  // onForm: osserva la forma corrente. L'editor possiede la forma, non la spec:
  // e' FleetTab (buildEngine) a costruire la spec che viene salvata.
  if (onForm) onForm(state.form);
  return <EngineEditor state={state} setState={setState} busy={false} onSave={onSave} catalog={catalog} fetchModels={fetchModels} onSetModelValue={onSetModelValue} />;
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

// --- lotto 3b: la finestra dei dati mancanti del modello attivo ---------------
// Il dialogo apre da solo quando il modello ATTIVO non ha un campo che serve
// (context/output; gli altri sono opzionali), mostra la proposta del catalogo
// interno GIA' PRECOMPILATA e consegna la conferma al parent, che la scrive
// come valore utente. Il fetcher resta un fake: mai provider veri.
describe('EngineEditor missing-fields dialog', () => {
  beforeEach(() => localStorage.setItem('nc_lang', 'en'));

  const ACTIVE_RESULT = {
    engine: 'claude.kimi-code', supported: true, source: 'api', status: 'api',
    stale: false, error: '', fetchedAt: 1, cap: 128,
    models: [
      // Modello attivo: contesto coperto dall'utente, output mancante, e il
      // catalogo interno propone 8192.
      { id: 'k3[1m]', contextWindow: 1048576, fieldSources: { contextWindow: 'user' }, backupValues: { maxTokens: 8192 }, inApi: true },
      { id: 'k3', contextWindow: 262144, maxTokens: 4096, fieldSources: { contextWindow: 'public', maxTokens: 'api' }, inApi: true },
    ],
  };

  it('opens by itself when the active model lacks a needed field, with the backup pre-filled', async () => {
    const fetchModels = vi.fn().mockResolvedValue(ACTIVE_RESULT);
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3[1m]' }} fetchModels={fetchModels} onSetModelValue={vi.fn().mockResolvedValue({ ok: true })} />);
    const dialog = await screen.findByRole('dialog', { name: 'Missing data' });
    expect(within(dialog).getByText(/The engine needs a datum for k3\[1m\]/)).toBeTruthy();
    // Dice COSA manca: solo l'output, non il contesto che l'utente ha già.
    expect(within(dialog).getByLabelText('output')).toBeTruthy();
    expect(within(dialog).queryByLabelText('context')).toBeNull();
    // La proposta di backup arriva precompilata e dichiarata come tale.
    expect(within(dialog).getByLabelText('output').value).toBe('8192');
    expect(within(dialog).getByText('proposed backup: 8192')).toBeTruthy();
    expect(within(dialog).getByText(/top precedence, never rewritten/)).toBeTruthy();
  });

  it('confirm hands the values to the parent, which owns the user-value write', async () => {
    const onSetModelValue = vi.fn().mockResolvedValue({ ok: true });
    const fetchModels = vi.fn().mockResolvedValue(ACTIVE_RESULT);
    const user = userEvent.setup();
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3[1m]' }} fetchModels={fetchModels} onSetModelValue={onSetModelValue} />);
    await screen.findByRole('dialog', { name: 'Missing data' });
    // L'operatore CAMBIA la proposta prima di confermare.
    const input = screen.getByLabelText('output');
    await user.clear(input);
    await user.type(input, '4096');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onSetModelValue).toHaveBeenCalledWith('claude.kimi-code', 'k3[1m]', { maxTokens: '4096' });
  });

  it('«leave empty» writes nothing and does not nag again for the same defect', async () => {
    const onSetModelValue = vi.fn();
    const fetchModels = vi.fn().mockResolvedValue(ACTIVE_RESULT);
    const user = userEvent.setup();
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3[1m]' }} fetchModels={fetchModels} onSetModelValue={onSetModelValue} />);
    await screen.findByRole('dialog', { name: 'Missing data' });
    await user.click(screen.getByRole('button', { name: 'Leave empty' }));
    expect(onSetModelValue).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Resta la via d'ingresso, il dialogo non si riapre da solo.
    expect(screen.getByRole('button', { name: 'Missing data for k3[1m]' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a complete active model opens nothing, and without the write capability nothing opens either', async () => {
    const fetchModels = vi.fn().mockResolvedValue(ACTIVE_RESULT);
    const clean = render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={fetchModels} onSetModelValue={vi.fn()} />);
    await clean.findByRole('region', { name: 'Models' });
    expect(clean.queryByRole('dialog')).toBeNull();
    clean.unmount();
    const noCap = render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3[1m]' }} fetchModels={fetchModels} />);
    await noCap.findByRole('region', { name: 'Models' });
    expect(noCap.queryByRole('dialog')).toBeNull();
    expect(noCap.queryByRole('button', { name: 'Missing data for k3[1m]' })).toBeNull();
  });

  it('an active model absent from the listing is missing BOTH fields, with no invented backup', async () => {
    const fetchModels = vi.fn().mockResolvedValue(ACTIVE_RESULT);
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'ghost-model' }} fetchModels={fetchModels} onSetModelValue={vi.fn().mockResolvedValue({ ok: true })} />);
    const dialog = await screen.findByRole('dialog', { name: 'Missing data' });
    expect(within(dialog).getByLabelText('context').value).toBe('');
    expect(within(dialog).getByLabelText('output').value).toBe('');
    expect(within(dialog).queryByText(/proposed backup/)).toBeNull();
  });
});

// --- diagnosi dell'autenticazione del listing --------------------------------
// Il blocco `auth` arriva già curato dal nodo: stato della credenziale, envKey
// solo quando l'editor la mostra già, tentativo effettuato e causa a stringa
// fissa. Ogni causa ha la SUA riga, in tutte le lingue del pannello, e la
// riga sopravvive a stale/backup e a un elenco vuoto: non è «nessun modello».
describe('EngineEditor listing auth diagnosis', () => {
  beforeEach(() => localStorage.setItem('nc_lang', 'en'));

  const AUTH_CAUSES = ['missing-key', 'key-rejected', 'access-denied', 'credential-unavailable', 'endpoint-unreachable', 'provider-error', 'invalid-response', 'anonymous-success'];
  const AUTH_I18N_KEYS = [...AUTH_CAUSES.map((c) => `fleet-models-auth-${c}`), 'fleet-models-auth-missing-key-anonymous'];

  const authResult = (auth) => ({
    engine: 'claude.kimi-code', supported: true, source: 'api', status: 'api',
    stale: false, error: '', fetchedAt: 1, cap: 128, auth,
    models: [{ id: 'k3', inApi: true }],
  });

  it('every cause gets its own dedicated fixed line', async () => {
    const lines = {
      'missing-key': /requires authentication: the MY_API_KEY key is not configured/,
      'key-rejected': /submitted key was not accepted/,
      'access-denied': /was denied: it may be permissions or policy/,
      'credential-unavailable': /cannot be read or verified/,
      'endpoint-unreachable': /unreachable \(network or timeout\)/,
      'provider-error': /answered with an error/,
      'invalid-response': /response .* is not valid/,
      'anonymous-success': /obtained without a key/,
    };
    for (const cause of AUTH_CAUSES) {
      const fetchModels = vi.fn().mockResolvedValue(authResult({
        credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause,
      }));
      const { unmount } = render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={fetchModels} />);
      const section = await screen.findByRole('region', { name: 'Models' });
      expect(within(section).getByText(lines[cause])).toBeTruthy();
      unmount();
    }
  });

  it('every panel language carries the fixed strings', () => {
    for (const lang of ['it', 'en', 'es']) {
      for (const key of AUTH_I18N_KEYS) {
        expect(typeof DICTS[lang][key]).toBe('string');
        expect(DICTS[lang][key].length).toBeGreaterThan(0);
      }
    }
  });

  it('missing-key without an env key explains the anonymous request, and invents no name', async () => {
    const fetchModels = vi.fn().mockResolvedValue(authResult({
      credentialState: 'none', attempted: true, credentialSent: false, cause: 'missing-key',
    }));
    render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={fetchModels} />);
    const section = await screen.findByRole('region', { name: 'Models' });
    expect(within(section).getByText(/requests it anonymously: no key is configured/)).toBeTruthy();
    expect(within(section).queryByText(/\{key\}/)).toBeNull();
  });

  it('the diagnosis stays visible over stale data and an empty listing, never replaced by «No models found»', async () => {
    const fetchModels = vi.fn().mockResolvedValue({
      ...authResult({ credentialState: 'configured', envKey: 'MY_API_KEY', attempted: true, credentialSent: true, cause: 'key-rejected' }),
      source: 'cache', status: 'cache', stale: true, error: 'HTTP 401', models: [],
    });
    render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={fetchModels} />);
    const section = await screen.findByRole('region', { name: 'Models' });
    expect(within(section).getByText('Stale data: showing the last successful fetch')).toBeTruthy();
    expect(within(section).getByText(/submitted key was not accepted/)).toBeTruthy();
    expect(within(section).getByText('No models found')).toBeTruthy();
  });

  it('backup data shows the same dedicated line: empty listing, no stale flag', async () => {
    // Backup: nessun dato precedente da servire, ma il tentativo è avvenuto
    // e la sua diagnosi vale quanto sopra i dati stantii.
    const fetchModels = vi.fn().mockResolvedValue({
      ...authResult({ credentialState: 'missing', envKey: 'MY_API_KEY', attempted: true, credentialSent: false, cause: 'missing-key' }),
      source: 'backup', status: 'backup', stale: false, error: 'HTTP 401', models: [],
    });
    render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={fetchModels} />);
    const section = await screen.findByRole('region', { name: 'Models' });
    expect(within(section).getByText(/requires authentication: the MY_API_KEY key is not configured/)).toBeTruthy();
    expect(within(section).getByText('No models found')).toBeTruthy();
  });

  it('no cause, no line: a fresh cache claims nothing about the key', async () => {
    const fetchModels = vi.fn().mockResolvedValue(authResult({
      credentialState: 'missing', envKey: 'MY_API_KEY', attempted: false, credentialSent: false,
    }));
    const { container } = render(<Harness initial={profileForm('claude.kimi-code')} fetchModels={fetchModels} />);
    await screen.findByRole('region', { name: 'Models' });
    const text = container.querySelector('.nc-fleet-models').textContent;
    for (const fragment of ['requires authentication', 'was not accepted', 'was denied', 'cannot be read or verified', 'unreachable', 'answered with an error', 'is not valid', 'without a key']) {
      expect(text).not.toContain(fragment);
    }
  });
});

// --- promozione esplicita: «rendilo mio» e la marca del default -------------
// La marca resta nella VISTA: il campo che viene da models.dev si dichiara
// default, e ogni campo/riga ha un'azione che lo modifica o lo conferma. La
// scrittura passa dallo stesso percorso del dato mancante, e dopo la conferma
// la vista si ricarica: la fonte diventa «utente» per davvero.
describe('EngineEditor make-it-mine', () => {
  beforeEach(() => localStorage.setItem('nc_lang', 'en'));

  const RESULT = {
    engine: 'claude.kimi-code', supported: true, source: 'api', status: 'api',
    stale: false, error: '', fetchedAt: 1, cap: 128,
    models: [{
      id: 'k3', contextWindow: 262144, maxTokens: 4096, tools: true,
      fieldSources: { contextWindow: 'public', maxTokens: 'public', tools: 'api' },
      inApi: true,
    }],
  };

  it('a field from the catalog says «models.dev · default»', async () => {
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={vi.fn().mockResolvedValue(RESULT)} />);
    const section = await screen.findByRole('region', { name: 'Models' });
    expect(within(section).getAllByText('models.dev · default')).toHaveLength(2);
  });

  it('a per-field action confirms that field only, on the same write path, and reloads', async () => {
    const onSetModelValue = vi.fn().mockResolvedValue({ ok: true });
    const fetchModels = vi.fn().mockResolvedValue(RESULT);
    const user = userEvent.setup();
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={fetchModels} onSetModelValue={onSetModelValue} />);
    await screen.findByRole('region', { name: 'Models' });
    await user.click(screen.getByRole('button', { name: 'Make it mine: context of k3' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm the values of k3' });
    expect(within(dialog).getByLabelText('context').value).toBe('262144');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(onSetModelValue).toHaveBeenCalledWith('claude.kimi-code', 'k3', { contextWindow: '262144' });
    // La vista si ricarica DOPO la scrittura: non basta un badge in memoria.
    await waitFor(() => expect(fetchModels).toHaveBeenCalledTimes(2));
  });

  it('a row action groups all five controls, and an explicit No is sent as false', async () => {
    const onSetModelValue = vi.fn().mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={vi.fn().mockResolvedValue(RESULT)} onSetModelValue={onSetModelValue} />);
    await screen.findByRole('region', { name: 'Models' });
    await user.click(screen.getByRole('button', { name: 'Make it mine: k3' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm the values of k3' });
    expect(within(dialog).getByLabelText('context')).toBeTruthy();
    expect(within(dialog).getByLabelText('output')).toBeTruthy();
    expect(within(dialog).getByLabelText('tools').value).toBe('true');
    expect(within(dialog).getByLabelText('vision').value).toBe('');
    await user.selectOptions(within(dialog).getByLabelText('tools'), 'false');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(onSetModelValue).toHaveBeenCalledWith('claude.kimi-code', 'k3', {
      contextWindow: '262144', maxTokens: '4096', tools: 'false', vision: '', reasoning: '',
    });
  });

  it('an out-of-range number shows the error and disables Confirm', async () => {
    const onSetModelValue = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={vi.fn().mockResolvedValue(RESULT)} onSetModelValue={onSetModelValue} />);
    await screen.findByRole('region', { name: 'Models' });
    await user.click(screen.getByRole('button', { name: 'Make it mine: k3' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm the values of k3' });
    const input = within(dialog).getByLabelText('context');
    await user.clear(input);
    await user.type(input, '512');
    expect(within(dialog).getByText(/between 1024 and 100000000/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Confirm' }).disabled).toBe(true);
    expect(onSetModelValue).not.toHaveBeenCalled();
  });

  it('cancel writes nothing, and without the write capability there are no actions', async () => {
    const onSetModelValue = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={vi.fn().mockResolvedValue(RESULT)} onSetModelValue={onSetModelValue} />);
    await screen.findByRole('region', { name: 'Models' });
    await user.click(screen.getByRole('button', { name: 'Make it mine: k3' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'cancel' }));
    expect(onSetModelValue).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={vi.fn().mockResolvedValue(RESULT)} />);
    await screen.findByRole('region', { name: 'Models' });
    expect(screen.queryByRole('button', { name: 'Make it mine: k3' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Make it mine:/ })).toBeNull();
  });
});

// --- an engine without a listing still shows its known ids and defaults ----
// The section is fed by the merge layers: with no API layer, `supported` stays
// false and the note stays honest, but the declared/backup ids and the public
// defaults are there — and the missing-fields dialog must work on them.
describe('EngineEditor discovery without a listing', () => {
  beforeEach(() => localStorage.setItem('nc_lang', 'en'));

  const UNSUPPORTED = {
    engine: 'pi.native', supported: false, source: 'unsupported', status: 'unsupported',
    stale: false, error: '', cap: 128,
    auth: { credentialState: 'none', attempted: false, credentialSent: false },
    models: [{
      id: 'k3', contextWindow: 8192,
      fieldSources: { contextWindow: 'public' },
    }],
  };

  it('shows the note and the catalog default together', async () => {
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={vi.fn().mockResolvedValue(UNSUPPORTED)} />);
    const section = await screen.findByRole('region', { name: 'Models' });
    expect(within(section).getByText('This engine does not expose a model listing')).toBeTruthy();
    expect(within(section).getByText('k3')).toBeTruthy();
    expect(within(section).getByText('models.dev · default')).toBeTruthy();
    expect(within(section).getByText('context: 8192')).toBeTruthy();
  });

  it('opens the missing-fields dialog and writes through the same path', async () => {
    const onSetModelValue = vi.fn().mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<Harness initial={{ ...profileForm('claude.kimi-code'), managedModel: 'k3' }} fetchModels={vi.fn().mockResolvedValue(UNSUPPORTED)} onSetModelValue={onSetModelValue} />);
    const dialog = await screen.findByRole('dialog', { name: 'Missing data' });
    expect(within(dialog).getByLabelText('output').value).toBe('');
    await user.type(within(dialog).getByLabelText('output'), '4096');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(onSetModelValue).toHaveBeenCalledWith('claude.kimi-code', 'k3', { maxTokens: '4096' });
  });
});

// --- vl: i campi del contratto engine vl sono presenti SOLO per il client vl
// I quattro campi (binario, catalogo, profilo, effort) sono il contratto del
// ramo vl: percorsi e nomi, mai segreti. Devono comparire per il client vl e
// restare ASSENTI per ogni altro client — un campo vl che spunta su un engine
// claude verrebbe rifiutato dal validatore del backend, e l'operatore
// scoprirebbe il rifiuto solo al salvataggio.
describe('EngineEditor vl fields', () => {
  beforeEach(() => localStorage.setItem('nc_lang', 'en'));

  const vlForm = () => profileForm('vl.native');

  it('shows the four vl fields for the vl client, with their hints', () => {
    render(<Harness initial={vlForm()} />);
    expect(screen.getByPlaceholderText('absolute path of the vl binary (empty = PATH)')).toBeTruthy();
    expect(screen.getByPlaceholderText('shared vl profile catalog (config.toml, absolute path)')).toBeTruthy();
    expect(screen.getByPlaceholderText('vl profile (-p)')).toBeTruthy();
    expect(screen.getByPlaceholderText('effort (VL_EFFORT)')).toBeTruthy();
    expect(screen.getByText(/Every vl cell gets its own state and config/)).toBeTruthy();
  });

  it('keeps the vl fields out of a non-vl engine', () => {
    render(<Harness initial={profileForm('claude.native')} />);
    expect(screen.queryByPlaceholderText('absolute path of the vl binary (empty = PATH)')).toBeNull();
    expect(screen.queryByPlaceholderText('shared vl profile catalog (config.toml, absolute path)')).toBeNull();
    expect(screen.queryByPlaceholderText('vl profile (-p)')).toBeNull();
    expect(screen.queryByPlaceholderText('effort (VL_EFFORT)')).toBeNull();
  });

  it('edits the vl fields: the form carries them and the spec built from it keeps them', async () => {
    const user = userEvent.setup();
    let form = null;
    const onSave = vi.fn();
    render(<Harness initial={vlForm()} onSave={onSave} onForm={(_f) => { form = _f; }} />);
    await user.type(screen.getByPlaceholderText('absolute path of the vl binary (empty = PATH)'), '/opt/vl/bin/vl');
    await user.type(screen.getByPlaceholderText('shared vl profile catalog (config.toml, absolute path)'), '/opt/vl/config.toml');
    await user.type(screen.getByPlaceholderText('vl profile (-p)'), 'work');
    await user.type(screen.getByPlaceholderText('effort (VL_EFFORT)'), 'high');
    // l'editor possiede la FORMA; la spec la costruisce il padre (FleetTab)
    // con buildEngine. Qui si verifica il passaggio dei due lati: la forma
    // tiene i valori, e la spec che ne nasce li riporta (trim inclusi).
    expect(form.vlBinary).toBe('/opt/vl/bin/vl');
    expect(form.vlConfigFile).toBe('/opt/vl/config.toml');
    expect(form.vlProfile).toBe('work');
    expect(form.effort).toBe('high');
    const saved = buildEngine({ ...form, kind: 'managed' }, true, catalog);
    expect(saved.managed.vlBinary).toBe('/opt/vl/bin/vl');
    expect(saved.managed.vlConfigFile).toBe('/opt/vl/config.toml');
    expect(saved.managed.vlProfile).toBe('work');
    expect(saved.managed.effort).toBe('high');
  });

  it('omits an empty vl field from the spec (that is how a field is cleared)', async () => {
    const user = userEvent.setup();
    let form = null;
    render(<Harness initial={{ ...vlForm(), vlProfile: 'work' }} onForm={(_f) => { form = _f; }} mode="edit" />);
    // l'operatore svuota il campo profilo: nella forma resta vuoto, e la spec
    // che ne nasce OMETTE la chiave — omissione e' il modo con cui il backend
    // cancella (un null verrebbe rifiutato dal validatore).
    await user.clear(screen.getByPlaceholderText('vl profile (-p)'));
    expect(form.vlProfile).toBe('');
    const saved = buildEngine({ ...form, kind: 'managed' }, false, catalog);
    expect(Object.prototype.hasOwnProperty.call(saved.managed, 'vlProfile')).toBe(false);
    // gli altri campi vl mai valorizzati restano assenti dalla spec
    expect(Object.prototype.hasOwnProperty.call(saved.managed, 'vlBinary')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(saved.managed, 'vlConfigFile')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(saved.managed, 'effort')).toBe(false);
  });
});
