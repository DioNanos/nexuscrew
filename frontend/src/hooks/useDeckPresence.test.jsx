import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createWindowRuntimeId, useDeckPresence } from './useDeckPresence.js';
import { loadPresence, PRESENCE_KEY } from '../lib/deck-presence-model.js';

// Componente probe che monta l'hook (nessuna markup: testiamo il side effect
// su localStorage, come fa il modello).
function Probe({ deck, enabled = true }) {
  useDeckPresence(deck, enabled);
  return null;
}

function VisualProbe({ deck }) {
  const { dotFor } = useDeckPresence(deck);
  return <output data-testid="dots">{`${dotFor('local:main')}/${dotFor('local:work')}`}</output>;
}

const someEntry = (deckId) => Object.values(loadPresence()).some((e) => e.deckId === deckId);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('useDeckPresence', () => {
  it('registers the current deck in the presence map', () => {
    render(<Probe deck="local:main" />);
    expect(someEntry('local:main')).toBe(true);
  });

  it('updates the presence when the current deck changes (no heartbeat gap)', () => {
    const { rerender } = render(<Probe deck="local:main" />);
    expect(someEntry('local:main')).toBe(true);
    rerender(<Probe deck="local:work" />);
    expect(someEntry('local:work')).toBe(true);
    expect(someEntry('local:main')).toBe(false); // stesso windowId, deckId sovrascritto
  });

  it('updates rendered dot state immediately on mount and deck navigation', () => {
    const { getByTestId, rerender } = render(<VisualProbe deck="local:main" />);
    expect(getByTestId('dots').textContent).toMatch(/^(working|on)\/neutral$/);
    rerender(<VisualProbe deck="local:work" />);
    expect(getByTestId('dots').textContent).toMatch(/^neutral\/(working|on)$/);
  });

  it('generates distinct runtime ids without consulting opener-copied sessionStorage', () => {
    sessionStorage.setItem('nc_window_id', 'copied-opener-id');
    const first = createWindowRuntimeId();
    const second = createWindowRuntimeId();
    expect(first).toMatch(/^w[A-Za-z0-9_-]{1,63}$/);
    expect(second).toMatch(/^w[A-Za-z0-9_-]{1,63}$/);
    expect(first).not.toBe(second);
    expect(first).not.toBe(sessionStorage.getItem('nc_window_id'));
    expect(second).not.toBe(sessionStorage.getItem('nc_window_id'));
  });

  it('removes its window from the presence map on unmount (cleanup)', () => {
    const { unmount } = render(<Probe deck="local:main" />);
    expect(Object.keys(loadPresence()).length).toBe(1);
    unmount();
    expect(Object.keys(loadPresence()).length).toBe(0);
  });

  it('is a no-op when disabled', () => {
    render(<Probe deck="local:main" enabled={false} />);
    expect(Object.keys(loadPresence()).length).toBe(0);
  });

  it('keeps a stable window identity across re-renders (one entry, not many)', () => {
    const { rerender } = render(<Probe deck="local:main" />);
    rerender(<Probe deck="local:work" />);
    rerender(<Probe deck="local:work" />);
    expect(Object.keys(loadPresence()).length).toBe(1);
  });
});
