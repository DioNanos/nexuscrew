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
  q.enqueue({ askId: 'a1', outcome: 'dismissed', session: 'cell-a', targets: ['peer'] });
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
    run: async () => { calls += 1; return online ? [{ target: 'peer', status: 'delivered' }] : [{ target: 'peer', status: 'unreachable' }]; },
  });
  q.enqueue({ askId: 'a2', outcome: 'answered', session: 'cell-a', targets: ['peer'] });
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
  q.enqueue({ askId: 'a3', outcome: 'dismissed', session: 'cell-a', targets: ['peer'] });
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
    run: async () => { calls += 1; return [{ target: 'peer', status: 'unreachable' }]; },
  });
  q.enqueue({ askId: 'a4', outcome: 'dismissed', session: 'cell-a', targets: ['peer'] });
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
    run: async () => { calls2 += 1; return [{ target: 'peer', status: 'unknown' }]; },
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
    run: async ({ targets }) => targets.map((target) => ({ target, status: 'unreachable' })),
  });
  for (let i = 0; i < CLOSURE_RETRY_MAX_ENTRIES + 5; i += 1) {
    q.enqueue({ askId: `k${String(i).padStart(4, '0')}`, outcome: 'dismissed', session: 'cell-a', targets: [`t${i}`] });
  }
  assert.equal(q.size(), CLOSURE_RETRY_MAX_ENTRIES, 'tetto duro sulle voci');
  const ids = q.pending().map((e) => e.askId);
  assert.ok(!ids.includes('k0000'), 'la piu- vecchia e- stata scartata');
  assert.ok(ids.includes(`k${String(CLOSURE_RETRY_MAX_ENTRIES + 4).padStart(4, '0')}`), 'la piu- recente resta');

  // La stessa chiusura non entra due volte.
  const before = q.size();
  q.enqueue({ askId: 'k0005', outcome: 'dismissed', session: 'cell-a', targets: ['peer'] });
  assert.equal(q.size(), before, 'nessun duplicato per la stessa chiusura');
});

test('rifiuto e consegna chiudono la voce; stop() non lascia timer', async () => {
  const clock = fakeClock();
  const q = createClosureRetryQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: async ({ askId, targets }) => targets.map((target) => (askId === 'r1'
      ? { target, status: 'refused', reason: 'grant-required' }
      : { target, status: 'delivered' })),
  });
  q.enqueue({ askId: 'r1', outcome: 'dismissed', session: 'cell-a', targets: ['peer'] });
  clock.advance(1000); await flush();
  assert.equal(q.size(), 0, 'un rifiuto non si ritenta');

  q.enqueue({ askId: 'r2', outcome: 'dismissed', session: 'cell-a', targets: ['peer'] });
  clock.advance(1000); await flush();
  assert.equal(q.size(), 0, 'una consegna chiude la voce');

  q.enqueue({ askId: 'r3', outcome: 'dismissed', session: 'cell-a', targets: ['peer'] });
  assert.equal(q.size(), 1);
  assert.equal(clock.pending(), 1);
  q.stop();
  assert.equal(q.size(), 0);
  assert.equal(clock.pending(), 0, 'nessun timer sopravvive alla chiusura del server');
  // Dopo stop() la coda non accetta piu- nulla.
  assert.equal(q.enqueue({ askId: 'r4', outcome: 'dismissed', session: 'cell-a', targets: ['peer'] }).ok, false);
  assert.equal(q.size(), 0);
});

// --- recapito MISTO: un peer risponde, l'altro no ---------------------------
//
// Il difetto: si accodava solo se NESSUN peer aveva ricevuto. Bastava che uno
// rispondesse perche' il peer spento sparisse dalla coda — e la sua copia
// restava aperta per sempre, perche' da quel lato non c'e' modo di rimediare.
// Qui la coda porta i SOLI pendenti, e li aggiorna a ogni risposta.

const { createClosureFanout } = require('../lib/notify/routes.js');

const A_ID = 'a'.repeat(32);
const B_ID = 'b'.repeat(32);
const C_ID = 'c'.repeat(32);

