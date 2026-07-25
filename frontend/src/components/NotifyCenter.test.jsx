import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  eventHandler: null,
  speechEnabled: true,
  speaker: { enqueue: vi.fn(), stop: vi.fn(), dispose: vi.fn() },
  resolveLang: vi.fn((frame, uiLang) => frame.lang || uiLang),
  closeEvents: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  getAsks: vi.fn(() => Promise.resolve({ asks: [] })),
  answerAsk: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../lib/events.js', () => ({
  connectEvents: vi.fn((_token, onFrame) => {
    mocks.eventHandler = onFrame;
    return mocks.closeEvents;
  }),
}));

vi.mock('../hooks/useNotificationSpeech.js', () => ({
  useNotificationSpeech: () => [mocks.speechEnabled, vi.fn()],
}));

vi.mock('../lib/notification-speech.js', () => ({
  NOTIFICATION_SPEECH_PREVIEW_EVENT: 'nc-notification-speech-preview',
  createNotificationSpeaker: () => mocks.speaker,
  notificationSpeechFrameLang: (frame, uiLang) => mocks.resolveLang(frame, uiLang),
}));

import NotifyCenter from './NotifyCenter.jsx';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  mocks.eventHandler = null;
  mocks.speechEnabled = true;
  mocks.speaker.enqueue.mockReset();
  mocks.speaker.stop.mockReset();
  mocks.speaker.dispose.mockReset();
  mocks.resolveLang.mockClear();
  mocks.closeEvents.mockReset();
});

describe('NotifyCenter notification speech integration', () => {
  it('speaks only live notify frames and prefers an explicit content language', async () => {
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));

    const notify = {
      type: 'notify', title: 'Build ready', body: 'Correzione completata', urgency: 'normal', lang: 'it',
    };
    act(() => mocks.eventHandler(notify));
    expect(await screen.findByText('Build ready')).toBeTruthy();
    expect(mocks.resolveLang).toHaveBeenCalledWith(notify, 'en');
    expect(mocks.speaker.enqueue).toHaveBeenCalledWith(notify, 'it');

    mocks.speaker.enqueue.mockClear();
    act(() => mocks.eventHandler({
      type: 'ask',
      ask: { id: 'a1', session: 'cloud-Dev', question: 'Publish now?', options: [] },
    }));
    act(() => screen.getByTitle('questions from the cells').click());
    expect(await screen.findByText('Publish now?')).toBeTruthy();
    expect(mocks.speaker.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the UI language as the legacy fallback when a frame has no language', async () => {
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    const notify = { type: 'notify', title: 'Short mixed title', body: 'build ok' };
    act(() => mocks.eventHandler(notify));
    expect(mocks.resolveLang).toHaveBeenCalledWith(notify, 'en');
    expect(mocks.speaker.enqueue).toHaveBeenCalledWith(notify, 'en');
  });

  it('keeps visual toasts but does not speak after local opt-out', async () => {
    mocks.speechEnabled = false;
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    const notify = { type: 'notify', title: 'Visual only', urgency: 'normal' };
    act(() => mocks.eventHandler(notify));
    expect(await screen.findByText('Visual only')).toBeTruthy();
    expect(mocks.speaker.enqueue).not.toHaveBeenCalled();
    expect(mocks.speaker.stop).toHaveBeenCalled();
  });

  it('keeps toast delivery and SSE handling alive when the optional speaker throws', async () => {
    mocks.speaker.enqueue.mockImplementationOnce(() => { throw new Error('native speech failed'); });
    render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));

    act(() => mocks.eventHandler({ type: 'notify', title: 'Still visible', ts: 1 }));
    expect(await screen.findByText('Still visible')).toBeTruthy();
    act(() => mocks.eventHandler({ type: 'notify', title: 'Next frame', ts: 2 }));
    expect(await screen.findByText('Next frame')).toBeTruthy();
    expect(mocks.speaker.enqueue).toHaveBeenCalledTimes(2);
  });

  it('closes SSE and stops speech on unmount', async () => {
    const view = render(<NotifyCenter token="token" />);
    await waitFor(() => expect(mocks.eventHandler).toBeTypeOf('function'));
    act(() => window.dispatchEvent(new Event('nc-notification-speech-preview')));
    expect(mocks.speaker.stop).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mocks.closeEvents).toHaveBeenCalled();
    expect(mocks.speaker.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.speaker.stop).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new Event('nc-notification-speech-preview')));
    expect(mocks.speaker.stop).toHaveBeenCalledTimes(1);
  });
});
