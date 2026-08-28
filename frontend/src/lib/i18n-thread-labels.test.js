import { describe, expect, it } from 'vitest';
import {
  DICTS, LANGUAGES, THREAD_STATUS_I18N_KEYS, assertThreadStatusLabelsAreThreadOnly,
} from './i18n.js';

describe('thread status labels — promessa semantica V1', () => {
  it('tutte le lingue presenti hanno le chiavi e parlano del thread', () => {
    expect(LANGUAGES).toEqual(['it', 'en', 'es']);
    expect(assertThreadStatusLabelsAreThreadOnly(DICTS)).toBe(true);
  });

  it('NEGATIVO: una copia con Live connessa deve diventare rossa', () => {
    const copiedDicts = Object.fromEntries(
      Object.entries(DICTS).map(([lang, dict]) => [lang, { ...dict }]),
    );
    copiedDicts.en['host-thread-active'] = 'Live connessa';

    expect(() => assertThreadStatusLabelsAreThreadOnly(copiedDicts))
      .toThrow('en.host-thread-active');
  });
});
