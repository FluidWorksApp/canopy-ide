#!/usr/bin/env node
// Tells release.yml whether a tag changes what workspace hosts run.
//
// Every version bump registers a new host release, because a host release is
// named by its commit. Activating one when only the app changed rolls a host
// out to workspaces for nothing, so the host is compared by its inputs instead:
// the files workspace-image.yml builds from, with version numbers ignored.
//
//   unchanged <tag>
//     Exits 0 when the tag's host inputs match the previous v* tag's. Exits
//     non-zero otherwise, including on any error, so the caller activates.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const WORKFLOW='.github/workflows/workspace-image.yml';
const git=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:256*1024*1024});

/** The `paths:` filter of the workflow's push trigger. */
export function hostPaths(workflow){
 const lines=workflow.split('\n'),start=lines.findIndex(line=>line.trim()==='paths:');
 if(start<0)throw Error(`${WORKFLOW} has no paths filter`);
 const paths=[];
 for(const line of lines.slice(start+1)){
  const text=line.trim();
  if(text.startsWith('#'))continue;
  const entry=/^- '?([^']+)'?$/.exec(text);
  if(!entry)break;
  paths.push(entry[1]);
 }
 if(!paths.length)throw Error(`${WORKFLOW} lists no paths`);
 return paths;
}

const escape=text=>text.replace(/[.+^${}()|[\]\\]/g,'\\$&');
export function pathMatcher(paths){
 const patterns=paths.map(path=>new RegExp(`^${escape(path).replace(/\*\*/g,'\0').replace(/\*/g,'[^/]*').replace(/\0/g,'.*')}$`));
 return file=>patterns.some(pattern=>pattern.test(file));
}

/** Drops the app's version, the one thing a bump changes in these files. */
export function withoutAppVersion(file,text){
 if(file==='package.json'){const {version:_,...rest}=JSON.parse(text);return JSON.stringify(rest);}
 if(file.endsWith('Cargo.lock'))return text.replace(/(\[\[package\]\]\nname = "canopy"\n)version = "[^"]+"\n/,'$1');
 return text;
}

export function fingerprint(revision,paths,cwd){
 const matches=pathMatcher(paths),hash=createHash('sha256');
 const entries=git(['ls-tree','-r',revision],cwd).split('\n').filter(Boolean).map(line=>{
  const [meta,file]=line.split('\t');return {file,mode:meta.split(' ')[0],blob:meta.split(' ')[2]};
 }).filter(entry=>matches(entry.file)).sort((a,b)=>a.file<b.file?-1:1);
 if(!entries.length)throw Error(`No host inputs at ${revision}`);
 for(const {file,mode,blob} of entries){
  const versioned=file==='package.json'||file.endsWith('Cargo.lock');
  const content=versioned?createHash('sha256').update(withoutAppVersion(file,git(['show',`${revision}:${file}`],cwd))).digest('hex'):blob;
  hash.update(`${mode} ${file} ${content}\n`);
 }
 return hash.digest('hex');
}

/** The newest release tag behind this one. */
export function previousTag(tag,cwd){
 const tags=git(['tag','--merged',tag,'--list','v*','--sort=-v:refname'],cwd).split('\n').filter(name=>/^v\d+\.\d+\.\d+$/.test(name));
 return tags.find(name=>name!==tag)??null;
}

export function hostUnchanged(tag,cwd){
 const previous=previousTag(tag,cwd);
 if(!previous)return {unchanged:false,previous};
 const paths=hostPaths(git(['show',`${tag}:${WORKFLOW}`],cwd));
 return {unchanged:fingerprint(tag,paths,cwd)===fingerprint(previous,paths,cwd),previous};
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const [command,tag]=process.argv.slice(2);
 if(command!=='unchanged'||!tag){console.error('Usage: workspace-host-fingerprint.mjs unchanged <tag>');process.exit(2);}
 const {unchanged,previous}=hostUnchanged(tag);
 console.log(`${tag} host inputs ${unchanged?'match':'differ from'} ${previous??'no previous tag'}`);
 process.exit(unchanged?0:1);
}
