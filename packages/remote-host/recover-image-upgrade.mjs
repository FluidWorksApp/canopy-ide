#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {validateConfig,validId} from './policy.mjs';
import {safeDockerError} from './docker.mjs';
import {requireOfflineGateway} from './recover-migration.mjs';
import {readImageUpgrade,imageUpgradeJournal,recoverImageUpgrade} from './image-upgrade.mjs';
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const [configPath,directory,id,...extra]=process.argv.slice(2);
 if(!configPath||!directory||!validId(id)||extra.length){console.error('Usage: node recover-image-upgrade.mjs HOST_CONFIG IMAGE_JOURNAL_DIRECTORY WORKSPACE_ID');process.exitCode=2;}
 else try{
  if(process.platform!=='linux'||process.getuid?.()!==0)throw Error('Run on the trusted Linux host as root');
  const run=promisify(execFile);await requireOfflineGateway(run);
  const config=validateConfig(JSON.parse(await readFile(configPath,'utf8')));
  if(!config.workspaces.some(workspace=>workspace.id===id))throw Error('Workspace not configured');
  const record=await readImageUpgrade(directory,id);
  const docker=async args=>{try{return await run('docker',args,{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});}catch(error){throw safeDockerError(error,args[0]);}};
  await requireOfflineGateway(run);
  console.log(JSON.stringify(await recoverImageUpgrade(record,{docker,journal:imageUpgradeJournal(directory,id)})));
 }catch{console.error('Image recovery was not completed. Keep the gateway stopped and inspect the trusted journal and preserved containers.');process.exitCode=1;}
}
