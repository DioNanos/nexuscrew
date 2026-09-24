import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  CellActionsMenu, CellActionsPopover, CellActionsSheet,
  cellActionsItems, cellActionsState,
} from './CellActions.jsx';
import { hostRouteKey } from '../lib/host-designation.js';
import { t } from '../lib/i18n.js';

// Il menu condiviso delle azioni cella: una voce tolta (capability assente,
// cella spenta, handler non passato) NON compare — il controllo negativo è
// questo, non una voce disabilitata. La logica resta nelle sue case: qui si
// verifica che il menu mostri e passi i gesti giusti.

const itemA = { key: 'k1', value: { cell: 'cellA' } };

describe('cellActionsItems', () => {
  it('offre Togli la Live quando la cella È host, Assegna quando non lo è', () => {
    const live = cellActionsItems({ isLive: true, handlers: { onToggleLive: () => {} } });
    expect(live.find((v) => v.id === 'live').labelKey).toBe('cell-actions-live-remove');
    const notLive = cellActionsItems({ isLive: false, handlers: { onToggleLive: () => {} } });
    expect(notLive.find((v) => v.id === 'live').labelKey).toBe('cell-actions-live-assign');
  });

  it('usa Fissa/Togli in cima secondo il pin', () => {
    const on = cellActionsItems({ pinned: true, handlers: { onTogglePin: () => {} } });
    expect(on.find((v) => v.id === 'pin').labelKey).toBe('cell-actions-unpin');
    const off = cellActionsItems({ pinned: false, handlers: { onTogglePin: () => {} } });
    expect(off.find((v) => v.id === 'pin').labelKey).toBe('cell-actions-pin');
  });

  it('il boot è un interruttore e il run propone lo stato opposto', () => {
    const onToggleBoot = vi.fn();
    const items = cellActionsItems({ canBoot: true, boot: true, handlers: { onToggleBoot } });
    const boot = items.find((v) => v.id === 'boot');
    expect(boot.kind).toBe('switch');
    expect(boot.on).toBe(true);
    boot.run();
    expect(onToggleBoot).toHaveBeenCalledWith(false);
  });

  it('GUARDA DAL VIVO solo su cella viva', () => {
    const handlers = { onWatchLive: () => {} };
    expect(cellActionsItems({ alive: true, handlers }).some((v) => v.id === 'watch')).toBe(true);
    expect(cellActionsItems({ alive: false, handlers }).some((v) => v.id === 'watch')).toBe(false);
  });

  it('controllo negativo: senza capability boot la voce boot NON c\'è', () => {
    const items = cellActionsItems({ canBoot: false, boot: false, handlers: { onToggleBoot: () => {} } });
    expect(items.some((v) => v.id === 'boot')).toBe(false);
  });

  it('controllo negativo: senza handler la voce non c\'è (Live, pin, boot, guarda)', () => {
    expect(cellActionsItems({})).toEqual([]);
    expect(cellActionsItems({ isLive: true }).some((v) => v.id === 'live')).toBe(false);
    expect(cellActionsItems({ pinned: true }).some((v) => v.id === 'pin')).toBe(false);
    expect(cellActionsItems({ canBoot: true, boot: true }).some((v) => v.id === 'boot')).toBe(false);
    expect(cellActionsItems({ alive: true }).some((v) => v.id === 'watch')).toBe(false);
  });
});

describe('cellActionsState', () => {
  it('deriva pin da cell-star e isLive dall\'host del nodo, senza duplicarli', () => {
    const pins = ['k1'];
    const hostByRoute = { [hostRouteKey([])]: { hostCell: 'cellB' } };
    const pinata = cellActionsState({ item: itemA, cellName: 'cellA', pins, hostByRoute });
    expect(pinata.pinned).toBe(true);
    expect(pinata.isLive).toBe(false);
    const viva = cellActionsState({
      item: itemA, cellName: 'cellA', pins: [],
      hostByRoute: { [hostRouteKey([])]: { hostCell: 'cellA' } },
    });
    expect(viva.pinned).toBe(false);
    expect(viva.isLive).toBe(true);
  });
});

