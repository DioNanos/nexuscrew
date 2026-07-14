import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import DeckBar from './DeckBar.jsx';

const owner = 'a'.repeat(32);
const decks = [
  { id: 'local:main', name: 'main', ownerId: 'b'.repeat(32), ownerLabel: 'Local', local: true, available: true },
  { id: 'local:work', name: 'work', ownerId: 'b'.repeat(32), ownerLabel: 'Local', local: true, available: true },
  { id: `${owner}:main`, name: 'main', ownerId: owner, ownerLabel: 'Relay', local: false, available: true },
];

function renderBar(onReorder = vi.fn()) {
  render(<DeckBar decks={decks} currentDeck="local:main" onReorder={onReorder}
    onNavigate={vi.fn()} onCreate={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} />);
  return onReorder;
}

beforeEach(() => localStorage.setItem('nc_lang', 'en'));

describe('deck pointer reorder', () => {
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
