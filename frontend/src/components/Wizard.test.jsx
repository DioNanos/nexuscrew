import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ pairNode: vi.fn(), saveConfig: vi.fn() }));

vi.mock('../lib/api.js', () => ({ pairNode: mocks.pairNode, saveConfig: mocks.saveConfig }));
vi.mock('./QrScanModal.jsx', () => ({ default: () => null }));

import Wizard from './Wizard.jsx';

function pairingUrl() {
  const payload = {
    v: 2,
    instanceId: 'a'.repeat(32),
    port: 41820,
    label: 'Relay',
    invite: 'i'.repeat(43),
    name: 'home-relay',
    ssh: 'dag@relay.example',
    sshPort: 41822,
  };
  return `http://127.0.0.1:41820/#pair=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

// IL CASO CHE LA CARD DA SOLA NON COPRE: al successo questo passo fa
// setStep('done') e SMONTA la PairingCard. Una riga mostrata soltanto dentro
// la card sparirebbe proprio qui — cioè nel percorso del PRIMO pairing, quello
// in cui l'utente non ha ancora nessun altro modo di sapere cosa incollare.
describe('Wizard — la riga authorized_keys sopravvive allo smontaggio della card', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    mocks.pairNode.mockReset();
  });

  it('mostra la riga nel passo finale, dopo che la card è stata smontata', async () => {
    const riga = 'restrict,port-forwarding,permitopen="127.0.0.1:41800",permitopen="127.0.0.1:41821",command="/bin/false" ssh-ed25519 AAAAC3Test peer';
    mocks.pairNode.mockResolvedValueOnce({
      paired: true, authorizedKeys: riga, authorizedKeysNote: 'il peer ha un pannello sulla propria porta 41821',
    });
    render(<Wizard token="token" initialPair={pairingUrl()} deviceDefault="AsusRP3"
      localNodeId={'5bd61234'.repeat(4)} localNameDefault="asus-rp3-5bd6" />);
    await waitFor(() => expect(mocks.pairNode).toHaveBeenCalledTimes(1));
    // il passo è cambiato: il bottone finale c'è, il modulo di pairing no
    expect(await screen.findByRole('button', { name: 'finish' })).toBeTruthy();
    const campo = await screen.findByLabelText('Line to replace in ~/.ssh/authorized_keys on the peer');
    expect(campo.value).toBe(riga);
  });

  it('non mostra nulla quando il pairing non produce la riga', async () => {
    mocks.pairNode.mockResolvedValueOnce({ paired: true });
    render(<Wizard token="token" initialPair={pairingUrl()} deviceDefault="AsusRP3"
      localNodeId={'5bd61234'.repeat(4)} localNameDefault="asus-rp3-5bd6" />);
    await waitFor(() => expect(mocks.pairNode).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'finish' })).toBeTruthy();
    expect(screen.queryByLabelText('Line to replace in ~/.ssh/authorized_keys on the peer')).toBeNull();
  });
});

// LA PROPRIETA' che la guardia testuale in tests/ui-pairing.test.js protegge
// per forma, provata qui per comportamento: l'invito one-time si consuma SOLO
// a pairing riuscito. Un tentativo fallito deve restare riprovabile per tutta
// la sessione del tab — se `onPairDone` scattasse comunque, l'utente perde
// l'invito e non ha modo di rifarlo.
describe('Wizard — l invito si consuma solo a successo', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    mocks.pairNode.mockReset();
  });

  it('chiama onPairDone dopo un pairing riuscito', async () => {
    const onPairDone = vi.fn();
    mocks.pairNode.mockResolvedValueOnce({ paired: true });
    render(<Wizard token="token" initialPair={pairingUrl()} deviceDefault="AsusRP3"
      localNodeId={'5bd61234'.repeat(4)} localNameDefault="asus-rp3-5bd6" onPairDone={onPairDone} />);
    await waitFor(() => expect(mocks.pairNode).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onPairDone).toHaveBeenCalledTimes(1));
  });

  it('NON chiama onPairDone quando il pairing fallisce', async () => {
    const onPairDone = vi.fn();
    const errore = new Error('HTTP 502');
    errore.data = { stage: 'ssh-ready', code: 'ssh-auth-failed', detail: 'rejected', retryable: true };
    mocks.pairNode.mockRejectedValueOnce(errore);
    render(<Wizard token="token" initialPair={pairingUrl()} deviceDefault="AsusRP3"
      localNodeId={'5bd61234'.repeat(4)} localNameDefault="asus-rp3-5bd6" onPairDone={onPairDone} />);
    await waitFor(() => expect(mocks.pairNode).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onPairDone).not.toHaveBeenCalled();
  });
});
