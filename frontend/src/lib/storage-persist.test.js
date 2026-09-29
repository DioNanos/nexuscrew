import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureStoragePersistence, readPersistState } from './storage-persist.js';
import { readOrderJournal } from './order-journal.js';

beforeEach(() => localStorage.clear());
const mgr = (persisted, persist) => ({ persisted: vi.fn(async () => persisted), persist: vi.fn(async () => persist) });

describe('storage.persist() al primo avvio (O5)', () => {
  it('chiede la persistenza, registra l\'esito e lo mette nel diario', async () => {
    const m = mgr(false, true);
    const r = await ensureStoragePersistence({ manager: m });
    expect(m.persist).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('persistent');
    expect(readPersistState().status).toBe('persistent');
    expect(readOrderJournal().at(-1)).toMatchObject({ reason: 'storage-persist', note: 'persistent' });
  });
  it('se e\' gia\' persistente non richiede nulla', async () => {
    const m = mgr(true, true);
    expect((await ensureStoragePersistence({ manager: m })).status).toBe('persistent');
    expect(m.persist).not.toHaveBeenCalled();
  });
  it('rifiuto del browser: visibile come denied, e si riprova non prima di 24 ore', async () => {
    const m = mgr(false, false); let t = 1000;
    expect((await ensureStoragePersistence({ manager: m, now: () => t })).status).toBe('denied');
    t += 3600_000;
    await ensureStoragePersistence({ manager: m, now: () => t });
    expect(m.persist).toHaveBeenCalledTimes(1);
    t += 24 * 3600_000;
    await ensureStoragePersistence({ manager: m, now: () => t });
    expect(m.persist).toHaveBeenCalledTimes(2);
  });
  it('API assente o che lancia: stato dichiarato, mai un\'eccezione', async () => {
    expect((await ensureStoragePersistence({ manager: undefined })).status).toBe('unsupported');
    localStorage.clear();
    const bad = { persisted: async () => { throw new Error('boom'); }, persist: async () => true };
    const r = await ensureStoragePersistence({ manager: bad });
    expect(r.status).toBe('error'); expect(r.note).toBe('boom');
  });
});
