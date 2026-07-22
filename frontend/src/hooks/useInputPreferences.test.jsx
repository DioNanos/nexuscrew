import React from 'react';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  DEFAULT_INPUT_PREFERENCES, INPUT_PREFERENCES_EVENT, INPUT_PREFERENCES_KEY,
} from '../lib/input-preferences.js';
import useInputPreferences from './useInputPreferences.js';

// Sonda minima: espone il gesto terminale corrente per ispezione dal DOM.
function Probe() {
  const [prefs] = useInputPreferences();
  return <div data-testid="gesture">{prefs.terminalKeyboardGesture}</div>;
}

beforeEach(() => {
  localStorage.clear();
});

describe('useInputPreferences — synchronization', () => {
  it('updates the same window on a CustomEvent carrying the normalized payload', () => {
    const view = render(<Probe />);
    expect(view.getByTestId('gesture').textContent).toBe(DEFAULT_INPUT_PREFERENCES.terminalKeyboardGesture);
    act(() => window.dispatchEvent(new CustomEvent(INPUT_PREFERENCES_EVENT, {
      detail: { terminalKeyboardGesture: 'single-tap' },
    })));
    expect(view.getByTestId('gesture').textContent).toBe('single-tap');
  });

  it('re-reads storage on a StorageEvent for the preferences key', () => {
    const view = render(<Probe />);
    expect(view.getByTestId('gesture').textContent).toBe('double-tap');
    // un'altra finestra ha scritto localStorage; jsdom non propaga, scriviamo a mano
    // e notifichiamo tramite l'evento 'storage' cross-window.
    localStorage.setItem(INPUT_PREFERENCES_KEY, JSON.stringify({
      ...DEFAULT_INPUT_PREFERENCES, terminalKeyboardGesture: 'never',
    }));
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: INPUT_PREFERENCES_KEY,
      newValue: localStorage.getItem(INPUT_PREFERENCES_KEY),
    })));
    expect(view.getByTestId('gesture').textContent).toBe('never');
  });

  it('restores defaults when another window clears client storage (key === null)', () => {
    const view = render(<Probe />);
    // portiamo il gesto lontano dal default per rendere osservabile il ripristino
    act(() => window.dispatchEvent(new CustomEvent(INPUT_PREFERENCES_EVENT, {
      detail: { terminalKeyboardGesture: 'single-tap' },
    })));
    expect(view.getByTestId('gesture').textContent).toBe('single-tap');
    // localStorage.clear() di un'altra finestra emette storage con key === null
    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null })));
    expect(view.getByTestId('gesture').textContent).toBe(DEFAULT_INPUT_PREFERENCES.terminalKeyboardGesture);
  });

  it('ignores a storage event for an unrelated key', () => {
    const view = render(<Probe />);
    act(() => window.dispatchEvent(new CustomEvent(INPUT_PREFERENCES_EVENT, {
      detail: { terminalKeyboardGesture: 'single-tap' },
    })));
    expect(view.getByTestId('gesture').textContent).toBe('single-tap');
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'nc_unrelated_v1', newValue: '{"terminalKeyboardGesture":"never"}',
    })));
    // nessun aggiornamento: lo stato resta al valore impostato dal CustomEvent
    expect(view.getByTestId('gesture').textContent).toBe('single-tap');
  });

  it('removes its listeners on unmount (no update after unmount + explicit cleanup)', () => {
    // osservabile comportamentale: snapshot aggiornato dal corpo del componente.
    // un componente smontato non puo' piu' renderizzare, quindi l'assenza di un
    // nuovo snapshot dopo l'unmount dimostra "no update/render"; la spia su
    // removeEventListener documenta che il cleanup esplicito e' avvenuto.
    const snapshots = [];
    function SnapshotProbe() {
      const [prefs] = useInputPreferences();
      snapshots.push(prefs.terminalKeyboardGesture);
      return null;
    }
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      const { unmount } = render(<SnapshotProbe />);
      // controllo positivo: il listener e' attivo e l'evento aggiorna lo stato
      act(() => window.dispatchEvent(new CustomEvent(INPUT_PREFERENCES_EVENT, {
        detail: { terminalKeyboardGesture: 'single-tap' },
      })));
      expect(snapshots[snapshots.length - 1]).toBe('single-tap');
      removeSpy.mockClear();
      unmount();
      // cleanup esplicito di entrambi i listener registrati nell'effect
      expect(removeSpy).toHaveBeenCalledWith(INPUT_PREFERENCES_EVENT, expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('storage', expect.any(Function));
      const before = snapshots[snapshots.length - 1];
      const storageReadSpy = vi.spyOn(Storage.prototype, 'getItem');
      try {
        // Se il listener storage fosse rimasto vivo, loadInputPreferences()
        // leggerebbe localStorage: e' un effetto osservabile anche dopo unmount.
        act(() => window.dispatchEvent(new StorageEvent('storage', {
          key: INPUT_PREFERENCES_KEY, newValue: null,
        })));
        act(() => window.dispatchEvent(new CustomEvent(INPUT_PREFERENCES_EVENT, {
          detail: { terminalKeyboardGesture: 'never' },
        })));
        expect(storageReadSpy).not.toHaveBeenCalled();
        expect(snapshots[snapshots.length - 1]).toBe(before);
      } finally {
        storageReadSpy.mockRestore();
      }
    } finally {
      removeSpy.mockRestore();
    }
  });
});
