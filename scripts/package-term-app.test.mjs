import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assetName,bundleId,infoPlist,readme,sha256Line,parseArgs,packageTermApp,MAC_TARGET,LINUX_TARGET} from './package-term-app.mjs';
import {TERMINAL_ASSETS,checkSha256File} from './release-assets.mjs';

const conf=JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
const meta={identifier:conf.identifier,minimumSystemVersion:conf.bundle.macOS.minimumSystemVersion,copyright:conf.bundle.copyright};

test('asset names are exactly the ones the release gate requires',()=>{
 assert.deepEqual([assetName(MAC_TARGET),assetName(LINUX_TARGET)],TERMINAL_ASSETS);
 for(const t of ['x86_64-pc-windows-msvc','x86_64-apple-darwin','aarch64-unknown-linux-gnu'])assert.throws(()=>assetName(t),/no standalone terminal download/);
});

test('the bundle id is a sibling of the app\'s and the plist names the app, the executable and the version',()=>{
 assert.equal(bundleId('app.causeconnect.canopy'),'app.causeconnect.canopy.terminal');
 const plist=infoPlist({version:'0.5.15',...meta});
 const value=k=>new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
 assert.equal(value('CFBundleIdentifier'),conf.identifier+'.terminal');
 assert.notEqual(value('CFBundleIdentifier'),conf.identifier);
 assert.equal(value('CFBundleName'),'Canopy Terminal');
 assert.equal(value('CFBundleDisplayName'),'Canopy Terminal');
 assert.equal(value('CFBundleExecutable'),'canopy-term-app');
 assert.equal(value('CFBundleIconFile'),'icon');
 assert.equal(value('CFBundleShortVersionString'),'0.5.15');
 assert.equal(value('CFBundleVersion'),'0.5.15');
 assert.equal(value('CFBundlePackageType'),'APPL');
 assert.equal(value('LSMinimumSystemVersion'),conf.bundle.macOS.minimumSystemVersion);
 assert.match(plist,/<key>NSHighResolutionCapable<\/key>\s*<true\/>/);
 assert.throws(()=>infoPlist({version:'0.5',...meta}),/invalid version/);
 // Escaped, so a copyright line cannot break the XML.
 assert.match(infoPlist({version:'1.2.3',...meta,copyright:'A & B <c>'}),/A &amp; B &lt;c&gt;/);
});

test('the icon the bundle copies exists and the entitlement files are the empty ones',()=>{
 assert.ok(statSync(new URL('../src-tauri/icons/icon.icns',import.meta.url)).size>0);
 for(const f of ['term-app-entitlements.plist','pty-host-entitlements.plist'])assert.ok(!/<key>/.test(readFileSync(new URL('../src-tauri/'+f,import.meta.url),'utf8').replace(/<!--[\s\S]*?-->/g,'')),f);
});

test('the checksum line is what the release gate accepts and what shasum reads',()=>{
 const line=sha256Line(Buffer.from('x'),TERMINAL_ASSETS[1]);
 assert.match(line,/^[a-f0-9]{64}  Canopy-Terminal-linux-x86_64\.tar\.gz\n$/);
 const digest='sha256:'+line.slice(0,64);
 assert.doesNotThrow(()=>checkSha256File(line,TERMINAL_ASSETS[1],digest));
});

test('the readme tells each platform how to start and how the IDE is shared with',()=>{
 const mac=readme({version:'0.5.15',os:'macos'}),linux=readme({version:'0.5.15',os:'linux'});
 assert.match(mac,/Open "Canopy Terminal\.app"/);assert.match(linux,/Run \.\/canopy-term-app/);
 for(const r of [mac,linux]){assert.match(r,/0\.5\.15/);assert.match(r,/host\.sock/);assert.match(r,/--socket/);}
});

