// R27: la regola della lettura flotta e' ESATTA e vale per due siti
// (SessionList mobile e App desktop) — la si prova come policy pura, cosi'
// i due consumatori non possono divergere di nuovo.
// R27 rev3 (audit): available:false NON e' un fallimento di lettura, e' un
// DATO del server — e il server DICE quale dei due attraverso `reason`
// (lib/fleet/provider.js:22/23/25, builtin.js:577, route /status lo propaga):
//   - «fleetEnabled=false»/«builtinEnabled=false» → spento PER SCELTA: zero
//     celle e' la verita' (kind 'disabled' — lista vuota + indicatore);
//   - «fleet.json …» → config mancante/invalida/non verificabile: transitorio
//     ai fini dell'elenco, resta l'ultima lista nota (kind 'stale');
//   - reject (rete/401/5xx) → non si e' potuto leggere: stale.
// Fail-safe: available:false con reason NON riconosciuto resta una risposta
// RIUSCITA → dato (lista vuota): mai celle fantasma su un server che ha
// parlato (l'audit ha detto che le fantasma sono il caso peggiore).
import { describe, expect, it } from 'vitest';
import { fleetReadOutcome } from './fleet-read-policy.js';

describe('fleetReadOutcome — tre esiti: dato, spento-per-scelta, non-letto', () => {
  it('lettura riuscita: la risposta e\' un dato (celle e capabilities, default lista vuota)', () => {
    expect(fleetReadOutcome({ fs: { available: true, cells: [{ cell: 'A' }], capabilities: ['boot'] } }))
      .toEqual({ kind: 'data', cells: [{ cell: 'A' }], capabilities: ['boot'] });
    expect(fleetReadOutcome({ fs: { available: true } }))
      .toEqual({ kind: 'data', cells: [], capabilities: [] });
  });
  it('zero celle con lettura riuscita resta un DATO: lista vuota vera, non guasto', () => {
    expect(fleetReadOutcome({ fs: { available: true, cells: [] } })).toEqual({ kind: 'data', cells: [], capabilities: [] });
  });
  it('available:false + fleetEnabled=false → SPENTO PER SCELTA: zero celle e\' la verita\' (disabled)', () => {
    const out = fleetReadOutcome({ fs: { available: false, provider: 'disabled', reason: 'fleet disabilitata (fleetEnabled=false)' } });
    expect(out.kind).toBe('disabled');
    expect(out.reason).toBe('fleet disabilitata (fleetEnabled=false)');
  });
  it('available:false + builtinEnabled=false → disabled (l\'altra config esplicita)', () => {
    expect(fleetReadOutcome({ fs: { available: false, reason: 'fleet builtin disabilitata (builtinEnabled=false)' } }).kind).toBe('disabled');
  });
  it('available:false + fleet.json mancante/invalida → TRANSITORIO per l\'elenco: stale', () => {
    expect(fleetReadOutcome({ fs: { available: false, reason: 'fleet.json mancante o invalido (fail-closed)' } }).kind).toBe('stale');
  });
  it('available:false + fleet.json non verificabile (EACCES) → stale', () => {
    expect(fleetReadOutcome({ fs: { available: false, reason: 'fleet.json non verificabile (EACCES): fail-closed, non "assente" né "invalido"' } }).kind).toBe('stale');
  });
  it('reject (rete/401/5xx) → stale: resta l\'ultima lista nota', () => {
    expect(fleetReadOutcome({ error: new Error('fetch failed') }).kind).toBe('stale');
  });
  it('available:false con reason SCONOSCIUTO o assente → dato (lista vuota): mai celle fantasma', () => {
    expect(fleetReadOutcome({ fs: { available: false } }).kind).toBe('disabled');
    expect(fleetReadOutcome({ fs: { available: false, reason: 'qualcosa di nuovo' } }).kind).toBe('disabled');
  });
  it('nessuna risposta → stale', () => {
    expect(fleetReadOutcome({}).kind).toBe('stale');
    expect(fleetReadOutcome().kind).toBe('stale');
  });
});

