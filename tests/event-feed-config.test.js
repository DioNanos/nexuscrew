'use strict';
// tests/event-feed-config.test.js — the strict-boolean kill switch: undefined
// keeps the default (enabled), the literals decide, ANY other type is invalid
// config, treated as DISABLED and reported. Fail-closed on garbage.
const { test } = require('node:test');
const assert = require('node:assert');
const { eventsEnabledFlag } = require('../lib/config.js');

test('undefined keeps the default: enabled', () => {
  assert.equal(eventsEnabledFlag(undefined, () => {}), true);
});

test('the boolean literals decide', () => {
  assert.equal(eventsEnabledFlag(true, () => {}), true);
  assert.equal(eventsEnabledFlag(false, () => {}), false);
});

test('any other type is invalid config: DISABLED, not enabled', () => {
  for (const bad of ['false', 'true', '0', '1', 0, 1, null, {}, [], 'disabled']) {
    assert.equal(eventsEnabledFlag(bad, () => {}), false, String(typeof bad) + ':' + String(bad));
  }
});

test('an invalid value is REPORTED, never swallowed (negative: silence must not pass)', () => {
  let reported = null;
  eventsEnabledFlag('false', (msg) => { reported = msg; });
  assert.match(reported, /must be a boolean/);
  // And the negative control of the negative: a valid value reports nothing.
  let quiet = null;
  eventsEnabledFlag(true, (msg) => { quiet = msg; });
  assert.equal(quiet, undefined);
});
