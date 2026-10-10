import {readFileSync} from 'node:fs';
import {transformWithOxc} from 'vite';
import {describe,expect,it,vi} from 'vitest';
import {identifyAgent,rememberAgentPtys,agentIdForCommand} from './agentIdentity';
import {namePatch} from './tabName';
import type {SessionStats} from './ipc';
import type {TermSubTab,SubTab} from './components/ProjectView/helpers';

// Exercise ProjectView's actual stats subscriber without mounting its editor,
// browser and terminal surfaces. This catches a destructive listener even when
// agentIdentity's sticky classification is correct on its own.
const source=readFileSync('src/components/ProjectView/index.tsx','utf8');
const prefix='ipc.onPtyStats(';
const start=source.indexOf(prefix);
const end=source.indexOf('\n    return () => void sub.then',start);
if(start<0||end<0)throw Error('ProjectView has no PTY stats subscription boundary');
const subscription=source.slice(start+prefix.length,end).trim();
if(!subscription.endsWith('});'))throw Error('Unexpected PTY stats subscription');
const {code:callback}=await transformWithOxc(`const receive=${subscription.slice(0,-2)};`,'stats-subscriber.ts');
function harness(){
 const tabsRef={current:[{id:'agent-in-shell',type:'terminal',cwd:'/project',ptyId:7}] as SubTab[]};
 const close=vi.fn((id:string)=>{tabsRef.current=tabsRef.current.filter(tab=>tab.id!==id);});
 let stats:SessionStats[]=[];
 const scope={tabsRef,identifyAgent,agentIdForCommand,namePatch,setTabs:(update:(tabs:SubTab[])=>SubTab[])=>{tabsRef.current=update(tabsRef.current);},setStats:(update:(rows:SessionStats[])=>SessionStats[])=>{stats=update(stats);},
  agentLife:{current:new Map<number,number>()},closeTabRef:{current:close},SHELL_PATTERN:/^(bash|zsh|sh)$/,
  idleWatch:{current:new Map()},QUIET_CPU:10,activeTabIdRef:{current:'agent-in-shell'},visibleRef:{current:true},attentionRef:{current:vi.fn()}};
 const receive=new Function(...Object.keys(scope),`${callback}\nreturn receive;`)(...Object.values(scope)) as (rows:SessionStats[])=>void;
 const memory=new Map<number,string>();
 const sample=(hint:SessionStats['agent_hint'])=>[{id:7,name:'agent',agent_hint:hint,total_cpu:0,procs:[{name:'bash'}]}] as SessionStats[];
 const agent={bin:'claude',pkg:null,path:'/usr/bin/claude',interactive:true};
 function tick(rows:SessionStats[]){
  receive(rows);
  rememberAgentPtys(memory,tabsRef.current.filter((tab):tab is TermSubTab=>tab.type==='terminal').flatMap(tab=>tab.ptyId==null?[]:[tab.ptyId]),stats);
 }
 return {tabsRef,close,memory,sample,agent,tick};
}

describe('agent tab survival during stats gaps',()=>{
 it('keeps a manually launched agent after repeated foreground-hint misses',()=>{
  const h=harness();h.tick(h.sample(h.agent));
  for(let i=0;i<100;i++)h.tick(h.sample(null));
  expect(h.close).not.toHaveBeenCalled();
  expect(h.tabsRef.current.map(tab=>tab.id)).toEqual(['agent-in-shell']);
  expect(h.memory.get(7)).toBe('claude');
 });
 it('keeps the tab and identity when complete stats samples are temporarily empty',()=>{
  const h=harness();h.tick(h.sample(h.agent));
  for(let i=0;i<5;i++)h.tick([]);
  h.tick(h.sample(null));h.tick(h.sample(null));
  expect(h.close).not.toHaveBeenCalled();expect(h.memory.get(7)).toBe('claude');
 });
 it('updates identity when another agent takes over the same live shell',()=>{
  const h=harness();h.tick(h.sample(h.agent));h.tick(h.sample(null));h.tick(h.sample(null));
  h.tick(h.sample({...h.agent,bin:'codex',path:'/usr/bin/codex'}));
  expect(h.close).not.toHaveBeenCalled();expect(h.memory.get(7)).toBe('codex');
 });
 it('leaves a plain shell open without inventing an agent identity',()=>{
  const h=harness();for(let i=0;i<5;i++)h.tick(h.sample(null));
  expect(h.close).not.toHaveBeenCalled();expect(h.memory.size).toBe(0);expect(h.tabsRef.current).toHaveLength(1);
 });
});
