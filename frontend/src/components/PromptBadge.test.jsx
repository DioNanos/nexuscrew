import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import PromptBadge from './PromptBadge.jsx';

describe('badge della consegna', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('nc_lang', 'en'); });

  it('non mostra niente senza consegna leggibile', () => {
    const { container } = render(<PromptBadge prompt={null} />);
    expect(container.textContent).toBe('');
    expect(render(<PromptBadge prompt={{ badge: 'none', key: null }} />).container.textContent).toBe('');
  });

  it('mostra lo stato quando la lettura è corrente', () => {
    render(<PromptBadge prompt={{ badge: 'submitted', key: 'prompt-badge-submitted', freschezza: 'current' }} />);
    expect(screen.getByText('delivered')).toBeTruthy();
    expect(screen.queryByText(/last known/i)).toBeNull();
  });

  it('dichiara «ultimo dato noto» quando la lettura non è corrente', () => {
    render(<PromptBadge prompt={{ badge: 'stale', key: 'prompt-badge-last-known', freschezza: 'last-known' }} />);
    expect(screen.getByText('last known')).toBeTruthy();
  });

  it('tiene visibile una richiesta d azione, dichiarandola storica', () => {
    render(<PromptBadge prompt={{ badge: 'action', key: 'prompt-badge-action', freschezza: 'last-known' }} />);
    expect(screen.getByText('a response is needed · last known')).toBeTruthy();
  });
});
