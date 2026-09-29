import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginScreen from './LoginScreen.jsx';

// T1: la schermata di login non deve sparire al primo carattere; il token si salva su «ok» e su Invio.
afterEach(() => vi.unstubAllGlobals());
const type = async (text) => { await userEvent.type(screen.getByPlaceholderText('token'), text); };

describe('LoginScreen', () => {
  it('digitare non smonta il campo e il bottone ok resta cliccabile', async () => {
    render(<LoginScreen onSubmit={() => {}} />);
    await type('abcdef');
    expect(screen.getByPlaceholderText('token').value).toBe('abcdef');
    expect(screen.getByRole('button', { name: /ok/i }).disabled).toBe(false);
  });

  it('ok chiama onSubmit(token, remember) con il token ripulito', async () => {
    const onSubmit = vi.fn();
    render(<LoginScreen onSubmit={onSubmit} />);
    await type('  tok123  ');
    await userEvent.click(screen.getByRole('button', { name: /ok/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('tok123');
    expect(typeof onSubmit.mock.calls[0][1]).toBe('boolean');
  });

  it('Invio nel campo salva come il bottone', async () => {
    const onSubmit = vi.fn();
    render(<LoginScreen onSubmit={onSubmit} />);
    await type('tok123{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('tok123');
  });

  it('con il campo vuoto ok e Invio non salvano nulla', async () => {
    const onSubmit = vi.fn();
    render(<LoginScreen onSubmit={onSubmit} />);
    expect(screen.getByRole('button', { name: /ok/i }).disabled).toBe(true);
    fireEvent.submit(screen.getByPlaceholderText('token').closest('form'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('«ricorda» e\' acceso di default su un telefono (puntatore grossolano) e si puo\' spegnere', async () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: /pointer:\s*coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {} }));
    const onSubmit = vi.fn();
    render(<LoginScreen onSubmit={onSubmit} />);
    const box = screen.getByRole('checkbox');
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    await type('tok');
    await userEvent.click(screen.getByRole('button', { name: /ok/i }));
    expect(onSubmit).toHaveBeenCalledWith('tok', false);
  });

  it('con un token rifiutato mostra il motivo e il campo per reinserirlo', () => {
    render(<LoginScreen onSubmit={() => {}} reason="invalid" />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByPlaceholderText('token')).toBeTruthy();
  });
});
