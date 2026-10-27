// Jobs another agent submitted to this one (meshJobs.ts), waiting on the
// user. Nothing in a brief runs until it is approved here: the brief is about
// to become an agent's instructions in one of the user's projects, so the
// user reads the whole of it and says yes or no.
//
// Where it runs is decided by the repository the job carries (jobScope.ts),
// never by a project's name and never by whichever project happens to be
// first. A job whose repository is checked out here shows that project and
// needs no choosing; one with no repository, or one this machine does not
// have, says so plainly and has no project selected until the user picks one.
//
// A corner stack rather than a modal. Unlike an agent's question, nobody on
// this machine is blocked on the answer, so it must not take the window — but
// it stays until it is answered, because a job that silently expired is a
// teammate left waiting with no reply.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { IncomingJob, JobWhere, MeshJobs } from "../meshJobs";
import { cloneUrlFor, repoName, type Checkout } from "../jobScope";
import { Button } from "./ui";

const checkoutLabel = (c: Checkout) =>
  `${c.project}${c.rel ? ` · ${c.rel}` : ""}${c.main ? "" : " (worktree)"}`;

function JobCard({
  item,
  workspaces,
  jobs,
  onClone,
}: {
  item: IncomingJob;
  workspaces: string[];
  jobs: MeshJobs;
  onClone?: (url: string) => void;
}) {
  const { placement } = item;
  const choices = placement.kind === "matched" ? placement.choices : [];
  // Matched: the best checkout, changeable only among checkouts of the same
  // repository. Otherwise nothing at all until the user picks.
  const [dir, setDir] = useState(choices[0]?.dir ?? "");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A job that found its checkout after a clone or an open moves to it.
  useEffect(() => {
    if (placement.kind === "matched") setDir(placement.choices[0]?.dir ?? "");
  }, [placement]);
  const from = item.sameAccount ? "Your other machine" : (item.sender.name ?? "A teammate");
  const others = item.job.scope?.repos.slice(1) ?? [];
  const chosen = choices.find((c) => c.dir === dir);
  let where: JobWhere | null = null;
  if (chosen) where = { dir: chosen.dir, label: chosen.project };
  else if (placement.kind !== "matched" && project) where = { project };
  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    run().catch((err) => {
      setError(String(err instanceof Error ? err.message : err));
      setBusy(false);
    });
  };
  const missing = placement.kind === "missing" ? placement.repo : null;
  const cloneUrl = missing ? cloneUrlFor(missing) : null;
  return (
    <div className="mesh-job-card" role="dialog" aria-label={`Job from ${from}`}>
      <p className="ask-from">
        Job from {from}
        {item.teamName ? ` · ${item.teamName}` : ""}
      </p>
      <p className="mesh-job-title">{item.job.title}</p>
      <div className="mesh-job-brief">{item.job.brief}</div>
      {placement.kind === "matched" && choices.length === 1 && chosen && (
        <p className="mesh-job-where">
          <span>
            Runs in <strong>{chosen.project}</strong> (matches {repoName(placement.repo)})
          </span>
        </p>
      )}
      {placement.kind === "matched" && choices.length > 1 && (
        <>
          <label className="mesh-job-where">
            Runs in
            <select value={dir} disabled={busy} onChange={(e) => setDir(e.target.value)}>
              {choices.map((c) => (
                <option key={c.dir} value={c.dir}>
                  {checkoutLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <p className="mesh-job-note">
            {choices.length} of your checkouts are {repoName(placement.repo)}; the main one is picked.
          </p>
        </>
      )}
      {placement.kind !== "matched" && (
        <>
          <p className="mesh-job-note">
            {missing
              ? `You don't have ${repoName(missing)} open here. Where do you want to run it?`
              : "No project attached to this job. Where do you want to run it?"}
          </p>
          <label className="mesh-job-where">
            Run in
            <select
              value={project}
              disabled={busy || !workspaces.length}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="" disabled>
                Choose a project…
              </option>
              {workspaces.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {missing && cloneUrl && onClone && (
            <p className="mesh-job-note">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onClone(cloneUrl)}>
                Clone {repoName(missing)}…
              </Button>
            </p>
          )}
        </>
      )}
      {others.length > 0 && (
        <p className="mesh-job-note">Also involves {others.map(repoName).join(", ")}.</p>
      )}
      {error && <p className="mesh-job-error">{error}</p>}
      <div className="confirm-actions">
        <Button disabled={busy} onClick={() => act(() => jobs.decline(item.job.id))}>
          Decline
        </Button>
        <Button
          variant="accent"
          disabled={busy || !where}
          onClick={() => {
            if (where) act(() => jobs.approve(item.job.id, where));
          }}
        >
          Approve and run
        </Button>
      </div>
    </div>
  );
}

export function MeshJobInbox({
  jobs,
  workspaces,
  checkoutsKey,
  onClone,
}: {
  jobs: MeshJobs;
  workspaces: string[];
  /** Changes whenever a project or component is added or removed. */
  checkoutsKey?: string;
  /** Open the new-project dialog on its clone step with this URL. */
  onClone?: (url: string) => void;
}) {
  const inbox = useSyncExternalStore(jobs.subscribe, jobs.inbox);
  // A project or component opened or cloned since a job arrived may be the
  // checkout it names.
  const projectsKey = `${workspaces.join("\n")}\0${checkoutsKey ?? ""}`;
  useEffect(() => {
    void jobs.relocate();
  }, [jobs, projectsKey]);
  if (!inbox.length) return null;
  return (
    <div className="mesh-job-inbox">
      {inbox.map((item) => (
        <JobCard key={item.job.id} item={item} workspaces={workspaces} jobs={jobs} onClone={onClone} />
      ))}
    </div>
  );
}
