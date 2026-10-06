import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {installMcp,mcpStatus} from './agent-mcp.mjs';
test('MCP registration preserves account configuration and rejects foreign names or invalid TOML',async()=>{const home=await mkdtemp(path.join(os.tmpdir(),'canopy-mcp-'));try{
 await mkdir(home+'/.claude');await mkdir(home+'/.codex');const helper='/usr/local/bin/canopy-hook';
 const claude=home+'/.claude/.claude.json';await writeFile(claude,JSON.stringify({oauthAccount:{emailAddress:'synthetic@example.com'},mcpServers:{other:{command:'other'}}}));
 await installMcp(home,'claude',helper);assert.equal(await mcpStatus(home,'claude',helper),'ours');assert.equal(JSON.parse(await readFile(claude,'utf8')).oauthAccount.emailAddress,'synthetic@example.com');
 const codex=home+'/.codex/config.toml';await writeFile(codex,'model = "test"\n');await installMcp(home,'codex',helper);assert.equal(await mcpStatus(home,'codex',helper),'ours');const installed=await readFile(codex,'utf8');await installMcp(home,'codex',helper);assert.equal(await readFile(codex,'utf8'),installed);
 const foreign='[mcp_servers.canopy]\ncommand = "someone-else"\n';await writeFile(codex,foreign);await assert.rejects(installMcp(home,'codex',helper),/preserved/);assert.equal(await readFile(codex,'utf8'),foreign);
 await writeFile(codex,'broken = [');await assert.rejects(installMcp(home,'codex',helper),/preserved/);assert.equal(await readFile(codex,'utf8'),'broken = [');
 }finally{await rm(home,{recursive:true,force:true});}});