describe('CellActionsMenu', () => {
  beforeEach(() => { localStorage.setItem('nc_lang', 'en'); });

  it('mostra le etichette, chiama il gesto della voce e non propaga alla riga', () => {
    const onTogglePin = vi.fn();
    const items = cellActionsItems({ pinned: false, handlers: { onTogglePin } });
    const rigaClick = vi.fn();
    const { container } = render(
      <div onClick={rigaClick}><CellActionsMenu items={items} /></div>,
    );
    const voce = screen.getByText('Pin to top');
    expect(voce).toBeTruthy();
    fireEvent.click(voce.closest('button'));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(rigaClick).not.toHaveBeenCalled();
    expect(container.querySelector('[data-cellaction="pin"]')).toBeTruthy();
    cleanup();
  });

  it('il boot ha aria-checked coerente e busy disabilita tutto', () => {
    const items = cellActionsItems({ canBoot: true, boot: true, handlers: { onToggleBoot: () => {} } });
    const { container } = render(<CellActionsMenu items={items} busy />);
    const boot = container.querySelector('[data-cellaction="boot"]');
    expect(boot.getAttribute('aria-checked')).toBe('true');
    expect(boot.disabled).toBe(true);
    expect(container.querySelector('[role="menu"]').getAttribute('aria-busy')).toBe('true');
    cleanup();
  });
});

describe('sottoriga opzionale della voce', () => {
  // La sottoriga e' OPZIONALE e additiva: chi non la passa rende esattamente
  // come prima (nessuna regressione sui chiamanti esistenti).
  const voce = (id, extra) => ({
    id, kind: 'action', on: false, labelKey: 'panel', run: () => {}, ...extra,
  });

  it('con descKey la sottoriga c\'è, in piccolo sotto l\'etichetta', () => {
    const { container } = render(<CellActionsMenu items={[voce('a', { descKey: 'composer' })]} />);
    const bottone = container.querySelector('[data-cellaction="a"]');
    expect(bottone.querySelector('.nc-cellactions-desc').textContent).toBe(t('composer'));
    // L'etichetta resta quella di sempre.
    expect(bottone.textContent.startsWith(t('panel'))).toBe(true);
    cleanup();
  });

  it('senza descKey la voce rende come oggi: nessuna sottoriga', () => {
    const { container } = render(<CellActionsMenu items={[voce('b')]} />);
    const bottone = container.querySelector('[data-cellaction="b"]');
    expect(bottone.querySelector('.nc-cellactions-desc')).toBeNull();
    expect(bottone.querySelector('.nc-cellactions-testo').textContent).toBe(t('panel'));
    cleanup();
  });
});

describe('CellActionsPopover', () => {
  beforeEach(() => { localStorage.setItem('nc_lang', 'en'); });

  it('una voce: esegue e chiude', () => {
    const onTogglePin = vi.fn();
    const onClose = vi.fn();
    const items = cellActionsItems({ pinned: false, handlers: { onTogglePin } });
    render(<CellActionsPopover anchorRect={{ top: 0, bottom: 30, left: 100, right: 130 }} items={items} onClose={onClose} />);
    fireEvent.click(screen.getByText('Pin to top'));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('Escape chiude, pointerdown fuori chiude, dentro non chiude', () => {
    const onClose = vi.fn();
    const items = cellActionsItems({ pinned: false, handlers: { onTogglePin: () => {} } });
    const { container } = render(
      <div><div data-testid="fuori" /><CellActionsPopover anchorRect={{ bottom: 30, right: 130 }} items={items} onClose={onClose} /></div>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    const popover = container.querySelector('[data-testid="cell-actions-popover"]');
    // L'evento parte dal nodo REALE: target = nodo, il guscio si riconosce e resta.
    fireEvent.pointerDown(popover);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(container.querySelector('[data-testid="fuori"]'));
    expect(onClose).toHaveBeenCalledTimes(2);
    cleanup();
  });
});

describe('CellActionsSheet', () => {
  beforeEach(() => { localStorage.setItem('nc_lang', 'en'); });

  it('foglio dal basso: titolo con la cella, voce esegue e chiude, velo chiude', () => {
    const onTogglePin = vi.fn();
    const onClose = vi.fn();
    const items = cellActionsItems({ pinned: false, handlers: { onTogglePin } });
    const { container } = render(<CellActionsSheet cellName="cellA" items={items} onClose={onClose} />);
    const foglio = container.querySelector('[role="dialog"]');
    expect(foglio.getAttribute('aria-modal')).toBe('true');
    expect(foglio.getAttribute('aria-label')).toContain('cellA');
    expect(foglio.querySelector('[data-cellaction="pin"]')).toBeTruthy();
    const chiudi = container.querySelector('.nc-cellactions-chiudi');
    fireEvent.click(chiudi);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('il tocco sul velo (fuori dal foglio) chiude', () => {
    const onClose = vi.fn();
    const items = cellActionsItems({ pinned: false, handlers: { onTogglePin: () => {} } });
    const { container } = render(<CellActionsSheet cellName="cellA" items={items} onClose={onClose} />);
    // La chiusura fuori-guscio arriva su pointerdown: il velo non contiene il foglio.
    fireEvent.pointerDown(container.querySelector('[data-testid="cell-actions-sheet"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
