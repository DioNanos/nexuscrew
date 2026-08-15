import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  setNodeShare: vi.fn(),
  getAudioSettings: vi.fn(),
  setAudioConsent: vi.fn(),
  testLocalAudio: vi.fn(),
  stopLocalAudio: vi.fn(),
  getAudioGroups: vi.fn(),
  saveAudioGroup: vi.fn(),
  deleteAudioGroup: vi.fn(),
  getSettings: vi.fn(),
  getPeers: vi.fn(),
  getVlNodes: vi.fn(),
  getTopology: vi.fn(),
  saveConfig: vi.fn(),
  apiFetch: vi.fn(),
  getDiagnosticsStatus: vi.fn(),
  getDiagnosticsLogs: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  setNodeShare: mocks.setNodeShare,
  getAudioSettings: mocks.getAudioSettings,
  setAudioConsent: mocks.setAudioConsent,
  testLocalAudio: mocks.testLocalAudio,
  stopLocalAudio: mocks.stopLocalAudio,
  getAudioGroups: mocks.getAudioGroups,
  saveAudioGroup: mocks.saveAudioGroup,
  deleteAudioGroup: mocks.deleteAudioGroup,
  getSettings: mocks.getSettings,
  getPeers: mocks.getPeers,
  getVlNodes: mocks.getVlNodes,
  getTopology: mocks.getTopology,
  saveConfig: mocks.saveConfig,
  apiFetch: mocks.apiFetch,
  getDiagnosticsStatus: mocks.getDiagnosticsStatus,
  getDiagnosticsLogs: mocks.getDiagnosticsLogs,
}));
vi.mock('./PairingCard.jsx', () => ({ default: () => null }));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => [] }));

import SettingsPanel, { AudioTab, NodesTab, NotificationSpeechRow } from './SettingsPanel.jsx';
import { resetNotificationSpeechPriming } from '../lib/notification-speech.js';
import { vlNodeToPeer } from '../lib/vl-nodes-model.js';

const hub = {
  name: 'hub', label: 'Hub', ssh: 'hub', direction: 'outbound',
  shared: true, kind: 'direct', tunnel: { status: 'up' }, actions: {},
};

function renderNodes(refresh = vi.fn().mockResolvedValue(undefined)) {
  const view = render(<NodesTab
    token="token" nodes={[hub]} roster={[]} settings={{ deviceName: 'Phone' }}
    readonly={false} refresh={refresh} refreshAliases={vi.fn()}
  />);
  return { ...view, refresh, share: view.container.querySelector('.nc-node-share input') };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  resetNotificationSpeechPriming();
  vi.clearAllMocks();
  mocks.getAudioGroups.mockResolvedValue({ groups: [] });
  mocks.getSettings.mockResolvedValue({
    version: '0.8.40', platform: 'linux', port: 41820,
    service: { installed: true, active: true, boot: true }, autoUpdate: true, alternateScreen: false,
  });
  mocks.getPeers.mockResolvedValue({ peers: [] });
  mocks.getVlNodes.mockResolvedValue({ nodes: [] });
  mocks.getTopology.mockResolvedValue({ nodes: [] });
  mocks.saveConfig.mockResolvedValue({ saved: true });
  mocks.apiFetch.mockResolvedValue({
    json: vi.fn().mockResolvedValue({ readonlyDefault: false, instanceId: 'local-id-0000000' }),
  });
  mocks.getDiagnosticsStatus.mockResolvedValue({ verbose: false });
  mocks.getDiagnosticsLogs.mockResolvedValue({ events: [] });
});

