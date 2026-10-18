import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach } from 'vitest';

import FleetBackupDialog from './FleetBackupDialog.jsx';
import { t } from '../../lib/i18n.js';

beforeEach(() => { localStorage.clear(); localStorage.setItem('nc_lang', 'en'); });

// L'engine dichiarato porta il flag `standard` del payload; il backup no: i
// backup sono definizioni portabili e il flag e' calcolato a runtime.
const ENGINE = {
  id: 'opencode.native', client: 'opencode', provider: 'native', label: 'OpenCode',
  standard: true, protocol: 'opencode_tui', permissionPolicy: 'standard',
};
const CELL = { id: 'grafica', engine: 'opencode.native', cwdRel: 'progetti/grafica', prompt: 'ciao' };

// Il backup di un file vero: engine in forma portabile (managed), senza il flag
// `standard`, che e' calcolato a runtime e non viaggia nel file.
const BACKUP = {
  format: 'nexuscrew.fleet', version: 3, exportedAt: '2026-10-18T10:00:00.000Z',
  cells: [{ id: 'grafica', cwdRel: 'progetti/grafica', engine: 'opencode.native', prompt: 'ciao' }],
  engines: [{ id: 'opencode.native', label: 'OpenCode', rc: false,
    managed: { client: 'opencode', provider: 'native', permissionPolicy: 'standard' } }],
  models: [],
};
function backupTesto() { return JSON.stringify(BACKUP); }

async function caricaBackup() {
  const input = document.querySelector('input[type="file"]');
  const file = new File([backupTesto()], 'fleet.json', { type: 'application/json' });
  // jsdom non implementa File.text(): il componente legge il file cosi' nel browser
  file.text = async () => backupTesto();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { fireEvent.change(input); });
}

describe('restore: il gruppo standard sopravvive alla sovrascrittura', () => {
  it('sovrascrivere un engine standard lo lascia nel gruppo Standard', async () => {
    render(<FleetBackupDialog cells={[CELL]} engines={[ENGINE]} canRestore onRestore={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(t('fleet-backup-import')));
    await caricaBackup();

    // l'engine esiste gia': la riga non e' selezionata, si sceglie di sovrascriverlo
    const riga = screen.getByRole('checkbox', { name: /OpenCode/i });
    fireEvent.click(riga);

    const opzione = screen.getByRole('option', { name: /OpenCode/i });
    const gruppo = opzione.closest('optgroup');
    expect(gruppo && gruppo.getAttribute('label')).toBe(t('fleet-engine-group-standard'));
  });
});
