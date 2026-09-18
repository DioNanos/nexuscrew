'use strict';
// Coda di ritentativi della chiusura (lato owner): i tre assi del limite.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  createClosureRetryQueue,
  CLOSURE_RETRY_MAX_ATTEMPTS,
  CLOSURE_RETRY_MAX_ENTRIES,
  CLOSURE_RETRY_TTL_MS,
} = require('../lib/notify/closure-retry.js');

// Tempo finto: i timer non aspettano davvero. Ogni `advance` fa scattare i
// timer scaduti, cosi' il test misura la POLITICA e non l'orologio.
function fakeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, dead: false }; timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.dead = true; },
    advance: (ms) => {
      t += ms;
      for (const h of timers.slice()) {
        if (!h.dead && h.at <= t) { h.dead = true; timers.splice(timers.indexOf(h), 1); h.fn(); }
      }
    },
    pending: () => timers.filter((h) => !h.dead).length,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('peer offline e poi online: il tentativo successivo lo raggiunge', async () => {
  const clock = fakeClock();
  let online = false;
  const seen = [];
  const q = createClosureRetryQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: async ({ askId }) => {
      seen.push(askId);
      return online ? [{ target: 'peer', status: 'delivered' }] : [{ target: 'peer', status: 'unreachable' }];
    },
  });
  q.enqueue({ askId: 'a1', outcome: 'dismissed', session: 'cell-a' });
  assert.equal(q.size(), 1);
  assert.equal(seen.length, 0, 'l-accodamento non tenta subito: il primo tentativo e- gia- avvenuto');

  clock.advance(1000);           // primo ritardo di backoff
  await flush();
  assert.deepStrictEqual(seen, ['a1']);
  assert.equal(q.size(), 1, 'il peer e- ancora offline: la voce resta in coda');

  online = true;                 // il peer torna su
  clock.advance(2000);           // ritardo raddoppiato
  await flush();
  assert.deepStrictEqual(seen, ['a1', 'a1']);
  assert.equal(q.size(), 0, 'consegnata: la voce esce dalla coda');
  assert.equal(clock.pending(), 0, 'nessun timer lasciato acceso');
});

test('il risveglio su lettura anticipa il backoff, ma non a ogni lettura', async () => {
  const clock = fakeClock();
  let online = false;
  let calls = 0;
  const q = createClosureRetryQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: async () => { calls += 1; return online ? [{ status: 'delivered' }] : [{ status: 'unreachable' }]; },
  });
  q.enqueue({ askId: 'a2', outcome: 'answered', session: 'cell-a' });
  online = true;
  // La prima lettura e' libera: e' il momento in cui si guarda lo stato.
  assert.equal((await q.drain('read')).attempted, 1);
  assert.equal(calls, 1);
  assert.equal(q.size(), 0, 'consegnata alla prima lettura, senza aspettare il backoff');

  // Con la coda vuota una lettura non fa nulla.
  assert.equal((await q.drain('read')).attempted, 0);

  // E due risvegli ravvicinati non martellano il peer: il primo e' libero,
  // il secondo ravvicinato viene rimandato al backoff.
  online = false;
  clock.advance(2000);
  q.enqueue({ askId: 'a3', outcome: 'dismissed', session: 'cell-a' });
  const first = await q.drain('read');
  const second = await q.drain('read');
  assert.equal(first.attempted, 1);
  assert.equal(second.throttled, true, 'secondo risveglio ravvicinato: rimandato al backoff');
  assert.equal(calls, 2);
});

test('scaduto il TTL si rinuncia, e il tetto dei tentativi lo precede', async () => {
  const clock = fakeClock();
  let calls = 0;
  const q = createClosureRetryQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: async () => { calls += 1; return [{ status: 'unreachable' }]; },
  });
  q.enqueue({ askId: 'a4', outcome: 'dismissed', session: 'cell-a' });
  // Backoff esponenziale: 1s, 2s, 4s, 8s, 16s, 32s -> esattamente MAX_ATTEMPTS.
  for (let i = 0; i < 20; i += 1) { clock.advance(40000); await flush(); }
  assert.equal(calls, CLOSURE_RETRY_MAX_ATTEMPTS, 'i tentativi sono limitati, non infiniti');
  assert.equal(q.size(), 0, 'al tetto la voce esce: nessun timer perpetuo');
  assert.equal(clock.pending(), 0);

  // TTL: una voce che non ha ancora esaurito i tentativi ma e' troppo vecchia
  // esce comunque.
  const clock2 = fakeClock();
  let calls2 = 0;
  const q2 = createClosureRetryQueue({
    now: clock2.now, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer,
    run: async () => { calls2 += 1; return [{ status: 'unknown' }]; },
  });
  q2.enqueue({ askId: 'a5', outcome: 'dismissed', session: 'cell-a' });
  clock2.advance(CLOSURE_RETRY_TTL_MS + 1000);
  await q2.drain('read');
  assert.equal(calls2, 0, 'oltre il TTL non si tenta nemmeno: si rinuncia');
  assert.equal(q2.size(), 0);
});

test('la coda e- limitata: la voce piu- vecchia esce per prima', async () => {
  const clock = fakeClock();
  const q = createClosureRetryQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: async () => [{ status: 'unreachable' }],
  });
  for (let i = 0; i < CLOSURE_RETRY_MAX_ENTRIES + 5; i += 1) {
    q.enqueue({ askId: `k${String(i).padStart(4, '0')}`, outcome: 'dismissed', session: 'cell-a' });
  }
  assert.equal(q.size(), CLOSURE_RETRY_MAX_ENTRIES, 'tetto duro sulle voci');
  const ids = q.pending().map((e) => e.askId);
  assert.ok(!ids.includes('k0000'), 'la piu- vecchia e- stata scartata');
  assert.ok(ids.includes(`k${String(CLOSURE_RETRY_MAX_ENTRIES + 4).padStart(4, '0')}`), 'la piu- recente resta');

  // La stessa chiusura non entra due volte.
  const before = q.size();
  q.enqueue({ askId: 'k0005', outcome: 'dismissed', session: 'cell-a' });
  assert.equal(q.size(), before, 'nessun duplicato per la stessa chiusura');
});

test('rifiuto e consegna chiudono la voce; stop() non lascia timer', async () => {
  const clock = fakeClock();
  const q = createClosureRetryQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: async ({ askId }) => (askId === 'r1'
      ? [{ status: 'refused', reason: 'grant-required' }]
      : [{ status: 'delivered' }]),
  });
  q.enqueue({ askId: 'r1', outcome: 'dismissed', session: 'cell-a' });
  clock.advance(1000); await flush();
  assert.equal(q.size(), 0, 'un rifiuto non si ritenta');

  q.enqueue({ askId: 'r2', outcome: 'dismissed', session: 'cell-a' });
  clock.advance(1000); await flush();
  assert.equal(q.size(), 0, 'una consegna chiude la voce');

  q.enqueue({ askId: 'r3', outcome: 'dismissed', session: 'cell-a' });
  assert.equal(q.size(), 1);
  assert.equal(clock.pending(), 1);
  q.stop();
  assert.equal(q.size(), 0);
  assert.equal(clock.pending(), 0, 'nessun timer sopravvive alla chiusura del server');
  // Dopo stop() la coda non accetta piu- nulla.
  assert.equal(q.enqueue({ askId: 'r4', outcome: 'dismissed', session: 'cell-a' }).ok, false);
  assert.equal(q.size(), 0);
});
