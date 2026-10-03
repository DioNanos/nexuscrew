import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const calls = vi.hoisted(() => ({ updateNode: vi.fn(), getPushState: vi.fn(), subscribePush: vi.fn() }));
vi.mock('../lib/api.js', async original => ({ ...await original(), updateNode: calls.updateNode }));
vi.mock('../lib/push.js', async original => ({ ...await original(), getPushState: calls.getPushState, subscribePush: calls.subscribePush }));
import NodeSheet from './NodeSheet.jsx';
const node = { name: 'peer', label: 'Peer', direction: 'inbound', kind: 'direct', shared: true, visibility: 'network', tunnel: { status: 'up' }, eventsReceive: false, accessLabel: 'user', accessConfigured: true,
  access: { cellVisibility: 'all', eventsAccess: true, nodeEventsAccess: true, askReplyAccess: false, filesReadAccess: true, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false }, actions: { edit: true } };
function mount() { const refresh = vi.fn().mockResolvedValue(); render(<NodeSheet node={node} nodes={[node]} token="token" readonly={false} refresh={refresh} onClose={() => {}} peerAccessRevision={2} />); return refresh; }
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); localStorage.setItem('nc_lang', 'en'); calls.updateNode.mockResolvedValue({}); calls.getPushState.mockResolvedValue('idle'); calls.subscribePush.mockResolvedValue(true); vi.stubGlobal('Notification', { permission: 'granted' }); });
it('admin preview includes local reception before any write', () => {
  mount(); fireEvent.change(screen.getByLabelText(/Preset to apply/i), { target: { value: 'admin' } });
  expect(document.querySelectorAll('.nc-access-row')).toHaveLength(9); expect(calls.updateNode).not.toHaveBeenCalled();
});
it.each(['granted', 'denied', 'default'])('admin subscribes existing browser permission only when it is %s', async permission => {
  Notification.permission = permission; const refresh = mount(); fireEvent.change(screen.getByLabelText(/Preset to apply/i), { target: { value: 'admin' } }); fireEvent.click(screen.getByText(/Apply the preset/i));
  await waitFor(() => expect(refresh).toHaveBeenCalled()); expect(calls.subscribePush).toHaveBeenCalledTimes(permission === 'granted' ? 1 : 0);
});
it.each(['unsupported', 'denied', 'subscribed'])('admin does not claim or recreate a push subscription in state %s', async state => {
  calls.getPushState.mockResolvedValue(state); const refresh = mount(); fireEvent.change(screen.getByLabelText(/Preset to apply/i), { target: { value: 'admin' } }); fireEvent.click(screen.getByText(/Apply the preset/i));
  await waitFor(() => expect(refresh).toHaveBeenCalled()); expect(calls.subscribePush).not.toHaveBeenCalled();
});
it.each(['user', 'nexushost'])('applying %s leaves browser push preference alone', async preset => {
  const refresh = mount(); fireEvent.change(screen.getByLabelText(/Preset to apply/i), { target: { value: preset } }); fireEvent.click(screen.getByText(/Apply the preset/i)); await waitFor(() => expect(refresh).toHaveBeenCalled()); expect(calls.subscribePush).not.toHaveBeenCalled();
});

afterEach(() => vi.unstubAllGlobals());
