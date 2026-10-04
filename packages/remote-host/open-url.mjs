#!/usr/bin/env node
// Browser requests belong to the account/session that produced them. The IDE
// retrieves them over its authenticated workspace connection; no public ports.
import {mkdir,readdir,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const raw=process.argv.slice(2).find(v=>/^https?:\/\//i.test(v));
if(!raw||raw.length>8192)process.exit(1);
const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)process.exit(1);
const dir=(process.env.CANOPY_BROWSER_QUEUE||((process.env.HOME||'/home/agent')+'/.canopy/browser-requests'));
await mkdir(dir,{recursive:true,mode:0o700});if((await readdir(dir)).length>=32)process.exit(1);
const id=randomUUID(),tmp=dir+'/'+id+'.next';await writeFile(tmp,JSON.stringify({url:raw,createdAt:Date.now()}),{mode:0o600,flag:'wx'});await rename(tmp,dir+'/'+id+'.json');
