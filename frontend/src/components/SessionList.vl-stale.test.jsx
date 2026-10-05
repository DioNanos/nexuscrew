import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The stale marker must reach the existing sidebar indicator: a vl group
// built from the cache (stale) renders the same warn dot the fleet groups
// use for "not verified", while a freshly read vl group shows the plain
// up dot. The groups are built by vlSidebarGroups (model -> component),
// exactly like useNodes does.

const fixture = vi.hoisted(() => ({ groups: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async (path) => ({ json: async () => (path === '/api/config' ? { version: 'test', instanceId: 'c'.repeat(32) } : { sessions: [] }) })),
  seenKey: (s) => `nc_seen_${s}`,
  fleetStatus: vi.fn(async () => ({ available: false })),
  fleetDefinitions: vi.fn(async () => ({ engines: [] })),
  fleetUp: vi.fn(), fleetDown: vi.fn(), fleetBoot: vi.fn(), killSession: vi.fn(), nodeAction: vi.fn(),
  renameNodeLabel: vi.fn(), setSessionTechnical: vi.fn(),
  getLiveHost: vi.fn(async () => ({ revision: 1, hostCell: null, threadStatus: null })),
  designateHostCell: vi.fn(), clearHostCell: vi.fn(),
  ROSTER_READ_TIMEOUT_MS: 8000,
  getNodes: vi.fn(async () => ({ nodes: [] })),
  getTopology: vi.fn(async () => ({ nodes: [] })),
  getVlNodes: vi.fn(async () => ({ nodes: [] })),
}));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => fixture.groups }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import SessionList from './SessionList.jsx';
import { vlNodeToPeer, vlSidebarGroups } from '../lib/vl-nodes-model.js';

const RAW = {
  nodeId: 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
  label: 'VL-Node-A',
  cell: 'VL-e5e5e5e5',
  pairedAt: 1785601321838,
  online: true,
  lastSeen: 1785982674769,
  generation: 1,
  version: '0.1.0',
  capabilities: ['status'],
  health: { status: 'healthy', state: 'running', uptimeSec: 371554, rssBytes: 2097152 },
  session: { attached: true, profile: 'ollama' },
  inflight: null,
  lastAck: null,
};

const vlGroup = (stale) => vlSidebarGroups([{ ...vlNodeToPeer(RAW), stale }]);

// Renders SessionList and returns the section for the vl group, the way
// useNodes would feed it (model output straight into the component).
const renderVlSection = () => {
  const { container } = render(<SessionList token="t" onPick={vi.fn()} onSettings={vi.fn()} />);
  expect(screen.getByText('VL-Node-A')).toBeTruthy();
  const section = container.querySelector(`section[data-position="${fixture.groups[0].name}"]`);
  expect(section).toBeTruthy();
  return section;
};

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); localStorage.setItem('nc_lang', 'en');
  fixture.groups = [];
});

describe('vl group stale marker in the sidebar indicator', () => {
  it('a stale vl group gets the warn dot with the not-verified notice', () => {
    fixture.groups = vlGroup(true);
    const section = renderVlSection();
    const warnDot = section.querySelector('.dot.warn');
    expect(warnDot).toBeTruthy();
    expect(warnDot.getAttribute('title') || '').toMatch(/not be up to date/);
  });

  it('a fresh vl group shows the plain up dot, no stale notice', () => {
    fixture.groups = vlGroup(false);
    const section = renderVlSection();
    expect(section.querySelector('.dot.warn')).toBeNull();
    expect(section.querySelector('.dot.on')).toBeTruthy();
  });
});
