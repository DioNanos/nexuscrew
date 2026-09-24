import { describe, expect, it, vi } from 'vitest';

// Il confermo del foglio di alimentazione, mobile e desktop, vive qui:
// azione + notice di esito + mapping degli esiti benigni (timeout client e
// sessione già attiva). Il punto che decide se funziona: gli esiti benigni
// NON devono arrivare al foglio come errori — chiudono e lasciano una notice.

vi.mock('./i18n.js', () => ({ t: (k) => k }));

const { fleetActionErrorNotice, runFleetPowerAction } = await import('./fleet-action-notice.js');

function timeoutError() {
  return new DOMException('timeout', 'TimeoutError');
}

function duplicateError() {
  const e = new Error('sessione già in esecuzione');
  e.status = 409;
  e.data = { error: 'sessione già in esecuzione', code: 'SESSION_DUPLICATE', phase: 'preflight' };
  return e;
}

function slowRouteError() {
  const e = new Error('node non raggiungibile');
  e.status = 502;
  e.data = { error: 'node non raggiungibile', cause: 'upstream-timeout' };
  return e;
}

function deadNodeError() {
  const e = new Error('node non raggiungibile');
  e.status = 502;
  e.data = { error: 'node non raggiungibile' };
  return e;
}

describe('fleetActionErrorNotice', () => {
  it('timeout: notice di avvio/arresto in corso a seconda dell\'azione', () => {
    expect(fleetActionErrorNotice(timeoutError(), 'up')).toMatchObject({
      code: 'FLEET_ACTION_TIMEOUT', text: 'fleet-up-slow',
    });
    expect(fleetActionErrorNotice(timeoutError(), 'down')).toMatchObject({
      code: 'FLEET_ACTION_TIMEOUT', text: 'fleet-down-slow',
    });
  });

  it('409 SESSION_DUPLICATE su up: notice «già in esecuzione»', () => {
    expect(fleetActionErrorNotice(duplicateError(), 'up')).toMatchObject({
      code: 'FLEET_SESSION_DUPLICATE', text: 'fleet-up-duplicate',
    });
  });

  it('down non ha esiti benigni: il 409 resta un errore', () => {
    expect(fleetActionErrorNotice(duplicateError(), 'down')).toBe(null);
  });

  it('502 upstream-timeout della route federata: stessa notice del timeout client', () => {
    expect(fleetActionErrorNotice(slowRouteError(), 'up')).toMatchObject({
      code: 'FLEET_ACTION_TIMEOUT', text: 'fleet-up-slow',
    });
    expect(fleetActionErrorNotice(slowRouteError(), 'down')).toMatchObject({
      code: 'FLEET_ACTION_TIMEOUT', text: 'fleet-down-slow',
    });
  });

  it('502 senza cause (nodo davvero irraggiungibile) resta un errore vero', () => {
    expect(fleetActionErrorNotice(deadNodeError(), 'up')).toBe(null);
  });

  it('409 con altro codice, 5xx e input nulli restano errori veri', () => {
    const other = new Error('conflict');
    other.status = 409; other.data = { code: 'OTHER' };
    expect(fleetActionErrorNotice(other, 'up')).toBe(null);
    const boom = new Error('boom'); boom.status = 500;
    expect(fleetActionErrorNotice(boom, 'up')).toBe(null);
    expect(fleetActionErrorNotice(null, 'up')).toBe(null);
  });
});

