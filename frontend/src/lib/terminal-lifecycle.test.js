import { describe, expect, it } from 'vitest';
import { buildNodeGroups } from './nodes-model.js';
import { sessionPresenceForTile, nextTerminalGeneration } from './terminal-lifecycle.js';

// La presenza di una sessione in un tile della griglia.
//
// Il contratto: il terminale si ricrea SOLO quando c'e' la prova che la
// sessione e' finita e poi tornata. Una lettura FALLITA non e' una prova di
// assenza, un nodo giu' non lo e', e la sparizione dell'owner nemmeno: in tutti
// quei casi la presenza resta, il buffer xterm sopravvive, e il recupero lo fa
// il socket con il suo snapshot.

const SESSIONE = 'sessione-uno';
const NODO = 'relay';
const CHIAVE = `${NODO}:${SESSIONE}`;

// Un owner raggiungibile la cui lettura delle sessioni e' caduta, ma il cui
// inventario Fleet risponde: e' lo stato che il gruppo dichiara «parziale».
function gruppoParziale() {
  return buildNodeGroups({
    nodes: [{ name: NODO, tunnel: { status: 'up' }, nodeId: 'istanza-1' }],
    topology: [],
    remote: { [NODO]: { error: 'unreachable', cause: 'peer-assente' } },
    fleet: { [NODO]: { available: true, provider: 'builtin', capabilities: [], cells: [] } },
    down: {}, aliases: {},
  });
}

// Un owner raggiungibile e leggibile: la sua lista e' autorevole.
function gruppoFresco(sessioni) {
  return buildNodeGroups({
    nodes: [{ name: NODO, tunnel: { status: 'up' }, nodeId: 'istanza-1' }],
    topology: [],
    remote: { [NODO]: { sessions: sessioni.map((nome) => ({ name: nome, windows: 1 })) } },
    fleet: { [NODO]: { available: true, provider: 'builtin', capabilities: [], cells: [] } },
    down: {}, aliases: {},
  });
}

const chiaviVive = (gruppi) => new Set(gruppi.flatMap((g) => g.sessions.map((s) => s.key)));

describe('presenza di una sessione: cosa prova l\'assenza', () => {
  it('una lista NON leggibile non prova che la sessione sia finita', () => {
    const gruppi = gruppoParziale();
    expect(gruppi[0].inventoryPartial).toBe(true);
    expect(sessionPresenceForTile({
      tileKey: CHIAVE, node: NODO, nodeGroups: gruppi, sessionsAlive: chiaviVive(gruppi),
    })).toBe(true);
  });

  it('una lista fresca senza la sessione prova che e\' finita', () => {
    const gruppi = gruppoFresco([]);
    expect(sessionPresenceForTile({
      tileKey: CHIAVE, node: NODO, nodeGroups: gruppi, sessionsAlive: chiaviVive(gruppi),
    })).toBe(false);
  });

  it('un owner non raggiungibile non prova che la sessione sia finita', () => {
    const gruppi = buildNodeGroups({
      nodes: [{ name: NODO, tunnel: { status: 'down' } }], topology: [],
      remote: {}, fleet: {}, down: {}, aliases: {},
    });
    expect(sessionPresenceForTile({
      tileKey: CHIAVE, node: NODO, nodeGroups: gruppi, sessionsAlive: new Set(),
    })).toBe(true);
  });
});

describe('generazione del terminale: quando si ricrea', () => {
  it('una lettura caduta e poi tornata NON ricrea il terminale', () => {
    // Round 1: la lettura cade (lista parziale). Round 2: la lettura torna con
    // la sessione. La sessione non e' MAI risultata assente in una lista
    // autorevole: la generazione non si tocca.
    const parziale = gruppoParziale();
    const primo = sessionPresenceForTile({
      tileKey: CHIAVE, node: NODO, nodeGroups: parziale, sessionsAlive: chiaviVive(parziale),
    });
    const fresco = gruppoFresco([SESSIONE]);
    const secondo = sessionPresenceForTile({
      tileKey: CHIAVE, node: NODO, nodeGroups: fresco, sessionsAlive: chiaviVive(fresco),
    });
    expect(primo).toBe(true);
    expect(secondo).toBe(true);
    expect(nextTerminalGeneration(primo, secondo, 7)).toBe(7);
  });

  it('assenza verificata e poi ritorno: il terminale si ricrea UNA volta', () => {
    const assente = gruppoFresco([]);
    const dopo = gruppoFresco([SESSIONE]);
    const a = sessionPresenceForTile({
      tileKey: CHIAVE, node: NODO, nodeGroups: assente, sessionsAlive: chiaviVive(assente),
    });
    const b = sessionPresenceForTile({
      tileKey: CHIAVE, node: NODO, nodeGroups: dopo, sessionsAlive: chiaviVive(dopo),
    });
    expect(a).toBe(false);
    expect(b).toBe(true);
    expect(nextTerminalGeneration(a, b, 7)).toBe(8);
    // e non due volte: due letture fresche consecutive non rinnovano nulla
    expect(nextTerminalGeneration(b, b, 8)).toBe(8);
  });
});
