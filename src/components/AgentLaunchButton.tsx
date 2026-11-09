// The one "hand this to an agent" control, shared by every surface that starts
// one: the ticket tab's "▶ Start work" split-button and the PR header's
// "Review ▾" dropdown. It owns the agent menu (running agents to send to, or a
// fresh CLI in a worktree) and either an agent or task primary action.
import { useRef, useState } from "react";
import { AGENT_CLIS } from "../projects";
import { resolveBrain } from "../brain";
import { agentMenuItems } from "../agentMenu";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { AgentsIcon, TasksIcon } from "./icons";
import type { AgentTarget } from "./TicketsPanel";
import { Button } from "./ui";
import { Dialog } from "./Dialog";
import { ProjectSetupDialog } from "../remoteExecution/ProjectSetupDialog";
import { decideLaunch } from "../placement/launch";
import { getAgentPreference, setAgentPreference } from "../placement/preferences";
import type { PlacementDecision, Preference } from "../placement/types";

/** Where an agent launched from this button should run. Omit it and the button
 *  behaves exactly as before (always here). */
export interface LaunchPlacement {
  project: { id: string; name: string; components: { componentId: string; label: string }[] };
  /** Name shown for the remote while it is being set up. */
  workspaceName?: string;
  /** The decision for this agent now. Defaults to the stored preferences and
   *  live resources; injectable so callers and tests can supply their own. */
  decide?: (agentId: string) => Promise<PlacementDecision>;
}

const RUN_ON: { value: Preference; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "local", label: "Local" },
  { value: "remote", label: "Remote" },
  { value: "balance", label: "Balance" },
];

async function defaultDecide(project: { id: string }, agentId: string): Promise<PlacementDecision> {
  // Loaded on demand: gathering pulls in the T3 and workspace clients.
  const { gatherUnified } = await import("../placement/gather");
  const g = await gatherUnified();
  const availability = g.rows
    .filter((r) => r.kind === "project" && !r.needsSetup && r.target.kind !== "local")
    .map((r) => r.target);
  return decideLaunch({ projectId: project.id, agentKind: agentId, resources: g.resources, availability });
}

interface AgentLaunchButtonProps {
  /** The verb on the button, e.g. "Start work" or "Review". */
  label: string;
  /** Agent terminals open in this project — the "send it there" targets. */
  agentTargets: AgentTarget[];
  /** Which agent CLIs are on PATH. */
  installed: Record<string, boolean>;
  /** Label for the new-agent menu row, e.g. "New agent in feat/x". */
  newAgentLabel: string;
  /** Tooltip for the primary action, given the resolved CLI's name. */
  primaryTitle?: (cliName: string) => string;
  /** Start a fresh agent (the given CLI) on this item, in its worktree. */
  onStart: (agentId: string, decision?: PlacementDecision) => void;
  /** Hand it to an already-running agent instead. */
  onSend: (target: AgentTarget) => void;
  /** When this surface came from an agent, send back there on the primary click
   *  instead of starting a new agent. The caret still offers every target. */
  primaryTarget?: AgentTarget;
  /** A non-session primary action. Ticket work defaults to a one-shot Task;
   *  the caret still contains every running/new-agent destination. `state`
   *  is the run's live state on this surface: "starting" while the submit is
   *  in flight (the click is disabled — worktree setup takes a beat), and
   *  "running" once the task is detached — then the primary click opens it
   *  via `onShow` instead of silently launching a second copy. */
  primaryTask?: {
    title: string;
    onRun: () => void;
    state?: "starting" | "running";
    onShow?: () => void;
  };
  /** "split" — the accent primary + caret used in a footer (ticket tab).
   *  "mini" — a single btn-mini dropdown that sits in a header row of small
   *  buttons (PR header), next to Merge ▾ / Request review ▾. */
  variant?: "split" | "mini";
  /** Destinations that are not an agent, appended below the agent rows behind
   *  a divider — the preview's "run it as a one-off task". Kept as extra rows
   *  on this control rather than a second button beside it: the question is
   *  who should look at this, and one question wants one control. */
  extras?: MenuItem[];
  /** Run-on control and on-demand remote setup; see LaunchPlacement. */
  placement?: LaunchPlacement;
}

