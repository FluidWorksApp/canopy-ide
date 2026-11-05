import {mkdir,cp} from 'node:fs/promises';
// The agent browser injects the same picker the desktop preview does.
const target=new URL('./browser-assets/',import.meta.url);await mkdir(target,{recursive:true});
await cp(new URL('../../src-tauri/src/preview_picker.js',import.meta.url),new URL('preview_picker.js',target));
