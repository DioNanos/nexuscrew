import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ serverSttConfigured: false }) })),
}));

vi.mock('../lib/attachments.js', () => ({
  uploadSessionFiles: vi.fn(async () => ({ paths: [], errors: [] })),
}));

import ComposerBar from './ComposerBar.jsx';
import {
  COMPOSER_RESET_EVENT,
  composerCellKey,
  loadComposerCell,
  pushComposerHistory,
} from '../lib/composer-model.js';

const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);

function textarea() {
  return screen.getByPlaceholderText('type or dictate…');
}

function renderComposer(props = {}) {
  return render(
    <ComposerBar
      submitText={vi.fn(async () => true)} token="test-token"
      ownerId={OWNER_A} node="relay-old" session="cloud-Dev" {...props}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
});

describe('ComposerBar persistence and history', () => {
  it('persists a long Unicode draft and expanded state by ownerId + tmux session', async () => {
    vi.useFakeTimers();
    const draft = `${'è'.repeat(5000)}\n${'🧠'.repeat(2000)}`;
    const view = renderComposer();
    fireEvent.change(textarea(), { target: { value: draft } });
    fireEvent.click(screen.getByRole('button', { name: 'input history and size' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'expand input' }));
    act(() => vi.advanceTimersByTime(350));
    view.unmount();

    const sameOwner = renderComposer({ node: 'relay-renamed' });
    expect(textarea().value).toBe(draft);
    expect(textarea().rows).toBe(8);
    sameOwner.unmount();

    renderComposer({ ownerId: OWNER_B, node: 'relay-old' });
    expect(textarea().value).toBe('');
    expect(textarea().rows).toBe(2);
    vi.useRealTimers();
  });

  it('flushes the previous cell before a mounted composer changes identity', () => {
    vi.useFakeTimers();
    const submitText = vi.fn(async () => true);
    const view = renderComposer({ submitText });
    fireEvent.change(textarea(), { target: { value: 'draft A' } });

    view.rerender(
      <ComposerBar submitText={submitText} token="test-token"
        ownerId={OWNER_B} node="other-route" session="cloud-Dev" />,
    );
    expect(textarea().value).toBe('');
    fireEvent.change(textarea(), { target: { value: 'draft B' } });

    view.rerender(
      <ComposerBar submitText={submitText} token="test-token"
        ownerId={OWNER_A} node="renamed-route" session="cloud-Dev" />,
    );
    expect(textarea().value).toBe('draft A');
    const keyB = composerCellKey({ ownerId: OWNER_B, session: 'cloud-Dev' });
    expect(loadComposerCell(keyB).draft).toBe('draft B');
    vi.useRealTimers();
  });

  it('keeps a failed draft and does not erase newer typing after an async success', async () => {
    let resolveSubmit;
    const submitText = vi.fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSubmit = resolve; }));
    renderComposer({ submitText });

    fireEvent.change(textarea(), { target: { value: 'keep me' } });
    fireEvent.click(document.querySelector('button.go'));
    expect(await screen.findByText('connection not ready — text kept, try again')).toBeTruthy();
    expect(textarea().value).toBe('keep me');

    fireEvent.change(textarea(), { target: { value: 'submitted text' } });
    fireEvent.click(document.querySelector('button.go'));
    fireEvent.change(textarea(), { target: { value: 'new text while waiting' } });
    await act(async () => { resolveSubmit(true); });

    expect(textarea().value).toBe('new text while waiting');
    const key = composerCellKey({ ownerId: OWNER_A, session: 'cloud-Dev' });
    expect(loadComposerCell(key).history.map((item) => item.text)).toEqual(['submitted text']);
  });

  it('records a delayed success against the cell that submitted it, not the newly selected cell', async () => {
    let resolveSubmit;
    const submitText = vi.fn(() => new Promise((resolve) => { resolveSubmit = resolve; }));
    const view = renderComposer({ submitText });
    fireEvent.change(textarea(), { target: { value: 'from A' } });
    fireEvent.click(document.querySelector('button.go'));

    view.rerender(
      <ComposerBar submitText={submitText} token="test-token"
        ownerId={OWNER_B} node="other-route" session="cloud-Dev" />,
    );
    fireEvent.change(textarea(), { target: { value: 'draft B' } });
    await act(async () => { resolveSubmit(true); });

    expect(textarea().value).toBe('draft B');
    const keyA = composerCellKey({ ownerId: OWNER_A, session: 'cloud-Dev' });
    const keyB = composerCellKey({ ownerId: OWNER_B, session: 'cloud-Dev' });
    expect(loadComposerCell(keyA).draft).toBe('');
    expect(loadComposerCell(keyA).history.map((item) => item.text)).toEqual(['from A']);
    expect(loadComposerCell(keyB).history).toEqual([]);
  });

  it('recalls history only at textarea boundaries and ignores active IME composition', () => {
    const key = composerCellKey({ ownerId: OWNER_A, session: 'cloud-Dev' });
    const now = Date.now();
    pushComposerHistory(key, 'older prompt', localStorage, now - 1);
    pushComposerHistory(key, 'latest prompt', localStorage, now);
    renderComposer();
    const input = textarea();

    input.focus();
    input.setSelectionRange(0, 0);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('latest prompt');

    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { value: 'abc' } });
    input.setSelectionRange(1, 1);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('abc');

    input.setSelectionRange(0, 0);
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'ArrowUp', isComposing: true });
    expect(input.value).toBe('abc');
    fireEvent.compositionEnd(input);
  });

  it('selects a history entry from the popover without submitting it', async () => {
    const submitText = vi.fn(async () => true);
    const key = composerCellKey({ ownerId: OWNER_A, session: 'cloud-Dev' });
    pushComposerHistory(key, 'reusable prompt', localStorage, Date.now());
    renderComposer({ submitText });

    fireEvent.click(screen.getByRole('button', { name: 'input history and size' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /reusable prompt/ }));
    await waitFor(() => expect(textarea().value).toBe('reusable prompt'));
    expect(submitText).not.toHaveBeenCalled();
  });

  it('accepts only a newer cross-tab draft for the same cell', async () => {
    renderComposer();
    fireEvent.change(textarea(), { target: { value: 'local edit' } });
    const key = composerCellKey({ ownerId: OWNER_A, session: 'cloud-Dev' });
    const oldEnvelope = JSON.stringify({
      version: 1,
      cells: { [key]: { draft: 'stale tab edit', history: [], expanded: false, updatedAt: 1 } },
    });
    localStorage.setItem('nc_composer_v1', oldEnvelope);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'nc_composer_v1', newValue: oldEnvelope })));
    expect(textarea().value).toBe('local edit');

    const later = Date.now() + 1000;
    const envelope = JSON.stringify({
      version: 1,
      cells: { [key]: { draft: 'newer tab edit', history: [], expanded: false, updatedAt: later } },
    });
    localStorage.setItem('nc_composer_v1', envelope);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'nc_composer_v1', newValue: envelope })));
    await waitFor(() => expect(textarea().value).toBe('newer tab edit'));
  });

  it('clears mounted in-memory state when browser composer data is reset', () => {
    renderComposer();
    fireEvent.change(textarea(), { target: { value: 'discard me' } });
    act(() => window.dispatchEvent(new Event(COMPOSER_RESET_EVENT)));
    expect(textarea().value).toBe('');
    expect(textarea().rows).toBe(2);
  });

  it('starts STT while explicitly closing the virtual keyboard by default', () => {
    const start = vi.fn();
    class Recognition { start() { start(); } stop() {} }
    const oldSpeech = Object.getOwnPropertyDescriptor(window, 'SpeechRecognition');
    const oldVk = Object.getOwnPropertyDescriptor(navigator, 'virtualKeyboard');
    const hide = vi.fn();
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    Object.defineProperty(navigator, 'virtualKeyboard', { configurable: true, value: { hide } });
    try {
      renderComposer();
      const input = textarea(); input.focus();
      fireEvent.pointerDown(screen.getByRole('button', { name: 'voice' }));
      expect(start).toHaveBeenCalledOnce();
      expect(hide).toHaveBeenCalledOnce();
      expect(document.activeElement).not.toBe(input);
    } finally {
      if (oldSpeech) Object.defineProperty(window, 'SpeechRecognition', oldSpeech); else delete window.SpeechRecognition;
      if (oldVk) Object.defineProperty(navigator, 'virtualKeyboard', oldVk); else delete navigator.virtualKeyboard;
    }
  });

  it('lets the Settings preference preserve the composer IME during STT', () => {
    const start = vi.fn();
    class Recognition { start() { start(); } stop() {} }
    const oldSpeech = Object.getOwnPropertyDescriptor(window, 'SpeechRecognition');
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    try {
      renderComposer({ keepKeyboardClosedOnVoice: false });
      const input = textarea(); input.focus();
      fireEvent.pointerDown(screen.getByRole('button', { name: 'voice' }));
      expect(start).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(input);
    } finally {
      if (oldSpeech) Object.defineProperty(window, 'SpeechRecognition', oldSpeech); else delete window.SpeechRecognition;
    }
  });
});