describe('runFleetPowerAction', () => {
  const powerCell = { cell: 'X', route: [] };
  const fleetApi = (up, down) => ({ fleetUp: up, fleetDown: down });

  it('up ok senza degradi: nessuna notice, esito pieno', async () => {
    const onNotice = vi.fn();
    const up = vi.fn(async () => ({}));
    const out = await runFleetPowerAction({ token: 't', powerCell, payload: { action: 'up', boot: true }, onNotice, fleetApi: fleetApi(up) });
    expect(out).toBe(undefined);
    expect(onNotice).not.toHaveBeenCalled();
    expect(up).toHaveBeenCalledWith('t', { cell: 'X', boot: true }, []);
  });

  it('la route del click vince: powerCell.route arriva all\'azione con engine/model/policy', async () => {
    const onNotice = vi.fn();
    const up = vi.fn(async () => ({}));
    const routed = { cell: 'X', route: ['relay'] };
    await runFleetPowerAction({
      token: 't', powerCell: routed, onNotice, fleetApi: fleetApi(up),
      payload: { action: 'up', boot: true, engine: 'claude.native', model: 'm1', permissionPolicy: 'standard' },
    });
    expect(up).toHaveBeenCalledWith('t', {
      cell: 'X', boot: true, engine: 'claude.native', model: 'm1', permissionPolicy: 'standard',
    }, ['relay']);
  });

  it('up ok con degrado di prontezza: notice mostrata, esito pieno', async () => {
    const onNotice = vi.fn();
    const up = vi.fn(async () => ({ readinessDegraded: true }));
    const out = await runFleetPowerAction({ token: 't', powerCell, payload: { action: 'up' }, onNotice, fleetApi: fleetApi(up) });
    expect(out).toBe(undefined);
    expect(onNotice).toHaveBeenCalledWith('fleet-readiness-degraded');
  });

  it('timeout su up: benigno, notice di avvio in corso', async () => {
    const onNotice = vi.fn();
    const up = vi.fn(() => Promise.reject(timeoutError()));
    const out = await runFleetPowerAction({ token: 't', powerCell, payload: { action: 'up' }, onNotice, fleetApi: fleetApi(up) });
    expect(out).toEqual({ benign: 'FLEET_ACTION_TIMEOUT' });
    expect(onNotice).toHaveBeenCalledWith('fleet-up-slow');
  });

  it('409 SESSION_DUPLICATE su up: benigno, notice «già in esecuzione»', async () => {
    const onNotice = vi.fn();
    const up = vi.fn(() => Promise.reject(duplicateError()));
    const out = await runFleetPowerAction({ token: 't', powerCell, payload: { action: 'up' }, onNotice, fleetApi: fleetApi(up) });
    expect(out).toEqual({ benign: 'FLEET_SESSION_DUPLICATE' });
    expect(onNotice).toHaveBeenCalledWith('fleet-up-duplicate');
  });

  it('errore vero (500): rilanciato, nessuna notice', async () => {
    const onNotice = vi.fn();
    const boom = new Error('boom'); boom.status = 500;
    const up = vi.fn(() => Promise.reject(boom));
    await expect(runFleetPowerAction({ token: 't', powerCell, payload: { action: 'up' }, onNotice, fleetApi: fleetApi(up) }))
      .rejects.toMatchObject({ message: 'boom' });
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('down ok: esito pieno, corpo minimo', async () => {
    const onNotice = vi.fn();
    const down = vi.fn(async () => ({ ok: true, killed: false }));
    const out = await runFleetPowerAction({ token: 't', powerCell, payload: { action: 'down', boot: true }, onNotice, fleetApi: fleetApi(null, down) });
    expect(out).toBe(undefined);
    expect(down).toHaveBeenCalledWith('t', { cell: 'X', boot: true }, []);
  });

  it('timeout su down: benigno, notice di arresto in corso', async () => {
    const onNotice = vi.fn();
    const down = vi.fn(() => Promise.reject(timeoutError()));
    const out = await runFleetPowerAction({ token: 't', powerCell, payload: { action: 'down' }, onNotice, fleetApi: fleetApi(null, down) });
    expect(out).toEqual({ benign: 'FLEET_ACTION_TIMEOUT' });
    expect(onNotice).toHaveBeenCalledWith('fleet-down-slow');
  });

  it('502 upstream-timeout su up: benigno, notice di avvio in corso', async () => {
    const onNotice = vi.fn();
    const up = vi.fn(() => Promise.reject(slowRouteError()));
    const out = await runFleetPowerAction({ token: 't', powerCell, payload: { action: 'up' }, onNotice, fleetApi: fleetApi(up) });
    expect(out).toEqual({ benign: 'FLEET_ACTION_TIMEOUT' });
    expect(onNotice).toHaveBeenCalledWith('fleet-up-slow');
  });
});
