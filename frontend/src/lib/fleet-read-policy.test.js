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
