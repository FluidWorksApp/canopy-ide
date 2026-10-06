#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readMigrationJournal} from './migration-journal.mjs';
import {assessMigrationRecovery} from './migration-recovery.mjs';
import {validateConfig} from './policy.mjs';
import {safeDockerError} from './docker.mjs';

const args=process.argv.slice(2);
if(args.length!==2){
 console.error('Usage: node inspect-migration.mjs HOST_CONFIG JOURNAL');
 process.exitCode=2;
}else{
 try{
  const config=validateConfig(JSON.parse(await readFile(args[0],'utf8')));
  const journal=await readMigrationJournal(args[1]);
  const run=promisify(execFile);
  const docker=async parameters=>{
   if(parameters[0]!=='inspect')throw Error('Recovery inspection is read-only');
   try{return await run('docker',parameters,{encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});}
   catch(error){throw safeDockerError(error,'inspect');}
  };
  const assessment=await assessMigrationRecovery({...journal,config,docker});
  console.log(JSON.stringify({...assessment,incompleteJournalTail:journal.incompleteTail},null,2));
 }catch{
  // Configuration and Docker errors can contain credentials. Preserve evidence
  // on disk for the operator rather than echoing arbitrary error payloads.
  console.error('Cannot establish safe migration recovery. Check the host configuration, journal and Docker container identities. No changes were made.');
  process.exitCode=1;
 }
}
