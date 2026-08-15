import { describe, it, expect } from 'vitest';
import {
  hostRenderState, hostNextAction, HOST_NONE, HOST_FAVORITE, HOST_LIVE,
  hostRouteKey, hostDesignationFailureMessage,
} from './host-designation.js';
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

// --- Seam lease↔designazione: lo stato lease arriva DISTINTO a chi legge ------
// I cinque stati (live|grace|expired|none|unavailable) non collassano: chi legge
// la stellina deve distinguere «non idonea perche' morta» da «non idonea perche'
// in recupero». Ogni stato ha la propria chiave i18n (guardia: parita' it/en/es).
import { hostLeaseTitleKey } from './host-designation.js';

describe('hostLeaseTitleKey', () => {
  const dev = localItems().find((i) => i.value.cell === 'Dev');

  it('live host: una chiave DISTINCTA per ognuno dei cinque stati', () => {
    expect(hostLeaseTitleKey('live', 'live')).toBe('host-lease-live');
    expect(hostLeaseTitleKey('live', 'grace')).toBe('host-lease-grace');
    expect(hostLeaseTitleKey('live', 'expired')).toBe('host-lease-expired');
    expect(hostLeaseTitleKey('live', 'none')).toBe('host-lease-none');
    expect(hostLeaseTitleKey('live', 'unavailable')).toBe('host-lease-unavailable');
  });

  it('nessuno stato lease da mostrare fuori dal live host, o senza stato dal server', () => {
    expect(hostLeaseTitleKey('favorite', 'grace')).toBeNull();
    expect(hostLeaseTitleKey('none', 'live')).toBeNull();
    expect(hostLeaseTitleKey('live', null)).toBeNull();
    expect(hostLeaseTitleKey('live', undefined)).toBeNull();
  });

  it('uno stato sconosciuto non inventa una etichetta (nessuna bugia)', () => {
    expect(hostLeaseTitleKey('live', 'bogus')).toBeNull();
  });
});

// --- Per-nodo (0.9.1 seconda meta'): la mappa hostByRoute -------------------
describe('hostRouteKey — stessa forma di bootCellKey/nodeRoute altrove nel progetto', () => {
  it('locale (route vuota o assente) -> "local"', () => {
    expect(hostRouteKey([])).toBe('local');
    expect(hostRouteKey(undefined)).toBe('local');
    expect(hostRouteKey(null)).toBe('local');
  });
  it('route remota -> route.join("/"), MAI collassata su "local"', () => {
    expect(hostRouteKey(['relay'])).toBe('relay');
    expect(hostRouteKey(['relay', 'pixel'])).toBe('relay/pixel');
  });
  it('due nodi diversi devono avere due chiavi diverse (la guardia del bug originale)', () => {
    expect(hostRouteKey(['relay'])).not.toBe(hostRouteKey([]));
    expect(hostRouteKey(['relay'])).not.toBe(hostRouteKey(['pixel']));
  });
});

describe('hostDesignationFailureMessage — il rifiuto nomina la causa, mai un silenzio', () => {
  it('reason "live-host-not-granted" (dal gate federato) -> la sua chiave, non generica', () => {
    const err = new Error('cella ospite live non concessa da questo nodo');
    err.data = { reason: 'live-host-not-granted' };
    expect(hostDesignationFailureMessage(err)).toBe('live-host-not-granted');
  });
  it('qualunque altro fallimento (rete, 500, nodo giu) -> chiave generica, comunque presente', () => {
    expect(hostDesignationFailureMessage(new Error('boom'))).toBe('live-host-error');
    expect(hostDesignationFailureMessage({})).toBe('live-host-error');
    expect(hostDesignationFailureMessage(undefined)).toBe('live-host-error');
  });
});
