'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('terminal generation is anti-flap: only false -> true remounts', async () => {
  const { nextTerminalGeneration } = await import('../frontend/src/lib/terminal-lifecycle.js');
  let previous = true; let generation = 0;
  for (const alive of [true, false, false, true, true, false, true]) {
    generation = nextTerminalGeneration(previous, alive, generation);
    previous = alive;
  }
  assert.equal(generation, 2, 'two actual returns create exactly two terminal/socket generations');
  assert.equal(nextTerminalGeneration(false, false, 7), 7);
  assert.equal(nextTerminalGeneration(true, true, 7), 7);
});

test('GridTile wires the tested transition to the same tile key', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'components', 'GridTile.jsx'), 'utf8');
  assert.match(source, /const wasAlive = previousAlive\.current/);
  assert.match(source, /nextTerminalGeneration\(wasAlive, alive, value\)/);
  assert.match(source, /key=\{`\$\{tileKey\}:\$\{terminalGeneration\}`\}/);
  assert.doesNotMatch(source, /key=\{`\$\{tileKey\}:\$\{alive/,
    'turning off must preserve the ended transcript until restart');
});
