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
it('a new live generation updates the existing card without duplicating its canonical key', async () => {
 await mount();await emit({type:'ask',ask});await openPanel();
 await emit({type:'ask',ask:{...ask,ownerAskTs:200,question:'New generation'}});
 expect(screen.queryByText('New generation')).not.toBeNull();expect(screen.queryByText(ask.question)).toBeNull();expect(document.querySelectorAll('.nc-ask-card').length).toBe(1);
});
it('an owner resync signal refreshes the panel while its SSE stays connected', async () => {
 m.getFeedState.mockResolvedValueOnce({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:0',asks:[ask]}]});await mount();await openPanel();
 m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:1',asks:[]}]});await emit({type:'feed-state-changed',ownerId:owner});await waitFor(()=>expect(screen.queryByText(ask.question)).toBeNull());
});
it('an old token read cannot overwrite the next token view', async () => {
 const pending=deferred();m.getAsks.mockReturnValueOnce(pending.promise);
 const view=render(<NotifyCenter token="old"/>);await waitFor(()=>expect(m.frame).toBeTypeOf('function'));
 m.getAsks.mockResolvedValue({asks:[{id:'new-local',ts:200,question:'Current token',session:'reviewer'}]});view.rerender(<NotifyCenter token="new"/>);await openPanel();
 await act(async()=>pending.resolve({asks:[{id:'old-local',ts:100,question:'Old token',session:'reviewer'}]}));expect(screen.queryByText('Old token')).toBeNull();expect(screen.getByText('Current token')).toBeTruthy();
});
it('a late close cannot erase a newer generation that arrives again after a confirmed close',async()=>{
 await mount();await emit({type:'ask',ask});await openPanel();await emit({type:'ask-answered',id:ask.id,ownerId:owner,ownerAskTs:100});
 await emit({type:'ask',ask:{...ask,ownerAskTs:200,question:'Reopened generation'}});expect(screen.getByText('Reopened generation')).toBeTruthy();
 await emit({type:'ask-answered',id:ask.id,ownerId:owner,ownerAskTs:100});expect(screen.getByText('Reopened generation')).toBeTruthy();
});
it('an owner snapshot at the ASK cap is a floor and cannot remove a known absent card',async()=>{
 await mount();await emit({type:'ask',ask});await openPanel();
 const floor=Array.from({length:100},(_,i)=>({...ask,id:'id-'+i,question:'Floor '+i}));m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:0',asks:floor}]});await act(async()=>m.open());expect(screen.queryByText(ask.question)).not.toBeNull();
});

it('a late imported alias read cannot resurrect a card after a newer complete owner snapshot',async()=>{
 const pending=deferred();m.getAsks.mockReturnValue(pending.promise);
 m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:2',asks:[]}]});
 await mount();await act(async()=>pending.resolve({asks:[{...ask,id:'local-alias',ownerAskId:ask.id,originNode:owner}]}));
 expect(screen.queryByTitle((_t,e)=>e.className==='nc-ask-badge')).toBeNull();
});

it('an unknown-generation closure keeps identical historical content hidden but permits different authoritative content',async()=>{
 const historic={...ask,ownerAskTs:null};await mount();await emit({type:'ask',ask:historic});await openPanel();
 await emit({type:'ask-answered',id:historic.id,ownerId:owner});
 m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:2',asks:[{...historic,ownerAskTs:100}]}]});
 await emit({type:'feed-state-changed',ownerId:owner});expect(screen.queryByText(ask.question)).toBeNull();
 m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:3',asks:[{...historic,ownerAskTs:200,question:'Different canonical content'}]}]});
 await emit({type:'feed-state-changed',ownerId:owner});await waitFor(()=>expect(screen.queryByText('Different canonical content')).not.toBeNull());
});

it('a stale dismissed frame cannot install a generic tombstone for a newer current generation',async()=>{
 const current={...ask,ownerAskTs:200,question:'Current after stale dismiss'};await mount();await emit({type:'ask',ask:current});await openPanel();
 await emit({type:'ask-dismissed',id:ask.id,ownerId:owner,ownerAskTs:100});
 m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,viewEpoch:1,cursor:'1:3',asks:[current]}]});
 await emit({type:'feed-state-changed',ownerId:owner});expect(screen.queryByText(current.question)).not.toBeNull();
});

for (const watermark of [{viewEpoch:0,cursor:'0:0'},{viewEpoch:1,cursor:'invalid'},{viewEpoch:1,cursor:'2:0'}]) it(`an invalid authoritative watermark cannot remove cards: ${JSON.stringify(watermark)}`,async()=>{
 await mount();await emit({type:'ask',ask});await openPanel();
 m.getFeedState.mockResolvedValue({views:[{ownerId:owner,stale:false,asks:[],...watermark}]});
 await emit({type:'feed-state-changed',ownerId:owner});expect(screen.queryByText(ask.question)).not.toBeNull();
});
