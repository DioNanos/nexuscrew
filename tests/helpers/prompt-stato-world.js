'use strict';
// Mondo isolato per le prove di cellStatus / consultazione del proprietario:
// fleet.json con un engine send-keys, tmux finto pilotato da un file di stato
// (viva / errore di list-sessions), runtime vero. Nessun tmux reale.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { atomicWrite, loadDefinitions } = require('../../lib/fleet/definitions.js');
const { createBuiltinRuntime } = require('../../lib/fleet/runtime.js');


function mondoStato({ engineExtra = {}, prompt = 'ciao' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
  const home = path.join(root, 'home');
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(path.join(home, 'Cella'), { recursive: true });
  fs.mkdirSync(filesRoot, { recursive: true });
  const stato = path.join(root, 'stato.json');
  fs.writeFileSync(stato, JSON.stringify({ viva: true, errore: null }));
  const tmuxBin = path.join(root, 'tmux.cjs');
  fs.writeFileSync(tmuxBin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(${JSON.stringify(stato)}, 'utf8'));
if (args.includes('list-sessions')) {
  if (st.errore) { process.stderr.write(st.errore + '\\n'); process.exit(1); }
  if (st.viva) process.stdout.write(${JSON.stringify(SESSIONE)} + '\\t1\\n');
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);
  const client = path.join(home, 'client');
  fs.writeFileSync(client, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'client', label: 'Client', rc: false, command: client, args: [], env: {},
      promptMode: 'send-keys', ...engineExtra,
    }],
    cells: [{ id: 'Cella', tmuxSession: SESSIONE, cwd: path.join(home, 'Cella'), engine: 'client', boot: false, prompt }],
  });
  const imposta = (p) => fs.writeFileSync(stato, JSON.stringify({ ...JSON.parse(fs.readFileSync(stato, 'utf8')), ...p }));
  const apri = (leaseManager) => createBuiltinRuntime({
    cfg: { filesRoot, activityHooks: false, log: () => {}, env: {} },
    home, defsPath, tmuxBin, readonly: () => false,
    launchBroker: { issue: async () => ({ socketPath: '/x', nonce: 'n'.repeat(64) }), revoke: async () => {}, close: async () => {} },
    ...(leaseManager ? { leaseManager } : {}),
    boot: loadDefinitions(defsPath),
  });
  return { root, home, filesRoot, imposta, apri, defsPath, tmuxBin, dirSessione: path.join(filesRoot, SESSIONE) };
}


const SESSIONE = 'cloud-Cella';
module.exports = { mondoStato, SESSIONE };
