import {afterEach,beforeEach,expect,it,vi} from 'vitest';import {cleanup,render,screen} from '@testing-library/react';
const invoke=vi.hoisted(()=>vi.fn());vi.mock('@tauri-apps/api/core',()=>({invoke}));vi.mock('./AccountSettings',()=>({AccountSettings:()=>null}));
vi.mock('./LiveSessions',()=>({LiveSessions:({visible}:{visible?:boolean})=><section aria-label="Live now">{visible===false?'paused':'live'}</section>}));
import {TeamPanel} from './TeamPanel';
const directory={selfId:'me',teams:[{id:'team',name:'Engineering',role:'owner'}],invitations:[]};
beforeEach(()=>{window.dispatchEvent(new Event('canopy:account-changed'));invoke.mockReset();invoke.mockImplementation(async(_name:string,{body}:{body:{action?:string}|null})=>!body?directory:body.action==='detail'?{members:[],invitations:[]}:{});});
afterEach(cleanup);
const relayForm=()=>[screen.queryByText('Host address or link'),screen.queryByText('Reachable from'),screen.queryByPlaceholderText('7-digit code'),screen.queryByRole('button',{name:/Host a relay|join code|relay/i})];
it('signed in, the panel shows Live now under the team and no relay join form',async()=>{
 render(<TeamPanel/>);
 expect(await screen.findByRole('region',{name:'Live now'})).toHaveTextContent('live');
 expect(relayForm().every(el=>el===null)).toBe(true);
});
it('hidden behind another side tab, Live now stops polling',async()=>{
 render(<TeamPanel visible={false}/>);
 expect(await screen.findByRole('region',{name:'Live now'})).toHaveTextContent('paused');
});
it('signed out, it asks for a sign-in instead of offering sharing or a join code',async()=>{
 invoke.mockRejectedValue('unauthorized');
 render(<TeamPanel/>);
 expect(await screen.findByText('Sign in to share with your team.')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Sign in'})).toBeInTheDocument();
 expect(screen.queryByRole('region',{name:'Live now'})).toBeNull();
 expect(relayForm().every(el=>el===null)).toBe(true);
});

it('signed in with a relay, the panel has no share button and no address or code fields',async()=>{
 invoke.mockImplementation(async(_name:string,{route,body}:{route:string;body:{action?:string}|null})=>route==='/api/me'?{user:{id:'me',name:'Sam',email:'sam@coraa.ai'}}:!body?directory:body.action==='detail'?{members:[],invitations:[]}:{});
 const relay={status:{role:'off',code:null,port:null,ips:[],addr:null,self_id:null,name:null,visibility:null,public_ip:null,members:[]},chat:[],unread:{},inbox:[],transfers:[],hostStart:async()=>{},hostStop:async()=>{},connect:async()=>{},disconnect:async()=>{}} as never;
 render(<TeamPanel relay={relay}/>);
 await screen.findByRole('heading',{name:'Teams'});
 expect(screen.queryByRole('button',{name:'Share my desktop'})).toBeNull();
 expect(screen.queryByPlaceholderText('7-digit code')).toBeNull();
 expect(screen.queryByLabelText('Host address')).toBeNull();
});
