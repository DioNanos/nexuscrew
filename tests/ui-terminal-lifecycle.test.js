'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('terminal generation is anti-flap: only false -> true remounts', async () => {
  const { nextTerminalGeneration, sessionPresenceForTile } = await import('../frontend/src/lib/terminal-lifecycle.js');
  let previous = true; let generation = 0;
  for (const alive of [true, false, false, true, true, false, true]) {
    generation = nextTerminalGeneration(previous, alive, generation);
    previous = alive;
  }
  assert.equal(generation, 2, 'two actual returns create exactly two terminal/socket generations');
  assert.equal(nextTerminalGeneration(false, false, 7), 7);
  assert.equal(nextTerminalGeneration(true, true, 7), 7);
  assert.equal(sessionPresenceForTile({
    tileKey: 'mac:cloud-Dev', node: 'mac', nodeGroups: [{ route: ['mac'], status: 'down' }], sessionsAlive: new Set(),
  }), true, 'node down is not proof that the session ended');
  assert.equal(sessionPresenceForTile({
    tileKey: 'mac:cloud-Dev', node: 'mac', nodeGroups: [{ route: ['mac'], status: 'up' }], sessionsAlive: new Set(),
  }), false, 'healthy node without the session is an authoritative absence');
  assert.equal(sessionPresenceForTile({
    tileKey: 'mac:cloud-Dev', node: 'mac', nodeGroups: [{ route: ['mac'], status: 'up' }], sessionsAlive: new Set(['mac:cloud-Dev']),
  }), true);
});

test('GridTile wires the tested transition to the same tile key', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', 'GridTile.jsx'), 'utf8');
  assert.match(source, /const wasSessionAlive = previousSessionAlive\.current/);
  assert.match(source, /nextTerminalGeneration\(wasSessionAlive, sessionAlive, value\)/);
  assert.match(source, /key=\{`\$\{tileKey\}:\$\{terminalGeneration\}`\}/);
  assert.doesNotMatch(source, /key=\{`\$\{tileKey\}:\$\{alive/,
    'turning off must preserve the ended transcript until restart');
  assert.match(source, /previousSessionAlive/);
  assert.doesNotMatch(source, /previousAlive\.current/,
    'node health must not be used as the terminal session lifecycle');
});

test('node health flap conserva la stessa sessione, l uscita reale abilita una nuova generazione', async () => {
  const { nextTerminalGeneration, sessionPresenceForTile } = await import('../frontend/src/lib/terminal-lifecycle.js');
  const tile = { tileKey: 'mac:cloud-Dev', node: 'mac' };
  const groups = [{ route: ['mac'], status: 'up' }];
  let generation = 0;
  let previous = true;
  for (const status of ['up', 'down', 'up']) {
    groups[0].status = status;
    const present = sessionPresenceForTile({
      ...tile, nodeGroups: groups,
      sessionsAlive: status === 'up' ? new Set(['mac:cloud-Dev']) : new Set(),
    });
    generation = nextTerminalGeneration(previous, present, generation);
    previous = present;
  }
  assert.equal(generation, 0, 'up/down/up del nodo non rimonta il terminale');

  groups[0].status = 'up';
  const ended = sessionPresenceForTile({ ...tile, nodeGroups: groups, sessionsAlive: new Set() });
  generation = nextTerminalGeneration(previous, ended, generation);
  previous = ended;
  const recreated = sessionPresenceForTile({ ...tile, nodeGroups: groups, sessionsAlive: new Set(['mac:cloud-Dev']) });
  generation = nextTerminalGeneration(previous, recreated, generation);
  assert.equal(generation, 1, 'una sessione realmente uscita e poi ricreata ottiene un terminale nuovo');
});
