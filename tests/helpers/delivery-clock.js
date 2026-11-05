'use strict';
// Shared virtual clock for the 0.9.80 s2a delivery-guard tests.
//
// TWO separate clocks, never mixed (C7 / decision 8):
//  - `mono` : monotonic millisecond counter. Drives every deadline, duration
//             and budget (the same domain as the production default
//             `process.hrtime.bigint()/1000000n`). Injected as `nowImpl`.
//  - `wall` : civil Date.now-style counter. Drives only civil timestamps
//             (`notBeforeMs` of the MCP log adapter, presentation). Injected
//             as `wallNowImpl`. Jumping it must NEVER move a budget.
//
// `sleep(ms)` advances BOTH counters by ms: virtual time flows without real
// waiting, so a suite that exhausts a 1000 ms window stays fast. `jumpWall`
// moves ONLY the civil clock (test case 10: +1h / -1h civil jumps must not
// shift the monotonic budget nor produce a late paste). `advanceMono` moves
// only the monotonic counter (an await that takes mono time without civil
// drift, e.g. a slow load inside securePaste).
function virtualClock({ start = 0, wallStart = 1_700_000_000_000 } = {}) {
  let mono = start;
  let wall = wallStart;
  return {
    now: () => mono,
    wallNow: () => wall,
    mono: () => mono,
    advanceMono(ms) { mono += ms; return mono; },
    jumpWall(delta) { wall += delta; return wall; },
    sleep: async (ms) => { mono += ms; wall += ms; },
  };
}

// A capture stub that observes the (optional) target argument and can advance
// the monotonic clock while the capture is "in flight", modelling a capture
// that lands after the deadline (test case 1 / 6: capture tardivo).
function captureSeq(clk, screens, { advanceEach = 0 } = {}) {
  const seen = [];
  let n = 0;
  const fn = async (target) => {
    seen.push(target === undefined ? '<default>' : String(target));
    if (advanceEach) clk.advanceMono(advanceEach);
    const s = n < screens.length ? screens[n] : screens[screens.length - 1];
    n += 1;
    return s;
  };
  return { fn, seen: () => seen, calls: () => n };
}

module.exports = { virtualClock, captureSeq };
