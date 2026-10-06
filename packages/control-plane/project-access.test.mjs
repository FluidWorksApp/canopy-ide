import test from 'node:test';
import assert from 'node:assert/strict';
import {projectAccess} from './lib/project-access.mjs';
import {grantedProjects} from '../remote-host/project-mounts.mjs';
test('broad viewer plus narrow writer stays narrow and catalog caps access',()=>{
 const access=projectAccess([{role:'viewer',permissions:{projects:'all'}},{role:'member',permissions:{projects:'selected',projectIds:['app','locked']}}]);
 const workspace={id:'owner',projectMounts:[{id:'app',writable:true},{id:'other',writable:true},{id:'locked',writable:false}]};
 assert.deepEqual(grantedProjects(workspace,access),[{id:'app',writable:true},{id:'other',writable:false},{id:'locked',writable:false}]);
 assert.deepEqual(grantedProjects(workspace,projectAccess([{role:'member',permissions:{projectIds:['app','not-in-catalog']}}])),[{id:'app',writable:true}]);
 assert.deepEqual(grantedProjects(workspace,projectAccess([])),[]);
});
