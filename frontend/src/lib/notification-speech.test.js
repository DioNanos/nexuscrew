import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_SPEECH,
  MAX_NOTIFICATION_SPEECH_CHARS,
  NOTIFICATION_SPEECH_KEY,
  createNotificationSpeaker,
  detectNotificationSpeechLang,
  loadNotificationSpeech,
  notificationSpeechFrameLang,
  notificationSpeechLang,
  notificationSpeechPrimed,
  notificationSpeechSupported,
  notificationSpeechText,
  notificationSpeechVoice,
  previewNotificationSpeech,
  saveNotificationSpeech,
} from './notification-speech.js';

function speechFixture({ visible = true, focused = true, voices = [] } = {}) {
  const spoken = [];
  let currentVoices = voices;
  const listeners = new Map();
  const synth = {
    cancel: vi.fn(),
    speak: vi.fn((utterance) => { spoken.push(utterance); }),
    getVoices: vi.fn(() => currentVoices),
    addEventListener: vi.fn((type, fn) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    }),
  };
  class Utterance {
    constructor(text) {
      this.text = text;
      this.lang = '';
      this.voice = null;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  const scope = {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: Utterance,
  };
  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    hasFocus: () => focused,
  };
  const setVoices = (next) => {
    currentVoices = next;
    listeners.get('voiceschanged')?.();
  };
  return { scope, document, synth, spoken, setVoices };
}

function createPrimedSpeaker(fixture, opts = {}) {
  return createNotificationSpeaker({
    scope: fixture.scope,
    document: fixture.document,
    isPrimed: () => true,
    ...opts,
  });
}

describe('notification speech preferences and formatting', () => {
  it('is default-off and fails closed on malformed storage', () => {
    const storage = {
      getItem: vi.fn(() => '{broken'),
      setItem: vi.fn(),
    };
    expect(loadNotificationSpeech(storage)).toEqual(DEFAULT_NOTIFICATION_SPEECH);
    expect(storage.getItem).toHaveBeenCalledWith(NOTIFICATION_SPEECH_KEY);
  });

  it('persists only the normalized enabled boolean', () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() };
    expect(saveNotificationSpeech({ enabled: true, extra: 'drop' }, storage)).toEqual({ enabled: true });
    expect(storage.setItem).toHaveBeenCalledWith(NOTIFICATION_SPEECH_KEY, '{"enabled":true}');
    expect(saveNotificationSpeech({ enabled: 'true' }, storage)).toEqual({ enabled: false });
  });

  it('normalizes whitespace, omits duplicate body and bounds Unicode text', () => {
    expect(notificationSpeechText({ title: ' Done\n now ', body: 'body\ttext' })).toBe('Done now. body text');
    expect(notificationSpeechText({ title: 'same', body: 'same' })).toBe('same');
    const bounded = notificationSpeechText({ title: '🔔'.repeat(400) });
    expect(Array.from(bounded)).toHaveLength(MAX_NOTIFICATION_SPEECH_CHARS);
    expect(bounded.endsWith('…')).toBe(true);
  });

  it('redacts credential-shaped values and private home paths before speech', () => {
    const text = notificationSpeechText({
      title: 'token=top-secret /home/alice/private/report.txt',
      body: 'Bearer hidden-value OPENAI_API_KEY="also-hidden"',
    });
    expect(text).toBe(
      '[redacted] [private path]. Bearer [redacted] [redacted]',
    );
    expect(text).not.toContain('alice');
    expect(text).not.toContain('hidden');
  });

  it('normalizes supported locale tags and uses an empty browser-default fallback', () => {
    expect(notificationSpeechLang('it')).toBe('it-IT');
    expect(notificationSpeechLang('it-IT')).toBe('it-IT');
    expect(notificationSpeechLang(' IT-it ')).toBe('it-IT');
    expect(notificationSpeechLang('en')).toBe('en-US');
    expect(notificationSpeechLang('es')).toBe('es-ES');
    for (const value of ['xx', '', undefined, null]) {
      expect(notificationSpeechLang(value)).toBe('');
    }
  });

  it('uses explicit frame language, then high-confidence body detection, then UI language', () => {
    expect(notificationSpeechFrameLang({ lang: 'it-IT', body: 'English body is ignored' }, 'en')).toBe('it-IT');
    expect(notificationSpeechFrameLang({
      title: 'Build ready',
      body: 'Correzione completata e verificata con nessun difetto nel rilascio pubblicato.',
    }, 'en')).toBe('it-IT');
    expect(notificationSpeechFrameLang({
      title: 'file da cloud-Dev',
      body: 'report.txt',
    }, 'en')).toBe('en-US');
    expect(detectNotificationSpeechLang('Correzione completata, versione verificata e pubblicata.')).toBe('it');
    expect(detectNotificationSpeechLang('file da cloud-Dev')).toBe('');
  });

  it('selects an exact or base-matching voice without falling back to another language', () => {
    const en = { name: 'English', lang: 'en-US', default: true };
    const it = { name: 'Federica', lang: 'it-IT' };
    const itCh = { name: 'Italian Swiss', lang: 'it-CH', default: true };
    expect(notificationSpeechVoice([en, itCh, it], 'it-IT')).toBe(it);
    expect(notificationSpeechVoice([en, itCh], 'it-IT')).toBe(itCh);
    expect(notificationSpeechVoice([en], 'it-IT')).toBeNull();
    expect(notificationSpeechVoice([it], '')).toBeNull();
  });
});

