import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptDeviceId, applyPrefs, collectPrefs, DEVICE_KEY, exportPrefs, importPrefs, isEmptyPrefs, resolveConflict, SYNC_KEY, syncPrefs } from './prefs-sync.js';

// Server finto con la stessa semantica di /api/prefs: dispositivi emessi dal server, If-Match, whitelist.
function fakeServer() {
  const devices = new Map(); let n = 0; const calls = [];
  const res = (status, body, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
  const request = async (method, path, { headers = {}, body } = {}) => {
    calls.push({ method, path, device: headers['x-nc-device'] || null });
    if (method === 'POST' && path === '/api/prefs/devices') { const id = String(++n).padStart(32, '0'); devices.set(id, { revision: 0, data: null }); return res(201, { deviceId: id }); }
    const d = devices.get(headers['x-nc-device']);
    if (!d) return res(404, { code: 'unknown-device' });
    if (method === 'GET') return res(200, { revision: d.revision, data: d.data });
    const rev = Number(String(headers['if-match'] || '').replace(/"/g, ''));
    if (rev !== d.revision) return res(409, { code: 'revision-conflict', current: { revision: d.revision, data: d.data } });
    const data = JSON.parse(body).data;
    if (isEmptyPrefs(data) && !isEmptyPrefs(d.data)) return res(422, { code: 'refuse-empty-overwrite' });
    d.revision += 1; d.data = data;
    return res(200, { revision: d.revision });
  };
  return { request, devices, calls };
}

const full = { pins: ['n:a'], orders: { 'id:aa': ['n:a', 'n:b'] }, views: { local: { open: false, filter: 'all' } }, nodeOrder: ['id:aa'] };
const seed = (p = full) => {
  localStorage.setItem('nc_pins', JSON.stringify(p.pins));
  localStorage.setItem('nc_sidebar_order_v1', JSON.stringify(p.orders));
  localStorage.setItem('nc_sidebar_views_v1', JSON.stringify(p.views));
  localStorage.setItem('nc_node_order_v1', JSON.stringify(p.nodeOrder));
};

beforeEach(() => localStorage.clear());

describe('preferenze per dispositivo sul server (R1)', () => {
  it('primo sync con preferenze locali: emette il dispositivo e carica la copia', async () => {
    seed(); const s = fakeServer();
    const r = await syncPrefs({ request: s.request });
    expect(r.status).toBe('uploaded');
    expect(localStorage.getItem(DEVICE_KEY)).toBe('0'.repeat(31) + '1');
    expect([...s.devices.values()][0].data).toEqual(full);
  });

  it('primo sync con storage VUOTO e nessuna copia: non carica mai default vuoti', async () => {
    const s = fakeServer();
    const r = await syncPrefs({ request: s.request });
    expect(r.status).toBe('synced');
    expect(s.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('wipe dello storage: le preferenze tornano dalla copia del server (stesso deviceId dal link)', async () => {
    seed(); const s = fakeServer();
    await syncPrefs({ request: s.request });
    const id = localStorage.getItem(DEVICE_KEY);
    localStorage.clear(); adoptDeviceId(id);
    const r = await syncPrefs({ request: s.request });
    expect(r.status).toBe('restored');
    expect(collectPrefs()).toEqual(full);
  });

  it('wipe PRIMA del primo backup: non c\'e\' nulla da ritrovare e non si inventa nulla', async () => {
    const s = fakeServer();
    const r = await syncPrefs({ request: s.request });
    expect(r.status).toBe('synced');
    expect(isEmptyPrefs(collectPrefs())).toBe(true);
  });

  it('non sovrascrive mai preferenze locali non vuote con la copia server: segnala il conflitto', async () => {
    seed(); const s = fakeServer();
    await syncPrefs({ request: s.request });
    const id = localStorage.getItem(DEVICE_KEY);
    localStorage.clear(); adoptDeviceId(id);
    seed({ ...full, pins: ['n:solo-locale'] });
    const r = await syncPrefs({ request: s.request });
    expect(r.status).toBe('conflict');
    expect(collectPrefs().pins).toEqual(['n:solo-locale']);
    expect(r.conflict.server.pins).toEqual(['n:a']);
    expect([...s.devices.values()][0].data.pins).toEqual(['n:a']);
  });

  it('resolveConflict: «tieni questo» carica, «usa il server» ripristina', async () => {
    seed(); const s = fakeServer();
    await syncPrefs({ request: s.request });
    const id = localStorage.getItem(DEVICE_KEY);
    localStorage.clear(); adoptDeviceId(id); seed({ ...full, pins: ['n:x'] });
    const c = (await syncPrefs({ request: s.request })).conflict;
    expect((await resolveConflict('local', c, { request: s.request })).status).toBe('uploaded');
    expect([...s.devices.values()][0].data.pins).toEqual(['n:x']);
    localStorage.clear(); adoptDeviceId(id); seed({ ...full, pins: ['n:y'] });
    const c2 = (await syncPrefs({ request: s.request })).conflict;
    expect((await resolveConflict('server', c2, { request: s.request })).status).toBe('restored');
    expect(collectPrefs().pins).toEqual(['n:x']);
  });

  it('modifica locale dopo un sync: si carica con la revisione giusta', async () => {
    seed(); const s = fakeServer();
    await syncPrefs({ request: s.request });
    localStorage.setItem('nc_pins', JSON.stringify(['n:a', 'n:c']));
    expect((await syncPrefs({ request: s.request })).status).toBe('uploaded');
    expect([...s.devices.values()][0].data.pins).toEqual(['n:a', 'n:c']);
    expect((await syncPrefs({ request: s.request })).status).toBe('synced');
  });

  it('due dispositivi con lo stesso token restano isolati', async () => {
    const s = fakeServer(); seed();
    await syncPrefs({ request: s.request });
    localStorage.clear(); seed({ ...full, pins: ['n:altro'] });
    await syncPrefs({ request: s.request });
    const datas = [...s.devices.values()].map((d) => d.data.pins);
    expect(datas).toEqual([['n:a'], ['n:altro']]);
  });

  it('dispositivo sconosciuto al server (dati del nodo persi): ne chiede uno nuovo senza toccare le locali', async () => {
    seed(); const s = fakeServer();
    adoptDeviceId('e'.repeat(32));
    const r = await syncPrefs({ request: s.request });
    expect(r.status).toBe('uploaded');
    expect(localStorage.getItem(DEVICE_KEY)).not.toBe('e'.repeat(32));
    expect(collectPrefs()).toEqual(full);
  });

  it('rete/errore: mai un\'eccezione, stato dichiarato, preferenze locali intatte', async () => {
    seed();
    const r = await syncPrefs({ request: async () => { throw new Error('offline'); } });
    expect(r.status).toBe('offline');
    expect(collectPrefs()).toEqual(full);
  });

  it('adoptDeviceId non sostituisce un id gia\' presente (un telefono che ha un profilo non lo cambia)', () => {
    adoptDeviceId('a'.repeat(32)); adoptDeviceId('b'.repeat(32)); adoptDeviceId('zz');
    expect(localStorage.getItem(DEVICE_KEY)).toBe('a'.repeat(32));
  });

  it('il token non finisce mai fra le preferenze ne\' nel backup', () => {
    localStorage.setItem('nc_token', 'SEGRETO-TOKEN'); seed();
    expect(JSON.stringify(collectPrefs())).not.toContain('SEGRETO');
    expect(exportPrefs()).not.toContain('SEGRETO');
    expect(JSON.parse(exportPrefs()).kind).toBe('nexuscrew-preferences');
  });

  it('export/import: roundtrip, e un file non valido viene rifiutato senza toccare nulla', () => {
    seed();
    const file = exportPrefs();
    localStorage.clear();
    expect(importPrefs(file).ok).toBe(true);
    expect(collectPrefs()).toEqual(full);
    seed({ ...full, pins: ['n:z'] });
    for (const bad of ['non json', '{"kind":"altro"}', JSON.stringify({ kind: 'nexuscrew-preferences', version: 1, data: { token: 'x' } })]) {
      expect(importPrefs(bad).ok).toBe(false);
    }
    expect(collectPrefs().pins).toEqual(['n:z']);
  });

  it('applyPrefs annota il ripristino nel diario e non lascia chiavi fuori schema', () => {
    applyPrefs(full);
    expect(localStorage.getItem(SYNC_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem('nc_order_journal_v1')).at(-1).reason).toBe('prefs-restore');
  });

  describe('storage che rifiuta le scritture (il ripristino dichiara il vero)', () => {
    const failOn = (key) => {
      const real = Storage.prototype.setItem;
      return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) {
        if (k === key) throw new DOMException('quota', 'QuotaExceededError');
        return real.call(this, k, v);
      });
    };
    afterEach(() => vi.restoreAllMocks());

    it('syncPrefs: la scrittura fallisce -> errore con causa, mai «restored», nessuna scrittura a meta\' e revisione non avanzata', async () => {
      seed(); const s = fakeServer();
      await syncPrefs({ request: s.request });
      const id = localStorage.getItem(DEVICE_KEY);
      localStorage.clear(); adoptDeviceId(id);
      const spy = failOn('nc_pins');
      const r = await syncPrefs({ request: s.request });
      expect(r.status).toBe('error');
      expect(r.code).toBe('storage-write-failed');
      expect(r.note).toMatch(/quota/i);
      expect(localStorage.getItem('nc_pins')).toBeNull();
      // niente a meta': le altre chiavi non restano scritte da sole
      for (const k of ['nc_sidebar_order_v1', 'nc_sidebar_views_v1', 'nc_node_order_v1']) expect(localStorage.getItem(k)).toBeNull();
      expect(localStorage.getItem(SYNC_KEY)).toBeNull();
      // la copia del nodo e' intatta: quando lo storage torna a funzionare il ripristino riesce
      spy.mockRestore();
      const again = await syncPrefs({ request: s.request });
      expect(again.status).toBe('restored');
      expect(collectPrefs()).toEqual(full);
    });

    it('resolveConflict(server): stessa verita\' — errore, il locale resta com\'era, si puo\' ritentare', async () => {
      seed(); const s = fakeServer();
      await syncPrefs({ request: s.request });
      const id = localStorage.getItem(DEVICE_KEY);
      localStorage.clear(); adoptDeviceId(id); seed({ ...full, pins: ['n:locale'] });
      const c = (await syncPrefs({ request: s.request })).conflict;
      const spy = failOn('nc_sidebar_views_v1');
      const r = await resolveConflict('server', c, { request: s.request });
      expect(r.status).toBe('error'); expect(r.code).toBe('storage-write-failed');
      expect(collectPrefs().pins).toEqual(['n:locale']);
      expect(collectPrefs().orders).toEqual(full.orders);
      spy.mockRestore();
      expect((await resolveConflict('server', c, { request: s.request })).status).toBe('restored');
      expect(collectPrefs().pins).toEqual(['n:a']);
    });

    it('importPrefs: errore dichiarato e nulla cambia', () => {
      seed(); const file = exportPrefs(); localStorage.clear();
      failOn('nc_pins');
      const r = importPrefs(file);
      expect(r.ok).toBe(false); expect(r.reason).toBe('storage-write-failed');
      expect(localStorage.getItem('nc_pins')).toBeNull();
      expect(localStorage.getItem('nc_sidebar_order_v1')).toBeNull();
    });
  });
});
