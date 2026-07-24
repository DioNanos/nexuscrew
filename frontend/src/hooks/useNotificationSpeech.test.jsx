import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_SPEECH_EVENT, NOTIFICATION_SPEECH_KEY,
} from '../lib/notification-speech.js';
import useNotificationSpeech from './useNotificationSpeech.js';

function Probe() {
  const [enabled, setEnabled] = useNotificationSpeech();
  return (
    <button type="button" data-testid="speech" onClick={() => setEnabled(!enabled)}>
      {enabled ? 'on' : 'off'}
    </button>
  );
}

beforeEach(() => localStorage.clear());

describe('useNotificationSpeech', () => {
  it('persists and synchronizes an update in the same window', () => {
    const view = render(<Probe />);
    expect(view.getByTestId('speech').textContent).toBe('off');
    act(() => view.getByTestId('speech').click());
    expect(view.getByTestId('speech').textContent).toBe('on');
    expect(JSON.parse(localStorage.getItem(NOTIFICATION_SPEECH_KEY))).toEqual({ enabled: true });

    act(() => window.dispatchEvent(new CustomEvent(NOTIFICATION_SPEECH_EVENT, {
      detail: { enabled: false },
    })));
    expect(view.getByTestId('speech').textContent).toBe('off');
  });

  it('re-reads cross-window storage and localStorage.clear events', () => {
    const view = render(<Probe />);
    localStorage.setItem(NOTIFICATION_SPEECH_KEY, '{"enabled":true}');
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: NOTIFICATION_SPEECH_KEY,
      newValue: '{"enabled":true}',
    })));
    expect(view.getByTestId('speech').textContent).toBe('on');

    localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
    expect(view.getByTestId('speech').textContent).toBe('off');
  });

  it('ignores unrelated storage events and removes both listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      const view = render(<Probe />);
      act(() => view.getByTestId('speech').click());
      act(() => window.dispatchEvent(new StorageEvent('storage', {
        key: 'nc_unrelated', newValue: null,
      })));
      expect(view.getByTestId('speech').textContent).toBe('on');
      view.unmount();
      expect(removeSpy).toHaveBeenCalledWith(NOTIFICATION_SPEECH_EVENT, expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('storage', expect.any(Function));
    } finally {
      removeSpy.mockRestore();
    }
  });
});
