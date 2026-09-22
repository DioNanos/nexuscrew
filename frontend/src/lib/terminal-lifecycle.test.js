import { describe, expect, it } from 'vitest';
import { buildNodeGroups } from './nodes-model.js';
import {
  sessionPresenceForTile, nextTerminalGeneration, tileLifecycle,
  advanceTileRuntime, initialTileRuntime, PRESENZA, OWNER, CAUSA, MOTIVO,
} from './terminal-lifecycle.js';

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

// ---------------------------------------------------------------------------
// I quattro stati, i due trigger, l'asse dell'owner separato.
// ---------------------------------------------------------------------------

// Un owner raggiungibile e leggibile, con l'istante in cui ha risposto: e' il
// dato che alimenta il tetto del «non verificato», non la presenza.
function gruppoLetto(sessioni, { at = null, istante = null } = {}) {
  return buildNodeGroups({
    nodes: [{ name: NODO, tunnel: { status: 'up' }, nodeId: 'istanza-1' }],
    topology: [],
    remote: { [NODO]: { sessions: sessioni, ...(at === null ? {} : { at }) } },
    fleet: { [NODO]: { available: true, provider: 'builtin', capabilities: [], cells: [] } },
    down: {}, aliases: {},
  })[0];
}

const sessioneCon = (nome, created) => ({ name: nome, windows: 1, ...(created === undefined ? {} : { created }) });

const campione = (gruppo, extra = {}) => {
  const gruppi = gruppo ? [gruppo] : [];
  return tileLifecycle({
    tileKey: CHIAVE, node: NODO, nodeGroups: gruppi, sessionsAlive: chiaviVive(gruppi), nowMs: 0, ...extra,
  });
};

describe('i quattro stati di presenza', () => {
  it('presente verificata: la lista autorevole porta la sessione', () => {
    const s = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    expect(s.presenza).toBe(PRESENZA.PRESENTE);
    expect(s.verificata).toBe(true);
    expect(s.identita).toBe(1700);
  });

  it('assente verificata: SOLO una lista fresca senza la sessione', () => {
    expect(campione(gruppoLetto([])).presenza).toBe(PRESENZA.ASSENTE);
  });

  it('ignota: lettura non verificabile (owner risponde, sessioni no)', () => {
    const s = campione(gruppoParziale()[0]);
    expect(s.presenza).toBe(PRESENZA.IGNOTA);
    expect(s.causa).toBe(CAUSA.LETTURA_NON_VERIFICABILE);
    expect(s.verificata).toBe(false);
  });

  it('ignota: owner non disponibile', () => {
    const giu = buildNodeGroups({
      nodes: [{ name: NODO, tunnel: { status: 'down' } }], topology: [],
      remote: {}, fleet: {}, down: {}, aliases: {},
    })[0];
    const s = campione(giu);
    expect(s.presenza).toBe(PRESENZA.IGNOTA);
    expect(s.owner).toBe(OWNER.NON_DISPONIBILE);
    expect(s.causa).toBe(CAUSA.OWNER_NON_DISPONIBILE);
  });

  it('ignota: owner rimosso dalla topologia', () => {
    const s = campione(null);
    expect(s.presenza).toBe(PRESENZA.IGNOTA);
    expect(s.owner).toBe(OWNER.RIMOSSO);
    expect(s.causa).toBe(CAUSA.OWNER_RIMOSSO);
  });

  it('l\'asse owner e\' separato: ignota non vuol dire assente, e owner ok non vuol dire presente', () => {
    expect(campione(null).presenza).not.toBe(PRESENZA.ASSENTE);
    const s = campione(gruppoParziale()[0]);
    expect(s.owner).toBe(OWNER.OK);          // l'owner risponde
    expect(s.presenza).toBe(PRESENZA.IGNOTA); // la sessione non si sa
  });

  it('le tre cause del peer restano distinte', () => {
    const causa = (c) => campione(buildNodeGroups({
      nodes: [{ name: NODO, tunnel: { status: 'up' }, nodeId: 'istanza-1' }], topology: [],
      remote: { [NODO]: { error: 'unreachable', cause: c } }, fleet: {}, down: {}, aliases: {},
    })[0]).causa;
    expect(causa('peer-nega')).toBe('peer-nega');
    expect(causa('rotta-inesistente')).toBe('rotta-inesistente');
    expect(causa('peer-assente')).toBe('peer-assente');
  });
});

