// Reactive [kobbUI, setKobbUI]. Live toggle without reload (mirrors useLang).
import { useSyncExternalStore } from 'react';
import { getKobbUI, setKobbUI, subscribeKobbUI } from '../lib/kobb-ui.js';

export function useKobbUI() {
  const kobbUI = useSyncExternalStore(subscribeKobbUI, getKobbUI, () => getKobbUI());
  return [kobbUI, setKobbUI];
}