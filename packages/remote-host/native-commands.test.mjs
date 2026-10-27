import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeInvoke,NATIVE_FAMILIES} from './native.mjs';
import {HOST_PROTOCOL,NATIVE_COMMANDS,isNativeCommand} from './native-commands.mjs';
import {READ_ONLY_NATIVE} from './readonly-native.mjs';

// What native.mjs dispatches on by name, read from its source: the desktop
// trusts NATIVE_COMMANDS to mean "a current host answers this".
async function dispatched(){
 const source=await readFile(new URL('./native.mjs',import.meta.url),'utf8');const names=new Set(Object.keys(NATIVE_FAMILIES));
 for(const match of source.matchAll(/command===?'([a-z_0-9]+)'/g))names.add(match[1]);
 for(const match of source.matchAll(/\[((?:'[a-z_0-9]+',?)+)\]\.includes\(command\)/g))for(const name of match[1].matchAll(/'([a-z_0-9]+)'/g))names.add(name[1]);
 return names;
}
test('the shared command list is exactly what this host dispatches',async()=>{
 const names=await dispatched();
 assert.deepEqual([...names].filter(name=>!NATIVE_COMMANDS.has(name)).sort(),[],'handled by native.mjs but missing from native-commands.mjs');
 assert.deepEqual([...NATIVE_COMMANDS].filter(name=>!names.has(name)).sort(),[],'listed in native-commands.mjs but not handled');
});
test('view-only commands are all commands this host serves',()=>{
 assert.deepEqual([...READ_ONLY_NATIVE].filter(name=>!isNativeCommand(name)),[]);
});
test('host capabilities report the protocol and the command list',async()=>{
 const capabilities=await nativeInvoke('host_capabilities');
 assert.equal(capabilities.protocol,HOST_PROTOCOL);assert.ok(capabilities.commands.includes('git_status'));assert.ok(capabilities.prefixes.includes('claude_ide_'));
 assert.equal(isNativeCommand('fs_upload_begin'),true);assert.equal(isNativeCommand('vault_list'),false);
});
