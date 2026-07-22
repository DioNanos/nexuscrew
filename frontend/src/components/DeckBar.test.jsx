import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PRESENCE_KEY } from '../lib/deck-presence-model.js';

vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import DeckBar from './DeckBar.jsx';

const owner = 'a'.repeat(32);
const decks = [
  { id: 'local:main', name: 'main', ownerId: 'b'.repeat(32), ownerLabel: 'Local', local: true, available: true },
  { id: 'local:work', name: 'work', ownerId: 'b'.repeat(32), ownerLabel: 'Local', local: true, available: true },
  { id: `${owner}:main`, name: 'main', ownerId: owner, ownerLabel: 'Relay', local: false, available: true },
];
const COLLAPSE_KEY = 'nc_deckbar_collapsed_v1';

function expandAll() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ local: false, [owner]: false }));
}

function renderBar(onReorder = vi.fn(), overrides = {}) {
  render(<DeckBar decks={decks} currentDeck="local:main" onReorder={onReorder}
    onNavigate={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} {...overrides} />);
  return onReorder;
}

// helper: trova il button toggle del nodo via nome owner
const toggleFor = (name) => screen.getByRole('button', { name });
const groupFor = (name) => toggleFor(name).closest('.nc-deck-owner-group');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  expandAll();
});

describe('deck pointer reorder (regression: handles still work when expanded)', () => {
  it.each(['mouse', 'touch'])('moves a deck inside its owner with a %s pointer', (pointerType) => {
    const onReorder = renderBar();
    const source = screen.getByRole('button', { name: 'reorder Local · work' });
    const target = document.querySelector('[data-deck-id="local:main"]');
    const previous = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });
    fireEvent.pointerDown(source, { pointerId: 9, pointerType, button: 0, clientX: 40, clientY: 10 });
    fireEvent.pointerMove(source, { pointerId: 9, pointerType, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(source, { pointerId: 9, pointerType, clientX: 10, clientY: 10 });
    expect(onReorder).toHaveBeenCalledWith('local:work', 'local:main');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: previous });
  });

  it('supports keyboard left/right and rejects a cross-owner drop', async () => {
    const user = userEvent.setup();
    const onReorder = renderBar();
    const source = screen.getByRole('button', { name: 'reorder Local · work' });
    source.focus();
    await user.keyboard('{ArrowLeft}');
    expect(onReorder).toHaveBeenCalledWith('local:work', 'local:main');
    onReorder.mockClear();

    const remote = document.querySelector(`[data-deck-id="${owner}:main"]`);
    const previous = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => remote) });
    fireEvent.pointerDown(source, { pointerId: 11, pointerType: 'mouse', button: 0, clientX: 40, clientY: 10 });
    fireEvent.pointerMove(source, { pointerId: 11, pointerType: 'mouse', clientX: 90, clientY: 10 });
    fireEvent.pointerUp(source, { pointerId: 11, pointerType: 'mouse', clientX: 90, clientY: 10 });
    expect(onReorder).not.toHaveBeenCalled();
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: previous });
  });
});

describe('owner group accessibility', () => {
  it('renders a real button with aria-expanded and aria-controls on the node name', () => {
    renderBar();
    const toggle = toggleFor('Local');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const controlled = document.getElementById(toggle.getAttribute('aria-controls'));
    expect(controlled).toBeTruthy();
    expect(controlled.hidden).toBe(false);
  });

  it('toggles expanded/collapsed on click and reflects aria-expanded', async () => {
    const user = userEvent.setup();
    renderBar();
    const toggle = toggleFor('Local');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')).hidden).toBe(true);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles via keyboard Enter and Space (native button activation)', async () => {
    const user = userEvent.setup();
    renderBar();
    const toggle = toggleFor('Relay');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('default collapsed for new owners', () => {
  it('a brand-new owner (no stored preference) starts collapsed', () => {
    localStorage.removeItem(COLLAPSE_KEY);
    renderBar();
    const group = groupFor('Local');
    expect(group.className).toContain('collapsed');
    expect(group.getAttribute('data-collapsed')).toBe('1');
    // I deck compressi non sono esposti nell'albero accessibile.
    expect(screen.queryByRole('button', { name: 'reorder Local · work' })).toBeNull();
  });
});

describe('collapsed summary chip', () => {
  it('shows window count and the current deck when the node owns it', () => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ local: true })); // comprimi Local
    render(<DeckBar decks={decks} currentDeck="local:main" onNavigate={vi.fn()} />);
    const group = groupFor('Local');
    expect(group.className).toContain('collapsed');
    expect(group.querySelector('.nc-deck-summary-count').textContent).toBe('2'); // main + work
    expect(group.querySelector('.nc-deck-summary').title).toBe('2 decks');
    expect(group.querySelector('.nc-deck-summary-current').textContent).toContain('main');
  });

  it('omits the current indicator when the current deck belongs to another node', () => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ [owner]: true }));
    render(<DeckBar decks={decks} currentDeck="local:main" onNavigate={vi.fn()} />);
    const group = groupFor('Relay');
    expect(group.className).toContain('collapsed');
    expect(group.querySelector('.nc-deck-summary-current')).toBeNull();
    expect(group.querySelector('.nc-deck-summary-count').textContent).toBe('1');
    expect(group.querySelector('.nc-deck-summary').title).toBe('1 deck');
  });
});

