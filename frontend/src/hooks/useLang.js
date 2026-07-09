// Hook reattivo [lang, setLang] (switch live senza reload).
// Separato da lib/i18n.js: quello resta puro e testabile in node senza React.
import { useSyncExternalStore } from 'react';
import { getLang, setLang, subscribeLang } from '../lib/i18n.js';

export function useLang() {
  const lang = useSyncExternalStore(subscribeLang, getLang, getLang);
  return [lang, setLang];
}
