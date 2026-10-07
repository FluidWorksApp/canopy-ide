#!/usr/bin/env node
import {readFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validateConfig} from './policy.mjs';
import {DockerWorkspaces} from './docker.mjs';
import {readMigrationJournal,createMigrationJournal} from './migration-journal.mjs';
import {assessMigrationRecovery,rollbackMigration} from './migration-recovery.mjs';

export async function requireOfflineGateway(run){
 const {stdout}=await run('systemctl',['show','canopy-host.service','--property=ActiveState','--property=SubState','--property=UnitFileState','--property=MainPID','--property=LoadState'],{encoding:'utf8',timeout:15000});
 const state=Object.fromEntries(stdout.trim().split('\n').map(line=>line.split('=')));
 if(state.LoadState!=='masked'||state.ActiveState!=='inactive'||state.SubState!=='dead'||state.MainPID!=='0'||!['masked','masked-runtime'].includes(state.UnitFileState))throw Error('Stop and runtime-mask canopy-host.service before offline recovery');
}

// This command never stops the gateway itself, changes configuration, or starts
// the original container. A trusted operator establishes maintenance mode first.
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const [configPath,journalPath,stateDirectory,...extra]=process.argv.slice(2);
 if(!configPath||!journalPath||!stateDirectory||extra.length){
  console.error('Usage: node recover-migration.mjs HOST_CONFIG JOURNAL HOST_STATE');process.exitCode=2;
 }else{
  let journal;
  try{
   if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Run on the trusted Linux host as root');
   const run=promisify(execFile);
   await requireOfflineGateway(run);
   const readConfig=async()=>validateConfig(JSON.parse(await readFile(configPath,'utf8')));
   const config=await readConfig();
   const {records}=await readMigrationJournal(journalPath);
   const host=new DockerWorkspaces({secret:'offline-recovery-does-not-start-runtimes',registry:config.workspaces});
   const assessment=await assessMigrationRecovery({records,config,docker:host.docker});
   if(assessment.state!=='rollback-needed')throw Error('No automatic rollback is appropriate');
   const directory=join(stateDirectory,'recovery-'+randomUUID());
   await mkdir(directory,{mode:0o700});
   journal=await createMigrationJournal(directory,assessment.workspaceId);
   await requireOfflineGateway(run);
   const result=await rollbackMigration({records,readConfig,host,journal});
   await journal.close();journal=undefined;
   console.log(JSON.stringify({...result,recoveryJournalDirectory:directory}));
  }catch{
   await journal?.close().catch(()=>{});
   console.error('Recovery was not completed. Keep the gateway stopped and inspect the configuration, journals and preserved containers before retrying.');process.exitCode=1;
  }
 }
}
