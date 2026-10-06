// Owner checkpoints retain the container's writable layer (installed packages
// and files outside volumes). They are pinned by image ID and never used for a
// member runtime. Original containers and all volumes remain untouched.
export async function checkpointOwner(workspace,{docker}){
 if(workspace.memberId||workspace.parentWorkspaceId||typeof workspace.id!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(workspace.id))throw Error('Invalid owner checkpoint');
 const name='canopy-ws-'+workspace.id;
 const current=JSON.parse((await docker(['inspect',name])).stdout)[0];
 if(current?.Config?.Labels?.['canopy.workspace']!==workspace.id||current.State?.Running!==false)throw Error('Stop the owning workspace before checkpointing');
 const result=await docker(['commit','--pause=false','--change',`LABEL canopy.owner-checkpoint=${workspace.id}`,name]);
 const ids=result.stdout.split(/\r?\n/).map(line=>line.trim()).filter(line=>/^sha256:[a-f0-9]{64}$/.test(line));
 if(ids.length!==1)throw Error('Invalid checkpoint image');
 const image=ids[0];
 const saved=JSON.parse((await docker(['image','inspect',image])).stdout)[0];
 if(saved?.Id!==image||saved.Config?.Labels?.['canopy.owner-checkpoint']!==workspace.id)throw Error('Owner checkpoint verification failed');
 return {ownerImage:image,originalContainerId:current.Id};
}
