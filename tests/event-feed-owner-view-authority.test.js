'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProbe, ownerId, ask } = require('./helpers/owner-view-probe.cjs');
for (const [reason, response] of [
  ['asks-unreadable', () => ({ ok: false, status: 503 })],
  ['transport', () => { throw new Error('socket unavailable'); }],
]) test(`a failed owner snapshot revokes authority and preserves data: ${reason}`, async () => {
  const p = createProbe();
  const initial = p.snapshot(); initial.asks = [ask];
  p.setResponse(() => ({ ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(initial) }));
  assert.equal((await p.client.ownerSnapshotAsks(ownerId)).status, 'ok');
  const before = p.client.state().views[0]; assert.equal(before.stale, false);
  p.setResponse(response);
  const result = await p.client.ownerSnapshotAsks(ownerId);
  const after = p.client.state().views[0];
  assert.equal(after.stale, true);
  assert.equal(after.lastError, reason);
  assert.equal(result.reason, reason);
  assert.deepEqual(after.asks, before.asks);
  assert.equal(p.changes.length, 2);
});
test('the exported owner view follows live ASK, generation replacement and owner closure', async () => {
  const p = createProbe();
  try {
    await p.start();
    await p.emit({ type: 'ask', askId: ask.id, question: ask.question, options: [], session: ask.session, ts: 999, askTs: 100 });
    assert.equal(p.client.state().views[0].asks.length, 1);
    assert.equal(p.client.state().views[0].asks[0].ownerAskTs, 100);
    await p.emit({ type: 'ask', askId: ask.id, question: 'New generation', options: [], session: ask.session, ts: 999, askTs: 200 });
    assert.equal(p.client.state().views[0].asks.length, 1);
    assert.equal(p.client.state().views[0].asks[0].ownerAskTs, 200);
    await p.emit({ type: 'ask-closed', askId: ask.id, outcome: 'answered', askTs: 100 });
    assert.equal(p.client.state().views[0].asks.length, 1);
    await p.emit({ type: 'ask-closed', askId: ask.id, outcome: 'answered', askTs: 200 });
    assert.equal(p.client.state().views[0].asks.length, 0);
  } finally { p.client.stop(); }
});
test('a fresh owner snapshot after a live ASK can certify its absence', async () => {
  const p = createProbe();
  try {
    await p.start(); await p.emit({ type: 'ask', askId: ask.id, question: ask.question, session: ask.session, ts: 100, askTs: 100 });
    assert.equal(p.client.state().views[0].asks.length, 1);
    assert.equal((await p.client.ownerSnapshotAsks(ownerId)).status, 'ok');
    assert.equal(p.client.state().views[0].asks.length, 0);
    assert.equal(p.client.state().views[0].stale, false);
  } finally { p.client.stop(); }
});
test('a snapshot started before a live ASK cannot certify its absence', async () => {
  const p = createProbe(); let complete, started;
  try {
    await p.start();
    const waiting = new Promise(resolve => { started = resolve; });
    const old = p.snapshot();
    p.setResponse(() => { started(); return new Promise(resolve => { complete = () => resolve({ ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(old) }); }); });
    const pending = p.client.ownerSnapshotAsks(ownerId); await waiting;
    await p.emit({ type: 'ask', askId: ask.id, question: ask.question, session: ask.session, ts: 100, askTs: 100 });
    complete(); const result = await pending;
    assert.equal(p.client.state().views[0].asks.length, 1);
    assert.notEqual(result.status, 'ok', 'an old owner read must not authorize imported alias removal either');
  } finally { p.client.stop(); }
});
test('a replayed closed generation cannot return to the exported owner view', async () => {
  const p = createProbe();
  try {
    await p.start();
    const frame = { type: 'ask', askId: ask.id, question: ask.question, session: ask.session, ts: 100, askTs: 100 };
    await p.emit(frame);
    await p.emit({ type: 'ask-closed', askId: ask.id, outcome: 'dismissed', askTs: 100 });
    await p.emit(frame);
    assert.equal(p.client.state().views[0].asks.length, 0);
  } finally { p.client.stop(); }
});
test('an older live generation cannot overwrite the current ASK', async () => {
 const p = createProbe();
 try {
  await p.start();
  await p.emit({type:'ask',askId:ask.id,question:'Current generation',session:ask.session,ts:200,askTs:200});
  await p.emit({type:'ask',askId:ask.id,question:ask.question,session:ask.session,ts:999,askTs:100});
  assert.equal(p.client.state().views[0].asks[0].ownerAskTs,200);
  assert.equal(p.client.state().views[0].asks[0].question,'Current generation');
 } finally {p.client.stop();}
});
test('a live ASK beyond the view cap revokes authority without silently evicting existing cards', async () => {
 const p = createProbe(); const initial=p.snapshot();
 initial.asks=Array.from({length:99},(_,i)=>({...ask,id:`item${i}`,question:`Question ${i}`}));
 p.setResponse(()=>({ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(initial)}));
 try {
  await p.start();
  await p.emit({type:'ask',askId:'last-item',question:'Last slot',session:ask.session,ts:100,askTs:100});
  await p.emit({type:'ask',askId:'overflow-item',question:'Overflow',session:ask.session,ts:100,askTs:100});
  const view=p.client.state().views[0];
  assert.equal(view.asks.length,100);assert.equal(view.stale,true);assert.equal(view.lastError,'snapshot-asks-cap');
  assert.ok(view.asks.some(a=>a.id==='item0'));
  assert.ok(p.frames.some(f=>f.ask && f.ask.id==='overflow-item'),'the live ASK is still delivered to the UI');
 } finally {p.client.stop();}
});
test('an owner snapshot deadline revokes cached authority while its acquisition is pending', async () => {
 const p=createProbe(); assert.equal((await p.client.ownerSnapshotAsks(ownerId)).status,'ok');
 let release;
 p.setResponse(()=>new Promise(resolve=>{release=()=>resolve({ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(p.snapshot())});}));
 const keepAlive=setTimeout(()=>{},5000);
 try {
  const result=await p.client.ownerSnapshotAsks(ownerId);
  assert.equal(result.status,'pending');assert.equal(result.reason,'door-timeout');
  assert.equal(p.client.state().views[0].stale,true);
  assert.equal(p.client.state().views[0].lastError,'snapshot-timeout');
 } finally {clearTimeout(keepAlive);release();await new Promise(resolve=>setImmediate(resolve));}
});
test('a fan-out received during a pending owner read supersedes it without fabricating a cursor', async () => {
 const p=createProbe();assert.equal((await p.client.ownerSnapshotAsks(ownerId)).status,'ok');
 let release,started;const waiting=new Promise(resolve=>{started=resolve;});const before=p.snapshot();
 p.setResponse(()=>{started();return new Promise(resolve=>{release=()=>resolve({ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(before)});});});
 const pending=p.client.ownerSnapshotAsks(ownerId);await waiting;
 p.client.rememberLiveAsk(ownerId,{...ask,id:'local-alias',ownerAskId:ask.id,imported:true});
 assert.equal(p.client.state().views[0].cursor,'1:0');
 release();const result=await pending;
 assert.notEqual(result.status,'ok');assert.equal(p.client.state().views[0].asks.length,1);
 assert.equal(p.client.state().views[0].asks[0].id,ask.id);
});
test('a decision-only snapshot started before fan-out cannot authorize alias closure', async () => {
 const p=createProbe();assert.equal((await p.client.ownerSnapshotAsks(ownerId)).status,'ok');
 let release,started;const waiting=new Promise(resolve=>{started=resolve;});const before=p.snapshot();before.notifications="unusable-view";
 p.setResponse(()=>{started();return new Promise(resolve=>{release=()=>resolve({ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(before)});});});
 const pending=p.client.ownerSnapshotAsks(ownerId);await waiting;
 p.client.rememberLiveAsk(ownerId,{...ask,id:'local-alias',ownerAskId:ask.id,imported:true});
 release();const result=await pending;
 assert.notEqual(result.status,'ok','a valid decision schema cannot make a superseded read authoritative');
 assert.equal(p.client.state().views[0].asks.length,1);
});
