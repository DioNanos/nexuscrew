import { describe, it, expect, beforeEach } from 'vitest';
import { hostRenderState, hostNextAction, HOST_NONE, HOST_FAVORITE, HOST_LIVE } from './host-designation.js';
import { buildLocalRoster } from './roster-view-model.js';

// FIX 1 (vincolo non negoziabile): la fixture e' l'OUTPUT VERO di buildLocalRoster,
// non un letterale scritto a mano. E' la fixture inventata che ha nascosto il
// difetto (item.key non ha forma "local:..."). Questo test attraversa il confine
// reale tra il modello del roster e la logica del ciclo.
const CELLS = [
  { cell: 'cloud-Dev', tmuxSession: 'cloud-Dev', tmux: true },
  { cell: 'cloud-Off', tmuxSession: 'cloud-Off', tmux: false },
];

function localItems() {
  // byName vuoto: basta per ottenere item con value/label/key reali.
  return buildLocalRoster(CELLS, [], new Map());
}

describe('hostRenderState — identita\' da item.value.cell (non da item.key)', () => {
  it('la chiave reale e\' il tmuxSession nudo, NON la forma "local:" (regression del difetto)', () => {
    const items = localItems();
    const dev = items.find((i) => i.value.cell === 'cloud-Dev');
    expect(dev).toBeTruthy();
    expect(dev.key).toBe('cloud-Dev'); // positionKey([], tmuxSession) = id nudo
    expect(dev.key.startsWith('local:')).toBe(false); // la forma morta non c'e'
  });

  it('live quando hostCell === item.value.cell (anche senza pin locale)', () => {
    const dev = localItems().find((i) => i.value.cell === 'cloud-Dev');
    expect(hostRenderState({ hostCell: 'cloud-Dev', pins: [], item: dev })).toBe(HOST_LIVE);
  });

  it('favorite quando nel pin locale (item.key = tmuxSession) e non host', () => {
    const dev = localItems().find((i) => i.value.cell === 'cloud-Dev');
    expect(hostRenderState({ hostCell: 'cloud-Sys', pins: ['cloud-Dev'], item: dev })).toBe(HOST_FAVORITE);
  });

  it('live vince su favorite se entrambi veri', () => {
    const dev = localItems().find((i) => i.value.cell === 'cloud-Dev');
    expect(hostRenderState({ hostCell: 'cloud-Dev', pins: ['cloud-Dev'], item: dev })).toBe(HOST_LIVE);
  });

  it('none quando non host e non pinnata', () => {
    const dev = localItems().find((i) => i.value.cell === 'cloud-Dev');
    expect(hostRenderState({ hostCell: null, pins: [], item: dev })).toBe(HOST_NONE);
  });

  it('una sessione tmux (niente value.cell) non e\' mai host', () => {
    const session = buildLocalRoster([], [{ name: 'misc', activity: 0 }], new Map())
      .find((i) => i.type === 'session');
    expect(hostRenderState({ hostCell: 'misc', pins: [], item: session })).toBe(HOST_NONE);
  });
});

describe('hostNextAction — ciclo a 3 stati, nessun quarto', () => {
  it('none -> addPin, favorite -> designate, live -> clearAndUnpin', () => {
    expect(hostNextAction(HOST_NONE)).toBe('addPin');
    expect(hostNextAction(HOST_FAVORITE)).toBe('designate');
    expect(hostNextAction(HOST_LIVE)).toBe('clearAndUnpin');
  });
});

describe('ciclo end-to-end su item reale (desktop e mobile usano lo stesso modello)', () => {
  it('3 clic: none -> favorite -> live -> none, riflesso della risposta server', () => {
    const dev = localItems().find((i) => i.value.cell === 'cloud-Dev');
    let pins = []; let hostCell = null;

    // clic 1: addPin -> favorite
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: dev }))).toBe('addPin');
    pins = [dev.key];
    expect(hostRenderState({ hostCell, pins, item: dev })).toBe(HOST_FAVORITE);

    // clic 2: designate; hostCell cambia solo con la risposta server (no ottimismo)
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: dev }))).toBe('designate');
    hostCell = dev.value.cell; // riflesso della risposta
    expect(hostRenderState({ hostCell, pins, item: dev })).toBe(HOST_LIVE);

    // clic 3: clearAndUnpin
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: dev }))).toBe('clearAndUnpin');
    hostCell = null; pins = [];
    expect(hostRenderState({ hostCell, pins, item: dev })).toBe(HOST_NONE);
  });

  it('rollback: designate fallisce -> hostCell resta null, la cella resta favorite', () => {
    const dev = localItems().find((i) => i.value.cell === 'cloud-Dev');
    const pins = [dev.key];
    expect(hostNextAction(hostRenderState({ hostCell: null, pins, item: dev }))).toBe('designate');
    expect(hostRenderState({ hostCell: null, pins, item: dev })).toBe(HOST_FAVORITE);
  });

  it('regression auditor: clic 2 accende davvero il rosso (non resta favorite)', () => {
    // era il difetto misurato: hostCell registrato ma stellina non aggiornata.
    const dev = localItems().find((i) => i.value.cell === 'cloud-Dev');
    expect(hostRenderState({ hostCell: 'cloud-Dev', pins: [dev.key], item: dev })).toBe(HOST_LIVE);
  });
});
