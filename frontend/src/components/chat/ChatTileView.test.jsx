import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ChatTileView from './ChatTileView.jsx';
import {
  BASE, REVIEWS, TARGETS, approvalConflictEvents, approvalThenTerminalEvents, cliApprovalEvents,
  cliApprovalResolvedEvents, cliCancelledEvents, cliErrorEvents, cliRunningEvents,
  duplicateSeqEvents, gapEvents, identicalReplayEvents, incompleteReviewEvents, longTextEvents,
  markupEvents, terminalConflictEvents, vlDoneEvents,
} from '../../lib/chat-fixtures.js';

function renderChat(props = {}) {
  return render(
    <ChatTileView target={TARGETS.vl} events={vlDoneEvents()} now={BASE} reviews={REVIEWS} {...props} />,
  );
}

describe('ChatTileView states', () => {
  const cases = [
    ['inviato', { events: [] }, 'submitted'],
    ['ammesso', { events: vlDoneEvents().slice(0, 1) }, 'admitted'],
    ['in corso', { events: cliRunningEvents(), target: TARGETS.cli }, 'running'],
    ['in attesa di OK', { events: cliApprovalEvents(), target: TARGETS.cli, viewer: { canApprove: true } }, 'awaiting_approval'],
    ['terminato', { events: vlDoneEvents() }, 'done'],
    ['errore', { events: cliErrorEvents(), target: TARGETS.cli }, 'error'],
    ['annullato', { events: cliCancelledEvents(), target: TARGETS.cli }, 'cancelled'],
    ['annullamento richiesto', { events: cliRunningEvents(), target: TARGETS.cli, cancelRequested: true }, 'cancel_requested'],
    ['esito incerto', { events: gapEvents() }, 'unknown'],
  ];

  it.each(cases)('renders %s', (_name, props, state) => {
    const { container } = renderChat(props);
    expect(container.querySelector('.nc-chat').getAttribute('data-state')).toBe(state);
  });

  it('shows the terminal stop reason', () => {
    const { container } = renderChat({ events: cliErrorEvents(), target: TARGETS.cli });
    const pill = container.querySelector('.nc-chat-state');
    expect(pill.textContent).toContain('errore');
    expect(pill.textContent).toContain('provider_error');
  });
});

describe('ChatTileView source kinds', () => {
  it('renders CLI and VL with the same components', () => {
    const { container: vl } = renderChat({ events: vlDoneEvents() });
    const { container: cli } = render(
      <ChatTileView target={TARGETS.cli} events={cliApprovalEvents()} now={BASE} viewer={{ canApprove: true }} reviews={REVIEWS} />,
    );
    expect(vl.querySelector('.nc-chat').getAttribute('data-target-kind')).toBe('vl_node');
    expect(cli.querySelector('.nc-chat').getAttribute('data-target-kind')).toBe('cli_cell');
    expect(cli.querySelector('.nc-chat-tool')).toBeTruthy();
    expect(vl.querySelector('.nc-chat-msg')).toBeTruthy();
  });

  it('does not mix two targets sharing a sessionId', () => {
    render(
      <>
        <ChatTileView target={TARGETS.vl} events={vlDoneEvents('sess-shared')} now={BASE} reviews={REVIEWS} />
        <ChatTileView target={TARGETS.cli} events={cliApprovalEvents('sess-shared')} now={BASE} viewer={{ canApprove: true }} reviews={REVIEWS} />
      </>,
    );
    expect(screen.getByText('Ciao dal nodo')).toBeTruthy();
    expect(screen.getByText('Serve il tuo OK')).toBeTruthy();
    expect(screen.getAllByText('Ciao dal nodo')).toHaveLength(1);
  });
});

