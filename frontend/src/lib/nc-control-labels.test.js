import { describe, expect, it } from 'vitest';
import { DICTS, LANGUAGES, setLang, t } from './i18n.js';
import { cellRuntime } from './roster-view-model.js';

// Strato R0c lato PWA: la riga della cella presenta lo stato onesto della
// supervisione NC (campo ncControl del /status). Il campo ASSENTE (vecchio
// server) non diventa mai «senza supervisione»: resta non verificabile.
// Dallo strato P3-2 l'etichetta RENDERIZZATA in card resta solo per «expired»
// (l'unico che chiede un intervento); per tutto il resto il FOGLIO nomina il
// codice per esteso (PowerSheet.test.jsx), e le prove di rendering della card
// vivono in NcControlRow.test.jsx.
const KEYS = ['attested', 'none', 'reconnecting', 'expired', 'unqualified', 'unverifiable', 'inactive'];

describe('nc-control labels — stato supervisione NC per cella', () => {
  it('tutte le lingue hanno le sette chiavi e dicono NC (tranne inactive)', () => {
    for (const lang of LANGUAGES) {
      for (const code of KEYS) {
        const v = DICTS[lang][`nc-control-${code}`];
        expect(v, `${lang} nc-control-${code}`).toBeTruthy();
        if (code !== 'inactive') expect(v).toMatch(/NC/i);
      }
    }
  });

  it('cellRuntime espone ncControl nel campo dedicato; l\'etichetta sta nel foglio', () => {
    setLang('it');
    const r = cellRuntime({ active: true, tmux: true, engine: 'ec', ncControl: 'none' }, {});
    expect(r.ncControl).toBe('none');
    // P3-2: in card l'etichetta non c'è più — la nomina il foglio della cella
    // dal codice. Il subtitle resta il testo di STATO: mai «NC» dentro.
    expect(r.ncControlLabel).toBeUndefined();
    expect(r.subtitle).not.toContain('NC');
  });

  it('cella viva con controllo attestato: il codice resta distinto dalla none', () => {
    setLang('en');
    const r = cellRuntime({ active: true, tmux: true, engine: 'ec', ncControl: 'attested' }, {});
    expect(r.ncControl).toBe('attested');
    expect(r.ncControl).not.toBe('unverifiable');
    expect(r.ncControlLabel).toBeUndefined();
    expect(r.subtitle).not.toContain('NC');
  });

  it('campo assente (vecchio server): non verificabile nel codice, mai «senza supervisione» ricostruita', () => {
    setLang('it');
    const r = cellRuntime({ active: true, tmux: true, engine: 'ec' }, {});
    expect(r.ncControl).toBe('unverifiable');
    // La non verificabilita' vive nel codice che il foglio nomina per esteso
    // (prove reali in PowerSheet.test.jsx). Resta il negativo: mai un none.
    expect(r.ncControl).not.toBe('none');
    expect(r.ncControlLabel).toBeUndefined();
    expect(r.subtitle).not.toContain('NC');
  });

  it('dato fleet conservato (stale o preserved): l\'attestazione corrente non si eredita', () => {
    setLang('it');
    const r = cellRuntime({ active: true, tmux: true, engine: 'ec', ncControl: 'attested' }, {}, { fleetStale: true });
    expect(r.ncControl).toBe('unverifiable');
    expect(r.ncControlLabel).toBeUndefined();
    expect(r.subtitle).not.toContain('NC');
    const p = cellRuntime({ active: true, tmux: true, engine: 'ec', ncControl: 'attested', preserved: true }, {});
    expect(p.ncControl).toBe('unverifiable');
    // Riga preserved: nessuna etichetta di controllo CORRENTE prestata.
    expect(p.ncControlLabel).toBeUndefined();
  });

  it('cella spenta: nessuna etichetta NC in riga', () => {
    setLang('it');
    const r = cellRuntime({ active: false, tmux: false, engine: 'ec', ncControl: 'inactive' }, {});
    expect(r.ncControl).toBe('inactive');
    expect(r.ncControlLabel).toBeUndefined();
    expect(r.subtitle).not.toContain('NC');
  });
});

// ---------------------------------------------------------------------------
// P3-2 — Dell'etichetta NC in CARD resta solo ciò che chiede un'azione
// ADESSO: il controllo SCADUTO. Tutti gli altri esiti — attestato, nessuno,
// in riconnessione, non qualificato, non verificabile — vivono nel FOGLIO
// della cella: senza il binding persistito (F1-c), dopo ogni riavvio del
// servizio l'etichetta perenne sarebbe rumore su ogni riga viva.
// ---------------------------------------------------------------------------
describe('nc-control in card: solo «scaduto» (P3-2)', () => {
  it('attested/none/reconnecting/unqualified/unverifiable NON lasciano etichetta in card', () => {
    setLang('it');
    for (const code of ['attested', 'none', 'reconnecting', 'unqualified', 'unverifiable']) {
      const r = cellRuntime({ active: true, tmux: true, engine: 'ec', ncControl: code }, {});
      expect(r.ncControl, code).toBe(code);
      expect(r.ncControlLabel, code).toBeUndefined();
    }
  });

  it('il campo ASSENTE non lascia etichetta in card (resta non verificabile nel codice)', () => {
    setLang('it');
    const r = cellRuntime({ active: true, tmux: true, engine: 'ec' }, {});
    expect(r.ncControl).toBe('unverifiable');
    expect(r.ncControlLabel).toBeUndefined();
  });

  it('il controllo SCADUTO resta in card: è l\'unico che chiede un intervento', () => {
    setLang('it');
    const r = cellRuntime({ active: true, tmux: true, engine: 'ec', ncControl: 'expired' }, {});
    expect(r.ncControlLabel).toBe(t('nc-control-expired'));
  });
});
