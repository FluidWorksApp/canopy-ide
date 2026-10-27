import {afterEach,describe,expect,it,vi} from 'vitest';
import {mockCommands} from './test/setup';
import {RESERVED_HANDLES,parseReadableLink,ensureReadableLink,copyReadableLink,openReadableLink,takePendingSession,SHOW_WORKSPACE_EVENT,SHARED_SESSION_FOCUS_EVENT,type ResolvedLink} from './readableLinks';
import {formatDeepLink,parseDeepLink} from './deepLinks';
import {readableLinkRows} from './spotSources';
// The control plane is the authority on link shapes; the app must agree.
import {RESERVED_HANDLES as SERVER_RESERVED,parseReadableUrl} from '../packages/control-plane/lib/readable-links.mjs';

afterEach(()=>window.dispatchEvent(new Event('canopy:account-changed')));

describe('parsing',()=>{
 it('reserves exactly what the control plane reserves',()=>{expect([...RESERVED_HANDLES]).toEqual([...SERVER_RESERVED]);});
 it('agrees with the control plane on every shape',()=>{
  for(const raw of ['https://canopyide.dev/acme/api','https://canopyide.dev/Acme/API/s/fix-login-27/','https://acme.canopyide.dev/t/general/quiet-otter-41','https://www.canopyide.dev/acme/t/dm/quiet-otter-41','http://canopyide.dev/acme/api','https://canopyide.dev/teams/x','https://canopyide.dev/acme','https://canopyide.dev/acme/s/x','https://canopyide.dev/acme/api/x/y','https://ws-1.workspaces.canopyide.dev/x','https://evil.dev/acme/api','https://canopyide.dev:444/acme/api']){
   const app=parseReadableLink(raw),server=parseReadableUrl(raw,'https://canopyide.dev');
   expect(app&&{namespace:app.namespace,path:app.path,kind:app.kind},raw).toEqual(server);
  }
 });
 it('canonicalises the URL it returns',()=>{expect(parseReadableLink(' https://acme.canopyide.dev/API ')?.url).toBe('https://canopyide.dev/acme/api');});
});

describe('copy link',()=>{
 it('asks once per thing and account, then answers from memory',async()=>{
  const calls:unknown[]=[];mockCommands({canopy_account_request:(args:Record<string,unknown>)=>{calls.push(args);return {link:{url:'https://canopyide.dev/acme/api'}};}});
  expect(await ensureReadableLink({kind:'workspace',workspaceId:'ws-1'})).toBe('https://canopyide.dev/acme/api');
  expect(await ensureReadableLink({kind:'workspace',workspaceId:'ws-1'})).toBe('https://canopyide.dev/acme/api');
  expect(calls).toEqual([{route:'/api/links',body:{action:'ensure',kind:'workspace',workspaceId:'ws-1'}}]);
  window.dispatchEvent(new Event('canopy:account-changed'));
  await ensureReadableLink({kind:'workspace',workspaceId:'ws-1'});expect(calls).toHaveLength(2);
 });
 it('puts the URL on the clipboard, and says to sign in when signed out',async()=>{
  mockCommands({canopy_account_request:()=>({link:{url:'https://canopyide.dev/acme/t/general/quiet-otter-41'}})});
  const write=vi.fn(async()=>true);
  expect(await copyReadableLink({kind:'message',teamId:'t',peer:null,messageId:'m'},write)).toBe('https://canopyide.dev/acme/t/general/quiet-otter-41');
  expect(write).toHaveBeenCalledWith('https://canopyide.dev/acme/t/general/quiet-otter-41');
  mockCommands({canopy_account_request:()=>{throw 'Unauthorized';}});
  await expect(copyReadableLink({kind:'workspace',workspaceId:'ws-2'},write)).rejects.toThrow('Sign in to Canopy to copy links.');
 });
 it('refuses a link the server returns in the wrong shape',async()=>{
  mockCommands({canopy_account_request:()=>({link:{url:'https://evil.dev/x/y'}})});
  await expect(ensureReadableLink({kind:'workspace',workspaceId:'ws-3'})).rejects.toThrow(/invalid link/);
 });
});