describe('i due soli trigger di generazione', () => {
  const avanza = (stato, s) => advanceTileRuntime(stato, s);

  it('(a) assente verificata e poi ritorno: una sola generazione', () => {
    const assente = campione(gruppoLetto([]));
    const presente = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    const uno = avanza(initialTileRuntime(), assente);
    expect(uno.generazione).toBe(0);
    const due = avanza(uno.runtime, presente);
    expect(due.generazione).toBe(1);
    expect(due.motivo).toBe(MOTIVO.RITORNO);
    // e non due volte: due letture presenti consecutive non rinnovano
    expect(avanza(due.runtime, presente).generazione).toBe(0);
  });

  it('(b) identita\' diversa fra due letture autorevoli: una generazione', () => {
    const a = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    const b = campione(gruppoLetto([sessioneCon(SESSIONE, 9000)]));
    const uno = avanza(initialTileRuntime(), a);
    expect(uno.generazione).toBe(0);
    const due = avanza(uno.runtime, b);
    expect(due.generazione).toBe(1);
    expect(due.motivo).toBe(MOTIVO.IDENTITA);
  });

  it('stessa identita\': nessuna generazione', () => {
    const a = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    const uno = avanza(initialTileRuntime(), a);
    expect(avanza(uno.runtime, a).generazione).toBe(0);
  });

  it('identita\' non confrontabile (`created` assente): nessuna generazione, limite dichiarato', () => {
    const a = campione(gruppoLetto([sessioneCon(SESSIONE)]));
    const b = campione(gruppoLetto([sessioneCon(SESSIONE, 9000)]));
    const uno = avanza(initialTileRuntime(), a);
    expect(uno.runtime.identita).toBeNull();
    expect(avanza(uno.runtime, b).generazione).toBe(0);
  });

  it('una lettura caduta in mezzo NON ricrea il terminale', () => {
    const presente = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    const caduta = campione(gruppoParziale()[0]);
    const uno = avanza(initialTileRuntime(), presente);
    const due = avanza(uno.runtime, caduta);
    expect(due.generazione).toBe(0);
    expect(avanza(due.runtime, presente).generazione).toBe(0);
  });

  it('nodo giu\' e poi su: la generazione si conserva', () => {
    const presente = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    const giu = campione(buildNodeGroups({
      nodes: [{ name: NODO, tunnel: { status: 'down' } }], topology: [],
      remote: {}, fleet: {}, down: {}, aliases: {},
    })[0]);
    const uno = avanza(initialTileRuntime(), presente);
    const due = avanza(uno.runtime, giu);
    expect(due.generazione).toBe(0);
    expect(avanza(due.runtime, presente).generazione).toBe(0);
  });

  it('owner espulso dalla topologia e riapparso: nessuna generazione', () => {
    const presente = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    const uno = avanza(initialTileRuntime(), presente);
    const fuori = avanza(uno.runtime, campione(null));
    expect(fuori.generazione).toBe(0);
    expect(fuori.runtime.presenza).toBe(PRESENZA.PRESENTE); // l'ultimo VERIFICATO
    expect(avanza(fuori.runtime, presente).generazione).toBe(0);
  });

  it('l\'ignoto non cancella l\'ultimo stato verificato: assente, buco, ritorno', () => {
    // Sessione finita davvero, lettura caduta per qualche giro, sessione
    // ricreata: la ricreazione si deve vedere. Senza questa regola l'ignoto
    // sovrascriverebbe l'assenza e il terminale resterebbe morto.
    const assente = campione(gruppoLetto([]));
    const caduta = campione(gruppoParziale()[0]);
    const tornata = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    const uno = avanza(initialTileRuntime(), assente);
    const due = avanza(uno.runtime, caduta);
    expect(due.generazione).toBe(0);
    expect(due.runtime.presenza).toBe(PRESENZA.ASSENTE);
    const tre = avanza(due.runtime, tornata);
    expect(tre.generazione).toBe(1);
    expect(tre.motivo).toBe(MOTIVO.RITORNO);
  });

  it('il caso locale: una lettura locale caduta non prova l\'assenza', () => {
    const s = tileLifecycle({
      tileKey: SESSIONE, node: null, nodeGroups: [],
      sessionsAlive: new Set([SESSIONE]), localVerified: false, nowMs: 0,
    });
    expect(s.presenza).toBe(PRESENZA.IGNOTA);
    expect(s.causa).toBe(CAUSA.LOCALE_NON_VERIFICATO);
    // e in una lettura caduta il tile non e' nemmeno «assente» per il pallino
    expect(s.verificata).toBe(false);
  });

  it('il caso locale: assenza e ritorno con identita\' verificata', () => {
    const locale = (presente, created) => tileLifecycle({
      tileKey: SESSIONE, node: null, nodeGroups: [],
      sessionsAlive: presente ? new Set([SESSIONE]) : new Set(),
      localIdentita: created, nowMs: 0,
    });
    const uno = advanceTileRuntime(initialTileRuntime(), locale(true, 1700));
    expect(uno.generazione).toBe(0);
    const due = advanceTileRuntime(uno.runtime, locale(false));
    expect(due.generazione).toBe(0);
    const tre = advanceTileRuntime(due.runtime, locale(true, 1700));
    expect(tre.generazione).toBe(1);
    const quattro = advanceTileRuntime(tre.runtime, locale(true, 9000));
    expect(quattro.generazione).toBe(1);
    expect(quattro.motivo).toBe(MOTIVO.IDENTITA);
  });
});

