import { renderHook, act, cleanup } from '@testing-library/react';
import { it, expect, vi, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api.js', () => ({ getVlNodes: mocks.get }));
import { useVlNodeLive } from './useVlNodeLive.js';
import { risolviVlSession } from '../lib/vl-session-model.js';
const A='a'.repeat(32), B='b'.repeat(32), NODE='c'.repeat(32);
const sA={nodeId:NODE,ownerInstanceId:A,route:['r1']};
const response=(owner,generation)=>({instanceId:owner,protocol:'vl-node/1',nodes:[{nodeId:NODE,instanceId:owner,id:`${owner}:VL-${NODE}`,online:true,lastSeen:Date.now(),generation}]});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject}};
afterEach(()=>{cleanup();vi.useRealTimers()});

it('CP05 la fonte di owner B non attesta il nodo di owner A sulla stessa route',async()=>{
 mocks.get.mockReset().mockResolvedValue(response(B,2));
 const h=renderHook(()=>useVlNodeLive('t',sA,true));
 await act(async()=>{});
 expect(mocks.get).toHaveBeenCalledWith('t',['r1']);
 // Missing authority is unknown, not an authoritative absence or a peer relabelled A.
 expect(h.result.current,'instanceId diverso: la fonte non attesta presenza/assenza per owner A').toBeNull();
});

it('CP06 un errore più recente impedisce al vecchio successo di ripristinare corrente',async()=>{
 vi.useFakeTimers();const old=deferred(),fresh=deferred();
 mocks.get.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 const h=renderHook(()=>useVlNodeLive('t',sA,true));
 await act(async()=>vi.advanceTimersByTime(4000));
 await act(async()=>fresh.reject(new Error('fonte attuale non disponibile')));
 expect(h.result.current).toBeNull();
 await act(async()=>old.resolve(response(A,1)));
 expect(h.result.current,'il giro vecchio non è autorità dopo il fallimento del giro nuovo').toBeNull();
});

it('CP07 un esito già pubblicato non viene consegnato come corrente alla nuova identità',async()=>{
 const old=deferred(),fresh=deferred();
 mocks.get.mockReset().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
 const h=renderHook(({sessione})=>useVlNodeLive('t',sessione,true),{initialProps:{sessione:sA}});
 await act(async()=>old.resolve(response(A,1)));
 expect(h.result.current.peer.ownerInstanceId).toBe(A);
 const sB={...sA,ownerInstanceId:B};h.rerender({sessione:sB});
 const resolved=risolviVlSession(sB,[],{isDesktop:false,live:h.result.current});
 expect(resolved?.nonCorrente,'la fonte della nuova selezione non ha ancora risposto').toBe(true);
 expect(resolved?.peer.ownerInstanceId,'nessun peer corrente di owner A nella vista di B').not.toBe(A);
});
