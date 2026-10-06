import {mkdir,cp} from 'node:fs/promises';
const target=new URL('./chrome-stream/',import.meta.url);await mkdir(target,{recursive:true});
for(const file of ['server.mjs','playwright.mjs','protocol.mjs','viewer.html','viewer.js'])await cp(new URL('../chrome-stream/'+file,import.meta.url),new URL(file,target));
await cp(new URL('../../src-tauri/src/preview_picker.js',import.meta.url),new URL('preview_picker.js',target));