describe('ChatTileView tool cards', () => {
  it('shows name, outcome and duration but never the command or output', () => {
    const { container } = renderChat({
      target: TARGETS.cli, events: cliApprovalEvents(), viewer: { canApprove: true },
    });
    const card = container.querySelector('.nc-chat-tool');
    expect(card.textContent).toContain('bash');
    expect(card.textContent).toContain('ok');
    expect(card.textContent).toContain('0,2 s');
    expect(card.textContent).not.toContain('rm -rf');
    expect(card.textContent).not.toContain('build/tmp');
    expect(card.querySelector('pre')).toBeNull();
  });

  it('says the duration is unknown when the source has no times', () => {
    const { container } = renderChat({ target: TARGETS.cli, events: cliRunningEvents() });
    expect(container.querySelector('.nc-chat-tool').textContent).toContain('durata sconosciuta');
  });

  it('opens the tool history menu with aria-expanded', () => {
    renderChat({ target: TARGETS.cli, events: cliApprovalEvents(), viewer: { canApprove: true } });
    const button = screen.getByRole('button', { name: /1 tool/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(button.getAttribute('aria-controls'));
    expect(list).toBeTruthy();
    expect(within(list).getByText('bash')).toBeTruthy();
  });
});

describe('ChatTileView approval', () => {
  it('enables once/deny only for an approver with a complete review', () => {
    const { container } = renderChat({
      target: TARGETS.cli, events: cliApprovalEvents(), viewer: { canApprove: true },
    });
    expect(container.querySelector('.nc-chat-approval-command').textContent).toBe('rm -rf build/tmp');
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Nega' }).disabled).toBe(false);
    expect(screen.queryByText('sempre per la sessione')).toBeNull();
  });

  it('gives a reader no active action and no command', () => {
    const { container } = renderChat({
      target: TARGETS.cli, events: cliApprovalEvents(), viewer: { canApprove: false },
    });
    expect(container.querySelector('.nc-chat-approval-command')).toBeNull();
    expect(container.textContent).toContain('Dettaglio non disponibile a questo lettore.');
    expect(container.textContent).not.toContain('rm -rf');
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Nega' }).disabled).toBe(true);
  });

  it('disables the action when the review is incomplete', () => {
    const { container } = renderChat({
      target: TARGETS.cli, events: incompleteReviewEvents(), viewer: { canApprove: true },
    });
    expect(container.querySelector('.nc-chat-approval').getAttribute('data-state')).toBe('pending');
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
  });

  it('disables the action when the run already ended', () => {
    const { container } = renderChat({
      target: TARGETS.cli, events: approvalThenTerminalEvents(), viewer: { canApprove: true },
    });
    expect(container.querySelector('.nc-chat').getAttribute('data-state')).toBe('done');
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
  });

  it('cannot approve an expired request', () => {
    const events = cliApprovalEvents('sess-exp', { remainingMs: 0 });
    const { container } = renderChat({ target: TARGETS.cli, events, viewer: { canApprove: true } });
    expect(container.querySelector('.nc-chat-approval').getAttribute('data-state')).toBe('expired');
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Nega' }).disabled).toBe(true);
  });

  it('cannot approve an already resolved request', () => {
    const { container } = renderChat({
      target: TARGETS.cli, events: cliApprovalResolvedEvents(), viewer: { canApprove: true },
    });
    expect(container.querySelector('.nc-chat-approval').getAttribute('data-state')).toBe('resolved');
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
  });
});

describe('ChatTileView integrity notice', () => {
  it('shows the conflict for a duplicate seq with different payload', () => {
    const { container } = renderChat({ target: TARGETS.cli, events: duplicateSeqEvents() });
    const notice = container.querySelector('[data-testid="chat-conflicts"]');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain("conflitto d'integrità");
    expect(notice.textContent).toContain('evento duplicato con contenuto diverso');
  });

  it('shows the conflict for a second, different terminal', () => {
    const { container } = renderChat({ target: TARGETS.cli, events: terminalConflictEvents() });
    expect(container.querySelector('[data-testid="chat-conflicts"]').textContent)
      .toContain('terminale in conflitto');
  });

  it('does not show a conflict for an identical replay', () => {
    const { container } = renderChat({ target: TARGETS.cli, events: identicalReplayEvents() });
    expect(container.querySelector('[data-testid="chat-conflicts"]')).toBeNull();
  });
});

describe('ChatTileView approval invalidation', () => {
  it('disables the action and declares the conflict', () => {
    const { container } = renderChat({
      target: TARGETS.cli, events: approvalConflictEvents(), viewer: { canApprove: true },
    });
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
    expect(screen.getByTestId('approval-invalidated').textContent).toContain('seq-payload');
    expect(container.querySelector('[data-testid="chat-conflicts"]')).toBeTruthy();
  });

  it('disables the action when cancel is requested', () => {
    const { container } = renderChat({
      target: TARGETS.cli, events: cliApprovalEvents(), viewer: { canApprove: true }, cancelRequested: true,
    });
    expect(container.querySelector('.nc-chat').getAttribute('data-state')).toBe('cancel_requested');
    expect(screen.getByRole('button', { name: 'Approva una volta' }).disabled).toBe(true);
    expect(screen.getByTestId('approval-invalidated').textContent).toContain('cancel_requested');
  });
});

describe('ChatTileView inert data', () => {
  it('renders markup as text, never as HTML', () => {
    const { container } = renderChat({ target: TARGETS.cli, events: markupEvents() });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>window.__pwned = 1</script>');
    expect(window.__pwned).toBeUndefined();
  });

  it('keeps a long message inside the scroll container', () => {
    const { container } = renderChat({ events: longTextEvents() });
    const p = container.querySelector('.nc-chat-msg p');
    expect(p.textContent).toHaveLength(9000);
    expect(container.querySelector('.nc-chat-log')).toBeTruthy();
  });
});

describe('ChatTileView composer preview', () => {
  it('has exactly one composer, local and inert', () => {
    const { container } = renderChat();
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Allega' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Invia' }).disabled).toBe(true);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'bozza locale' } });
    expect(textarea.value).toBe('bozza locale');
  });

  it('shows a stop button (inert) while the run is active', () => {
    const { container } = renderChat({ target: TARGETS.cli, events: cliRunningEvents() });
    expect(screen.getByRole('button', { name: 'Ferma il turno' }).disabled).toBe(true);
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
  });
});

describe('ChatTileView status line', () => {
  it('shows only available fields and an em dash elsewhere', () => {
    const { container } = renderChat({ target: TARGETS.cli, events: cliApprovalEvents(), capabilities: { permissionPolicy: 'yolo' } });
    const line = container.querySelector('.nc-chat-statusline').textContent;
    expect(line).toContain('/srv/app');
    expect(line).toContain('yolo');
    expect(line).toContain('ctx 18%');
    expect(line).toContain('RAM —');
  });

  it('declares missing context instead of inventing it', () => {
    const { container } = renderChat({ events: [] });
    const line = container.querySelector('.nc-chat-statusline').textContent;
    expect(line).toContain('—');
    expect(line).toContain('ctx —');
  });
});
