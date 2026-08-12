import { describe, it, expect } from 'vitest';
import {
  hostRenderState, hostNextAction, localCellId,
  HOST_NONE, HOST_FAVORITE, HOST_LIVE,
} from './host-designation.js';

const item = (key) => ({ key });

describe('localCellId — solo le celle locali hanno un host designabile', () => {
  it("estrae il cellId dalla chiave 'local:<cell>'", () => {
    expect(localCellId(item('local:cloud-Dev'))).toBe('cloud-Dev');
  });
  it('ritorna null per celle remote (relay:...)', () => {
    expect(localCellId(item('relay:remote-shell'))).toBeNull();
  });
  it('ritorna null per sessioni tmux locali non-cella o chiavi senza prefisso', () => {
    expect(localCellId(item('local:'))).toBeNull();
    expect(localCellId(item('session-x'))).toBeNull();
    expect(localCellId(null)).toBeNull();
  });
});

describe('hostRenderState — precedenza live > favorite > none', () => {
  it('none quando non e\' host e non e\' pinnata', () => {
    expect(hostRenderState({ hostCell: null, pins: [], item: item('local:cloud-Dev') })).toBe(HOST_NONE);
  });
  it('favorite quando e\' nel pin locale e non e\' host', () => {
    expect(hostRenderState({ hostCell: 'cloud-Sys', pins: ['local:cloud-Dev'], item: item('local:cloud-Dev') })).toBe(HOST_FAVORITE);
  });
  it('live quando hostCell === cellId (rossa ANCHE senza pin locale)', () => {
    expect(hostRenderState({ hostCell: 'cloud-Dev', pins: [], item: item('local:cloud-Dev') })).toBe(HOST_LIVE);
  });
  it('live vince su favorite se entrambi veri', () => {
    expect(hostRenderState({ hostCell: 'cloud-Dev', pins: ['local:cloud-Dev'], item: item('local:cloud-Dev') })).toBe(HOST_LIVE);
  });
  it('una cella remota non e\' mai live (federazione default-deny)', () => {
    expect(hostRenderState({ hostCell: 'remote-shell', pins: ['relay:remote-shell'], item: item('relay:remote-shell') })).toBe(HOST_FAVORITE);
    expect(hostRenderState({ hostCell: 'remote-shell', pins: [], item: item('relay:remote-shell') })).toBe(HOST_NONE);
  });
});

describe('hostNextAction — ciclo a 3 stati, nessun quarto', () => {
  it('none -> addPin (locale, diventa favorite)', () => {
    expect(hostNextAction(HOST_NONE)).toBe('addPin');
  });
  it('favorite -> designate (API, diventa live)', () => {
    expect(hostNextAction(HOST_FAVORITE)).toBe('designate');
  });
  it('live -> clearAndUnpin (API clear + remove pin, torna none)', () => {
    expect(hostNextAction(HOST_LIVE)).toBe('clearAndUnpin');
  });
});

describe('ciclo end-to-end tramite renderState + nextAction', () => {
  // Simula i 3 clic partendo da none, riflesso della risposta server (API-first):
  // nessuno stato viene assunto prima della transazione server.
  it('none -> favorite -> live -> none (3 clic, poi ricomincia)', () => {
    const key = item('local:cloud-Dev');
    // Clic 1: addPin -> la UI diventa favorite (pin locale aggiunto).
    let pins = [];
    let hostCell = null;
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: key }))).toBe('addPin');
    pins = ['local:cloud-Dev'];
    // Clic 2: favorite -> designate. La UI NON assume live prima della response:
    // hostCell resta null finche\' il server non risponde. Qui simuliamo la
    // response OK che riflette hostCell='cloud-Dev'.
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: key }))).toBe('designate');
    hostCell = 'cloud-Dev'; // riflesso della risposta server (non ottimismo)
    expect(hostRenderState({ hostCell, pins, item: key })).toBe(HOST_LIVE);
    // Clic 3: live -> clearAndUnpin.
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: key }))).toBe('clearAndUnpin');
    hostCell = null; pins = []; // clear server OK + remove pin
    expect(hostRenderState({ hostCell, pins, item: key })).toBe(HOST_NONE);
  });

  it('rollback: se designate fallisce, hostCell resta null (nessun ottimismo pre-response)', () => {
    const key = item('local:cloud-Dev');
    const pins = ['local:cloud-Dev'];
    // favorite -> designate; la transazione server FALLISCE: hostCell non cambia.
    expect(hostNextAction(hostRenderState({ hostCell: null, pins, item: key }))).toBe('designate');
    expect(hostRenderState({ hostCell: null, pins, item: key })).toBe(HOST_FAVORITE); // resta favorite
  });
});
