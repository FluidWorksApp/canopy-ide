// After a host restart, nothing is watched until a client opens a workspace:
// hang recovery, agent resume and the Canopy service's relay credential all
// key on an open runtime. Open the owner workspaces whose container is already
// running, exactly as a client's /open would. A stopped container is left
// stopped, and a running one is never restarted or upgraded (open without
// resume reuses it as it is).
export async function adoptRunning({config,host,harness,authorize,log=message=>console.warn(message)}){
 const adopted=[];
 for(const workspace of config.workspaces){
  if(workspace.memberId||workspace.parentWorkspaceId||['stopped','deleted'].includes(workspace.desiredState??workspace.desired_state))continue;
  try{
   const current=await host.inspectRuntime(workspace);
   if(current?.State?.Running!==true||current.State.Paused||current.State.Restarting)continue;
   const runtime=await host.open(workspace,authorize?{authorize:()=>authorize(workspace)}:{});
   if(harness)await harness.attach(workspace,runtime).catch(()=>{});
   adopted.push(workspace.id);
  }catch(error){log(`Running workspace ${workspace.id} was not adopted: ${error.message}`);}
 }
 return adopted;
}
