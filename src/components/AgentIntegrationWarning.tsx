import { useCallback, useEffect, useState, useRef } from "react";
import {PROFILE_CHANGE_EVENT} from "../profiles";
import { agentCliFor } from "../projects";
import * as ipc from "../ipc";

/** Project-level warning: never depends on opening the agents sidebar. */
type IntegrationTarget={agent:string;ptyId:number;profile?:string};
export function AgentIntegrationWarning({ agents,targets }: { agents: string[];targets?:IntegrationTarget[] }) {
  const targetsRef=useRef(targets);targetsRef.current=targets;
  const targetsKey=JSON.stringify(targets??[]);
  const [profileEpoch,setProfileEpoch]=useState(0);
  const checkEpoch=useRef(0);
  useEffect(()=>{const changed=()=>{checkEpoch.current++;setProfileEpoch(value=>value+1);};window.addEventListener(PROFILE_CHANGE_EVENT,changed);return()=>window.removeEventListener(PROFILE_CHANGE_EVENT,changed);},[]);
  const targetKey=(target:IntegrationTarget)=>`${target.agent}:${target.ptyId}:${target.profile||"default"}`;
  const key = [...new Set(agents)].sort().join(",");
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [awaitingEvents, setAwaitingEvents] = useState<string[]>([]);
  const observedAgents = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void ipc.onAgentEvents(lines => {
      if (disposed) return;
      const seen = new Set<string>();
      for (const line of lines) {
        try { const event = JSON.parse(line); if (typeof event.agent === "string" && typeof event.hook_event_name === "string") {
          const currentTargets=targetsRef.current;
          if(currentTargets){for(const target of currentTargets)if(target.agent===event.agent&&target.ptyId===event.canopy_pty&&(event.canopy_profile==null||event.canopy_profile===(target.profile||"default")))observedAgents.current.add(targetKey(target));}
          else observedAgents.current.add(event.agent);
          seen.add(event.agent);
        } } catch { /* Ignore malformed telemetry. */ }
      }
      setAwaitingEvents(current => current.filter(agent => !seen.has(agent)||(targetsRef.current?.filter(target=>target.agent===agent).some(target=>!observedAgents.current.has(targetKey(target)))??false)));
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const check = useCallback(async () => {
    const epoch=++checkEpoch.current;
    const health = await ipc.agentIntegrationHealth();
    const candidates = [...new Set([
      ...key.split(",").filter(Boolean),
      ...health.filter(a => a.cli_installed).map(a => a.agent),
    ])].filter(a => agentCliFor(a)?.capabilities?.remoteIntegration);
    const unresolved = await Promise.all(candidates.map(async agent => {
      const status = health.find(a => a.agent === agent);
      const hooks = await ipc.agentHooksInstalled(agent);
      return !hooks || (status && !["ours", "unsupported"].includes(status.mcp)) ? agent : null;
    }));
    const pending = unresolved.filter((a): a is string => a !== null);
    if(epoch!==checkEpoch.current)return pending;
    if(targetsRef.current){const live=new Set(targetsRef.current.map(targetKey));for(const observed of observedAgents.current)if(!live.has(observed))observedAgents.current.delete(observed);}
    setError("");
    setMissing(pending);
    setAwaitingEvents(candidates.filter(agent => key.split(",").includes(agent) && !pending.some(value => value === agent) && !(targetsRef.current?targetsRef.current.filter(target=>target.agent===agent).every(target=>observedAgents.current.has(targetKey(target))):observedAgents.current.has(agent))));
    return pending;
  }, [key,targetsKey,profileEpoch]);
  useEffect(() => {
    let alive = true;
    const refresh = () => {const epoch=checkEpoch.current+1;void check().catch(() => {
      if (alive&&epoch===checkEpoch.current) setError("Could not verify agent integration. Retry to check this workspace.");
    });};
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [check]);
  const setup = async () => {
    setBusy(true); setError("");
    try {
      const targets = missing.length ? missing : await check();
      const reports = await Promise.allSettled(targets.map(a => ipc.setupAgentHooks(a)));
      const failures = reports.flatMap((result, i) => result.status === "rejected"
        ? [`${targets[i]}: ${String(result.reason)}`]
        : result.value.ok ? [] : [result.value.summary]);
      const pending = await check();
      const configured = targets.filter((agent, i) => reports[i].status === "fulfilled" && (reports[i] as PromiseFulfilledResult<ipc.SetupReport>).value.ok && !pending.some(value => value === agent) && key.split(",").includes(agent));
      setAwaitingEvents(current => [...new Set([...current, ...configured])]);
      if (failures.length) setError(failures.join("\n"));
      else if (pending.length) setError("Setup finished, but integration is not verified yet. Retry setup.");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  if (!missing.length && !error && !awaitingEvents.length) return null;
  return <section className="agent-integration-warning" role="alert" aria-label="Critical agent integration warning">
    <div className="agent-integration-warning-copy">
      <strong>{missing.length || error ? "Agent integration required" : "Restart agents to finish integration"}</strong>
      {awaitingEvents.length > 0 && <p>Setup is saved. Restart the existing {awaitingEvents.join(" and ")} sessions to load it. This warning stays until an integration event arrives.</p>}
      {missing.length > 0 && <p>{missing.map(a => agentCliFor(a)?.name ?? a).join(" and ") || "Agent integration"} needs setup for reliable activity, questions and task status.</p>}
      {error && <p className="agent-integration-warning-error">{error}</p>}
    </div>
    {(missing.length > 0 || error) && <button type="button" disabled={busy} onClick={() => void setup()}>{busy ? "Setting up…" : "Set up integrations"}</button>}
  </section>;
}