describe('Settings Share partial OFF convergence', () => {
  it.each([
    [
      { shared: false, revoked: false, reconcilePending: true },
      'Private state saved; hub revocation is still pending.',
    ],
    [
      { shared: false, revoked: true, localReconcilePending: true },
      'Hub revocation confirmed; the local tunnel still needs reconciliation.',
    ],
  ])('refreshes on bounded HTTP 502 state and preserves its pending cause', async (data, explanation) => {
    mocks.setNodeShare.mockRejectedValue(Object.assign(new Error('Share partial failure'), { data }));
    const { refresh, share } = renderNodes();
    expect(share).toBeTruthy();
    fireEvent.click(share);
    await waitFor(() => expect(mocks.setNodeShare).toHaveBeenCalledWith('token', 'hub', false));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText((text) => text.includes(explanation))).toBeTruthy();
    expect(screen.getByText((text) => text.includes('Share partial failure'))).toBeTruthy();
  });

  // Una revoca RIUSCITA puo' lasciare il canale in quarantena: il 200 non passa
  // dal catch, quindi senza questo l'operatore leggerebbe soltanto "revocato".
  it('surfaces a quarantined reverse channel even when the call succeeds', async () => {
    mocks.setNodeShare.mockResolvedValue({ name: 'hub', shared: false, revoked: true, reversePoolPending: true });
    const { refresh, share } = renderNodes();
    fireEvent.click(share);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText((text) => text.includes('quarantined, not closed'))).toBeTruthy();
  });

  // Il rollback di Share ON riporta reversePoolPending SENZA shared:false: se il
  // segnale fosse legato a quel campo tornerebbe muto proprio quando il pool
  // puo' essere rimasto vivo.
  it('surfaces a quarantined channel on the error path too, without shared:false', async () => {
    mocks.setNodeShare.mockRejectedValue(Object.assign(new Error('Share non attivato'), {
      data: { error: 'Share non attivato', reversePoolPending: true },
    }));
    const { share } = renderNodes();
    fireEvent.click(share);
    expect(await screen.findByText((text) => text.includes('quarantined, not closed'))).toBeTruthy();
    expect(screen.getByText((text) => text.includes('Share non attivato'))).toBeTruthy();
  });

  // Il titolo e' identico per cause opposte: un peer irraggiungibile, una
  // credenziale rifiutata, una prova di slot non ottenuta. Il server manda gia'
  // `code` e `detail`; finora restavano nella risposta e l'operatore vedeva
  // soltanto il titolo, quindi non poteva distinguere cio' che si ritenta da
  // cio' che va riparato.
  it('shows the typed code and the cause the server already sent', async () => {
    mocks.setNodeShare.mockRejectedValue(Object.assign(new Error('Share non attivato'), {
      data: {
        error: 'Share non attivato',
        code: 'reverse-slot-proof-unavailable',
        detail: 'la prova dello slot reverse non e\' stata ottenuta',
      },
    }));
    const { share } = renderNodes();
    fireEvent.click(share);
    expect(await screen.findByText((text) => text.includes('reverse-slot-proof-unavailable'))).toBeTruthy();
    expect(screen.getByText((text) => text.includes("la prova dello slot reverse non e' stata ottenuta"))).toBeTruthy();
  });

  // Se il dettaglio ripete il titolo non aggiunge nulla: ripeterlo peggiora la
  // leggibilita' proprio nel momento in cui serve leggere in fretta.
  it('does not repeat the detail when it only echoes the title', async () => {
    mocks.setNodeShare.mockRejectedValue(Object.assign(new Error('Share non attivato'), {
      data: { error: 'Share non attivato', detail: 'Share non attivato' },
    }));
    const { share } = renderNodes();
    fireEvent.click(share);
    await waitFor(() => expect(mocks.setNodeShare).toHaveBeenCalled());
    const shown = screen.getByText((text) => text.includes('Share non attivato')).textContent;
    expect(shown.match(/Share non attivato/g)).toHaveLength(1);
  });

  it('stays silent when the channel was demonstrably closed', async () => {
    mocks.setNodeShare.mockResolvedValue({ name: 'hub', shared: false, revoked: true });
    const { share } = renderNodes();
    fireEvent.click(share);
    await waitFor(() => expect(mocks.setNodeShare).toHaveBeenCalled());
    expect(screen.queryByText((text) => text.includes('quarantined, not closed'))).toBeNull();
  });

  it('does not refresh a generic failure without the authoritative shared:false body', async () => {
    mocks.setNodeShare.mockRejectedValue(Object.assign(new Error('transport failed'), { data: { error: 'transport failed' } }));
    const { refresh, share } = renderNodes();
    fireEvent.click(share);
    expect(await screen.findByText((text) => text.includes('transport failed'))).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

import { InputTab } from './SettingsPanel.jsx';

describe('Settings Input KeyBar layout', () => {
  it('renders the KeyBar layout select defaulting to full and writes compact', () => {
    render(<InputTab />);
    const select = screen.getByLabelText('Keypad layout');
    expect(select.value).toBe('full');
    fireEvent.change(select, { target: { value: 'compact' } });
    expect(JSON.parse(localStorage.getItem('nc_input_preferences_v1')).keybarLayout).toBe('compact');
  });

  it('restore input defaults resets the layout to full', () => {
    localStorage.setItem('nc_input_preferences_v1', JSON.stringify({
      terminalKeyboardGesture: 'single-tap', keybarKeepsKeyboardClosed: false,
      voiceKeepsKeyboardClosed: false, showKeybarEnter: false, keybarLayout: 'compact',
    }));
    render(<InputTab />);
    expect(screen.getByLabelText('Keypad layout').value).toBe('compact');
    fireEvent.click(screen.getByRole('button', { name: 'restore input defaults' }));
    const stored = JSON.parse(localStorage.getItem('nc_input_preferences_v1'));
    expect(stored.keybarLayout).toBe('full');
    expect(stored.showKeybarEnter).toBe(true);
  });

  it('stays editable regardless of server READONLY (InputTab is client-only)', () => {
    render(<InputTab />);
    expect(screen.getByLabelText('Keypad layout').disabled).toBe(false);
  });
});

describe('Settings System diagnostics', () => {
  it('keeps legacy diagnostics links compatible and saves alternateScreen from the nested section', async () => {
    const view = render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="diagnostics" />);
    const topTabs = [...view.container.querySelectorAll('.nc-set-tabs .nc-set-tabbtn')].map((button) => button.textContent.trim());
    expect(topTabs).toEqual(['nodes', 'fleet', 'audio', 'input', 'system']);
    expect(screen.getByRole('tab', { name: 'diagnostics' }).getAttribute('aria-selected')).toBe('true');
    const toggle = await screen.findByRole('checkbox', { name: 'alternate screen' });
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith('token', { alternateScreen: true }));
  });

  it('disables the nested terminal toggle in readonly mode', async () => {
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ readonlyDefault: true }) });
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="diagnostics" />);
    expect((await screen.findByRole('checkbox', { name: 'alternate screen' })).disabled).toBe(true);
  });
});

