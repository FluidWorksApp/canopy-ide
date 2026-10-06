import test from 'node:test';import assert from 'node:assert/strict';import {discoverWorkspaces} from './workspace-discovery.mjs';
function source({role='member',permissions={projects:'selected',projectIds:['app']},sharing_generation=3,state='stopped',operation=null}={}){
 const w={id:'ws-shared',owner_id:'owner',organization_id:null,provider:'lightsail',generation:4,sharing_generation,state,desired_state:state==='ready'?'running':'stopped'};
 return {query:async sql=>{
  if(sql.startsWith('SELECT w.id'))return {rows:[w]};if(sql.startsWith('SELECT owner_id'))return {rows:[w]};if(sql.includes('FROM workspace_member'))return {rows:[{role,permissions,source:'direct'}]};if(sql.startsWith('SELECT action'))return {rows:operation?[operation]:[]};if(sql.startsWith('SELECT state'))return {rows:[w]};throw Error('Unexpected query '+sql);
 }};
}
test('stopped previously enabled shared workspace exposes Resume but no infrastructure mutation controls',async()=>{
 const [workspace]=await discoverWorkspaces(source(),'alice');assert.equal(workspace.access.canResume,true);assert.equal(workspace.access.canConnect,false);assert.equal(workspace.access.owner,false);assert.equal(workspace.access.canStop,false);
});
test('viewer, empty project writes, never enabled sharing and other pending lifecycle actions cannot expose Resume',async()=>{
 for(const options of [{role:'viewer',permissions:{projects:'all'}},{permissions:{projects:'selected',projectIds:[]}},{sharing_generation:null},{operation:{action:'resize',status:'running'}}]){const [workspace]=await discoverWorkspaces(source(options),'alice');assert.equal(workspace.access.canResume,false);assert.equal(workspace.access.canStop,false);}
});
test('verified ready viewers can browse but cannot write, resume or stop the workspace',async()=>{
 const [workspace]=await discoverWorkspaces(source({role:'viewer',permissions:{projects:'all'},state:'ready',sharing_generation:4}),'alice');assert.equal(workspace.access.canConnect,true);assert.equal(workspace.access.canWrite,false);assert.equal(workspace.access.canResume,false);assert.equal(workspace.access.canStop,false);
});
