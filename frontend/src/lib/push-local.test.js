import { describe, it, expect, beforeEach } from 'vitest';
import { loadPushLocal, savePushLocal, pushLocallyDisabled, PUSH_LOCAL_KEY } from './push-local.js';

describe('browser-local push choice', () => {
  beforeEach(() => { localStorage.clear(); });

  it('defaults to push enabled: nothing is switched off on its own', () => {
    expect(loadPushLocal()).toEqual({ enabled: true });
    expect(pushLocallyDisabled()).toBe(false);
  });

  it('remembers an explicit opt-out and survives a page reload', () => {
    savePushLocal({ enabled: false });
    expect(JSON.parse(localStorage.getItem(PUSH_LOCAL_KEY))).toEqual({ enabled: false });
    expect(pushLocallyDisabled()).toBe(true);
  });

  it('repairs garbage instead of failing', () => {
    localStorage.setItem(PUSH_LOCAL_KEY, 'not json');
    expect(loadPushLocal()).toEqual({ enabled: true });
    localStorage.setItem(PUSH_LOCAL_KEY, JSON.stringify({ enabled: 'yes' }));
    expect(loadPushLocal().enabled).toBe(true);
  });
});
