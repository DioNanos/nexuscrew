import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

// Il gesto di resize deve avere un "fine": a pointerup/pointercancel
// il grid chiede UN solo salvataggio (saveNow) invece di affidarsi al debounce.
vi.mock('./GridTile.jsx', () => ({ default: () => <div data-testid="tile-stub" /> }));

import GridView from './GridView.jsx';

const twoCols = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }] }, { width: 1, tiles: [{ session: 'b', height: 1 }] }] };
const oneColTwoTiles = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }, { session: 'b', height: 1 }] }] };

const down = (el, x = 0, y = 0) => fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0 });

describe('GridView fine resize', () => {
  it('resize colonna: a pointerup chiama onResizeEnd una volta sola', () => {
    const onResizeEnd = vi.fn();
    const onLayoutChange = vi.fn();
    const { container } = render(
      <GridView layout={twoCols} onLayoutChange={onLayoutChange} onResizeEnd={onResizeEnd} />,
    );
    down(container.querySelector('.nc-divider-v'));
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    expect(onResizeEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('resize riga: a pointerup chiama onResizeEnd una volta sola', () => {
    const onResizeEnd = vi.fn();
    const { container } = render(
      <GridView layout={oneColTwoTiles} onLayoutChange={vi.fn()} onResizeEnd={onResizeEnd} />,
    );
    down(container.querySelector('.nc-divider-h'));
    fireEvent.pointerMove(window, { clientX: 0, clientY: 40 });
    expect(onResizeEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });
});
