import { describe, expect, it } from 'vitest';
import { nodeStateLabel, sessionsAuthoritative, cellRuntime, buildRemoteRoster, buildLocalRoster } from './roster-view-model.js';
import { DICTS, LANGUAGES, t } from './i18n.js';
import { CAUSE_PEER_ASENTE, CAUSE_PEER_NEGA, CAUSE_ROTTA_INESISTENTE } from './peer-backoff.js';

// R21 — tre cause, tre etichette, tre azioni. Il rumore indistinto faceva
// fare la cosa sbagliata; qui si prova che ogni causa produce la SUA frase.
// Le asserzioni confrontano con t(<chiave>), non con testo letterale: il
// contratto e' la mappatura causa -> chiave giusta, in qualunque lingua.
// t() ritorna la CHIAVE nuda quando la traduzione manca: il «not.toBe(key)»
// sotto smaschera anche la chiave senza testo.

describe('nodeStateLabel: peer non raggiungibile per causa (R21)', () => {
  it('peer assente (502/rete) -> peer-cause-assente', () => {
    const out = nodeStateLabel({ status: 'unreachable', cause: CAUSE_PEER_ASENTE });
    expect(out).toBe(t('peer-cause-assente'));
    expect(out).not.toBe('peer-cause-assente'); // la chiave risolve a testo vero
  });
  it('peer che nega (403) -> peer-cause-nega (azione: concedere il permesso)', () => {
    const out = nodeStateLabel({ status: 'unreachable', cause: CAUSE_PEER_NEGA });
    expect(out).toBe(t('peer-cause-nega'));
    expect(out).not.toBe('peer-cause-nega');
  });
  it('rotta inesistente (404) -> peer-cause-rotta (azione: aggiornare il nodo)', () => {
    const out = nodeStateLabel({ status: 'unreachable', cause: CAUSE_ROTTA_INESISTENTE });
    expect(out).toBe(t('peer-cause-rotta'));
    expect(out).not.toBe('peer-cause-rotta');
  });
  it('tre cause -> tre frasi DISTINTE: mai due cause con la stessa etichetta', () => {
    const a = nodeStateLabel({ status: 'unreachable', cause: CAUSE_PEER_ASENTE });
    const n = nodeStateLabel({ status: 'unreachable', cause: CAUSE_PEER_NEGA });
    const r = nodeStateLabel({ status: 'unreachable', cause: CAUSE_ROTTA_INESISTENTE });
    expect(new Set([a, n, r]).size).toBe(3);
  });
  it('senza causa (dato vecchio o non classificato): l\'etichetta generica di prima, non il silenzio', () => {
    expect(nodeStateLabel({ status: 'unreachable', cause: null })).toBe(t('node-unreachable'));
    expect(nodeStateLabel({ status: 'unreachable' })).toBe(t('node-unreachable'));
  });
});

