import {loadChatHistory,saveChatMessage,loadChatReadState,saveChatReadState} from './history';
import {invoke} from '@tauri-apps/api/core';
import {PeerClient,type ChatMessage} from './client';

type Snapshot={unreadIds:string[];restoredIds:string[];members:Record<string,string>;messages:ChatMessage[];receipts:Record<string,string[]>;status:string};
// One transport per account/team, shared by all conversation tabs in this IDE.
const sessions=new Map<string,TeamSession>();
const unreadListeners=new Set<()=>void>();
export const subscribeTeamUnread=(listener:()=>void)=>{unreadListeners.add(listener);return()=>{unreadListeners.delete(listener);};};
export const getTeamUnread=()=>[...sessions.values()].reduce((sum,session)=>sum+session.getSnapshot().unreadIds.length,0);
export class TeamSession {
 private listeners=new Set<()=>void>();
 private client:PeerClient;
 private refs=0;
 private invalid=false;
 private releaseGeneration=0;
 private snapshot:Snapshot={unreadIds:[],restoredIds:[],members:{},messages:[],receipts:{},status:'Connecting securely…'};
 readonly team:string;
 readonly user:string;
 constructor(team:string,user:string){
  this.team=team;this.user=user;
  this.client=new PeerClient({team,user,request:body=>invoke('canopy_account_request',{route:'/api/peers',body}),
   persist:message=>saveChatMessage(this.user,this.team,message),
   members:members=>this.update({members:Object.fromEntries(members.map(m=>[m.id,m.name]))}),
   message:message=>{if(this.invalid)return;this.update({unreadIds:message.sender!==this.user&&!this.snapshot.messages.some(m=>m.id===message.id)?[...this.snapshot.unreadIds.slice(-499),message.id]:this.snapshot.unreadIds,messages:this.snapshot.messages.some(m=>m.id===message.id)?this.snapshot.messages:[...this.snapshot.messages.slice(-499),message]});this.persistReadState();},
   receipt:(id,user)=>{if(this.invalid||!this.snapshot.messages.some(m=>m.id===id))return;this.update({receipts:{...this.snapshot.receipts,[id]:[...new Set([...(this.snapshot.receipts[id]??[]),user])].slice(-512)}});this.persistReadState();},
   status:status=>this.update({status})});
 }
 private async start(){
  try{const account=await invoke<{user:{id:string}}>('canopy_account_request',{route:'/api/me',body:null});if(this.invalid)return;if(account.user?.id!==this.user){this.clear('Sign in to the account that owns this conversation.');return;}}catch{this.clear('Sign in to restore this conversation.');return;}
  try{const history=await loadChatHistory(this.user,this.team);if(this.invalid)return;const state=await loadChatReadState(this.user,this.team).catch(()=>{this.update({status:'Local read status could not be restored.'});return {unreadIds:history.filter(m=>m.sender!==this.user).map(m=>m.id),receipts:{}};});if(this.invalid)return;const ids=new Set(history.map(m=>m.id));this.update({messages:history,restoredIds:[...ids],unreadIds:state.unreadIds.filter(id=>ids.has(id)),receipts:Object.fromEntries(Object.entries(state.receipts).filter(([id])=>ids.has(id)))});}catch{this.update({status:'Local history could not be restored.'});}
  if(!this.invalid)await this.client.start().catch(e=>this.update({status:String(e)}));
 }
 private persistReadState(){
  if(this.invalid)return;
  const ids=new Set(this.snapshot.messages.map(m=>m.id));
  const state={unreadIds:this.snapshot.unreadIds,receipts:Object.fromEntries(Object.entries(this.snapshot.receipts).filter(([id])=>ids.has(id)))};
  void saveChatReadState(this.user,this.team,state).catch(()=>this.update({status:'Read status could not be saved on this device.'}));
 }
 private update(change:Partial<Snapshot>){if(this.invalid)return;this.snapshot={...this.snapshot,...change};this.listeners.forEach(fn=>fn());unreadListeners.forEach(fn=>fn());}
 markRead(peer:string|null){
  const ids=new Set(this.snapshot.messages.filter(m=>peer===null?m.recipient===null:m.sender===peer&&m.recipient===this.user).map(m=>m.id));
  const unreadIds=this.snapshot.unreadIds.filter(id=>!ids.has(id));
  if(unreadIds.length!==this.snapshot.unreadIds.length){this.update({unreadIds});this.persistReadState();}
 }
 getSnapshot=()=>this.snapshot;
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 retain(){
  const generation=++this.releaseGeneration;
  if(this.refs++===0&&!this.invalid&&generation===1)void this.start();
  let released=false;return()=>{if(released)return;released=true;this.refs--;const closing=++this.releaseGeneration;queueMicrotask(()=>{if(this.refs===0&&closing===this.releaseGeneration)this.clear('Conversation closed.');});};
 }
 clear(status='Signed out. Sign in again to open this conversation.'){
  this.invalid=true;this.client.stop();this.snapshot={unreadIds:[],restoredIds:[],members:{},messages:[],receipts:{},status};
  if(sessions.get(`${this.user}:${this.team}`)===this)sessions.delete(`${this.user}:${this.team}`);
  this.listeners.forEach(fn=>fn());unreadListeners.forEach(fn=>fn());
 }
 send(text:string,peer:string|null){if(this.invalid)return Promise.reject(Error('Sign in again to send messages'));return this.client.send(text,peer);}

}
export function teamSession(team:string,user:string){const key=`${user}:${team}`;let session=sessions.get(key);if(!session){session=new TeamSession(team,user);sessions.set(key,session);}return session;}

export function clearTeamSessions(){for(const session of [...sessions.values()])session.clear();}
