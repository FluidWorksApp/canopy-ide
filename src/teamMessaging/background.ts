import {invoke} from '@tauri-apps/api/core';
import {teamSession} from './session';

type Directory={selfId:string;teams:{id:string}[]};
type Dependencies={
 request:()=>Promise<Directory>;
 retain:(team:string,user:string)=>()=>void;
};
/** Account-bound background connections outlive individual conversation tabs. */
export function startBackgroundTeams(dependencies:Dependencies={
 request:()=>invoke('canopy_account_request',{route:'/api/teams',body:null}),
 retain:(team,user)=>teamSession(team,user).retain(),
}){
 let disposed=false,epoch=0,user='',timer:ReturnType<typeof setTimeout>|undefined;
 const held=new Map<string,()=>void>();
 const release=()=>{for(const stop of held.values())stop();held.clear();};
 const refresh=async()=>{
  const current=epoch;
  try{
   const directory=await dependencies.request();
   if(disposed||epoch!==current)return;
   if(typeof directory.selfId!=='string'||!directory.selfId||!Array.isArray(directory.teams))throw Error('Invalid team directory');
   if(user!==directory.selfId){release();user=directory.selfId;}
   const next=new Set(directory.teams.map(team=>team.id).filter(id=>typeof id==='string'&&id.length>0));
   for(const [id,stop] of held)if(!next.has(id)){stop();held.delete(id);}
   // Acquire before releasing: healthy sessions stay alive, while a session
   // invalidated by failed authentication can be recreated on the next refresh.
   for(const id of next){const previous=held.get(id);held.set(id,dependencies.retain(id,user));previous?.();}
  }catch{
   if(!disposed&&epoch===current)release();
  }finally{
   if(!disposed&&epoch===current)timer=setTimeout(()=>void refresh(),15000);
  }
 };
 const changed=()=>{epoch++;clearTimeout(timer);release();user='';void refresh();};
 window.addEventListener('canopy:account-changed',changed);
 void refresh();
 return()=>{disposed=true;epoch++;clearTimeout(timer);release();window.removeEventListener('canopy:account-changed',changed);};
}