test('arguments are validated and signing needs its secrets',()=>{
 assert.throws(()=>parseArgs(['--target',MAC_TARGET]),/required/);
 assert.throws(()=>parseArgs(['--bogus']),/unknown argument/);
 assert.throws(()=>parseArgs(['--target']),/needs a value/);
 const base=['--target',MAC_TARGET,'--version','0.5.15','--term-app','a','--host','b','--out','o'];
 const o=parseArgs(base);assert.equal(o.termApp,'a');assert.equal(o.sign,false);assert.equal(o.notarize,false);
 const n=parseArgs([...base,'--notarize']);assert.ok(n.sign&&n.notarize);
 assert.throws(()=>packageTermApp({...o,sign:true},{}),/APPLE_SIGNING_IDENTITY/);
 assert.throws(()=>packageTermApp({...o,sign:true,notarize:true},{APPLE_SIGNING_IDENTITY:'x'}),/APPLE_ID/);
 assert.throws(()=>packageTermApp({...o,target:LINUX_TARGET,sign:true},{APPLE_SIGNING_IDENTITY:'x'}),/only the macOS app/);
});

const fixture=()=>{const d=mkdtempSync(join(tmpdir(),'pkg-term-test-'));writeFileSync(join(d,'app'),'#!/bin/sh\necho app\n');writeFileSync(join(d,'host'),'#!/bin/sh\necho host\n');return d;};

test('a missing or empty binary stops the packaging',()=>{
 const d=fixture();try{
  writeFileSync(join(d,'empty'),'');
  const o={target:LINUX_TARGET,version:'0.5.15',termApp:join(d,'empty'),host:join(d,'host'),out:join(d,'out'),sign:false,notarize:false};
  assert.throws(()=>packageTermApp(o,{}),/missing or empty/);
  assert.throws(()=>packageTermApp({...o,termApp:join(d,'nope')},{}),/missing or empty/);
 }finally{rmSync(d,{recursive:true,force:true});}
});

test('the Linux tar.gz holds both programs, a readme and the license, with a matching checksum',()=>{
 const d=fixture();try{
  const {asset,sum}=packageTermApp({target:LINUX_TARGET,version:'0.5.15',termApp:join(d,'app'),host:join(d,'host'),out:join(d,'out'),sign:false,notarize:false},{});
  assert.equal(asset,join(d,'out',TERMINAL_ASSETS[1]));
  const list=execFileSync('tar',['-tzf',asset],{encoding:'utf8'}).split('\n').filter(Boolean).sort();
  const dir='canopy-terminal-0.5.15-linux-x86_64/';
  assert.deepEqual(list.filter(n=>!n.endsWith('/')),['canopy-pty-host','canopy-term-app','LICENSE.md','README.txt'].map(n=>dir+n).sort());
  const text=readFileSync(sum,'utf8');
  const bytes=readFileSync(asset);
  checkSha256File(text,TERMINAL_ASSETS[1],'sha256:'+text.slice(0,64));
  assert.equal(text,sha256Line(bytes,TERMINAL_ASSETS[1]));
 }finally{rmSync(d,{recursive:true,force:true});}
});

test('the unsigned macOS zip (dry run) holds the .app with both programs and says it is unsigned',{skip:process.platform!=='darwin'},()=>{
 const d=fixture();try{
  const logs=[];const orig=console.log;console.log=(...a)=>logs.push(a.join(' '));
  let r;try{r=packageTermApp({target:MAC_TARGET,version:'0.5.15',termApp:join(d,'app'),host:join(d,'host'),out:join(d,'out'),sign:false,notarize:false},{});}finally{console.log=orig;}
  assert.ok(logs.some(l=>/UNSIGNED/.test(l))&&logs.some(l=>/notarization skipped/.test(l)));
  const x=join(d,'x');execFileSync('ditto',['-x','-k',r.asset,x]);
  assert.deepEqual(readdirSync(x),['Canopy Terminal.app']);
  const app=join(x,'Canopy Terminal.app','Contents');
  assert.ok(existsSync(join(app,'Info.plist'))&&existsSync(join(app,'Resources','icon.icns')));
  for(const n of ['canopy-term-app','canopy-pty-host'])assert.equal(statSync(join(app,'MacOS',n)).mode&0o111,0o111);
  execFileSync('plutil',['-lint',join(app,'Info.plist')],{stdio:'pipe'});
 }finally{rmSync(d,{recursive:true,force:true});}
});