// Fan-out e coda legati come in produzione: il `run` della coda e' il fan-out
// stesso, che ritenta i soli target che la voce gli passa, e non si riaccoda.
function impianto(t, risposta) {
  const clock = fakeClock();
  const retry = createClosureRetryQueue({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    run: ({ askId, outcome, session, targets }) => fanout.dispatch({ askId, outcome, session, retryOnFailure: false, targets }),
  });
  const fanout = createClosureFanout({
    dispatcher: { dispatch: async ({ target }) => risposta(target) },
    peerTargets: async () => [B_ID, C_ID],
    localNodeId: () => A_ID,
    retry,
  });
  t.after(() => retry.stop());
  return { retry, fanout, clock };
}

test('un peer riceve e l\'altro e\' spento: la coda tiene il SOLO spento', async (t) => {
  let cOnline = false;
  const { retry, fanout } = impianto(t, (target) => (target === B_ID
    ? { status: 'delivered' }
    : (cOnline ? { status: 'delivered' } : { status: 'unknown', reason: 'peer-offline' })));

  const out = await fanout.dispatch({ askId: 'm1', outcome: 'dismissed', session: 's' });
  assert.deepStrictEqual(out.map((r) => [r.target, r.status]), [[B_ID, 'delivered'], [C_ID, 'unknown']]);
  assert.equal(retry.size(), 1, 'il peer spento resta in coda anche se l\'altro ha ricevuto');
  assert.deepStrictEqual(retry.pending()[0].targets, [C_ID], 'e la voce dice QUALE manca');

  // C torna: il ritentativo va SOLO a lui e chiude la voce.
  cOnline = true;
  const r2 = await retry.drain('read');
  assert.equal(r2.attempted, 1, 'un solo tentativo: verso il solo pendente');
  assert.equal(retry.size(), 0, 'raggiunto l\'ultimo pendente, la voce si chiude');
});

test('tutti e due spenti, poi uno torna: la voce resta con l\'ALTRO', async (t) => {
  let bOnline = false;
  const { retry, fanout } = impianto(t, (target) => {
    const online = target === B_ID ? bOnline : false;
    return online ? { status: 'delivered' } : { status: 'unknown', reason: 'peer-offline' };
  });

  await fanout.dispatch({ askId: 'm2', outcome: 'answered', session: 's' });
  assert.equal(retry.size(), 1);
  assert.deepStrictEqual(retry.pending()[0].targets.slice().sort(), [B_ID, C_ID].sort());

  bOnline = true;
  await retry.drain('read');
  assert.equal(retry.size(), 1, 'la voce NON si chiude: C non ha ancora risposto');
  assert.deepStrictEqual(retry.pending()[0].targets, [C_ID], 'ed e\' rimasto solo C');

  // C risponde `refused`: e' un rifiuto, non una consegna, e non si ritenta.
  const { retry: r2 } = impianto(t, (target) => (target === C_ID
    ? { status: 'refused', reason: 'grant-required' }
    : { status: 'unknown', reason: 'peer-offline' }));
  await r2.enqueue({ askId: 'm3', outcome: 'dismissed', session: 's', targets: [C_ID] });
  await r2.drain('read');
  assert.equal(r2.size(), 0, 'un rifiuto esce dall\'insieme e chiude la voce');
});

test('due dispatch della stessa chiusura UNISCONO i target, non si scartano', async (t) => {
  const { retry } = impianto(t, () => ({ status: 'unknown' }));
  retry.enqueue({ askId: 'm4', outcome: 'dismissed', session: 's', targets: [B_ID] });
  const second = retry.enqueue({ askId: 'm4', outcome: 'dismissed', session: 's', targets: [C_ID] });
  assert.equal(second.merged, true);
  assert.equal(second.added, 1);
  assert.equal(retry.size(), 1, 'una sola voce per la coppia (chiusura, esito)');
  assert.deepStrictEqual(retry.pending()[0].targets.slice().sort(), [B_ID, C_ID].sort());

  // E la stessa chiusura con lo STESSO target non gonfia l'insieme.
  const terzo = retry.enqueue({ askId: 'm4', outcome: 'dismissed', session: 's', targets: [C_ID] });
  assert.equal(terzo.added, 0);
  assert.equal(retry.pending()[0].targets.length, 2);
});

test('una chiusura senza pendenti non entra in coda', async (t) => {
  const { retry } = impianto(t, () => ({ status: 'delivered' }));
  const r = retry.enqueue({ askId: 'm5', outcome: 'dismissed', session: 's', targets: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-targets');
  assert.equal(retry.size(), 0);
});
