'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseDefinitions,tmuxSessionForCell}=require('../lib/fleet/definitions.js');
const {resolveOwnerSession,createOwnerAskScope}=require('../lib/notify/owner-ask-scope.js');
function validatedCell(id,session){return parseDefinitions({schemaVersion:1,engines:[{id:'fixture',command:'/bin/true',args:[],env:{},promptMode:'send-keys'}],cells:[{id,engine:'fixture',cwd:'/tmp',boot:false,tmuxSession:session}]}).cells[0];}
test('exact owner session mapping wins without probing activity or stripping a prefix',()=>{
 const cells=[validatedCell('reviewer','mgm-reviewer'),validatedCell('other','samwork-other')];
 assert.equal(resolveOwnerSession('mgm-reviewer',cells),'reviewer');assert.equal(resolveOwnerSession('samwork-other',cells),'other');assert.equal(resolveOwnerSession('mgm-reviewer-extra',cells),null);assert.equal(resolveOwnerSession('MGM-reviewer',cells),null);
});
test('ambiguous exact matches of individually validated local cells never choose the first',()=>{
 const cells=[validatedCell('reviewer','mgm-shared'),validatedCell('other','mgm-shared')];assert.equal(resolveOwnerSession('mgm-shared',cells),null);
});
test('no exact match preserves both legacy canonical codecs',()=>{
 assert.equal(resolveOwnerSession('cloud-manual',[]),'manual');assert.equal(resolveOwnerSession(tmuxSessionForCell('reviewer.remote'),[]),'reviewer.remote');assert.equal(resolveOwnerSession('mgm-Unknown',[]),null);
});

test("disabled Fleet does not require a home directory",()=>{
 let scope;
 assert.doesNotThrow(()=>{scope=createOwnerAskScope({fleetEnabled:false});});
 assert.equal(scope.cellForSession("cloud-manual"),"manual");
 assert.equal(scope.snapshotResolver()("cloud-manual"),"manual");
});
