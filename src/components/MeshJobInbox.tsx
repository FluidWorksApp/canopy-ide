// Jobs another account's agent submitted to this one (meshJobs.ts), waiting on
// the user. Nothing in a brief runs until it is approved here: the brief is
// about to become an agent's instructions in one of the user's workspaces, so
// the user reads the whole of it, picks where it runs, and says yes or no.
//
// A corner stack rather than a modal. Unlike an agent's question, nobody on
// this machine is blocked on the answer, so it must not take the window — but
// it stays until it is answered, because a job that silently expired is a
// teammate left waiting with no reply.
import { useState, useSyncExternalStore } from "react";
import type { IncomingJob, MeshJobs } from "../meshJobs";
import { pickWorkspace } from "../meshJobs";
import { Button } from "./ui";

function JobCard({
  item,
  workspaces,
  jobs,
}: {
  item: IncomingJob;
  workspaces: string[];
  jobs: MeshJobs;
}) {
  const preset = pickWorkspace(item.job.workspace, workspaces.map((name) => ({ name })));
  const [workspace, setWorkspace] = useState(preset ?? workspaces[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const from = item.sameAccount ? "Your other machine" : (item.sender.name ?? "A teammate");
  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    run().catch((err) => {
      setError(String(err instanceof Error ? err.message : err));
      setBusy(false);
    });
  };
  return (
    <div className="mesh-job-card" role="dialog" aria-label={`Job from ${from}`}>
      <p className="ask-from">
        Job from {from}
        {item.teamName ? ` · ${item.teamName}` : ""}
      </p>
      <p className="mesh-job-title">{item.job.title}</p>
      <div className="mesh-job-brief">{item.job.brief}</div>
      {item.job.workspace && !preset && (
        <p className="mesh-job-note">
          It asked for “{item.job.workspace}”, which isn't one of your workspaces.
        </p>
      )}
      <label className="mesh-job-where">
        Run in
        <select
          value={workspace}
          disabled={busy || !workspaces.length}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          {workspaces.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="mesh-job-error">{error}</p>}
      <div className="confirm-actions">
        <Button disabled={busy} onClick={() => act(() => jobs.decline(item.job.id))}>
          Decline
        </Button>
        <Button
          variant="accent"
          disabled={busy || !workspace}
          onClick={() => act(() => jobs.approve(item.job.id, workspace))}
        >
          Approve and run
        </Button>
      </div>
    </div>
  );
}

export function MeshJobInbox({ jobs, workspaces }: { jobs: MeshJobs; workspaces: string[] }) {
  const inbox = useSyncExternalStore(jobs.subscribe, jobs.inbox);
  if (!inbox.length) return null;
  return (
    <div className="mesh-job-inbox">
      {inbox.map((item) => (
        <JobCard key={item.job.id} item={item} workspaces={workspaces} jobs={jobs} />
      ))}
    </div>
  );
}