describe('Settings top tab bar', () => {
  it('brings the tab selected at open into view, including System', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="system" />);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }));
    const selectedTab = document.querySelector('.nc-set-tabbtn.on');
    expect(selectedTab?.textContent).toContain('system');
    expect(scrollIntoView.mock.contexts).toContain(selectedTab);
  });

  it('shows only the edge cues that correspond to hidden tabs', async () => {
    const view = render(<SettingsPanel token="token" onClose={vi.fn()} />);
    const tabs = view.container.querySelector('.nc-set-tabs');
    const wrap = view.container.querySelector('.nc-set-tabs-wrap');
    Object.defineProperties(tabs, {
      clientWidth: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 360 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(tabs);
    await waitFor(() => expect(wrap.className).toContain('has-end-overflow'));
    expect(wrap.className).not.toContain('has-start-overflow');

    tabs.scrollLeft = 120;
    fireEvent.scroll(tabs);
    await waitFor(() => expect(wrap.className).toContain('has-start-overflow'));
    expect(wrap.className).toContain('has-end-overflow');
  });
});

describe('Settings notification speech', () => {
  function installSpeech(result = 'success') {
    const speak = vi.fn((utterance) => {
      queueMicrotask(() => {
        if (result === 'success') {
          utterance.onstart?.();
          utterance.onend?.();
        } else if (result === 'error') {
          utterance.onerror?.(new Event('error'));
        }
      });
    });
    const cancel = vi.fn();
    class Utterance {
      constructor(text) { this.text = text; this.lang = ''; }
    }
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true, value: { speak, cancel },
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true, value: Utterance,
    });
    return { speak, cancel };
  }

  it('is default-off, browser-local and editable independently of server READONLY', async () => {
    const speech = installSpeech();
    render(<NotificationSpeechRow />);
    const checkbox = screen.getByRole('checkbox', { name: 'read notifications aloud' });
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);

    fireEvent.click(checkbox);
    expect(JSON.parse(localStorage.getItem('nc_notification_speech_v1'))).toEqual({ enabled: true });
    expect(speech.cancel).toHaveBeenCalledTimes(1);
    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect(speech.speak.mock.calls[0][0]).toMatchObject({
      text: 'NexusCrew. Spoken notifications are active.',
      lang: 'en-US',
    });
    expect(await screen.findByText('Voice test completed.')).toBeTruthy();

    fireEvent.click(checkbox);
    expect(JSON.parse(localStorage.getItem('nc_notification_speech_v1'))).toEqual({ enabled: false });
    expect(speech.cancel).toHaveBeenCalledTimes(2);
  });

  it('offers a repeatable voice test after opt-in', async () => {
    const speech = installSpeech();
    localStorage.setItem('nc_notification_speech_v1', '{"enabled":true}');
    render(<NotificationSpeechRow />);
    fireEvent.click(screen.getByRole('button', { name: 'test voice' }));
    await waitFor(() => expect(speech.speak).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Voice test completed.')).toBeTruthy();
  });

  it('reports a failed native delivery instead of claiming preview success', async () => {
    installSpeech('error');
    render(<NotificationSpeechRow />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'read notifications aloud' }));
    expect(await screen.findByText(
      'The browser did not start the voice test. Interact with the page and try again.',
    )).toBeTruthy();
    expect(screen.queryByText('Voice test completed.')).toBeNull();
  });

  it('cancels and invalidates an in-flight preview when Settings unmounts', () => {
    const speech = installSpeech('pending');
    const view = render(<NotificationSpeechRow />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'read notifications aloud' }));
    expect(speech.cancel).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(speech.cancel).toHaveBeenCalledTimes(2);
  });

  it('fails closed with an explicit unsupported state', () => {
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: undefined });
    render(<NotificationSpeechRow />);
    expect(screen.getByRole('checkbox', { name: 'read notifications aloud' }).disabled).toBe(true);
    expect(screen.getByText('Speech synthesis is not supported in this browser.')).toBeTruthy();
  });
});

