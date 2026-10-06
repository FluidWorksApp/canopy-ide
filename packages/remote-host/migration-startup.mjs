import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {readMigrationJournal} from './migration-journal.mjs';
import {assessMigrationRecovery} from './migration-recovery.mjs';

// Run before accepting requests. Durable journals, not process-local flags,
// decide whether an interrupted replacement may be opened after a host restart.
export async function quarantineInterruptedMigrations({directory,config,host}) {
 let names;
 try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const blocked=[];
 for(const name of names.filter(name=>name.endsWith('.migration.jsonl')).sort()){
  const match=/^([a-z][a-z0-9-]{0,47})\.migration\.jsonl$/.exec(name);
  if(!match)throw Error('Invalid migration journal name');
  const id=match[1];
  if(!config.workspaces.some(workspace=>workspace.id===id))throw Error('Migration journal workspace is missing');
  // Set quarantine first: malformed records or Docker inspection failures must
  // never accidentally permit access if the caller handles a startup error.
  host.migrationCleanupRequired.add(id);
  const {records,incompleteTail}=await readMigrationJournal(join(directory,name));
  if(records[0].workspaceId!==id)throw Error('Migration journal identity differs');
  const final=records.at(-1).phase;
  const assessment=await assessMigrationRecovery({records,config,docker:host.docker});
  const complete=!incompleteTail&&(
   (final==='committed'&&assessment.state==='published')||
   (final==='rolled-back'&&assessment.state==='original-restored')
  );
  if(complete)host.migrationCleanupRequired.delete(id);
  else blocked.push(id);
 }
 return blocked;
}
