// Project model + persistence. A project is the unit of work: a name plus one
// or more labeled component directories (frontend, backend, ...). The whole
// workspace (projects, which are open, which is active) persists via the Rust
// core to ~/.canopy/projects.json.
import { invoke } from "@tauri-apps/api/core";

export interface RunCommand {
  name: string;
  command: string;
}

export interface Component {
  label: string;
  path: string;
  /** Named run commands (dev server, worker, ...) launched in this dir. */
  commands?: RunCommand[];
}

export interface Project {
  id: string;
  name: string;
  components: Component[];
  /** Let agent sessions in this project see each other's recent work. Off by
   *  default: it puts one session's prompts into another's context, which is
   *  the user's call to make, not ours. */
  shareContext?: boolean;
}

export interface WorkspaceState {
  projects: Project[];
  openIds: string[];
  activeId: string | null;
}

export const emptyWorkspace: WorkspaceState = {
  projects: [],
  openIds: [],
  activeId: null,
};

export async function loadWorkspace(): Promise<WorkspaceState> {
  try {
    const raw = await invoke<string>("store_load");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.projects)) {
      return {
        projects: parsed.projects,
        openIds: Array.isArray(parsed.openIds) ? parsed.openIds : [],
        activeId: parsed.activeId ?? null,
      };
    }
  } catch (err) {
    console.warn("workspace load failed", err);
  }
  return emptyWorkspace;
}

export async function saveWorkspace(state: WorkspaceState): Promise<void> {
  try {
    await invoke("store_save", { data: JSON.stringify(state, null, 2) });
  } catch (err) {
    console.warn("workspace save failed", err);
  }
}

// ---------- explicit export / import ----------
// The workspace already auto-persists; these back the File menu so a workspace
// can be moved between machines or checked into a repo.

interface WorkspaceFile {
  kind: "canopy.workspace";
  version: 1;
  projects: Project[];
  openIds: string[];
}

interface ProjectFile {
  kind: "canopy.project";
  version: 1;
  project: Project;
}

export const exportWorkspace = (path: string, state: WorkspaceState) =>
  invoke<void>("workspace_export", {
    path,
    data: JSON.stringify(
      {
        kind: "canopy.workspace",
        version: 1,
        projects: state.projects,
        // activeId is deliberately omitted: which tab you were on is a property
        // of a session, not of the workspace being shared.
        openIds: state.openIds,
      } satisfies WorkspaceFile,
      null,
      2,
    ),
  });

export const exportProject = (path: string, project: Project) =>
  invoke<void>("workspace_export", {
    path,
    data: JSON.stringify(
      { kind: "canopy.project", version: 1, project } satisfies ProjectFile,
      null,
      2,
    ),
  });

/** Read a workspace or single-project file. Throws with a readable message
 *  rather than silently importing something that isn't ours. */
export async function importFile(
  path: string,
): Promise<{ projects: Project[]; openIds: string[] }> {
  const raw = await invoke<string>("workspace_import", { path });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Not a canopy file (invalid JSON)");
  }
  // The two file kinds have conflicting `kind` literals, so widen rather than
  // intersect before narrowing.
  const obj = parsed as {
    kind?: string;
    project?: Project;
    projects?: Project[];
    openIds?: string[];
  };
  if (obj?.kind === "canopy.project" && obj.project) {
    return { projects: [obj.project], openIds: [obj.project.id] };
  }
  if (obj?.kind === "canopy.workspace" && Array.isArray(obj.projects)) {
    return {
      projects: obj.projects,
      openIds: Array.isArray(obj.openIds) ? obj.openIds : [],
    };
  }
  throw new Error("Not a canopy workspace or project file");
}

export const newProjectId = () =>
  `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ---------- Agent CLI launcher registry ----------

export interface AgentCli {
  id: string;
  name: string;
  bin: string;
  /** Fallback glyph for the terminal tab strip; the menu uses the brand SVG
   *  registered under the same `id` in components/icons.tsx. */
  icon: string;
  install: string;
  /**
   * Command that reopens an earlier conversation *by its session id*, or
   * undefined when the CLI cannot do that.
   *
   * Only fill this in for syntax verified against the CLI's own help or arg
   * parser. A wrong flag doesn't error — it silently starts a *fresh* session
   * while the UI claims the context was restored, which is worse than offering
   * nothing. Two CLIs genuinely cannot do this and stay undefined on purpose:
   *   - gemini: `--resume` takes a list *index* or "latest", not a session id.
   *   - aider: only `--restore-chat-history`, and it is per-directory.
   *
   * Callers must never invoke this with an empty id: `amp threads continue`
   * with no id silently continues the most recent thread, and `codex resume`
   * with no id opens an interactive picker that just hangs in a PTY nobody is
   * watching. See restoreCommand().
   */
  resume?: (sessionId: string) => string;
}

export const AGENT_CLIS: AgentCli[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    icon: "✳",
    install: "npm install -g @anthropic-ai/claude-code",
    // Verified: `-r, --resume [value]  Resume a conversation by session ID`.
    resume: (id) => `claude --resume ${id}`,
  },
  {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    icon: "⌬",
    install: "npm install -g @openai/codex",
    // Verified: `codex resume <SESSION_ID>` — subcommand, id is positional and
    // takes a UUID or a session name.
    resume: (id) => `codex resume ${id}`,
  },
  {
    id: "amp",
    name: "Amp",
    bin: "amp",
    icon: "⚡",
    install: "npm install -g @sourcegraph/amp",
    // Verified: `amp threads continue <threadId>`; thread ids look like T-<uuid>.
    resume: (id) => `amp threads continue ${id}`,
  },
  { id: "aider", name: "Aider", bin: "aider", icon: "a", install: "python3 -m pip install -U aider-chat" },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", icon: "✦", install: "npm install -g @google/gemini-cli" },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    icon: "▣",
    install: "npm install -g opencode-ai",
    // Verified: `-s, --session <id>` = "session id to continue". Treat the id as
    // opaque — enumerate via `opencode session list --format json`.
    resume: (id) => `opencode --session ${id}`,
  },
  // oh-my-pi. NB: the bare `omp` npm package is an unrelated squat — the
  // official installer is the omp.sh script.
  {
    id: "omp",
    name: "oh-my-pi",
    bin: "omp",
    icon: "π",
    install: "curl -fsSL https://omp.sh/install | sh",
    // Verified: `-r, --resume=<value>  Resume a session (by ID prefix, path...)`.
    resume: (id) => `omp --resume ${id}`,
  },
];

export async function checkInstalledClis(): Promise<Record<string, boolean>> {
  try {
    return await invoke<Record<string, boolean>>("which_check", {
      commands: AGENT_CLIS.map((c) => c.bin),
    });
  } catch {
    return {};
  }
}

/**
 * The command that reopens `sessionId` for `agentId`, or null when that agent
 * can't reopen a specific session (gemini resumes by list index; aider only
 * restores per-directory history).
 *
 * The empty-id check is not defensive padding. `amp threads continue` with no
 * id silently continues the *most recent* thread, and `codex resume` with no id
 * opens an interactive picker that hangs forever in a PTY nobody is watching.
 * Both would look like "restore worked" while doing something else entirely.
 */
export function restoreCommand(agentId: string, sessionId: string): string | null {
  const id = sessionId.trim();
  if (!id) return null;
  return AGENT_CLIS.find((c) => c.id === agentId)?.resume?.(id) ?? null;
}