describe('persistence owner-qualified', () => {
  it('persists the preference per owner under the owner-qualified key', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(toggleFor('Local')); // false(expanded) -> true(collapsed)
    expect(JSON.parse(localStorage.getItem(COLLAPSE_KEY)).local).toBe(true);
  });

  it('does not touch another owner preference when toggling one', async () => {
    const user = userEvent.setup();
    renderBar();
    const before = JSON.parse(localStorage.getItem(COLLAPSE_KEY));
    await user.click(toggleFor('Relay')); // Relay: false(expanded) -> true(collapsed)
    const after = JSON.parse(localStorage.getItem(COLLAPSE_KEY));
    expect(after.local).toBe(before.local);
    expect(after[owner]).toBe(true);
  });
});

describe('cross-window storage sync', () => {
  it('reflects a collapse change coming from another window via storage event', () => {
    renderBar();
    const toggle = toggleFor('Relay');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      // un'altra finestra ha scritto localStorage e l'evento 'storage' lo notifica qui
      const next = JSON.stringify({ local: false, [owner]: true });
      localStorage.setItem(COLLAPSE_KEY, next);
      window.dispatchEvent(new StorageEvent('storage', { key: COLLAPSE_KEY, newValue: next }));
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('resets to default-collapsed when another window clears client storage', () => {
    renderBar();
    const toggle = toggleFor('Local');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('activity dot (DeckBar + real presence hook)', () => {
  it('renders the current deck active, unopened decks neutral and offline owner warn', () => {
    const offlineOwner = 'c'.repeat(32);
    const withOffline = [
      ...decks,
      { id: `${offlineOwner}:stale`, name: 'stale', ownerId: offlineOwner, ownerLabel: 'Off', local: false, available: false },
    ];
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ local: false, [owner]: false, [offlineOwner]: false }));
    localStorage.setItem(PRESENCE_KEY, JSON.stringify({
      remoteWindow: { deckId: `${owner}:main`, ts: Date.now(), focus: false, visible: false },
    }));
    render(<DeckBar decks={withOffline} currentDeck="local:main" onNavigate={vi.fn()} />);
    const chip = document.querySelector(`[data-deck-id="${offlineOwner}:stale"]`);
    expect(chip).toBeTruthy();
    expect(chip.querySelector('.nc-deck-dot.warn')).toBeTruthy();
    const currentDot = document.querySelector('[data-deck-id="local:main"] .nc-deck-dot');
    expect(currentDot).toBeTruthy();
    expect(currentDot.classList.contains('working') || currentDot.classList.contains('on')).toBe(true);
    expect(document.querySelector(`[data-deck-id="${owner}:main"] .nc-deck-dot.on`)).toBeTruthy();
    expect(document.querySelector('[data-deck-id="local:work"] .nc-deck-dot.neutral')).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'not open' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'owner offline' })).toBeTruthy();
  });
});

describe('regressions: navigate / popout / new still wired', () => {
  it('still renders the deck open, detach and new actions for an expanded group', () => {
    renderBar();
    const workChip = document.querySelector('[data-deck-id="local:work"]');
    expect(workChip).toBeTruthy();
    expect(workChip.querySelector('.nc-deck-open')).toBeTruthy();
    expect(workChip.querySelector('.nc-deck-mini[title="detach into a new window"]')).toBeTruthy();
    // new-deck button per gruppo (almeno uno)
    expect(screen.getAllByRole('button', { name: /new/i }).length).toBeGreaterThan(0);
  });

  it('navigate is not called when clicking the current deck', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<DeckBar decks={decks} currentDeck="local:main" onNavigate={onNavigate} />);
    const currentOpen = document.querySelector('[data-deck-id="local:main"] .nc-deck-open');
    await user.click(currentOpen);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('cancels a pending new-deck draft when its owner group is collapsed', async () => {
    const user = userEvent.setup();
    renderBar();
    const group = groupFor('Local');
    await user.click(group.querySelector('.nc-deck-newbtn'));
    const input = group.querySelector('.nc-deck-add input');
    await user.type(input, 'draft deck');
    expect(input.value).toBe('draft deck');

    await user.click(toggleFor('Local'));
    expect(toggleFor('Local').getAttribute('aria-expanded')).toBe('false');
    await user.click(toggleFor('Local'));
    expect(group.querySelector('.nc-deck-add input')).toBeNull();
    expect(group.querySelector('.nc-deck-newbtn')).toBeTruthy();
  });
});
