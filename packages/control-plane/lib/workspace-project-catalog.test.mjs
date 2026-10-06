import test from 'node:test';import assert from 'node:assert/strict';import {workspaceProjectCatalog} from './workspace-project-catalog.mjs';
const project=id=>({id,name:id,components:[{id:'web',name:'Web'}],path:'/private/owner',credentials:'must-not-return'});
function fixture(grants,state='ready') {return {query:async sql=>sql.includes('SELECT id,state')?{rows:[{id:'workspace',state,desired_state:'running',endpoint:'https://workspace.invalid'}]}:sql.includes('owner_id')?{rows:[{owner_id:'owner'}]}:{rows:grants}};}
test('catalog filters to administrative projects and strips paths and credentials',async()=>{
 const db=fixture([{role:'admin',permissions:{projects:'selected',projectIds:['app']}},{role:'viewer',permissions:{projects:'all'}}]);
 assert.deepEqual(await workspaceProjectCatalog(db,'admin','workspace',{load:async()=>({projects:[project('app'),project('secret')]})}),{projects:[{id:'app',name:'app',components:[{id:'web',name:'Web'}]}]});
});
test('catalog lookup cannot start a stopped runtime or read projects without administrative access',async()=>{
 let calls=0;const load=async()=>{calls++;return {projects:[]};};
 await assert.rejects(workspaceProjectCatalog(fixture([{role:'member',permissions:{projects:'all'}}]),'member','workspace',{load}),e=>e.status===403);
 await assert.rejects(workspaceProjectCatalog(fixture([],'stopped'),'owner','workspace',{load}),e=>e.status===409);
 assert.equal(calls,0);
});
test('catalog rejects malformed/duplicate project and component identities',async()=>{
 for(const projects of [[project('app'),project('app')],[project('../owner')],[{...project('app'),components:[{id:'web',name:'Web'},{id:'web',name:'Other'}]}]])await assert.rejects(workspaceProjectCatalog(fixture([]),'owner','workspace',{load:async()=>({projects})}),e=>e.status===502);
});
test('unavailable management endpoint returns a retryable error',async()=>{
 await assert.rejects(workspaceProjectCatalog(fixture([]),'owner','workspace',{load:async()=>{throw Error('private detail');}}),e=>e.status===503&&!e.message.includes('private detail'));
});
