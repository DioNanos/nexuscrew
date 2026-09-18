import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import UpdatePrompt from './UpdatePrompt.jsx';
import { reportServerVersions } from '../lib/sw-update.js';
import { setLang, t } from '../lib/i18n.js';

// What the user actually reads. The state machine is pinned in
// lib/sw-update.test.js; this file pins the sentence, because the defect it
// prevents was a SENTENCE: a banner that kept saying "new version 0.9.25
// available" while the running interface already was 0.9.25, with no way of
// closing it.
//
// The session storage used here is the real one (jsdom) because that is the
// store the component's close button writes to: reporting into a different
// store would make the dismissal invisible to the module.
describe('UpdatePrompt', () => {
  beforeEach(() => {
    setLang('en');
    sessionStorage.clear();
  });

  // One silent anti-cache reload first, then the diagnosis — exactly what the
  // user sees on the second detection of the same mismatch.
  function staleInterface() {
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: sessionStorage, applyImpl: () => {} });
    reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: sessionStorage, applyImpl: () => {} });
  }

  it('a stale interface is diagnosed, and the copy is never a "new version" claim', () => {
    staleInterface();
    render(<UpdatePrompt />);

    const expected = t('update-stale').replace('{ui}', '0.9.25').replace('{browser}', '0.9.24');
    expect(screen.getByText(expected)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/new version/i);
    expect(document.body.textContent).not.toContain(t('update-available').replace('{v}', '0.9.25'));
    // The way out is a cache-busting reload, named as such.
    expect(screen.getByText(t('reload-no-cache'))).toBeTruthy();
    expect(screen.getByLabelText(t('update-dismiss'))).toBeTruthy();
  });

  it('a newer package on disk asks for a node restart and offers no reload', () => {
    reportServerVersions('0.9.27', '0.9.26', '0.9.26', { storage: sessionStorage, applyImpl: () => {} });
    render(<UpdatePrompt />);

    expect(screen.getByText(t('update-installed-restart').replace('{v}', '0.9.27'))).toBeTruthy();
    expect(screen.queryByText(t('reload'))).toBeNull();
    expect(screen.queryByText(t('reload-no-cache'))).toBeNull();
    expect(screen.getByLabelText(t('update-dismiss'))).toBeTruthy();
    // The running version is not announced: only the installed one is named.
    expect(document.body.textContent).not.toContain('0.9.26');
  });

  it('the close button hides the banner and the same versions do not bring it back', () => {
    staleInterface();
    render(<UpdatePrompt />);
    expect(screen.getByRole('status')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(t('update-dismiss')));
    expect(screen.queryByRole('status')).toBeNull();

    // Same three versions, same session: the user already closed it.
    act(() => {
      reportServerVersions('0.9.25', '0.9.25', '0.9.24', { storage: sessionStorage, applyImpl: () => {} });
    });
    expect(screen.queryByRole('status')).toBeNull();

    // A different version is news again.
    act(() => {
      reportServerVersions('0.9.26', '0.9.25', '0.9.24', { storage: sessionStorage, applyImpl: () => {} });
    });
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