describe('notification speech browser adapter', () => {
  it('feature-detects and confirms a preview only after native start and end', async () => {
    const italian = { name: 'Federica', lang: 'it-IT' };
    const f = speechFixture({ voices: [italian] });
    expect(notificationSpeechSupported(f.scope)).toBe(true);
    const result = previewNotificationSpeech('Pronto', 'it-IT', f.scope);
    expect(f.synth.cancel).toHaveBeenCalledTimes(1);
    expect(f.spoken).toHaveLength(1);
    expect(f.spoken[0]).toMatchObject({ text: 'Pronto', lang: 'it-IT', voice: italian });
    expect(notificationSpeechPrimed(f.scope)).toBe(false);
    f.spoken[0].onstart();
    f.spoken[0].onend();
    await expect(result).resolves.toBe(true);
    expect(notificationSpeechPrimed(f.scope)).toBe(true);
    expect(notificationSpeechSupported({})).toBe(false);
  });

  it('fails an honest preview when the native engine never starts or ends', async () => {
    vi.useFakeTimers();
    try {
      const f = speechFixture();
      const result = previewNotificationSpeech('Silent', 'en', f.scope, { timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(result).resolves.toBe('timeout');
      expect(f.synth.cancel).toHaveBeenCalledTimes(2);
      expect(notificationSpeechPrimed(f.scope)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a voice error when the native engine fails after starting (R27 #8)', async () => {
    const f = speechFixture();
    const result = previewNotificationSpeech('Broken', 'en', f.scope);
    f.spoken[0].onstart();
    f.spoken[0].onerror();
    await expect(result).resolves.toBe('voice-error');
    expect(notificationSpeechPrimed(f.scope)).toBe(false);
  });

  it('reports missing activation when the engine ends without ever starting (R27 #8)', async () => {
    const f = speechFixture();
    const result = previewNotificationSpeech('Ghost', 'en', f.scope);
    f.spoken[0].onend();
    await expect(result).resolves.toBe('no-activation');
    expect(notificationSpeechPrimed(f.scope)).toBe(false);
  });

  it('aborts an in-flight preview without accepting a later native end', async () => {
    const f = speechFixture();
    const controller = new AbortController();
    const result = previewNotificationSpeech('Cancel me', 'en', f.scope, {
      signal: controller.signal,
    });
    f.spoken[0].onstart();
    controller.abort();
    f.spoken[0].onend();
    await expect(result).resolves.toBe('no-activation');
    expect(f.synth.cancel).toHaveBeenCalledTimes(2);
    expect(notificationSpeechPrimed(f.scope)).toBe(false);
  });

  it('does not speak live notifications before a successful session preview', async () => {
    const f = speechFixture();
    const speaker = createNotificationSpeaker({ scope: f.scope, document: f.document });
    expect(speaker.enqueue({ ts: 1, title: 'Before preview' }, 'en')).toBe('unprimed');
    expect(f.spoken).toHaveLength(0);

    const result = previewNotificationSpeech('Ready', 'en', f.scope);
    f.spoken[0].onstart();
    f.spoken[0].onend();
    await expect(result).resolves.toBe(true);
    expect(speaker.enqueue({ ts: 2, title: 'After preview' }, 'en')).toBe('speaking');
    expect(f.spoken.map((utterance) => utterance.text)).toEqual(['Ready', 'After preview']);
  });

  it.each([
    [{ visible: false, focused: true }, 'hidden'],
    [{ visible: true, focused: false }, 'unfocused'],
  ])('does not speak from an inactive document: %s', (state) => {
    const f = speechFixture(state);
    const speaker = createPrimedSpeaker(f);
    expect(speaker.enqueue({ title: 'Do not read' }, 'en')).toBe('inactive');
    expect(f.synth.speak).not.toHaveBeenCalled();
  });

  it('fails closed when visibility or focus signals are unavailable', () => {
    const f = speechFixture();
    const noVisibility = createNotificationSpeaker({
      scope: f.scope, document: { hasFocus: () => true }, isPrimed: () => true,
    });
    const noFocus = createNotificationSpeaker({
      scope: f.scope, document: { visibilityState: 'visible' }, isPrimed: () => true,
    });
    expect(noVisibility.enqueue({ title: 'No visibility signal' }, 'en')).toBe('inactive');
    expect(noFocus.enqueue({ title: 'No focus signal' }, 'en')).toBe('inactive');
    expect(f.synth.speak).not.toHaveBeenCalled();
  });

  it('keeps only the two newest normal notifications pending', () => {
    const f = speechFixture();
    const speaker = createPrimedSpeaker(f);
    expect(speaker.enqueue({ title: 'one' }, 'en')).toBe('speaking');
    expect(speaker.enqueue({ title: 'two' }, 'en')).toBe('queued');
    expect(speaker.enqueue({ title: 'three' }, 'en')).toBe('queued');
    expect(speaker.enqueue({ title: 'four' }, 'en')).toBe('queued');
    expect(f.spoken.map((u) => u.text)).toEqual(['one']);

    f.spoken[0].onend();
    expect(f.spoken.map((u) => u.text)).toEqual(['one', 'three']);
    f.spoken[1].onend();
    expect(f.spoken.map((u) => u.text)).toEqual(['one', 'three', 'four']);
  });

  it('preempts current and pending speech for a high-urgency notification', () => {
    const f = speechFixture();
    const speaker = createPrimedSpeaker(f);
    speaker.enqueue({ title: 'normal one' }, 'en');
    speaker.enqueue({ title: 'normal two' }, 'en');
    expect(speaker.enqueue({ title: 'urgent', urgency: 'high' }, 'it')).toBe('speaking');
    expect(f.synth.cancel).toHaveBeenCalledTimes(1);
    expect(f.spoken.map((u) => [u.text, u.lang])).toEqual([
      ['normal one', 'en-US'],
      ['urgent', 'it-IT'],
    ]);
    f.spoken[0].onend?.();
    expect(f.spoken).toHaveLength(2);
  });

  it('refreshes an initially empty voice cache on voiceschanged without delaying the queue', () => {
    const f = speechFixture();
    const speaker = createPrimedSpeaker(f);
    expect(speaker.enqueue({ title: 'first' }, 'it')).toBe('speaking');
    expect(f.spoken[0]).toMatchObject({ lang: 'it-IT', voice: null });
    f.spoken[0].onend();

    const italian = { name: 'Federica', lang: 'it-IT', default: true };
    f.setVoices([italian]);
    expect(speaker.enqueue({ title: 'second' }, 'it-IT')).toBe('speaking');
    expect(f.spoken[1]).toMatchObject({ lang: 'it-IT', voice: italian });
    expect(f.synth.getVoices).toHaveBeenCalledTimes(2);

    speaker.dispose();
    expect(f.synth.removeEventListener).toHaveBeenCalledWith('voiceschanged', expect.any(Function));
  });

  it('keeps an unknown language as the empty browser default, never a stringified sentinel', () => {
    const f = speechFixture();
    const speaker = createPrimedSpeaker(f);
    expect(speaker.enqueue({ title: 'unknown' }, 'xx')).toBe('speaking');
    expect(f.spoken[0].lang).toBe('');
    expect(f.spoken[0].lang).not.toBe('undefined');
    expect(f.spoken[0].lang).not.toBe('null');
  });

  it('drains after native errors and cancels all work on stop', () => {
    const f = speechFixture();
    const speaker = createPrimedSpeaker(f);
    speaker.enqueue({ title: 'one' }, 'en');
    speaker.enqueue({ title: 'two' }, 'en');
    f.spoken[0].onerror();
    expect(f.spoken.map((u) => u.text)).toEqual(['one', 'two']);
    speaker.stop();
    expect(f.synth.cancel).toHaveBeenCalledTimes(1);
    f.spoken[1].onend?.();
    expect(f.spoken).toHaveLength(2);
  });

  it('uses a watchdog so a broken native engine cannot block the queue', () => {
    vi.useFakeTimers();
    try {
      const f = speechFixture();
      const speaker = createPrimedSpeaker(f, { watchdogMs: 1000 });
      speaker.enqueue({ title: 'stuck' }, 'en');
      speaker.enqueue({ title: 'next' }, 'en');
      vi.advanceTimersByTime(1000);
      expect(f.synth.cancel).toHaveBeenCalledTimes(1);
      expect(f.spoken.map((u) => u.text)).toEqual(['stuck', 'next']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates repeated reconnect frames inside a bounded time window', () => {
    let now = 1000;
    const f = speechFixture();
    const speaker = createPrimedSpeaker(f, { now: () => now });
    const frame = { ts: 42, title: 'Same notification' };

    expect(speaker.enqueue(frame, 'en')).toBe('speaking');
    expect(speaker.enqueue(frame, 'en')).toBe('duplicate');
    f.spoken[0].onend();
    expect(speaker.enqueue(frame, 'en')).toBe('duplicate');
    expect(f.spoken).toHaveLength(1);

    now += 60000;
    expect(speaker.enqueue(frame, 'en')).toBe('speaking');
    expect(f.spoken).toHaveLength(2);
  });

  it('bounds dedup memory and prefers an explicit frame id', () => {
    const f = speechFixture();
    const speaker = createPrimedSpeaker(f, { maxDedup: 2, maxPending: 8 });
    expect(speaker.enqueue({ id: 'a', ts: 1, title: 'first' }, 'en')).toBe('speaking');
    expect(speaker.enqueue({ id: 'b', ts: 2, title: 'second' }, 'en')).toBe('queued');
    expect(speaker.enqueue({ id: 'c', ts: 3, title: 'third' }, 'en')).toBe('queued');
    expect(speaker.enqueue({ id: 'c', ts: 4, title: 'changed title' }, 'en')).toBe('duplicate');
    expect(speaker.enqueue({ id: 'a', ts: 5, title: 'first again' }, 'en')).toBe('queued');
  });
});
