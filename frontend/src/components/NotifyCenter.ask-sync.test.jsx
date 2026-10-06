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
it('correlated remote ASK alerts keep the first toast and speech without a generic panel card',async()=>{
 await mount();await emit({type:'ask',ask});
 await emit({type:'notify',ownerId:owner,eventId:'first',askId:ask.id,ownerAskTs:100,title:'First ASK alert',body:ask.question});
 expect(screen.queryByText('First ASK alert')).not.toBeNull();expect(m.enqueue).toHaveBeenCalledTimes(1);
 await openPanel();expect(document.querySelectorAll('.nc-remote-notice').length).toBe(0);expect(document.querySelectorAll('.nc-ask-card').length).toBe(1);
});
it('the same canonical question alerts once across direct and feed identities',async()=>{
 await mount();const f={type:'notify',ownerId:owner,askId:ask.id,ownerAskTs:100,title:'Canonical alert'};
 await emit(f);await emit({...f,eventId:'feed'});expect(m.enqueue).toHaveBeenCalledTimes(1);expect(screen.getAllByText('Canonical alert').length).toBe(1);
});
it('an answered frame prevails over a local read already in flight',async()=>{
 const pending=deferred();m.getAsks.mockReturnValue(pending.promise);await mount();await emit({type:'ask',ask});await openPanel();
 await emit({type:'ask-answered',id:ask.id,ownerId:owner,ownerAskTs:100});await act(async()=>pending.resolve({asks:[ask]}));expect(screen.queryByText(ask.question)).toBeNull();
});
it('reconnect applies an authoritative empty owner snapshot without removing another owner',async()=>{
 m.getFeedState.mockResolvedValueOnce({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:"1:0",asks:[ask]},{ownerId:other,stale:false,viewEpoch:1,cursor:"1:0",asks:[{...ask,ownerId:other,question:'Other question'}]}]});
 await mount();await openPanel();expect(screen.getByText(ask.question)).toBeTruthy();
 m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:"1:0",asks:[]},{ownerId:other,stale:false,viewEpoch:1,cursor:"1:0",asks:[{...ask,ownerId:other,question:'Other question'}]}]});
 await act(async()=>m.open());await waitFor(()=>expect(screen.queryByText(ask.question)).toBeNull());expect(screen.getByText('Other question')).toBeTruthy();
});
it('a local ASK arriving after a read started survives its older empty result', async () => {
 const pending=deferred();m.getAsks.mockReturnValue(pending.promise);await mount();
 const local={...ask,ownerId:undefined,imported:false,ts:100};await emit({type:'ask',ask:local});await openPanel();
 await act(async()=>pending.resolve({asks:[]}));expect(screen.queryByText(local.question)).not.toBeNull();
});
it('an imported ASK arriving after a feed read started survives its older empty result', async () => {
 const pending=deferred();m.getFeedState.mockReturnValue(pending.promise);await mount();await emit({type:'ask',ask});await openPanel();
 await act(async()=>pending.resolve({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:0',asks:[]}]}));expect(screen.queryByText(ask.question)).not.toBeNull();
});
it('a closure for an earlier generation cannot remove the current reused ASK ID', async () => {
 await mount();await emit({type:'ask',ask:{...ask,ownerAskTs:200}});await openPanel();
 await emit({type:'ask-answered',id:ask.id,ownerId:owner,ownerAskTs:100});expect(screen.queryByText(ask.question)).not.toBeNull();
});
for(const bad of [{stale:true},{lastError:'unreachable'},{resyncRequired:true},{error:true}]) it(`a non-authoritative owner snapshot preserves cards: ${JSON.stringify(bad)}`,async()=>{
 await mount();await emit({type:'ask',ask});await openPanel();
 m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:0',asks:[],...bad}]});await act(async()=>m.open());expect(screen.queryByText(ask.question)).not.toBeNull();
});
it('distinct owners and generations each produce one first alert in either ingress order',async()=>{
 await mount();const f={type:'notify',ownerId:owner,askId:ask.id,ownerAskTs:100,title:'ASK alert'};
 await emit({...f,eventId:'feed-first'});await emit(f);await emit({...f,ownerId:other});await emit({...f,ownerAskTs:200});expect(m.enqueue).toHaveBeenCalledTimes(3);
});