describe('opening',()=>{
 const resolved=(link:ResolvedLink)=>async()=>link;
 it('opens a workspace through the workspace switcher',async()=>{
  const events:Event[]=[];
  await openReadableLink('https://canopyide.dev/acme/api',{follow:vi.fn(),dispatch:e=>events.push(e),resolve:resolved({url:'https://canopyide.dev/acme/api',kind:'workspace',target:{workspaceId:'ws-1',name:'API'}})});
  expect(events.map(e=>[e.type,(e as CustomEvent).detail])).toEqual([[SHOW_WORKSPACE_EVENT,{workspaceId:'ws-1',connect:true}]]);
 });
 it('shows a shared session in its workspace and hands the panel the session',async()=>{
  const events:Event[]=[];
  await openReadableLink('https://canopyide.dev/acme/api/s/fix-27',{follow:vi.fn(),dispatch:e=>events.push(e),resolve:resolved({url:'https://canopyide.dev/acme/api/s/fix-27',kind:'session',target:{workspaceId:'ws-1',workspaceName:'API',projectId:'app',publicationId:'pub-1',title:'Fix'}})});
  expect(events.map(e=>e.type)).toEqual([SHOW_WORKSPACE_EVENT,SHARED_SESSION_FOCUS_EVENT]);
  expect(takePendingSession('ws-other')).toBeNull();expect(takePendingSession('ws-1')).toBe('pub-1');expect(takePendingSession('ws-1')).toBeNull();
 });
 it('opens a message in its conversation as the signed-in person',async()=>{
  const follow=vi.fn();
  await openReadableLink('https://canopyide.dev/acme/t/dm/quiet-otter-41',{follow,dispatch:vi.fn(),resolve:resolved({url:'https://canopyide.dev/acme/t/dm/quiet-otter-41',kind:'message',target:{teamId:'team',teamName:'Acme',peer:'bob',peerName:'Bob',messageId:'m1',viewer:'alice'}})});
  expect(follow).toHaveBeenCalledWith({kind:'chat',peer:'bob',team:'team',account:'alice',name:'Bob',message:'m1'});
 });
 it('explains a revoked or inaccessible link without opening anything',async()=>{
  const dispatch=vi.fn();
  await expect(openReadableLink('https://canopyide.dev/acme/api',{follow:vi.fn(),dispatch,resolve:async()=>{throw 'Link not found';}})).rejects.toThrow("your account can't open it");
  await expect(openReadableLink('https://canopyide.dev/acme/api',{follow:vi.fn(),dispatch,resolve:async()=>{throw 'This link was revoked';}})).rejects.toThrow('revoked');
  await expect(openReadableLink('https://example.com/acme/api',{follow:vi.fn(),dispatch})).rejects.toThrow('not a Canopy link');
  expect(dispatch).not.toHaveBeenCalled();
 });
});

describe('entry points',()=>{
 it('a readable URL is a deep link as-is and as canopy://link',()=>{
  expect(parseDeepLink('https://canopyide.dev/Acme/api')).toEqual({kind:'link',url:'https://canopyide.dev/acme/api'});
  const formatted=formatDeepLink({kind:'link',url:'https://canopyide.dev/acme/api/s/fix-27'});
  expect(formatted).toBe('canopy://link?url=https%3A%2F%2Fcanopyide.dev%2Facme%2Fapi%2Fs%2Ffix-27');
  expect(parseDeepLink(formatted)).toEqual({kind:'link',url:'https://canopyide.dev/acme/api/s/fix-27'});
  expect(parseDeepLink('canopy://link?url=https%3A%2F%2Fevil.dev%2Fa%2Fb')).toBeNull();
 });
 it('a chat deep link carries the message to focus',()=>{
  const link=parseDeepLink(formatDeepLink({kind:'chat',peer:null,team:'t',account:'a',name:'Acme',message:'m1'}));
  expect(link).toEqual({kind:'chat',peer:null,team:'t',account:'a',name:'Acme',message:'m1'});
 });
 it('SpotSearch offers to open a pasted link',()=>{
  expect(readableLinkRows('quiet otter')).toEqual([]);
  const [row]=readableLinkRows('https://canopyide.dev/acme/api/s/fix-27');
  expect(row).toMatchObject({group:'Canopy link',title:'Open shared session',detail:'canopyide.dev/acme/api/s/fix-27'});
  const seen=vi.fn();window.addEventListener('canopy:follow-deep-link',seen);
  if(row.action.type==='custom')void row.action.run();
  expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({url:'https://canopyide.dev/acme/api/s/fix-27'});
  window.removeEventListener('canopy:follow-deep-link',seen);
 });
});

describe('links in text',()=>{
 it('a readable link clicked in chat is followed in the app, not the browser',async()=>{
  const {openLink}=await import('./links');
  const seen=vi.fn();window.addEventListener('canopy:follow-deep-link',seen);
  openLink('https://canopyide.dev/acme/t/general/quiet-otter-41');
  expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({url:'https://canopyide.dev/acme/t/general/quiet-otter-41'});
  window.removeEventListener('canopy:follow-deep-link',seen);
 });
});