// —— R33: il client decide su CODICE MACCHINA, non sulla prosa ——
// La regex sul reason e' un'interfaccia fragile: una riformulazione lato
// server cambia il comportamento del client in silenzio. E c'e' gia' un caso
// classificato MALE: la migrazione completata ma non persistibile blocca il
// BOOT del fleet (spento davvero, lista vuota = verita'), ma la prosa nomina
// fleet.json e la regex dice stale -> CELLE FANTASMA.
describe('fleetReadOutcome — R33 migrationCode vince sulla prosa', () => {
  it('TMUX_MIGRATION_PERSIST_FAILED con migrationCode → disabled, non stale: il boot e\' bloccato', () => {
    // Il reason con 'fleet.json' DENTRO c'e' apposta: e' la fixture reale e
    // serve a provare la PRECEDENZA del codice sulla prosa — con un reason
    // riformulato senza 'fleet.json' questo test non distinguerebbe
    // codice-vince da regex-vince.
    //
    // Due assert, due garanzie diverse, e vanno tenute distinte: la
    // CLASSIFICAZIONE guarda solo `kind` — se dipendesse dal testo avremmo
    // rimesso il difetto dentro il test. Il secondo assert non classifica
    // niente: prova che il reason arriva a chi legge INVARIATO, perche' resta
    // l'unica cosa che spiega a un umano cosa e' successo. La fixture qui e'
    // locale, quindi una riformulazione lato server non lo rompe.
    // (Il commento diceva «mai sul testo» e il secondo assert il testo lo
    // guarda: imprecisione trovata rileggendo, corretta.)
    const out = fleetReadOutcome({ fs: {
      available: false,
      reason: 'migrazione tmux completata ma fleet.json non e persistibile [TMUX_MIGRATION_PERSIST_FAILED]',
      migrationCode: 'TMUX_MIGRATION_PERSIST_FAILED',
    } });
    expect(out.kind).toBe('disabled');
    expect(out.reason).toBe('migrazione tmux completata ma fleet.json non e persistibile [TMUX_MIGRATION_PERSIST_FAILED]');
  });

  it('qualunque migrationCode significa boot bloccato: nessun enum chiuso nel client', () => {
    // blocked() e' l'unico produttore del campo e ogni suo codice significa
    // boot bloccato: un codice emesso da un server PIU' NUOVO di questo
    // client deve comunque classificarsi disabled, non cadere sulla prosa.
    expect(fleetReadOutcome({ fs: { available: false, reason: 'x', migrationCode: 'TMUX_MIGRATION_FAILED' } }).kind).toBe('disabled');
    expect(fleetReadOutcome({ fs: { available: false, reason: 'prosa futura senza nomi di file', migrationCode: 'UN_CODICE_CHE_ANCORA_NON_ESISTE' } }).kind).toBe('disabled');
  });

  it('SERVER VECCHIO + client nuovo: senza migrationCode decide il ripiego prosa (limite dichiarato, non regressione)', () => {
    expect(fleetReadOutcome({ fs: {
      available: false,
      reason: 'migrazione tmux completata ma fleet.json non e persistibile [TMUX_MIGRATION_PERSIST_FAILED]',
    } }).kind).toBe('stale');
  });

  it('il ripiego prosa resta per i reason senza codice: nessuna regressione sui cinque esistenti', () => {
    expect(fleetReadOutcome({ fs: { available: false, reason: 'fleet disabilitata (fleetEnabled=false)' } }).kind).toBe('disabled');
    expect(fleetReadOutcome({ fs: { available: false, reason: 'fleet builtin disabilitata (builtinEnabled=false)' } }).kind).toBe('disabled');
    expect(fleetReadOutcome({ fs: { available: false, reason: 'fleet.json mancante o invalido (fail-closed)' } }).kind).toBe('stale');
    expect(fleetReadOutcome({ fs: { available: false, reason: 'fleet.json non verificabile (EACCES): fail-closed, non "assente" né "invalido"' } }).kind).toBe('stale');
    expect(fleetReadOutcome({ fs: { available: false, reason: 'seam di test' } }).kind).toBe('disabled');
  });
});