// Lo stato della cella dagli hook vince sul titolo del pane.
// Il titolo NON prova nulla (`✳` sta sia su una cella al lavoro sia
// su una ferma), quindi dove non c'e' il canale lo stato e' dichiarato INCERTO
// e non si afferma mai «ferma» da un silenzio.
describe('cellRuntime: tre stati dagli hook + presenza dove il titolo non prova', () => {
  const cella = { tmux: true, cell: 'Dev', engine: 'claude' };
  const att = (stato) => ({ attivita: { stato, ts: Date.now() } });
  // La riga VIVA porta anche la supervisione NC nel campo DEDICATO
  // ncControl/ncControlLabel: dallo strato P3-2 l'etichetta RENDERIZZATA in
  // card resta solo per «expired», e il codice viaggia comunque nel campo
  // ncControl (è il foglio a nominarla per esteso).

  it('lavora -> «accesa · al lavoro», working true', () => {
    const out = cellRuntime(cella, { ...att('lavora'), working: false });
    expect(out.stato).toBe('lavora');
    expect(out.working).toBe(true);
    expect(out.subtitle).toBe(`${t('cell-present')} · ${t('cell-working')}`);
  });

  it('attesa -> «accesa · attesa permesso», resa come lavoro con la sua etichetta', () => {
    const out = cellRuntime(cella, att('attesa'));
    expect(out.stato).toBe('attesa');
    expect(out.working).toBe(true);
    expect(out.subtitle).toBe(`${t('cell-present')} · ${t('cell-permission')}`);
  });

  it('ferma -> «accesa · in attesa»: il turno finito non è uno stop', () => {
    const out = cellRuntime(cella, att('ferma'));
    expect(out.stato).toBe('ferma');
    expect(out.working).toBe(false);
    expect(out.subtitle).toBe(`${t('cell-present')} · ${t('cell-turn-idle')}`);
    expect(out.subtitle).not.toBe(t('cell-stopped'));
  });

  it('lo stato degli hook vince sul titolo: il titolo dice ferma, gli hook dicono lavora', () => {
    const out = cellRuntime(cella, { ...att('lavora'), working: false });
    expect(out.working).toBe(true);
  });

  it('nessun canale: la riga dice solo la presenza, il titolo resta un indizio', () => {
    const out = cellRuntime(cella, { working: true, status: 'Deciphering…' });
    expect(out.working).toBe(true);
    expect(out.stato).toBe('ignoto');
    expect(out.subtitle).toBe(t('cell-present'));
    expect(out.subtitle).not.toContain(t('cell-unknown'));
  });

  it('titolo «non al lavoro» senza canale -> presenza, MAI «in attesa» dal silenzio', () => {
    const out = cellRuntime(cella, { working: false });
    expect(out.working).toBe(false);
    expect(out.subtitle).toBe(t('cell-present'));
    expect(out.subtitle).not.toBe(t('cell-idle'));
  });

  it('peer precedente al contratto (nessun campo working): resta la presenza, che e\' vera', () => {
    const out = cellRuntime(cella, {});
    expect(out.subtitle).toBe(t('cell-present'));
    expect(out.working).toBe(false);
  });

  it('cella spenta: «spenta», anche quando il motore configurato c\'è', () => {
    expect(cellRuntime({ tmux: false, cell: 'Dev', engine: 'claude' }, {}).working).toBe(false);
    expect(cellRuntime({ tmux: false, cell: 'Dev', engine: 'claude' }, {}).subtitle).toBe(t('cell-off'));
    expect(cellRuntime({ tmux: false, cell: 'Dev' }, {}).subtitle).toBe(t('cell-off'));
  });

  it('ogni etichetta nuova risolve a testo vero, in tutte le lingue', () => {
    for (const chiave of ['cell-stopped', 'cell-permission', 'cell-unknown']) {
      expect(t(chiave)).not.toBe(chiave);
    }
    expect(new Set([t('cell-stopped'), t('cell-permission'), t('cell-unknown'), t('cell-idle')]).size).toBe(4);
  });

  // Ragione terminale del lancio corrente: la verita' di supervisione vince
  // sugli indizi (pane vivo, stato pubblicato, anteprima) e la cella e' FERMA
  // per QUELLA ragione — leggibile anche a pane sparito, perche' il record
  // vive su file. Ragione fuori enum: nessuna etichetta inventata.
  it('ragione terminale: la cella NON viva porta «spenta · <la sua ragione>»', () => {
    // Il record terminale e' l'esito di un lancio: spiega la riga quando la
    // cella non e' viva. A cella viva non sovrascrive cio' che la cella fa.
    const base = {
      active: false, tmux: false, cell: 'Dev', engine: 'claude',
      terminal: { reason: 'restart-budget-exhausted', ts: 1 },
    };
    const out = cellRuntime(base, { ...att('lavora'), working: true, status: 'Working…' });
    expect(out.working).toBe(false);
    expect(out.stato).toBe('ferma');
    expect(out.subtitle).toBe(`${t('cell-off')} · ${t('cell-terminal-restart-budget-exhausted')}`);
  });

  it('ragione terminale: a cella viva decide l’attivita, non il lancio concluso', () => {
    const base = {
      active: true, tmux: true, cell: 'Dev', engine: 'claude',
      terminal: { reason: 'restart-budget-exhausted', ts: 1 },
    };
    const out = cellRuntime(base, { ...att('lavora'), working: true, status: 'Working…' });
    expect(out.working).toBe(true);
    expect(out.stato).toBe('lavora');
    expect(out.subtitle).not.toBe(`${t('cell-off')} · ${t('cell-terminal-restart-budget-exhausted')}`);
  });

  it('ogni ragione dell\'enum ha la SUA frase, in tutte le lingue; ragione ignota non si inventa', () => {
    const ragioni = ['restart-budget-exhausted', 'uncertain-delivery', 'lease-lost', 'spawn-error', 'operator-stop'];
    const frasi = new Set();
    for (const reason of ragioni) {
      const chiave = `cell-terminal-${reason}`;
      expect(t(chiave)).not.toBe(chiave); // la traduzione esiste davvero
      frasi.add(t(chiave));
    }
    expect(frasi.size).toBe(ragioni.length); // frasi DISTINTE
    // Ragione fuori enum: la riga NON la nomina (resta il percorso di prima).
    const ignota = cellRuntime(
      { tmux: false, cell: 'Dev', engine: 'claude', terminal: { reason: 'qualcosaltro', ts: 1 } }, {},
    );
    expect(ignota.subtitle).toBe(t('cell-off'));
  });
});

