import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  status: vi.fn(async () => ({ verbose: false, expiresAt: null })),
  logs: vi.fn(async () => ({ records: [{ seq: 1, ts: '2026-07-21T08:00:00.000Z', level: 'warn', component: 'fleet', code: 'FLEET_ACTION_FAILED', message: 'Fleet action failed', meta: { cell: 'Dev' } }], cursor: 1 })),
  verbose: vi.fn(async () => ({ verbose: true, expiresAt: '2026-07-21T08:15:00.000Z' })),
  clear: vi.fn(async () => ({ verbose: false, expiresAt: null })),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getDiagnosticsStatus: mocks.status,
  getDiagnosticsLogs: mocks.logs,
  setDiagnosticsVerbose: mocks.verbose,
  clearDiagnosticsLogs: mocks.clear,
}));
vi.mock('../lib/i18n.js', () => ({ t: (key) => key }));

import { DiagnosticsTab } from './SettingsPanel.jsx';

const roster = [{ route: ['hub', 'workstation'], label: 'Remote Workstation', name: 'workstation', status: 'up' }];

beforeEach(() => {
  vi.useFakeTimers();
  mocks.status.mockClear(); mocks.logs.mockClear(); mocks.verbose.mockClear(); mocks.clear.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('DiagnosticsTab', () => {
  it('polls only while mounted, uses the routed target and pauses log collection', async () => {
    const view = render(<DiagnosticsTab token="token" roster={roster} readonly={false} />);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.status).toHaveBeenCalledWith('token', []);
    expect(mocks.logs).toHaveBeenCalledWith('token', { after: 0, limit: 200 }, []);
    expect(screen.getByText(/FLEET_ACTION_FAILED/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('diagnostics-target'), { target: { value: 'hub/workstation' } });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.status).toHaveBeenLastCalledWith('token', ['hub', 'workstation']);

    fireEvent.click(screen.getByLabelText('diagnostics-pause'));
    const logCalls = mocks.logs.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(2000); await Promise.resolve(); });
    expect(mocks.status.mock.calls.length).toBeGreaterThan(2);
    expect(mocks.logs.mock.calls.length).toBe(logCalls);

    const statusCalls = mocks.status.mock.calls.length;
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(mocks.status.mock.calls.length).toBe(statusCalls);
  });

  it('enables bounded verbose and exposes readonly-safe controls', async () => {
    const { unmount } = render(<DiagnosticsTab token="token" roster={roster} readonly={false} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('diagnostics-duration'), { target: { value: '300' } });
      fireEvent.click(screen.getByText('enable'));
      await Promise.resolve(); await Promise.resolve();
    });
    expect(mocks.verbose).toHaveBeenCalledWith('token', true, 300, []);
    await act(async () => unmount());

    const readonlyView = render(<DiagnosticsTab token="token" roster={roster} readonly />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText('enable').disabled).toBe(true);
    expect(screen.getByText('diagnostics-clear').disabled).toBe(true);
    await act(async () => readonlyView.unmount());
  });
});