describe('il tetto dei 60 s: dato non verificato', () => {
  it('sotto il tetto non si dichiara niente; oltre, si dichiara', () => {
    const t0 = 1_800_000_000_000;
    expect(campione(gruppoParziale()[0], { lastVerifiedAt: t0, nowMs: t0 + 59_000 }).oltreIlTetto).toBe(false);
    const dopo = campione(gruppoParziale()[0], { lastVerifiedAt: t0, nowMs: t0 + 61_000 });
    expect(dopo.oltreIlTetto).toBe(true);
    // e la presenza resta IGNOTA: il tetto NON e' un'assenza
    expect(dopo.presenza).toBe(PRESENZA.IGNOTA);
  });

  it('senza un istante di lettura non si inventa un\'eta\'', () => {
    expect(campione(gruppoParziale()[0], { lastVerifiedAt: null, nowMs: 1_900_000_000_000 }).oltreIlTetto).toBe(false);
  });

  it('l\'avviso non muove la generazione', () => {
    const t0 = 1_800_000_000_000;
    const presente = campione(gruppoLetto([sessioneCon(SESSIONE, 1700)]));
    const uno = advanceTileRuntime(initialTileRuntime(), presente);
    const vecchio = campione(gruppoParziale()[0], { lastVerifiedAt: t0, nowMs: t0 + 600_000 });
    const due = advanceTileRuntime(uno.runtime, vecchio);
    expect(vecchio.oltreIlTetto).toBe(true);
    expect(due.generazione).toBe(0);
  });

  it('una lettura autorevole porta con se\' l\'istante in cui e\' avvenuta', () => {
    // L'istante viaggia col DATO, non con lo sguardo di chi lo consuma: cosi'
    // l'eta' del dato non dipende da quando il componente ha ridisegnato.
    expect(gruppoLetto([sessioneCon(SESSIONE, 1700)], { at: 4242 }).verifiedAt).toBe(4242);
  });

  it('un tentativo fallito non cancella l\'istante dell\'ultima lettura buona', () => {
    const g = buildNodeGroups({
      nodes: [{ name: NODO, tunnel: { status: 'up' }, nodeId: 'istanza-1' }], topology: [],
      remote: { [NODO]: { error: 'unreachable', cause: 'peer-assente', lastGoodAt: 777 } },
      fleet: { [NODO]: { available: true, provider: 'builtin', capabilities: [], cells: [] } },
      down: {}, aliases: {},
    })[0];
    expect(g.inventoryPartial).toBe(true);
    expect(g.verifiedAt).toBe(777);
  });

  it('lo stesso vale sul ramo transitivo (posizione in topologia)', () => {
    // Il secondo ramo di buildNodeGroups: la posizione arriva dalla topologia
    // invece che dai nodi diretti. Il fix di presenza e' nella funzione, quindi
    // vale per entrambi — ma va provato su entrambi.
    const gruppi = buildNodeGroups({
      nodes: [], topology: [{ route: [NODO], label: NODO, instanceId: 'istanza-2' }],
      remote: { [NODO]: { error: 'unreachable', cause: 'peer-assente', lastGoodAt: 555 } },
      fleet: { [NODO]: { available: true, provider: 'builtin', capabilities: [], cells: [] } },
      down: {}, aliases: {},
    });
    expect(gruppi).toHaveLength(1);
    expect(gruppi[0].status).toBe('up');
    expect(gruppi[0].sessionsAvailable).toBe(false);
    expect(gruppi[0].verifiedAt).toBe(555);
    expect(sessionPresenceForTile({
      tileKey: `${NODO}:${SESSIONE}`, node: NODO, nodeGroups: gruppi, sessionsAlive: new Set(),
    })).toBe(true);
  });
});