describe('Settings native node audio', () => {
  const unavailable = {
    adapter: 'say', installed: true, consent: false, liveness: 'unavailable',
    languages: ['it-IT'], limits: 'a real output device is required',
  };
  const ready = { ...unavailable, consent: true, liveness: 'ready' };

  it('keeps consent node-local, exposes only redacted capability and runs the fixed local test explicitly', async () => {
    mocks.getAudioSettings.mockResolvedValue(unavailable);
    mocks.setAudioConsent.mockResolvedValue(ready);
    mocks.testLocalAudio.mockResolvedValue({ status: 'accepted' });
    render(<AudioTab token="token" readonly={false} />);

    const consent = await screen.findByRole('checkbox', { name: 'allow TTS on this node' });
    expect(screen.getByText('Native node audio')).toBeTruthy();
    expect(screen.getByText(/adapter: say/)).toBeTruthy();
    expect(screen.getByText(/a real output device is required/)).toBeTruthy();
    const testButton = screen.getByRole('button', { name: 'test local audio' });
    expect(testButton.disabled).toBe(true);

    fireEvent.click(consent);
    await waitFor(() => expect(mocks.setAudioConsent).toHaveBeenCalledWith('token', true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'test local audio' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'test local audio' }));
    await waitFor(() => expect(mocks.testLocalAudio).toHaveBeenCalledWith('token'));
    expect(await screen.findByText('The node accepted the test. It does not prove that anyone heard it.')).toBeTruthy();
  });

  it('keeps local Stop available in READONLY while consent and Test remain blocked', async () => {
    mocks.getAudioSettings.mockResolvedValue(ready);
    mocks.stopLocalAudio.mockResolvedValue({ status: 'accepted', stopped: true });
    render(<AudioTab token="token" readonly />);

    const consent = await screen.findByRole('checkbox', { name: 'allow TTS on this node' });
    expect(consent.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'test local audio' }).disabled).toBe(true);
    const stop = screen.getByRole('button', { name: 'stop local audio' });
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    await waitFor(() => expect(mocks.stopLocalAudio).toHaveBeenCalledWith('token'));
    expect(await screen.findByText('Local audio stopped.')).toBeTruthy();
  });

  it('edits named local groups with exact node IDs, without turning them into consent', async () => {
    const local = 'a'.repeat(32); const mac = 'b'.repeat(32);
    mocks.getAudioSettings.mockResolvedValue(ready);
    mocks.getAudioGroups.mockResolvedValue({ groups: [] });
    mocks.saveAudioGroup.mockResolvedValue({ group: { name: 'studio', mode: 'primary-failover', targets: [mac] } });
    render(<AudioTab token="token" readonly={false} settings={{ nodeId: local }} nodes={[{ nodeId: mac, label: 'Mac' }]} />);

    expect(await screen.findByText('Shared audio groups')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'group name' }), { target: { value: 'Studio' } });
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`Mac.*${mac}`) }));
    fireEvent.click(screen.getByRole('button', { name: 'save group' }));
    await waitFor(() => expect(mocks.saveAudioGroup).toHaveBeenCalledWith('token', 'studio', {
      targets: [mac], mode: 'primary-failover',
    }));
    expect(await screen.findByText('studio')).toBeTruthy();
    expect(screen.getByText(/A group is a local delivery preference/)).toBeTruthy();
  });
});

