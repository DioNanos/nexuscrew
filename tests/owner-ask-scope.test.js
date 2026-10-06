'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseDefinitions,tmuxSessionForCell}=require('../lib/fleet/definitions.js');
const {resolveOwnerSession,createOwnerAskScope}=require('../lib/notify/owner-ask-scope.js');
function validatedCell(id,session){return parseDefinitions({schemaVersion:1,engines:[{id:'fixture',command:'/bin/true',args:[],env:{},promptMode:'send-keys'}],cells:[{id,engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:session}]}).cells[0];}
test('exact owner session mapping wins without probing activity or stripping a prefix',()=>{
 const cells=[validatedCell('reviewer','lab-reviewer'),validatedCell('other','edge-other')];
 assert.equal(resolveOwnerSession('lab-reviewer',cells),'reviewer');assert.equal(resolveOwnerSession('edge-other',cells),'other');assert.equal(resolveOwnerSession('lab-reviewer-extra',cells),null);assert.equal(resolveOwnerSession('LAB-reviewer',cells),null);
});
test('ambiguous exact matches of individually validated local cells never choose the first',()=>{
 const cells=[validatedCell('reviewer','lab-shared'),validatedCell('other','lab-shared')];assert.equal(resolveOwnerSession('lab-shared',cells),null);
});
test('no exact match preserves both legacy canonical codecs',()=>{
 assert.equal(resolveOwnerSession('cloud-manual',[]),'manual');assert.equal(resolveOwnerSession(tmuxSessionForCell('reviewer.remote'),[]),'reviewer.remote');assert.equal(resolveOwnerSession('lab-Unknown',[]),null);
});

test("disabled Fleet does not require a home directory",()=>{
 let scope;
 assert.doesNotThrow(()=>{scope=createOwnerAskScope({fleetEnabled:false});});
 assert.equal(scope.cellForSession("cloud-manual"),"manual");
 assert.equal(scope.snapshotResolver()("cloud-manual"),"manual");
});
