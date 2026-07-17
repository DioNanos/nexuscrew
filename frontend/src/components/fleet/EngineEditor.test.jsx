import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EngineEditor from './EngineEditor.jsx';
import { blankEngine } from '../../lib/fleet-forms.js';

const catalog = [
  { id: 'claude.native', client: 'claude', clientLabel: 'Claude Code', provider: 'native', label: 'Anthropic', default: true, protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, rc: true },
  { id: 'claude.openrouter', client: 'claude', clientLabel: 'Claude Code', provider: 'openrouter', label: 'OpenRouter', protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, requiresModel: true, credentialEnv: 'OPENROUTER_API_KEY', authConfigured: false, credentialSource: 'missing', credentialUsedBy: ['claude.shared', 'pi.shared'], notice: 'claude-openrouter' },
  { id: 'claude.kimi-code', client: 'claude', clientLabel: 'Claude Code', provider: 'kimi-code', label: 'Kimi Code', protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, model: 'k3[1m]', models: ['k3[1m]'], credentialEnv: 'KIMI_API_KEY', authConfigured: false, credentialSource: 'missing', credentialUsedBy: [], notice: 'claude-kimi-code' },
  { id: 'codex-vl.openrouter', client: 'codex-vl', clientLabel: 'Codex-VL', provider: 'openrouter', label: 'OpenRouter', protocol: 'openai_responses', permissionPolicyDefault: 'standard', supportsUnsafe: true, requiresModel: true, credentialEnv: 'OPENROUTER_API_KEY', authConfigured: true, credentialSource: 'local', credentialUsedBy: ['codex.shared'], notice: 'codex-openrouter' },
];

function profileForm(id) {
  const profile = catalog.find((entry) => entry.id === id);
  return {
    ...blankEngine(), id: profile.id, client: profile.client, provider: profile.provider,
    managedModel: profile.model || (profile.requiresModel ? 'test/model' : ''),
    protocol: profile.protocol, permissionPolicy: profile.permissionPolicyDefault,
  };
}

function Harness({ initial, onSave = vi.fn() }) {
  const [state, setState] = useState({ mode: 'new', form: initial });
  if (!state) return <div>closed</div>;
  return <EngineEditor state={state} setState={setState} busy={false} onSave={onSave} catalog={catalog} />;
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
});
