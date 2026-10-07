// Replica only: stands in for `@aws-sdk/client-route-53`. The worker publishes
// and parks the workspace record exactly as in production; readiness and stop
// preparation pin the observed instance address, so nothing resolves these
// names. Records are kept for the harness report.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const FILE='/disks/route53-records.json';
const records=existsSync(FILE)?JSON.parse(readFileSync(FILE,'utf8')):{};
const persist=()=>writeFileSync(FILE,JSON.stringify(records,null,1));
class Command{constructor(input={}){this.input=input;}}
export class ChangeResourceRecordSetsCommand extends Command{}
export class ListResourceRecordSetsCommand extends Command{}
export class Route53Client{
 constructor(config={}){this.config=config;}
 async send(command){
  const input=command.input;
  if(input.HostedZoneId!==process.env.CANOPY_WORKSPACE_DNS_ZONE)throw Object.assign(new Error('No such hosted zone'),{name:'NoSuchHostedZone'});
  if(command instanceof ListResourceRecordSetsCommand){
   const names=Object.keys(records).sort().filter(name=>name>=input.StartRecordName+'.');
   return {ResourceRecordSets:names.slice(0,input.MaxItems??100).map(name=>records[name])};
  }
  if(command instanceof ChangeResourceRecordSetsCommand){
   for(const change of input.ChangeBatch.Changes){
    const set=change.ResourceRecordSet,name=set.Name.endsWith('.')?set.Name:set.Name+'.';
    if(change.Action==='UPSERT')records[name]={...set,Name:name};
    else if(change.Action==='DELETE'){if(!records[name])throw Object.assign(new Error('Record not found'),{name:'InvalidChangeBatch'});delete records[name];}
    console.log('[route53]',change.Action,name,set.ResourceRecords?.map(r=>r.Value).join(','));
   }
   persist();return {ChangeInfo:{Status:'INSYNC'}};
  }
  throw new Error(`${command.constructor.name} is not replicated`);
 }
 destroy(){}
}
