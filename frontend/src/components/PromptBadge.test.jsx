import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import PromptBadge from './PromptBadge.jsx';

// P3-2 — In card resta SOLO il badge che chiede una risposta all'operatore.
// Gli altri esiti (consegna fallita, non attestato, in consegna, consegnato,
// lancio precedente, non disponibile) vivono nel FOGLIO della cella: qui si
// prova che dalla card escono davvero.
describe('badge della consegna', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('nc_lang', 'en'); });

  it('non mostra niente senza consegna leggibile', () => {
    const { container } = render(<PromptBadge prompt={null} />);
    expect(container.textContent).toBe('');
    expect(render(<PromptBadge prompt={{ badge: 'none', key: null }} />).container.textContent).toBe('');
  });

  it('in card resta solo la richiesta d\'azione: «a response is needed»', () => {
    render(<PromptBadge prompt={{ badge: 'action', key: 'prompt-badge-action', freschezza: 'current' }} />);
    expect(screen.getByText('a response is needed')).toBeTruthy();
    expect(screen.queryByText(/last known/i)).toBeNull();
  });

  it('la richiesta d\'azione storica resta visibile, dichiarandola tale', () => {
    render(<PromptBadge prompt={{ badge: 'action', key: 'prompt-badge-action', freschezza: 'last-known' }} />);
    expect(screen.getByText('a response is needed · last known')).toBeTruthy();
  });

  it('gli altri esiti escono dalla card: sono dettaglio del foglio', () => {
    for (const badge of ['problem', 'pending', 'submitted', 'stale', 'unverified', 'unavailable']) {
      const { container } = render(
        <PromptBadge prompt={{ badge, key: `prompt-badge-${badge}`, freschezza: 'current' }} />,
      );
      expect(container.textContent, badge).toBe('');
    }
  });
});
