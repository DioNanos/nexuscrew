import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createProbe } = require('../../../tests/helpers/owner-view-probe.cjs');
import React from 'react';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ getAsks: vi.fn(), getFeedState: vi.fn(), frame: null, open: null, enqueue: vi.fn() }));
vi.mock('../lib/api.js', async original => ({ ...(await original()), getAsks: m.getAsks, getFeedState: m.getFeedState,
  getAskRelayState: vi.fn(async () => ({ attempts: [] })), getAskReplyCapability: vi.fn(async (_t, {ownerId,askId}) => ({ownerId,askId,canReply:false,status:'unreachable',canDismissLocal:false,canDismissRemote:false})) }));
vi.mock('../lib/events.js', () => ({ connectEvents: (_t, frame, open) => { m.frame=frame; m.open=open; return () => {}; } }));
vi.mock('../hooks/useNotificationSpeech.js', () => ({ useNotificationSpeech: () => [true, () => {}] }));
vi.mock('../lib/notification-speech.js', () => ({ NOTIFICATION_SPEECH_PREVIEW_EVENT:'preview', notificationSpeechFrameLang: () => 'en', createNotificationSpeaker: () => ({enqueue:m.enqueue,stop:()=>{},dispose:()=>{}}) }));
import NotifyCenter from './NotifyCenter.jsx';
const owner='a'.repeat(32), other='b'.repeat(32);
const ask={id:'abcdef01',ownerId:owner,ownerAskTs:100,question:'Shared question',options:[],session:'reviewer',imported:true};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
beforeEach(()=>{vi.clearAllMocks(); localStorage.setItem('nc_lang','en');m.getAsks.mockResolvedValue({asks:[]});m.getFeedState.mockResolvedValue({views:[]});});
const mount=async()=>{render(<NotifyCenter token="fixture"/>);await waitFor(()=>expect(m.frame).toBeTypeOf('function'));};
const emit=async frame=>act(async()=>m.frame(frame));
const openPanel=async()=>{fireEvent.click(await screen.findByTitle((_t,e)=>e.className==='nc-ask-badge'));};

for (const [reason, response] of [
 ['asks-unreadable', () => ({ok:false,status:503})],
 ['transport', () => {throw new Error('socket unavailable');}],
]) it(`a real failed owner snapshot preserves a fan-out card at reconnect: ${reason}`, async () => {
 const p=createProbe();
 expect((await p.client.ownerSnapshotAsks(owner)).status).toBe('ok');
 await mount(); await emit({type:'ask',ask}); await openPanel();
 expect(screen.queryByText(ask.question)).not.toBeNull();
 p.setResponse(response);expect((await p.client.ownerSnapshotAsks(owner)).status).toBe('error');
 m.getFeedState.mockResolvedValue(p.client.state());await act(async()=>m.open());
 expect(screen.queryByText(ask.question)).not.toBeNull();
 p.setResponse(()=>({ok:true,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(p.snapshot())}));
 expect((await p.client.ownerSnapshotAsks(owner)).status).toBe('ok');
 m.getFeedState.mockResolvedValue(p.client.state());await act(async()=>m.open());
 expect(screen.queryByText(ask.question)).toBeNull();
});
it('a real live owner ASK survives reconnect until a new owner snapshot excludes it', async () => {
 const p=createProbe();
 try {
  await p.start();await mount();
  await p.emit({type:'ask',askId:ask.id,question:ask.question,session:'cloud-reviewer',ts:100,askTs:100});
  await emit(p.frames.find(f=>f.type==='ask'));await openPanel();
  expect(screen.queryByText(ask.question)).not.toBeNull();
  m.getFeedState.mockResolvedValue(p.client.state());await act(async()=>m.open());
  expect(screen.queryByText(ask.question)).not.toBeNull();
  expect((await p.client.ownerSnapshotAsks(owner)).status).toBe('ok');
  m.getFeedState.mockResolvedValue(p.client.state());await act(async()=>m.open());
  expect(screen.queryByText(ask.question)).toBeNull();
 } finally {p.client.stop();}
});
it('a healthy cached owner read retains a fan-out ASK until a new snapshot excludes it',async()=>{
 const p=createProbe();expect((await p.client.ownerSnapshotAsks(owner)).status).toBe('ok');
 await mount();p.client.rememberLiveAsk(owner,ask);await emit({type:'ask',ask});await openPanel();
 m.getFeedState.mockResolvedValue(p.client.state());await act(async()=>m.open());
 expect(screen.queryByText(ask.question)).not.toBeNull();
 expect((await p.client.ownerSnapshotAsks(owner)).status).toBe('ok');
 m.getFeedState.mockResolvedValue(p.client.state());await act(async()=>m.open());
 expect(screen.queryByText(ask.question)).toBeNull();
});