export function AgentLaunchButton({
  label,
  agentTargets,
  installed,
  newAgentLabel,
  primaryTitle,
  onSend,
  primaryTarget,
  primaryTask,
  variant = "split",
  extras,
  placement,
  onStart: onStartDirect,
}: AgentLaunchButtonProps) {
  const menu = useContextMenu();
  const [, force] = useState(0);
  // The CLI the primary action starts: the brain, resolved the same way every
  // other launcher resolves it (brain.ts). `AGENT_CLIS[0]` only covers an empty
  // registry, so the button always has something to render.
  const preferredCli =
    resolveBrain((bin) => Boolean(installed[bin])) ?? AGENT_CLIS[0];

  const [pending, setPending] = useState<{ agentId: string; decision: PlacementDecision } | null>(null);
  const [setupOk, setSetupOk] = useState(false);
  const [refusal, setRefusal] = useState("");
  const launching = useRef(false);

  // Decide where first. A remote that lacks the project is set up on demand
  // (and only then launched); no room anywhere says so instead of launching.
  const onStart = (agentId: string) => {
    if (!placement) return onStartDirect(agentId);
    if (launching.current) return;
    launching.current = true;
    setRefusal("");
    void (placement.decide ?? ((id: string) => defaultDecide(placement.project, id)))(agentId)
      .then((decision) => {
        if (!decision.target) setRefusal(decision.reason);
        else if (decision.target.kind === "remote" && decision.needsSetup) { setSetupOk(false); setPending({ agentId, decision }); }
        else onStartDirect(agentId, decision);
      })
      .catch((e) => setRefusal(`Could not decide where to run this: ${String((e as { message?: string })?.message ?? e)}`))
      .finally(() => { launching.current = false; });
  };

  const openMenu = (e: React.MouseEvent) => {
    // ContextMenu items are built once at open; bump a counter so a change in
    // targets/installed since last open is reflected.
    force((n) => n + 1);
    const agents = agentMenuItems({
      targets: agentTargets,
      installed,
      newLabel: newAgentLabel,
      onSend,
      onStart,
    });
    const runOn: MenuItem[] = placement
      ? [
          { separator: true },
          ...RUN_ON.map((o) => ({
            label: `Run on: ${o.label}`,
            hint: getAgentPreference(preferredCli.id) === o.value ? "current" : undefined,
            onClick: () => setAgentPreference(preferredCli.id, o.value),
          })),
        ]
      : [];
    const tail = extras?.length ? [{ separator: true } as MenuItem, ...extras] : [];
    menu.open(e, [...agents, ...runOn, ...tail]);
  };

  return (
    <>
      {refusal && <small className="placement-decision" role="status">{refusal}</small>}
      {pending && placement && (
        <Dialog
          title={`Set up ${placement.project.name} first`}
          size="lg"
          dismissLabel="Cancel"
          onDismiss={() => setPending(null)}
          actions={[{ label: "Launch", primary: true, disabled: !setupOk, onClick: () => { const p = pending; setPending(null); onStartDirect(p.agentId, p.decision); } }]}
          body={<ProjectSetupDialog projectId={placement.project.id} projectName={placement.project.name} workspaceName={placement.workspaceName ?? "the remote workspace"} components={placement.project.components} onComplete={setSetupOk} />}
        />
      )}
      {menu.menu && (
        <ContextMenu x={menu.menu.x} y={menu.menu.y} items={menu.menu.items} onClose={menu.close} />
      )}
      {variant === "mini" ? (
        <div className="cli-menu-anchor">
          <Button size="sm"
            title={`Hand this to an agent — a running one, or a fresh ${preferredCli.name} in a worktree`}
            onClick={openMenu}>
            <AgentsIcon size={11} /> {label} ▾
          </Button>
        </div>
      ) : (
        <span className="split-btn">
          <Button variant="accent" className="split-btn-main"
            // The agent is named in the tooltip and the caret menu, not the
            // label: the button is the verb, not an endorsement of one CLI.
            disabled={primaryTask?.state === "starting"}
            onClick={() =>
              primaryTask
                ? primaryTask.state === "running"
                  ? primaryTask.onShow?.()
                  : primaryTask.onRun()
                : primaryTarget
                  ? onSend(primaryTarget)
                  : onStart(preferredCli.id)
            }
            title={
              primaryTask
                ? primaryTask.state === "starting"
                  ? "Starting the task…"
                  : primaryTask.state === "running"
                    ? "This is running as a task — click to watch it in Tasks"
                    : primaryTask.title
                : primaryTarget
                ? `Send this back to ${primaryTarget.title}`
                : primaryTitle?.(preferredCli.name)
            }>
            {primaryTask?.state === "starting"
              ? "Starting…"
              : primaryTask?.state === "running"
                ? "Running"
                : <>▶ {label}</>}
            <span className="split-btn-agent">
              {primaryTask ? (
                <>
                  <TasksIcon size={11} />{" "}
                  {primaryTask.state === "running" ? "In Tasks" : "Task"}
                </>
              ) : (
                primaryTarget?.title ?? preferredCli.name
              )}
            </span>
          </Button>
          <Button variant="accent" className="split-btn-caret"
            title={
              primaryTask
                ? "Send to a running agent, or start a new one instead"
                : primaryTarget
                ? "Send to another agent, or start a new one"
                : "Send to a running agent, or start a different one"
            }
            onClick={openMenu}>
            ▾
          </Button>
        </span>
      )}
    </>
  );
}
