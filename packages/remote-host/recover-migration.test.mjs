import test from 'node:test';import assert from 'node:assert/strict';
import {requireOfflineGateway} from './recover-migration.mjs';
test('offline recovery requires an inactive masked gateway with no running process',async()=>{
 const good={LoadState:'masked',ActiveState:'inactive',SubState:'dead',MainPID:'0',UnitFileState:'masked-runtime'};
 const run=value=>async()=>({stdout:Object.entries(value).map(([k,v])=>`${k}=${v}`).join('\n')});
 await requireOfflineGateway(run(good));
 for(const patch of [{LoadState:'loaded'},{ActiveState:'active'},{SubState:'running'},{MainPID:'123'},{UnitFileState:'enabled'},{UnitFileState:'disabled'},{ActiveState:undefined}])await assert.rejects(requireOfflineGateway(run({...good,...patch})),/runtime-mask/);
 await assert.rejects(requireOfflineGateway(async()=>{throw Error('systemctl failed');}));
});
