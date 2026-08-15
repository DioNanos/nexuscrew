import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PinPersistBanner from './PinPersistBanner.jsx';

// Banner condiviso dalla Sidebar desktop e dalla SessionList mobile: la UI per
// un fallimento di persistenza del pin (contratto rev6 §2.1: SEGNALATO +
// RITENTABILE). Non e' un console.log.

describe('PinPersistBanner', () => {
  it('non renderizza nulla senza pinError', () => {
    const { container } = render(<PinPersistBanner pinError={null} onRetry={() => {}} onDismiss={() => {}} />);
    expect(container.querySelector('.nc-pin-error')).toBeNull();
  });

  it('renderizza l\'avviso (role=alert) quando c\'e un pinError', () => {
    render(<PinPersistBanner pinError={{ key: 'A', message: 'quota' }} onRetry={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/riprova/)).toBeTruthy();
  });

  it('retry invoca onRetry (l\'utente puo\' ritentare)', () => {
    const onRetry = vi.fn();
    render(<PinPersistBanner pinError={{ key: 'A' }} onRetry={onRetry} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText(/riprova/));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('dismiss invoca onDismiss', () => {
    const onDismiss = vi.fn();
    render(<PinPersistBanner pinError={{ key: 'A' }} onRetry={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText(/chiudi avviso/));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
