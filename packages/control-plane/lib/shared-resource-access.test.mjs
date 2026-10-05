import test from 'node:test';import assert from 'node:assert/strict';import {sharedResourceAccess} from './shared-resource-access.mjs';
test('personal broad viewers cannot broaden explicitly shared selected credentials',()=>{
 const access=sharedResourceAccess([{role:'viewer',permissions:{projects:'all'}},{role:'member',permissions:{projects:'selected',projectIds:['app'],git:'shared',agents:'shared'}}]);
 for(const r of ['git','agents'])assert.deepEqual(access[r],{allRead:false,allWrite:false,selected:[{id:'app',writable:true}]});
});
test('read-only shared Git does not acquire push rights from a personal developer',()=>{
 const access=sharedResourceAccess([{role:'viewer',permissions:{projects:'all',git:'shared'}},{role:'member',permissions:{projects:'all'}}]);
 assert.deepEqual(access.git,{allRead:true,allWrite:false,selected:[]});assert.deepEqual(access.agents,{allRead:false,allWrite:false,selected:[]});
});
