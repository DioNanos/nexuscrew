import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));

import CellPopup from './CellPopup.jsx';

describe('CellPopup — apre sopra, non porta via', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('monta il contenuto che gli viene dato, senza saperne nulla', () => {
    render(<CellPopup title="Dev" onClose={() => {}}><p>contenuto arbitrario</p></CellPopup>);
    expect(screen.getByText('contenuto arbitrario')).toBeTruthy();
    // È un modale: chi legge con uno screen reader deve saperlo, altrimenti
    // continua a navigare la pagina sotto che non è più raggiungibile.
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });

  it('Esc chiude', () => {
    const onClose = vi.fn();
    render(<CellPopup title="Dev" onClose={onClose}><p>x</p></CellPopup>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('il clic FUORI chiude, quello DENTRO no', () => {
    const onClose = vi.fn();
    const { container } = render(<CellPopup title="Dev" onClose={onClose}><p>dentro</p></CellPopup>);

    // Dentro: non deve chiudere. Un popup che si chiude mentre ci si clicca
    // dentro fa perdere quello che si stava guardando — ed è il gesto più
    // comune, non un caso limite.
    fireEvent.mouseDown(screen.getByText('dentro'));
    expect(onClose).not.toHaveBeenCalled();

    // Fuori: chiude.
    fireEvent.mouseDown(container.querySelector('.nc-popup-velo'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('il fuoco entra nel popup: i tasti non finiscono a cio\' che sta sotto', () => {
    render(<CellPopup title="Dev" onClose={() => {}}><p>x</p></CellPopup>);
    // Sotto c'è un terminale ancora vivo e in ascolto: se il fuoco restasse
    // lì, digitare nel popup scriverebbe nella shell.
    expect(document.activeElement).toBe(screen.getByLabelText('close'));
  });

  it('senza onClose non esplode: chiudere è facoltativo per chi lo monta', () => {
    render(<CellPopup title="Dev"><p>x</p></CellPopup>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
