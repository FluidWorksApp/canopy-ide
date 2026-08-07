// What an agent Canopy launches against a project is allowed to do.
//
// This is one module because authority kept being decided five times, in five
// places, with five different answers — and the answers did not add up to a
// product. The project survey ran read-only with no shell. The Build executor
// could edit files but could not install a dependency it had just added to
// package.json, so a turn could write code that could never run. The repair
// agent had a shell and workspace-write authority, but only ever woke up after
// a server had already crashed three times. Meanwhile the one path with a
// planner — install a NAMED package, link a provider, deploy — could only be
// triggered by the person typing one of three verbs, and could not express
// "install what this project already declares" at all: planInstall refuses an
// empty package list.
//
// The result was a build mode that could not build a project from nothing, and
// that reported `node_modules missing, did you mean to install?` back to a
// person who had been promised they would not need to know what that meant.
//
// The fix is not another trigger. It is to stop treating authority as a
// property of the moment an agent happened to be spawned, and treat it as a
// property of the WORKSPACE it is working in.
//
// ## Containment is the operating system, not the prompt
//
// A prompt that says "only edit files inside the component" is a request. The
// model usually honours it, which is worse than if it never did, because the
// failure is rare enough to be a surprise. Both CLIs Canopy drives can do
// better than a request:
//
//   - codex: `-s workspace-write` is enforced by Seatbelt on macOS. From the
//     binary's own help text: "The sandbox permits reading files, and editing
//     files in `cwd` and `writable_roots`. Editing files in other directories
//     requires approval." A write outside the box does not depend on the model
//     deciding not to.
//   - claude: no OS sandbox, but a PreToolUse hook can refuse a call before it
//     runs, and canopy_hook already does exactly that for research writes with
//     a decision shape proven on Claude's wire (see canopy_hook.rs).
//
// So the boundary below is real on both. What this module owns is deciding
// where the boundary sits and what still needs a person inside it.
//
// ## Network is on, and that is a decision
//
// codex's workspace-write sandbox blocks network by default. Setting up a
// project is almost entirely network work — install the dependencies, fetch
// the scaffold, resolve the lockfile — so a sandbox without it can only ever
// report the same failure it was sent to fix. Granting it is not a loosening
// of the boundary: the filesystem boundary is what contains damage, and it is
// untouched. It is the difference between an agent that can do the job and an
// agent that can only describe why it could not.
//
// ## What is still worth asking about
//
// Because the sandbox already contains writes to the component, the questions
// left are the ones the sandbox cannot answer: destruction INSIDE the box that
// no boundary would stop, and any attempt to make the box bigger. Those are
// the only cases judgeCommand refuses to wave through — see DESTRUCTIVE.
//
// Everything else runs. That direction is deliberate: a classifier that asks
// about anything it does not recognise is a classifier that asks about
// everything, and a person who is asked about everything is a person sitting
// in the seat that Build mode exists to leave empty.

import { CANOPY_MCP_ALLOWANCE } from "./agentTools";
import type { StructuredRunnerAuthority } from "./structuredRunners";

/** What the agent was launched to do. Not how much power it gets — that
 *  follows from this, in one place, below. */
export type WorkspaceTask =
  /** Read the project and report what it is. Must not change it. */
  | "survey"
  /** Make the change the person asked for, and make it actually run. */
  | "build"
  /** Something is broken; find out why and fix it. */
  | "repair"
  /** There is no project here yet; create one that runs. */
  | "bootstrap";

export interface Workspace {
  /** The directory the agent works in and may change. */
  root: string;
  /** Sibling component directories of the same project. Readable and
   *  writable: a monorepo change that stops at one package is not a change,
   *  and the project's own components are not "somewhere else". */
  siblings?: readonly string[];
}

export interface WorkspaceGrant {
  authority: StructuredRunnerAuthority;
  /** Reaches the sandbox as sandbox_workspace_write.network_access. */
  network: boolean;
  writableRoots: string[];
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: string;
}

/** Tools withheld from every task, whatever its authority.
 *
 *  KillShell ends processes Canopy is responsible for and did not start on the
 *  agent's behalf; NotebookEdit is a file writer that bypasses the diff review
 *  every other write goes through. Neither is part of any job here. */
const NEVER = ["KillShell", "NotebookEdit"];

