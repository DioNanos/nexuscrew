import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import Icon from './Icon.jsx';

// The icon set is a closed map of names: a name that does not exist renders an
// empty <svg>, which is invisible in a header and looks like a missing button.
describe('Icon', () => {
  it('renders a drawn glyph for the renderer toggle', () => {
    const { container } = render(<Icon name="gpu" size={18} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('width')).toBe('18');
    expect(svg.children.length).toBeGreaterThan(0);
  });

  it('renders an empty svg for an unknown name (never a crash)', () => {
    const { container } = render(<Icon name="nope" />);
    expect(container.querySelector('svg').children.length).toBe(0);
  });
});
