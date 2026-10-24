import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {LOCK,validateLock,bump,sourceUrl} from './agents-lock.mjs';

const lock=JSON.parse(await readFile(LOCK,'utf8'));
const sha=character=>character.repeat(128);
const archive={kind:'archive',version:'1.0.0',format:'tar.gz',strip:1,bin:{tool:'tool'},platforms:{amd64:{url:'https://example.com/{version}/x64.tar.gz',sha512:sha('a')},arm64:{url:'https://example.com/{version}/arm64.tar.gz',sha512:sha('b')}}};

test('every workspace tool is pinned to an immutable, checksummed source',()=>{
 assert.deepEqual(validateLock(lock),[]);
});

test('the image installs exactly the locked tools, one layer each, in lock order',async()=>{
 const dockerfile=await readFile(new URL('./Dockerfile',import.meta.url),'utf8');
 const layers=[...dockerfile.matchAll(/^RUN bash \/usr\/local\/lib\/canopy\/install-agents\.sh \/tmp\/locks\/([a-z0-9-]+)\.json$/gm)].map(match=>match[1]);
 assert.deepEqual(layers,Object.keys(lock));
 for(const name of layers)assert.match(dockerfile,new RegExp(`^COPY --from=agent-locks /locks/${name}\\.json /tmp/locks/\\nRUN `,'m'));
 assert.match(dockerfile,/install-agents\.sh verify \/tmp\/locks\/all\.json/);
 assert.doesNotMatch(dockerfile,/^RUN npm install -g/m,'install npm tools through the lock');
});

test('the installer branches on kind, never on a tool name',async()=>{
 const script=new URL('./install-agents.sh',import.meta.url).pathname;
 execFileSync('bash',['-n',script]);
 const source=await readFile(script,'utf8');
 for(const name of Object.keys(lock))assert.doesNotMatch(source,new RegExp(`(^|[^a-z-])${name}([^a-z-]|$)`,'m'),`install-agents.sh names ${name}`);
});

test('a mutable installer or an unchecked download cannot be pinned',()=>{
 assert.deepEqual(validateLock({tool:archive}),[]);
 const broken=(change)=>validateLock({tool:{...archive,...change}}).join('\n');
 assert.match(broken({platforms:{...archive.platforms,amd64:{url:'https://example.com/install',sha512:sha('a')}}}),/must contain \{version\}/);
 assert.match(broken({platforms:{...archive.platforms,arm64:{url:archive.platforms.arm64.url}}}),/arm64 needs a sha512/);
 assert.match(broken({platforms:{amd64:archive.platforms.amd64}}),/platforms must be exactly/);
 assert.match(broken({platforms:{...archive.platforms,amd64:{...archive.platforms.amd64,url:'http://example.com/{version}'}}}),/must be https/);
 assert.match(broken({installer:'https://example.com/install.sh'}),/unexpected field installer/);
 assert.match(broken({version:'latest'}),/exact version/);
 assert.match(broken({bin:{tool:'../../usr/bin/tool'}}),/inside the package/);
 assert.match(validateLock({tool:{kind:'script',version:'1'}}).join(),/unknown kind/);
 assert.match(validateLock({tool:{kind:'npm',package:'a',version:'1.0.0',bin:['a','b'],lazy:true}}).join(),/lazy installs exactly one/);
});

test('bump pins a new version with freshly fetched checksums for every platform',async()=>{
 const fetched=[];
 const updated=await bump({tool:archive},'tool','2.0.0',{hash:async url=>{fetched.push(url);return sha('c');}});
 assert.deepEqual(fetched.sort(),['https://example.com/2.0.0/arm64.tar.gz','https://example.com/2.0.0/x64.tar.gz']);
 assert.equal(updated.tool.version,'2.0.0');
 assert.equal(updated.tool.platforms.amd64.sha512,sha('c'));
 assert.equal(sourceUrl(updated.tool,'arm64'),'https://example.com/2.0.0/arm64.tar.gz');
 const npm={kind:'npm',package:'pkg',version:'1.0.0',bin:['pkg']};
 assert.equal((await bump({npm},'npm','1.1.0',{exists:async()=>true})).npm.version,'1.1.0');
 await assert.rejects(bump({npm},'npm','9.9.9',{exists:async()=>false}),/not published/);
 await assert.rejects(bump({npm},'missing','1.0.0'),/No tool missing/);
});
