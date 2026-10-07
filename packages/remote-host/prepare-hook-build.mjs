// Stage only the helper's reviewed sources, never the working tree or secrets.
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const repository=path.resolve(here,'../..');
const destination=process.argv[2]?path.resolve(process.argv[2]):path.join(here,'hook-build');
const files=['src-tauri/src/bin/canopy_hook.rs','src-tauri/src/agent_instructions.rs','src-tauri/src/agent_life.rs','shared/agentLife/fidelity.json','shared/agentLife/policy.json','shared/agentLife/fixtures.json','packages/agent-hook/Cargo.toml','packages/agent-hook/Cargo.lock'];
for(const file of files){const target=path.join(destination,file);await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(repository,file),target);}
// Record exact input content for reviewable deployment bundles.
await writeFile(path.join(destination,'sources.json'),JSON.stringify(files));
