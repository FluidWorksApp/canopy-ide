import {lstat,realpath,readdir,mkdir,cp,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

function relative(value){
 return typeof value==='string'&&value.length<=1024&&(value==='.'||value.length>0&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'))&&!/[\\\x00-\x1f]/.test(value);
}
export function validateMigrationComponents(components){
 if(!Array.isArray(components)||!components.length||components.length>64)throw Error('Invalid migration components');
 const ids=new Set(),targets=[];
 for(const component of components){
  if(!component||typeof component.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(component.id)||ids.has(component.id)||
     typeof component.label!=='string'||!component.label.trim()||component.label.length>200||/[\x00-\x1f]/.test(component.label)||
     !relative(component.source)||!relative(component.relativePath))throw Error('Invalid migration component');
  ids.add(component.id);
  const target=component.relativePath;
  if(targets.some(other=>target==='.'||other==='.'||target===other||target.startsWith(other+'/')||other.startsWith(target+'/')))throw Error('Overlapping migration destinations');
  targets.push(target);
 }
 return components;
}

// Called inside a disposable helper with only the old project volume mounted
// read-only and the new project volume mounted writable. Publication is one
// rename; originals are never removed, and failed copies remain unpublished.
export async function copyProjectComponents({sourceRoot,destinationRoot,components}){
 validateMigrationComponents(components);
 const source=await realpath(sourceRoot),destination=await realpath(destinationRoot);
 if(source===destination||destination.startsWith(source+path.sep)||source.startsWith(destination+path.sep))throw Error('Migration roots must be separate');
 if((await readdir(destination)).length)throw Error('Migration destination is not empty');
 const resolved=[];
 for(const component of components){
  const from=await realpath(path.join(source,component.source));
  if(from!==source&&!from.startsWith(source+path.sep))throw Error('Component leaves source volume');
  if(!(await lstat(from)).isDirectory())throw Error('Component is not a directory');
  resolved.push({...component,from});
 }
 const staging=path.join(destination,'.canopy-migration-'+randomUUID());
 await mkdir(staging,{mode:0o700});
 const content=path.join(staging,'content');
 try{
  for(const component of resolved){
   const to=component.relativePath==='.'?content:path.join(content,component.relativePath);
   await cp(component.from,to,{recursive:true,dereference:false,verbatimSymlinks:true,preserveTimestamps:true,errorOnExist:true,force:false});
  }
  await rename(content,path.join(destination,'content'));
  await rm(staging,{recursive:true,force:true});
 }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
 return components.map(({id,label,relativePath})=>({id,label,relativePath:relativePath==='.'?'content':'content/'+relativePath}));
}
