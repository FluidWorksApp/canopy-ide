import test from 'node:test';import assert from 'node:assert/strict';
import {validateOperation,PHASES,nextPhase} from './lib/lifecycle.mjs';
const requestKey='f9b67dc0-f389-4ddb-b6c9-bb9aff258e67';
test('deletion always requires the exact name and running work interruption confirmation',()=>{
 const workspace={name:'My work',state:'ready'};
 assert.throws(()=>validateOperation(workspace,{action:'delete',requestKey,confirmName:'other',confirmInterrupt:true}),/Confirm the workspace name/);
 assert.throws(()=>validateOperation(workspace,{action:'delete',requestKey,confirmName:'My work'}),/agents and jobs/);
 assert.doesNotThrow(()=>validateOperation(workspace,{action:'delete',requestKey,confirmName:'My work',confirmInterrupt:true}));
});
test('hibernate retains storage; resize commits the price only after readiness',()=>{
 assert.ok(!PHASES.hibernate.includes('delete-storage'));assert.ok(!PHASES.hibernate.includes('delete-backups'));
 assert.ok(PHASES.hibernate.indexOf('verify-storage-retained')<PHASES.hibernate.indexOf('delete-compute'));
 assert.ok(PHASES.resize.indexOf('verify-ready')<PHASES.resize.indexOf('commit-package'));
 assert.ok(PHASES.resize.indexOf('commit-package')<PHASES.resize.indexOf('delete-old-compute'));
 assert.equal(nextPhase('hibernate','queued'),'quiesce');assert.equal(nextPhase('hibernate','complete'),'complete');
 assert.throws(()=>nextPhase('hibernate','delete-storage'));
});
test('deleted workspaces and malformed retry identifiers are rejected',()=>{
 assert.throws(()=>validateOperation({deleted_at:'now'},{action:'resume',requestKey}),/deleted/);
 assert.throws(()=>validateOperation({state:'stopped'},{action:'resume',requestKey:'same'}),/Invalid/);
 assert.throws(()=>validateOperation({state:'ready'},{action:'hibernate',requestKey}),/agents and jobs/);
});
