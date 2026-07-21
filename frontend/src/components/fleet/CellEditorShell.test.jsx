import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../lib/i18n.js', () => ({ t: (key) => key }));
vi.mock('../../lib/api.js', () => ({ listDirs: vi.fn() }));

import CellEditor from './CellEditor.jsx';

const engines = [
  { id: 'claude.native', label: 'Claude', managed: { client: 'claude', model: '' } },
  { id: 'shell.local', label: 'Shell', managed: { client: 'shell', model: '' } },
];

describe('CellEditor — Shell locale', () => {
  it('shows the per-cell command and hides model/prompt controls', () => {
    const setState = vi.fn();
    render(<CellEditor
      token="tok" route={[]} targets={[]} location="" setLocation={vi.fn()}
      state={{ mode: 'edit', form: { id: 'Ops', cwd: '/home/u', engine: 'shell.local', boot: false, model: 'stale', prompt: 'preserve', commands: {}, command: '' } }}
      setState={setState} engines={engines} busy={false} onSave={vi.fn()}
    />);
    expect(screen.getByPlaceholderText('fleet-shell-command-placeholder')).toBeTruthy();
    expect(screen.queryByPlaceholderText('fleet-model-override')).toBeNull();
    expect(screen.queryByPlaceholderText('prompt')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('fleet-shell-command-placeholder'), { target: { value: "printf '$HOME' | sed s/x/y/" } });
    expect(setState).toHaveBeenCalledWith(expect.objectContaining({
      form: expect.objectContaining({
        command: "printf '$HOME' | sed s/x/y/",
        commands: { 'shell.local': "printf '$HOME' | sed s/x/y/" },
      }),
    }));
  });
});