describe('Settings Nodes tab — VL nodes appear in the same list (NC_UI_NODI_VL)', () => {
  const vlPeer = vlNodeToPeer({
    nodeId: 'a'.repeat(32), label: 'N900', cell: 'VL-aaaaaaaa',
    pairedAt: 1700000000000, online: true, lastSeen: 1700000100000,
    health: { state: 'ok', uptimeSec: 3600, rssBytes: 12345, detail: 'nominal' },
    capabilities: ['status', 'health'],
  });

  it('renders a VL node row in NodesTab, in its own group, with real name + online status', () => {
    const view = render(<NodesTab
      token="token" nodes={[hub, vlPeer]} roster={[]} settings={{ deviceName: 'Phone' }}
      readonly={false} refresh={vi.fn().mockResolvedValue(undefined)} refreshAliases={vi.fn()}
    />);
    // Same row markup as any other node — the product owner's "come fosse un nodo
    // nexuscrew, non una sezione nuova": one button, same class, opens the
    // same sheet — just grouped under its own label like hubs/clients/routed
    // already are.
    const row = screen.getByRole('button', { name: /N900/ });
    expect(row.className).toContain('nc-node-row');
    expect(row.querySelector('.nc-dot').className).toContain('on'); // online
    expect(view.container.textContent).toContain('nominal'); // real health, not a placeholder
  });

  it('does NOT fall into the hubs group — a VL leaf device is not an invite hub', () => {
    render(<NodesTab
      token="token" nodes={[vlPeer]} roster={[]} settings={{}} readonly={false}
      refresh={vi.fn().mockResolvedValue(undefined)} refreshAliases={vi.fn()}
    />);
    const hubsGroup = screen.queryByText('Direct hubs')?.closest('.nc-peer-group');
    expect(hubsGroup).toBeFalsy();
    expect(screen.getByText('VL nodes')).toBeTruthy();
  });

  it('shows the offline poll state distinctly, not a Fleet "tunnel down"', () => {
    const offline = { ...vlPeer, online: false, health: null };
    render(<NodesTab
      token="token" nodes={[offline]} roster={[]} settings={{}} readonly={false}
      refresh={vi.fn().mockResolvedValue(undefined)} refreshAliases={vi.fn()}
    />);
    expect(screen.queryByText('tunnel down')).toBeNull();
    expect(screen.getByText('not responding')).toBeTruthy();
  });

  it('SettingsPanel merges /api/vl-nodes into the same nodes list it renders — presentation-only union', async () => {
    mocks.getPeers.mockResolvedValue({ peers: [hub] });
    mocks.getVlNodes.mockResolvedValue({
      instanceId: 'x', protocol: 'vl-node/1',
      nodes: [{
        nodeId: 'b'.repeat(32), label: 'N900', cell: 'VL-bbbbbbbb',
        pairedAt: 1700000000000, online: true, lastSeen: 1700000100000,
        health: { state: 'ok', uptimeSec: 60, rssBytes: 1, detail: 'ok' },
        capabilities: [],
      }],
    });
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />);
    expect(await screen.findByRole('button', { name: /N900/ })).toBeTruthy();
    // The Fleet hub is STILL there — union, not replacement.
    expect(screen.getByRole('button', { name: /Hub/ })).toBeTruthy();
  });

  it('does not break the Fleet-only list when /api/vl-nodes fails (older backend, feature off)', async () => {
    mocks.getPeers.mockResolvedValue({ peers: [hub] });
    mocks.getVlNodes.mockRejectedValue(new Error('not found'));
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />);
    expect(await screen.findByRole('button', { name: /Hub/ })).toBeTruthy();
    // A VL-only failure must not surface as a blocking, scary load error —
    // it is an enrichment, not a requirement.
    expect(screen.queryByText('not found')).toBeNull();
  });

  it('opens the detail sheet on click without crashing (full actions are step 2)', () => {
    render(<NodesTab
      token="token" nodes={[vlPeer]} roster={[]} settings={{}} readonly={false}
      refresh={vi.fn().mockResolvedValue(undefined)} refreshAliases={vi.fn()}
    />);
    fireEvent.click(screen.getByRole('button', { name: /N900/ }));
    expect(screen.getAllByText('N900').length).toBeGreaterThan(1); // riga + foglio
  });
});

