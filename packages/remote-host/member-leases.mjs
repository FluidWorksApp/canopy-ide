// Runs in the trusted host, independently of member terminals and sockets.
export class MemberLeases {
  entries = new Map();
  pending = new Map();
  constructor({authorize,stop,now=Date.now,intervalMs=5000}) {
    this.authorize=authorize;this.stop=stop;this.now=now;
    this.timer=setInterval(()=>{void this.checkAll();},intervalMs);this.timer.unref();
  }
  serial(id,action){
    const prior=this.pending.get(id)??Promise.resolve();
    const next=prior.catch(()=>{}).then(action);
    this.pending.set(id,next);
    void next.finally(()=>{if(this.pending.get(id)===next)this.pending.delete(id);}).catch(()=>{});
    return next;
  }
  async open(runtime,principal,bearer,action){
    return this.serial(runtime.id,async()=>{
      const old=this.entries.get(runtime.id);
      if(old?.stopping){await this.stop(old.runtime);this.entries.delete(runtime.id);}
      if(!Number.isFinite(principal.expiresAt)||principal.expiresAt<=this.now())throw Error('Access expired');
      await this.authorize(principal,bearer);
      // Register before opening: even a partially failed launch must be stopped
      // when its authorization is lost.
      // Two IDEs can renew the same member runtime out of order. An older,
      // still-valid credential must not shorten its current lease.
      const sameAccess=old&&!old.stopping&&old.principal.memberId===principal.memberId&&
        old.principal.workspaceId===principal.workspaceId&&old.principal.accessVersion===principal.accessVersion&&
        old.principal.scope===principal.scope;
      if(!sameAccess||old.principal.expiresAt<=principal.expiresAt){
        this.entries.set(runtime.id,{runtime,principal,bearer});
      }
      return action();
    });
  }
  async checkAll(){
    if(this.checking)return this.checking;
    this.checking=Promise.allSettled([...this.entries.keys()].map(id=>this.serial(id,async()=>{
      const entry=this.entries.get(id);if(!entry)return;
      if(!entry.stopping){
        try{if(entry.principal.expiresAt<=this.now())throw Error('Expired');await this.authorize(entry.principal,entry.bearer);}
        catch{entry.stopping=true;}
      }
      if(entry.stopping){await this.stop(entry.runtime);this.entries.delete(id);}
    })));
    try{await this.checking;}finally{this.checking=undefined;}
  }
  close(){clearInterval(this.timer);}
  renewedGrant(grant){
    const original=grant.memberPrincipal;if(!original)return grant;
    for(const entry of this.entries.values()){
      const current=entry.principal;
      if(!entry.stopping&&current.expiresAt>this.now()&&current.memberId===original.memberId&&
         current.workspaceId===original.workspaceId&&current.accessVersion===original.accessVersion&&current.scope===original.scope){
        return {...grant,memberPrincipal:current,expiresAt:current.expiresAt,bearer:entry.bearer};
      }
    }
    return grant;
  }
}
