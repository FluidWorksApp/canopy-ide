// The workspace's PR watcher, for provenance only: the desktop's prwatch.rs
// records which session raised a PR when it first sees it, which is the only
// thing that catches an agent that opened its PR by hand. The IDE names the
// projects to watch with pr_watch_set; this runs provenance_observe on each,
// more often while the IDE is focused, and at once on pr_watch_now.
const FOCUSED_MS=3*60_000,IDLE_MS=15*60_000,MAX_PATHS=32;
export class PrObserver{
 constructor({observe,log=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){Object.assign(this,{observe,log,setTimer,clearTimer});this.paths=[];this.focused=false;this.timer=null;this.running=null;}
 watch(paths,focused){
  this.paths=[...new Set((Array.isArray(paths)?paths:[]).filter(p=>typeof p==='string'&&p.startsWith('/')))].slice(0,MAX_PATHS);
  this.focused=!!focused;this.schedule(this.paths.length?1000:null);
 }
 now(){return this.pass();}
 schedule(ms){
  if(this.timer)this.clearTimer(this.timer);this.timer=null;
  if(ms==null||!this.paths.length)return;
  this.timer=this.setTimer(()=>{this.timer=null;void this.pass();},ms);this.timer?.unref?.();
 }
 async pass(){
  if(this.running)return this.running;
  this.running=(async()=>{
   for(const repo of this.paths){try{await this.observe(repo);}catch(error){this.log(`PR watch for ${repo}: ${error?.message??error}`);}}
  })();
  try{await this.running;}finally{this.running=null;this.schedule(this.focused?FOCUSED_MS:IDLE_MS);}
 }
}
