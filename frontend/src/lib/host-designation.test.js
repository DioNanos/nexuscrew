import { describe, it, expect } from 'vitest';
import { hostRenderState, hostNextAction, HOST_NONE, HOST_FAVORITE, HOST_LIVE } from './host-designation.js';
import { buildLocalRoster } from './roster-view-model.js';

// FIX (audit): la fixture usa la FORMA DI PRODUZIONE, dove `cell` e `tmuxSession`
// sono DIVERSI (runtime.js fa `cell: c.id` con tmuxSession separato). L'iterazione
// precedente usava cell === tmuxSession, il che collassava item.key e item.value.cell
// sulla stessa stringa: il test passava IDENTICO anche leggendo item.key, e la
// regressione non era pinnata. Qui i due campi differiscono apposta.
const CELLS = [
  { cell: 'Dev', tmuxSession: 'cloud-Dev', tmux: true },
  { cell: 'Off', tmuxSession: 'cloud-Off', tmux: false },
];

function localItems() {
  // byName vuoto: basta per ottenere item con value/label/key reali.
  return buildLocalRoster(CELLS, [], new Map());
}

describe('hostRenderState — identita\' da item.value.cell (NON da item.key)', () => {
  it('la chiave reale e\' il tmuxSession nudo e DIFFERisce da value.cell (forma di produzione)', () => {
    const dev = localItems().find((i) => i.value.cell === 'Dev');
    expect(dev).toBeTruthy();
    expect(dev.key).toBe('cloud-Dev'); // positionKey([], tmuxSession) = id nudo
    expect(dev.value.cell).toBe('Dev'); // il campo che il server memorizza
    expect(dev.key).not.toBe(dev.value.cell); // la distinzione che il test pinnar
    expect(dev.key.startsWith('local:')).toBe(false); // la forma morta non c'e'
  });

  it('live quando hostCell === item.value.cell (il valore server, anche senza pin)', () => {
    const dev = localItems().find((i) => i.value.cell === 'Dev');
    expect(hostRenderState({ hostCell: 'Dev', pins: [], item: dev })).toBe(HOST_LIVE);
  });

  it('NEGATIVA: hostCell uguale al tmuxSession (item.key) NON e\' live — e\' none', () => {
    // E la regressione: se l'implementazione tornasse a leggere item.key, questo
    // caso darebbe live sbagliato. Con value.cell deve dare none.
    const dev = localItems().find((i) => i.value.cell === 'Dev');
    expect(dev.key).toBe('cloud-Dev');
    expect(hostRenderState({ hostCell: 'cloud-Dev', pins: [], item: dev })).toBe(HOST_NONE);
  });

  it('favorite quando nel pin locale (item.key = tmuxSession) e non host', () => {
    const dev = localItems().find((i) => i.value.cell === 'Dev');
    expect(hostRenderState({ hostCell: null, pins: ['cloud-Dev'], item: dev })).toBe(HOST_FAVORITE);
  });

  it('live vince su favorite se entrambi veri', () => {
    const dev = localItems().find((i) => i.value.cell === 'Dev');
    expect(hostRenderState({ hostCell: 'Dev', pins: ['cloud-Dev'], item: dev })).toBe(HOST_LIVE);
  });

  it('none quando non host e non pinnata', () => {
    const dev = localItems().find((i) => i.value.cell === 'Dev');
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
    const dev = localItems().find((i) => i.value.cell === 'Dev');
    let pins = []; let hostCell = null;

    // clic 1: addPin -> favorite (il pin usa item.key, il tmuxSession)
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: dev }))).toBe('addPin');
    pins = [dev.key];
    expect(hostRenderState({ hostCell, pins, item: dev })).toBe(HOST_FAVORITE);

    // clic 2: designate; hostCell cambia solo con la risposta server (no ottimismo),
    // e il valore e' item.value.cell (il campo server), non item.key.
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: dev }))).toBe('designate');
    hostCell = dev.value.cell; // 'Dev', riflesso della risposta
    expect(hostRenderState({ hostCell, pins, item: dev })).toBe(HOST_LIVE);

    // clic 3: clearAndUnpin
    expect(hostNextAction(hostRenderState({ hostCell, pins, item: dev }))).toBe('clearAndUnpin');
    hostCell = null; pins = [];
    expect(hostRenderState({ hostCell, pins, item: dev })).toBe(HOST_NONE);
  });

  it('rollback: designate fallisce -> hostCell resta null, la cella resta favorite', () => {
    const dev = localItems().find((i) => i.value.cell === 'Dev');
    const pins = [dev.key];
    expect(hostNextAction(hostRenderState({ hostCell: null, pins, item: dev }))).toBe('designate');
    expect(hostRenderState({ hostCell: null, pins, item: dev })).toBe(HOST_FAVORITE);
  });

  it('regression auditor: clic 2 accende davvero il rosso (non resta favorite)', () => {
    // era il difetto misurato: hostCell registrato ma stellina non aggiornata.
    const dev = localItems().find((i) => i.value.cell === 'Dev');
    expect(hostRenderState({ hostCell: 'Dev', pins: [dev.key], item: dev })).toBe(HOST_LIVE);
  });
});