/** The grant for a task in a workspace. The single place authority is decided.
 *
 *  Note what does NOT vary: the boundary. Every task is confined to the same
 *  directories. What varies is whether the agent may write at all, and whether
 *  it has a shell — because a survey that can run commands is a survey that
 *  can change what it is surveying. */
export function grantFor(task: WorkspaceTask, workspace: Workspace): WorkspaceGrant {
  const writableRoots = [workspace.root, ...(workspace.siblings ?? [])];
  if (task === "survey") {
    return {
      authority: "read-only",
      // A read-only survey has nothing to fetch. Withholding it costs the task
      // nothing and keeps a reader off the network entirely.
      network: false,
      writableRoots: [],
      allowedTools: [CANOPY_MCP_ALLOWANCE],
      disallowedTools: ["Bash", "Edit", "Write", ...NEVER],
      permissionMode: "plan",
    };
  }
  return {
    authority: "workspace-write",
    network: true,
    writableRoots,
    // Bash is the point. Everything a project needs to become runnable —
    // installing, scaffolding, building, migrating — is a command, and an
    // agent that cannot run one can only ever hand the work back.
    allowedTools: [CANOPY_MCP_ALLOWANCE, "Bash"],
    disallowedTools: [...NEVER],
    permissionMode: "acceptEdits",
  };
}

export type CommandVerdict =
  /** Run it. The sandbox is the containment. */
  | { kind: "routine" }
  /** Ask the person first, in these words. */
  | { kind: "confirm"; because: string };

/** Irreversible inside the box, or an attempt to leave it.
 *
 *  Each entry is a pattern plus the sentence the person actually reads, so the
 *  question is never "Canopy wants to run `git reset --hard`" — which asks a
 *  non-engineer to adjudicate a command — but what it would cost them.
 *
 *  Deliberately short. Every addition is another interruption, and an
 *  interruption that turns out not to matter teaches people to click through
 *  the ones that do. */
const DESTRUCTIVE: { test: RegExp; because: string }[] = [
  {
    test: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/,
    because: "This deletes files for good. I can't undo it afterwards.",
  },
  {
    test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s)/,
    because: "This throws away changes that haven't been saved to a version.",
  },
  {
    test: /\bgit\s+push\s+.*(--force|-f)\b/,
    because: "This overwrites the shared history everyone else is working from.",
  },
  {
    test: /\b(drop\s+(database|table|schema)|truncate\s+table|prisma\s+migrate\s+reset|db\s+push\s+--force)/i,
    because: "This deletes data that isn't coming back.",
  },
  {
    test: /\bsudo\b|\bbrew\s+(install|uninstall|upgrade)\b|\bnpm\s+(i|install)\b[^\n]*\s-g\b/,
    because: "This changes software for your whole computer, not just this project.",
  },
  {
    test: /(^|\s)(\.env|\.env\.[a-z.]+)(\s|$)|\bsecrets?\b.*\b(write|set|put)\b/i,
    because: "This touches the private keys this project uses.",
  },
];

/** What the agent is asking to run, judged.
 *
 *  Takes the command as a STRING because that is what it really is: an agent
 *  runs `bash -lc "npm ci && rm -rf dist"`, and judging only argv[0] would see
 *  `bash` and wave the whole thing through. Matching the text is imprecise in
 *  the direction that costs a question rather than in the direction that costs
 *  a deletion.
 *
 *  Unrecognised commands are routine, on purpose — see the header. The
 *  filesystem boundary, not this list, is what contains an agent that does
 *  something unexpected. */
export function judgeCommand(command: string): CommandVerdict {
  const text = command.trim();
  for (const rule of DESTRUCTIVE) {
    if (rule.test.test(text)) return { kind: "confirm", because: rule.because };
  }
  return { kind: "routine" };
}

/** Is this path inside what the workspace may change?
 *
 *  The sandbox enforces this for codex; for claude the PreToolUse hook is the
 *  enforcement and needs the same answer, so both derive it from here rather
 *  than each implementing "inside" slightly differently. */
export function insideWorkspace(path: string, workspace: Workspace): boolean {
  const target = path.replace(/\/+$/, "");
  return [workspace.root, ...(workspace.siblings ?? [])].some((root) => {
    const base = root.replace(/\/+$/, "");
    return target === base || target.startsWith(`${base}/`);
  });
}
