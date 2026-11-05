'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {startGenerationPrompt,main}=require('../lib/fleet/cell-exec.js');const {securePaste}=require('../lib/fleet/launch.js');
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const cfg={tmuxBin:'tmux',tmuxSession:'cloud-T',prompt:'sentinel',readyMs:0,readyWaitMs:1000,client:'',reprompt:false};
function transport(pauseAt){const entered=defer(),release=defer(),calls=[];const exec=async(_b,args)=>{calls.push(args[0]);if(args[0]===pauseAt){entered.resolve();await release.promise;}return{err:null,stdout:'cloud-T\t0\t%42\n',stderr:'',code:0};};return{entered,release,calls,exec};}
for(const pauseAt of ['paste-buffer','delete-buffer'])test('cancel after paste attempt remains uncertain at '+pauseAt,async()=>{
 const tr=transport(pauseAt);const childState={exited:false};let fire;const marks=[];
 const ctl=startGenerationPrompt(cfg,0,childState,{setTimeout:fn=>{fire=fn;return 1;},clearTimeout:()=>{},tmuxExec:async(_b,a)=>{marks.push(a);return{err:null};},securePaste:(bin,session,prompt,opts)=>securePaste(bin,session,prompt,{...opts,exec:tr.exec})});
 fire();await tr.entered.promise;childState.exited=true;ctl.cancel();tr.release.resolve();const outcome=await ctl.settled;
 console.log('CANCEL_RESULT',pauseAt,outcome,tr.calls);assert.equal(tr.calls.filter(x=>x==='paste-buffer').length,1);assert.equal(tr.calls.filter(x=>x==='delete-buffer').length,1);
 assert.deepEqual(outcome,{state:'delivery-unknown'});
});
test('control: cancel during load is certain pre-paste and cleans buffer',async()=>{
 const tr=transport('load-buffer');const childState={exited:false};let fire;
 const ctl=startGenerationPrompt(cfg,0,childState,{setTimeout:fn=>{fire=fn;return 1;},clearTimeout:()=>{},tmuxExec:async()=>({err:null}),securePaste:(bin,session,prompt,opts)=>securePaste(bin,session,prompt,{...opts,exec:tr.exec})});fire();await tr.entered.promise;childState.exited=true;ctl.cancel();tr.release.resolve();const outcome=await ctl.settled;assert.equal(outcome,null);assert.equal(tr.calls.filter(x=>x==='paste-buffer').length,0);assert.equal(tr.calls.filter(x=>x==='delete-buffer').length,1);
});
test('control: completed paste is reported as paste-delivered',async()=>{let fire;const marks=[];const ctl=startGenerationPrompt(cfg,0,{exited:false},{setTimeout:fn=>{fire=fn;return 1;},clearTimeout:()=>{},tmuxExec:async(_b,a)=>{marks.push(a[a.length-1]);return{err:null};},securePaste:async()=>({ok:true,stage:'pasted',paneId:'%42'})});fire();assert.equal(await ctl.settled,null);assert(marks.includes('paste-delivered'));});
test('main refuses generation one when gen0 died during a successful paste',async()=>{
 const proc=new EventEmitter();const tr=transport('paste-buffer');let launches=0;let current;let tick=0;const errors=[];
 const payload={command:'/bin/fake',args:[],env:{},supervise:{enabled:true,initialReadyMs:50,restartDelayMs:50,maxRestartDelayMs:100,resetAfterMs:100000,rapidWindowMs:100000,maxRapidRestarts:10},restartPrompt:cfg};
 const done=main(['--socket','/tmp/unused','--nonce','a'.repeat(64)],{receivePayload:async()=>payload,process:proc,spawn:()=>{launches++;const child=new EventEmitter();current=child;child.kill=()=>queueMicrotask(()=>child.emit('exit',0,null));if(launches>1)queueMicrotask(()=>proc.emit('SIGTERM'));return child;},tmuxExec:async()=>({err:null,stdout:''}),securePaste:(bin,session,prompt,opts)=>securePaste(bin,session,prompt,{...opts,exec:tr.exec}),now:()=>0,monoNow:()=>{tick+=100;return tick;},sleep:async()=>{},setTimeout:fn=>{queueMicrotask(fn);return{unref(){}};},clearTimeout:()=>{},writeError:m=>errors.push(String(m))});
 await tr.entered.promise;current.emit('exit',1,null);await new Promise(r=>setImmediate(r));tr.release.resolve();const code=await done;console.log('MAIN_RESULT',{launches,code,errors,calls:tr.calls});assert.equal(launches,1);assert(errors.some(m=>m.includes('uncertain prompt delivery')));
});
test('cancel while publishing the completed paste report stays uncertain until settled',async()=>{
 const childState={exited:false};const reportEntered=defer(),reportRelease=defer();const tr=transport('never');let fire;
 const ctl=startGenerationPrompt(cfg,0,childState,{setTimeout:fn=>{fire=fn;return 1;},clearTimeout:()=>{},tmuxExec:async(_bin,args)=>{if(args.at(-1)==='paste-delivered'){reportEntered.resolve();await reportRelease.promise;}return{err:null};},securePaste:(bin,session,prompt,opts)=>securePaste(bin,session,prompt,{...opts,exec:tr.exec})});
 fire();await reportEntered.promise;childState.exited=true;ctl.cancel();reportRelease.resolve();const outcome=await ctl.settled;console.log('CANCEL_REPORT_RESULT',outcome,tr.calls);assert.deepEqual(outcome,{state:'delivery-unknown'});
});
