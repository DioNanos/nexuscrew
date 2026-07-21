import { describe, expect, it } from 'vitest';
import { cleanBackupCell, createFleetBackup, parseFleetBackup, restoreCellDefinition } from './fleet-backup.js';

describe('fleet backup v3 — Shell commands', () => {
  const cell = {
    id: 'Ops', cwdRel: 'Dev', engine: 'shell.local', boot: false,
    commands: { 'shell.local': "printf '$HOME' | sed s/x/y/" }, prompt: '',
  };

  it('round-trips the per-cell command without a device executable path', () => {
    const backup = createFleetBackup([cell], new Set(['Ops']), [], new Set(), new Date('2026-07-21T00:00:00Z'));
    expect(backup.cells[0].commands).toEqual(cell.commands);
    expect(JSON.stringify(backup)).not.toContain('/bin/');
    const parsed = parseFleetBackup(JSON.stringify(backup));
    expect(parsed.ok).toBe(true);
    expect(restoreCellDefinition(parsed.cells[0], 'shell.local', ['shell.local']).commands).toEqual(cell.commands);
  });

  it('fails closed for control characters, oversized values, and likely secrets', () => {
    expect(cleanBackupCell({ ...cell, commands: { 'shell.local': 'echo x\n' } })).toBeNull();
    expect(cleanBackupCell({ ...cell, commands: { 'shell.local': 'x'.repeat(4097) } })).toBeNull();
    expect(cleanBackupCell({ ...cell, commands: { 'shell.local': 'curl -H Authorization:token' } })).toBeNull();
  });
});
