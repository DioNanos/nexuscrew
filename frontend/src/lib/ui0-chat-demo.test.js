import { afterEach, describe, expect, it } from 'vitest';
import { ui0ChatEnabled, ui0DemoRequested } from './ui0-chat-demo.js';

afterEach(() => {
  delete globalThis.__NC_UI0_CHAT_DEMO__;
});

describe('ui0 flag', () => {
  it('is OFF by default', () => {
    expect(ui0ChatEnabled({})).toBe(false);
    expect(ui0ChatEnabled()).toBe(false);
  });

  it('reads the build flag only when it is exactly "1"', () => {
    expect(ui0ChatEnabled({ VITE_UI0_CHAT_DEMO: '1' })).toBe(true);
    expect(ui0ChatEnabled({ VITE_UI0_CHAT_DEMO: 'true' })).toBe(false);
    expect(ui0ChatEnabled({ VITE_UI0_CHAT_DEMO: '0' })).toBe(false);
  });

  it('ignores any runtime global override', () => {
    globalThis.__NC_UI0_CHAT_DEMO__ = true;
    expect(ui0ChatEnabled({ VITE_UI0_CHAT_DEMO: '0' })).toBe(false);
    expect(ui0ChatEnabled({})).toBe(false);
    globalThis.__NC_UI0_CHAT_DEMO__ = false;
    expect(ui0ChatEnabled({ VITE_UI0_CHAT_DEMO: '1' })).toBe(true);
  });
});

describe('demo entry', () => {
  it('requires ?ui0=1 exactly', () => {
    expect(ui0DemoRequested('?ui0=1')).toBe(true);
    expect(ui0DemoRequested('?ui0=1&x=2')).toBe(true);
    expect(ui0DemoRequested('?ui0=0')).toBe(false);
    expect(ui0DemoRequested('')).toBe(false);
  });
});
