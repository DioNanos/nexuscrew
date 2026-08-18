import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/notification-speech.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    notificationSpeechSupported: vi.fn(() => true),
    previewNotificationSpeech: vi.fn(),
  };
});

import { NotificationSpeechRow } from './SettingsPanel.jsx';
import { previewNotificationSpeech } from '../lib/notification-speech.js';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  previewNotificationSpeech.mockReset();
});

describe('NotificationSpeechRow preview failure messages (R27 #8)', () => {
  it('shows the voice-error message instead of the no-activation one', async () => {
    previewNotificationSpeech.mockResolvedValue('voice-error');
    render(<NotificationSpeechRow />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByText(
      'The voice test failed: voice or audio unavailable. Check the selected voice and try again.',
    )).toBeTruthy();
    expect(screen.queryByText(
      'The browser did not start the voice test. Interact with the page and try again.',
    )).toBeNull();
  });

  it('shows the timeout message instead of the no-activation one', async () => {
    previewNotificationSpeech.mockResolvedValue('timeout');
    render(<NotificationSpeechRow />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByText(
      'The voice test failed: no response from the speech engine. Check the selected voice and try again.',
    )).toBeTruthy();
  });
});
