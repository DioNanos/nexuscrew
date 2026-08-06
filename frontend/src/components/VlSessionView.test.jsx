import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api.js', () => ({ getVlNodeEvents: vi.fn() }));

import { getVlNodeEvents } from '../lib/api.js';
import VlSessionView from './VlSessionView.jsx';
import { vlNodeToPeer } from '../lib/vl-nodes-model.js';

// Il peer arriva dalla stessa strada della produzione (vlNodeToPeer su un
// nodo nella forma di GET /api/vl-nodes), non costruito a mano.
const PEER = vlNodeToPeer({
  nodeId: 'f'.repeat(32),
  label: 'N900',
  pairedAt: 1700000000000,
  online: true,
  session: { attached: true, profile: 'ollama' },
  capabilities: ['status'],
  health: { state: 'running' },
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  vi.mocked(getVlNodeEvents).mockReset();
});

describe('VlSessionView — la sessione VL nella vista larga', () => {
  it('reuses VlNodeEvents with the peer coordinates and shows identity + back', async () => {
    vi.mocked(getVlNodeEvents).mockResolvedValue({
      events: [{ seq: 1, kind: 'text', text: 'ciao dal N900' }],
      cursor: 1,
    });
    const onBack = vi.fn();
    render(<VlSessionView peer={PEER} token="token" onBack={onBack} />);
    expect(screen.getByText('N900')).toBeTruthy();
    expect(screen.getByText(/ollama/)).toBeTruthy();
    // il canale è LO STESSO componente in sola lettura, con nodeId e route
    // del peer — non un secondo fetch inventato.
    await waitFor(() => expect(getVlNodeEvents).toHaveBeenCalledWith('token', PEER.nodeId, 0, []));
    await waitFor(() => expect(screen.getByText('ciao dal N900')).toBeTruthy());
    fireEvent.click(screen.getByTitle('back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('renders nothing without a peer instead of a broken frame', () => {
    const { container } = render(<VlSessionView peer={null} token="token" onBack={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
