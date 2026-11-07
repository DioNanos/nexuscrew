import { describe, expect, it } from 'vitest';
import { buildLocalRoster, buildRemoteRoster, cellRuntime, healthDot, promptDeliveryBadge } from './roster-view-model.js';
import { buildNodeGroups } from './nodes-model.js';

// The prompt delivery is its own row: it says what happened to the prompt, not
// what the cell is doing. A cell waiting for a prompt is not "working", and a
// submitted prompt is not "incarico accettato" — the liveness keeps its own
// authority, untouched.
describe('prompt delivery badge', () => {
  const cell = (promptDelivery, extra = {}) => ({ cell: 'x', tmux: true, ...extra, ...(promptDelivery === undefined ? {} : { promptDelivery }) });

  it('is unavailable, never submitted, when the field is not there', () => {
    const out = promptDeliveryBadge(cell(undefined));
    expect(out.badge).toBe('unavailable');
    expect(out.key).toBe('prompt-badge-unavailable');
    expect(out.priorita).toBeLessThan(0);
  });

  it('is unavailable for a field that is not an object', () => {
    for (const v of [null, 'submitted', 42, []]) {
      expect(promptDeliveryBadge(cell(v)).badge, JSON.stringify(v)).toBe('unavailable');
    }
  });

  it('shows pending while the prompt is being delivered', () => {
    const out = promptDeliveryBadge(cell({ state: 'pending', launchId: 'abcdef0123456789', generation: 1 }));
    expect(out.badge).toBe('pending');
    expect(out.key).toBe('prompt-badge-pending');
    expect(out.reason).toBeNull();
  });

  it('keeps submitted quiet', () => {
    const out = promptDeliveryBadge(cell({ state: 'submitted', launchId: 'abcdef0123456789', generation: 1 }));
    expect(out.badge).toBe('submitted');
    expect(out.priorita).toBe(0);
    expect(out.key).toBe('prompt-badge-submitted');
  });

  it('treats the generation skip of a VL bootstrap as normal, without an alarm', () => {
    const out = promptDeliveryBadge(cell({ state: 'skipped', reason: 'vl-bootstrap-generation', launchId: 'abcdef0123456789' }));
    expect(out.badge).toBe('none');
    expect(out.priorita).toBeLessThan(0);
    expect(out.key).toBeNull();
  });

  it('asks for an action when the delivery needs the operator', () => {
    for (const extra of [
      { state: 'skipped', reason: 'prompt-rejected' },
      { state: 'skipped', reason: 'not-ready-auth', notReady: 'not-ready-auth' },
      { state: 'skipped', reason: 'not-ready-consent', notReady: 'not-ready-consent' },
      { state: 'skipped', reason: 'not-ready-onboarding', notReady: 'not-ready-onboarding' },
    ]) {
      const out = promptDeliveryBadge(cell({ ...extra, launchId: 'abcdef0123456789' }));
      expect(out.badge, JSON.stringify(extra)).toBe('action');
      expect(out.key).toBe('prompt-badge-action');
      expect(out.priorita).toBe(3);
    }
  });

  it('is a problem when the delivery stopped for a fault', () => {
    for (const extra of [
      { state: 'skipped', reason: 'failed-pre-paste' },
      { state: 'skipped', reason: 'transport-unsupported' },
      { state: 'skipped', reason: 'deadline-exceeded' },
      { state: 'skipped', reason: 'not-ready', notReady: 'busy' },
    ]) {
      const out = promptDeliveryBadge(cell({ ...extra, launchId: 'abcdef0123456789' }));
      expect(out.badge, JSON.stringify(extra)).toBe('problem');
      expect(out.key).toBe('prompt-badge-problem');
      expect(out.priorita).toBe(2);
    }
    // `unknown` non e' un guasto: e' il backend che dice di non poter
    // attestare. Ha una parola sua, neutra, e non sta in cima agli avvisi.
    for (const extra of [
      { state: 'unknown', reason: 'delivery-unknown' },
      { state: 'unknown', reason: 'record-broken' },
    ]) {
      const out = promptDeliveryBadge(cell({ ...extra, launchId: 'abcdef0123456789' }));
      expect(out.badge, JSON.stringify(extra)).toBe('unverified');
      expect(out.key).toBe('prompt-badge-unverified');
      expect(out.priorita).toBeLessThan(0);
    }
  });

  it('orders the alerts: action, then problem, then pending, then submitted, then the unattested', () => {
    const p = (extra) => promptDeliveryBadge(cell({ launchId: 'abcdef0123456789', generation: 1, ...extra })).priorita;
    expect(p({ state: 'skipped', reason: 'prompt-rejected' }))
      .toBeGreaterThan(p({ state: 'skipped', reason: 'transport-unsupported' }));
    expect(p({ state: 'skipped', reason: 'transport-unsupported' }))
      .toBeGreaterThan(p({ state: 'pending' }));
    expect(p({ state: 'pending' })).toBeGreaterThan(p({ state: 'submitted' }));
    // Non attestato e' un neutro: non sta davanti a una consegna in corso.
    expect(p({ state: 'unknown', reason: 'record-broken' })).toBeLessThan(p({ state: 'submitted' }));
  });

  it('does not show a record of a replaced launch as the current one', () => {
    const out = promptDeliveryBadge(
      cell({ state: 'submitted', launchId: 'aaaaaaaaaaaaaaaa', generation: 1 }, { launchId: 'bbbbbbbbbbbbbbbb' }),
      { currentLaunchId: 'bbbbbbbbbbbbbbbb' },
    );
    expect(out.badge).toBe('stale');
    expect(out.key).toBe('prompt-badge-stale');
    expect(out.reason).toBeNull();
  });

  it('shows the record when it belongs to the current launch', () => {
    const out = promptDeliveryBadge(
      cell({ state: 'submitted', launchId: 'bbbbbbbbbbbbbbbb', generation: 1 }, { launchId: 'bbbbbbbbbbbbbbbb' }),
      { currentLaunchId: 'bbbbbbbbbbbbbbbb' },
    );
    expect(out.badge).toBe('submitted');
  });

  it('carries only bounded codes and i18n keys, never a free text', () => {
    const out = promptDeliveryBadge(cell({
      state: 'skipped', reason: 'failed-pre-paste', launchId: 'abcdef0123456789',
      message: 'Traceback (most recent call last): permission denied',
    }));
    expect(Object.keys(out).sort()).toEqual(['badge', 'freschezza', 'key', 'launchId', 'priorita', 'reason']);
    expect(out.key).toBe('prompt-badge-problem');
    expect(out.reason).toBe('failed-pre-paste');
    for (const v of Object.values(out)) {
      if (typeof v === 'string') expect(v).not.toContain('Traceback');
    }
  });
});

