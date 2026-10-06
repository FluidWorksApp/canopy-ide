import test from 'node:test';import assert from 'node:assert/strict';import {sessionAccess} from './session-access.mjs';
test('view and interact retain the independent source grant project scopes',()=>{
 const result=sessionAccess([{role:'member',permissions:{projects:'all',sessions:'private'}},{role:'viewer',permissions:{projects:'all',sessions:'view'}},{role:'member',permissions:{projects:'selected',projectIds:['app'],sessions:'interact'}}]);
 assert.deepEqual(result.view,{allRead:true,allWrite:false,selected:[{id:'app',writable:true}]});assert.deepEqual(result.interact,{allRead:false,allWrite:false,selected:[{id:'app',writable:true}]});
});