// ---------------------------------------------------------------------------
// P3-1 — La riga principale della cella è PRESENZA + TURNO: «accesa · al
// lavoro», «accesa · in attesa», «accesa · attesa permesso», oppure «spenta»
// con la sua ragione terminale. Il turno finito («ferma») si dice «in
// attesa»: MAI «stopped», che è la parola dello stop NC. Senza attività
// qualificata la riga mostra SOLO la presenza: il titolo del pane non prova
// nulla e non si chiama più «non verificato».
// ---------------------------------------------------------------------------
describe('P3-1: la riga principale della cella è presenza + turno', () => {
  const cella = { tmux: true, active: true, cell: 'Dev', engine: 'claude' };
  const att = (stato) => ({ attivita: { stato, ts: Date.now() } });
  const presenza = () => t('cell-present');

  it('lavora -> «accesa · al lavoro»', () => {
    const out = cellRuntime(cella, att('lavora'));
    expect(out.working).toBe(true);
    expect(out.stato).toBe('lavora');
    expect(out.subtitle).toBe(`${presenza()} · ${t('cell-working')}`);
  });

  it('attesa -> «accesa · attesa permesso»', () => {
    const out = cellRuntime(cella, att('attesa'));
    expect(out.subtitle).toBe(`${presenza()} · ${t('cell-permission')}`);
  });

  it('ferma -> «accesa · in attesa», MAI «stopped»', () => {
    const out = cellRuntime(cella, att('ferma'));
    expect(out.stato).toBe('ferma');
    expect(out.working).toBe(false);
    expect(out.subtitle).toBe(`${presenza()} · ${t('cell-turn-idle')}`);
    expect(out.subtitle).not.toContain(t('cell-stopped'));
  });

  it('il dettaglio pubblicato dal turno resta, DOPO presenza e turno', () => {
    const out = cellRuntime(cella, { ...att('lavora'), status: 'Refactoring suite' });
    expect(out.subtitle).toBe(`${presenza()} · ${t('cell-working')} · Refactoring suite`);
  });

  it('senza attività qualificata si mostra SOLO la presenza, mai «non verificato» né l\'anteprima', () => {
    const sessioni = [
      { working: true, status: 'Deciphering…' },
      { working: false },
      {},
      { working: false, preview: 'anteprima che non è uno stato' },
    ];
    for (const sessione of sessioni) {
      const out = cellRuntime(cella, sessione);
      expect(out.subtitle, JSON.stringify(sessione)).toBe(presenza());
      expect(out.subtitle).not.toContain(t('cell-unknown'));
      expect(out.subtitle).not.toContain(t('cell-on'));
    }
  });

  it('cella viva con un terminale VECCHIO: la riga dice la presenza e il turno di adesso', () => {
    const out = cellRuntime(
      { ...cella, terminal: { reason: 'operator-stop', ts: 1 } },
      { ...att('lavora'), working: true },
    );
    expect(out.stato).toBe('lavora');
    expect(out.subtitle).toBe(`${presenza()} · ${t('cell-working')}`);
    expect(out.subtitle).not.toContain(t('cell-terminal-operator-stop'));
  });

  it('cella spenta con ragione terminale: «spenta · <ragione>»', () => {
    const out = cellRuntime(
      { tmux: false, active: false, cell: 'Dev', engine: 'claude', terminal: { reason: 'lease-lost', ts: 1 } },
      {},
    );
    expect(out.terminale).toBe('lease-lost');
    expect(out.subtitle).toBe(`${t('cell-off')} · ${t('cell-terminal-lease-lost')}`);
  });

  it('cella spenta senza ragione: SOLO «spenta», il motore configurato non è la presenza', () => {
    const out = cellRuntime({ tmux: false, active: false, cell: 'Dev', engine: 'claude', model: 'glm' }, {});
    expect(out.working).toBe(false);
    expect(out.subtitle).toBe(t('cell-off'));
  });

  it('le chiavi nuove risolvono a testo vero e restano distinte fra loro e da «spenta»', () => {
    for (const chiave of ['cell-present', 'cell-turn-idle']) {
      expect(t(chiave)).not.toBe(chiave);
    }
    expect(new Set([t('cell-present'), t('cell-turn-idle'), t('cell-off')]).size).toBe(3);
  });

  it('le chiavi nuove esistono nelle TRE lingue', () => {
    for (const lang of LANGUAGES) {
      for (const chiave of ['cell-present', 'cell-turn-idle']) {
        expect(DICTS[lang][chiave], `${lang} ${chiave}`).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Un gruppo «up» con la lettura delle sessioni caduta non e' una posizione
// verificata: l'inventario delle celle puo' essere completo mentre l'elenco
// tmux e' degradato. Tutto cio' che deriva dalla sessione — attivita',
// anteprima, stato acceso — in quel caso va dichiarato non verificato.
// ---------------------------------------------------------------------------

describe('autorevolezza della lettura: chi puo\' dire cosa', () => {
  const gruppo = (extra = {}) => ({
    name: 'relay', route: ['relay'], status: 'up',
    sessions: [], sessionsAvailable: true, inventoryPartial: false,
    cells: [], unmanaged: [], capabilities: [], engines: [],
    ...extra,
  });

  it('un gruppo up con lettura caduta lo dichiara, invece di tacere', () => {
    expect(sessionsAuthoritative(gruppo())).toBe(true);
    expect(nodeStateLabel(gruppo())).toBe('');

    const parziale = gruppo({ sessionsAvailable: false, inventoryPartial: true });
    expect(sessionsAuthoritative(parziale)).toBe(false);
    expect(nodeStateLabel(parziale)).toBe(t('node-sessions-unverified'));
    // la chiave deve avere un testo: se la traduzione manca, t() torna la
    // chiave nuda e il contratto e' rotto lo stesso
    expect(t('node-sessions-unverified')).not.toBe('node-sessions-unverified');
  });

  it('un nodo giu\' non e\' «non verificato»: e\' un\'altra cosa, e si dice', () => {
    expect(sessionsAuthoritative({ status: 'down' })).toBe(false);
    expect(nodeStateLabel({ status: 'down' })).not.toBe(t('node-sessions-unverified'));
  });

  it('la cella non si dichiara accesa se lo stato della sua sessione non e\' stato letto', () => {
    const cella = { cell: 'Alfa', tmux: true, engine: 'claude', model: 'm1', key: 'k', tmuxSession: 'cloud-Alfa' };
    // lettura autorevole, sessione assente dal campione: si mostra quel che
    // c'e' — nessuno stato del turno, ma nemmeno una dichiarazione di non
    // verificato, che qui non avrebbe motivo di esistere.
    const prima = cellRuntime(cella, {});
    expect(prima.stato).toBe('ignoto');
    expect(prima.subtitle).not.toContain(t('cell-unknown'));

    const dopo = cellRuntime(cella, {}, { autorevole: false });
    expect(dopo.stato).toBe('ignoto');
    expect(dopo.working).toBe(false);
    expect(dopo.subtitle).toContain(t('cell-unknown'));
    // il motore configurato e' un dato Fleet, che invece c'e': resta visibile
    expect(dopo.subtitle).toContain('claude');
  });

  it('il roster remoto propaga il non verificato alle sue righe', () => {
    const celle = [{ cell: 'Alfa', tmux: true, engine: 'claude', tmuxSession: 'cloud-Alfa' }];
    const verificato = buildRemoteRoster(gruppo({ cells: celle }));
    expect(verificato.rawItems[0].stato).toBe('ignoto');

    const parziale = buildRemoteRoster(gruppo({ cells: celle, sessionsAvailable: false, inventoryPartial: true }));
    expect(parziale.rawItems[0].stato).toBe('ignoto');
    expect(parziale.rawItems[0].working).toBe(false);
  });

  it('anche il roster locale accetta di non essere autorevole', () => {
    const celle = [{ cell: 'Alfa', tmux: true, engine: 'claude', tmuxSession: 'cloud-Alfa' }];
    const ok = buildLocalRoster(celle, [], new Map());
    expect(ok[0].stato).toBe('ignoto');
    const caduto = buildLocalRoster(celle, [], new Map(), undefined, { autorevole: false });
    expect(caduto[0].stato).toBe('ignoto');
  });
});
