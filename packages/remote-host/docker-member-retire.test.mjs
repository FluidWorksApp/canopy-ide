import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {DockerWorkspaces} from './docker.mjs';
const parent='ws-a',memberId='vijay';
const stable='member-'+createHash('sha256').update(JSON.stringify([parent,memberId])).digest('hex').slice(0,40);
const current='member-'+'c'.repeat(40),old='member-'+'0'.repeat(40);
const runtime=id=>({Config:{Labels:{'canopy.workspace':id,'canopy.member-storage':stable}},Mounts:[{Destination:'/home/agent',Type:'volume',Name:`canopy-home-${stable}`}],State:{Running:false}});
function host(names){
 const calls=[];
 const workspaces=new DockerWorkspaces({secret:'synthetic',docker:async args=>{calls.push(args);
  if(args[0]==='ps')return {stdout:names.join('\n')+'\n'};
  if(args[0]==='inspect'){const id=args[1].slice('canopy-ws-'.length);if(!names.includes(args[1]))throw Object.assign(Error('missing'),{missingResource:true});return {stdout:JSON.stringify([runtime(id)])};}
  return {stdout:''};}});
 return {workspaces,calls};
}
test('retiring old member runtimes leaves an image upgrade\'s preserved container alone',async()=>{
 // After an image release: the old runtime, the upgrade's preserved copy of it, and its failed/recovery spellings.
 const preserved=[`canopy-previous-${old}-${'a'.repeat(12)}`,`canopy-previous-${old}-${'b'.repeat(12)}-failed`,`canopy-previous-${old}-${'c'.repeat(12)}-recovery-${'d'.repeat(12)}`];
 const {workspaces,calls}=host([`canopy-ws-${old}`,...preserved,`canopy-ws-${current}`]);
 await workspaces.retireMemberVersions({id:current,storageId:stable,parentWorkspaceId:parent,memberId});
 const removed=calls.filter(c=>c[0]==='rm').map(c=>c[1]);
 assert.deepEqual(removed,[`canopy-ws-${old}`]);
 assert.ok(!calls.some(c=>preserved.includes(c[c.length-1])&&c[0]!=='ps'),'preserved containers are never inspected, stopped or removed');
});
test('a genuinely unexpected name sharing the member storage still refuses',async()=>{
 const {workspaces}=host([`canopy-ws-${current}`,'someone-elses-container']);
 await assert.rejects(workspaces.retireMemberVersions({id:current,storageId:stable,parentWorkspaceId:parent,memberId}),/Unexpected member runtime name/);
});