describe('the delivery row is orthogonal to the cell state', () => {
  const withPrompt = {
    cell: 'x', tmux: true, engine: 'vl', key: 'native',
    promptDelivery: { state: 'pending', launchId: 'abcdef0123456789', generation: 1 },
  };

  it('a pending prompt does not make the cell working', () => {
    const senza = cellRuntime({ cell: 'x', tmux: true, engine: 'vl', key: 'native' }, {});
    const con = cellRuntime(withPrompt, {});
    expect(con.working).toBe(senza.working);
    expect(con.subtitle).toBe(senza.subtitle);
    expect(con.stato).toBe(senza.stato);
  });

  it('a submitted prompt does not change the health dot', () => {
    const h = { status: 'healthy', detail: 'ok' };
    expect(healthDot(h)).toBe(healthDot(h, {}));
    expect(healthDot(h)).toBe('on');
    const down = { status: 'down', detail: 'ko' };
    expect(healthDot(down)).toBe('warn');
  });

  it('a terminal reason explains the row only when the cell is not alive', () => {
    const spenta = cellRuntime({
      ...withPrompt,
      active: false,
      tmux: false,
      terminal: { reason: 'lease-lost', ts: 1 },
    }, {});
    expect(spenta.stato).toBe('ferma');
    expect(spenta.terminale).toBe('lease-lost');
    // Viva: il lancio e' finito, la cella no — e la riga dice cosa fa adesso.
    const viva = cellRuntime({
      ...withPrompt,
      active: true,
      terminal: { reason: 'lease-lost', ts: 1 },
    }, { attivita: { stato: 'lavora' } });
    expect(viva.terminale).toBeUndefined();
    expect(viva.stato).toBe('lavora');
  });
});

// Una lettura non autorevole non promuove un'istantanea a stato corrente: il
// peer che non risponde non viene interrogato per degradarla, quindi tocca al
// frontend usare cio' che gia' sa — preserved, stale, lettura non autorevole.
describe('badge e autorità della lettura', () => {
  const storage = { getItem() { return null; }, setItem() {} };
  const consegnata = [{ cell: 'Fixture', tmuxSession: 'fixture-a', tmux: true,
    promptDelivery: { state: 'submitted', launchId: 'old-launch', generation: 0 } }];

  it('un inventario remoto conservato non mostra submitted come corrente', () => {
    const owner = { name: 'leaf', label: 'Leaf', instanceId: 'a'.repeat(32), route: ['hub', 'leaf'], stale: true };
    const groups = buildNodeGroups({
      nodes: [], topology: [owner], remote: {},
      fleet: { 'hub/leaf': { available: false, cells: consegnata, fleetState: 'stale' } },
    });
    const riga = buildRemoteRoster(groups[0], storage).rawItems[0];
    expect(riga.live).toBe(false);
    expect(riga.prompt.badge).not.toBe('submitted');
    expect(riga.prompt.freschezza).toBe('last-known');
  });

  it('una lettura locale non autorevole degrada lo stesso', () => {
    const riga = buildLocalRoster(consegnata, [], new Map(), storage, { autorevole: false, fleetStale: true })[0];
    expect(riga.prompt.badge).not.toBe('submitted');
    expect(riga.prompt.freschezza).toBe('last-known');
  });

  it('una lettura corrente e autorevole resta submitted', () => {
    const riga = buildLocalRoster(consegnata, [], new Map(), storage, { autorevole: true, fleetStale: false })[0];
    expect(riga.prompt.badge).toBe('submitted');
    expect(riga.prompt.freschezza).toBe('current');
  });

  it('una richiesta d azione resta visibile, ma come storico', () => {
    const riga = buildLocalRoster(
      [{ cell: 'Fixture', tmuxSession: 'fixture-a', tmux: true,
        promptDelivery: { state: 'skipped', reason: 'prompt-rejected', launchId: 'old-launch' } }],
      [], new Map(), storage, { autorevole: false, fleetStale: true },
    )[0];
    expect(riga.prompt.badge).toBe('action');
    expect(riga.prompt.freschezza).toBe('last-known');
  });
});