// Step 3 (NC_UI_NODI_VL_REMOTI): la federazione di /vl-nodes/* e' stata
// ripristinata (b0e8bd1) — la UI deve aggregare i nodi VL di TUTTI gli owner
// autorizzati (locale + topologia non-stale), non solo il locale. Pattern
// portato da `readVlDirectory` (lib/mcp/tools.js).
describe('Settings Nodes tab — VL nodes across REMOTE owners (NC_UI_NODI_VL_REMOTI)', () => {
  const remoteOwnerTopology = {
    nodes: [{ instanceId: 'remote-vps3-000', route: ['vps3'], label: 'VPS3', stale: false }],
  };
  const remoteVlNode = {
    nodeId: 'c'.repeat(32), label: 'N900', cell: 'VL-cccccccc',
    pairedAt: 1700000000000, online: true, lastSeen: 1700000100000,
    health: { state: 'running', detail: 'nominal' }, capabilities: ['status'],
  };

  it('aggregates VL nodes from a REMOTE owner found in /api/topology, not just local', async () => {
    mocks.getTopology.mockResolvedValue(remoteOwnerTopology);
    // Locale: nessun nodo. Remoto (vps3): un N900.
    mocks.getVlNodes.mockImplementation((token, route = []) => (
      route.length ? Promise.resolve({ instanceId: 'remote-vps3-000', nodes: [remoteVlNode] })
        : Promise.resolve({ nodes: [] })
    ));
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />);
    expect(await screen.findByRole('button', { name: /N900/ })).toBeTruthy();
    // Il fetch remoto e' realmente avvenuto sulla route dell'owner, non solo
    // su quella locale.
    await waitFor(() => expect(mocks.getVlNodes).toHaveBeenCalledWith('token', ['vps3']));
  });

  it('a REMOTE owner that does not respond does NOT hide the rest of the list (invariant 1)', async () => {
    mocks.getPeers.mockResolvedValue({ peers: [hub] });
    mocks.getTopology.mockResolvedValue(remoteOwnerTopology);
    mocks.getVlNodes.mockImplementation((token, route = []) => (
      route.length ? Promise.reject(new Error('timeout')) : Promise.resolve({ nodes: [] })
    ));
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />);
    // La lista Fleet resta visibile e usabile...
    expect(await screen.findByRole('button', { name: /Hub/ })).toBeTruthy();
  });

  it('...and the unresponsive owner is visible, not silently absent (invariant 1)', async () => {
    mocks.getTopology.mockResolvedValue(remoteOwnerTopology);
    mocks.getVlNodes.mockImplementation((token, route = []) => (
      route.length ? Promise.reject(new Error('timeout')) : Promise.resolve({ nodes: [] })
    ));
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />);
    // Un owner muto che sparisce in silenzio si legge come "non ha nodi" —
    // deve invece essere leggibile che NON ha risposto.
    expect(await screen.findByText(/VPS3/)).toBeTruthy();
  });

  it('a LOCAL VL failure keeps the step-1/2 silent-degrade behavior (not flagged as an unresponsive owner)', async () => {
    mocks.getPeers.mockResolvedValue({ peers: [hub] });
    mocks.getTopology.mockResolvedValue({ nodes: [] });
    mocks.getVlNodes.mockRejectedValue(new Error('not found'));
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />);
    expect(await screen.findByRole('button', { name: /Hub/ })).toBeTruthy();
    expect(screen.queryByText('not found')).toBeNull();
    expect(screen.queryByText(/unreachable/i)).toBeNull();
  });

  it('excludes a STALE topology owner — a stale peer is not a fetch target', async () => {
    mocks.getTopology.mockResolvedValue({
      nodes: [{ instanceId: 'stale-000', route: ['old'], label: 'Stale', stale: true }],
    });
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />);
    await waitFor(() => expect(mocks.getVlNodes).toHaveBeenCalled());
    expect(mocks.getVlNodes).not.toHaveBeenCalledWith('token', ['old']);
  });
});

