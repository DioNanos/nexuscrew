'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

test('copyText: Clipboard API e fallback execCommand', async () => {
  const { copyText } = await import('../frontend/src/lib/clipboard.js');
  const oldNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    let copied = '';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (x) => { copied = x; } } } });
    assert.equal(await copyText('hello'), true); assert.equal(copied, 'hello');
    const ta = { style: {}, select() {}, remove() {} };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ta, body: { appendChild() {} }, execCommand: (x) => x === 'copy' } });
    assert.equal(await copyText('fallback'), true); assert.equal(ta.value, 'fallback');
  } finally {
    if (oldNav) Object.defineProperty(globalThis, 'navigator', oldNav); else delete globalThis.navigator;
    if (oldDoc) Object.defineProperty(globalThis, 'document', oldDoc); else delete globalThis.document;
  }
});
