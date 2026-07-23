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
   * nothing. Some CLIs genuinely cannot do this and stay undefined on purpose:
   *   - aider: only `--restore-chat-history`, and it is per-directory.
   *
   * Callers must never invoke this with an empty id: `amp threads continue`
   * with no id silently continues the most recent thread, and `codex resume`
   * with no id opens an interactive picker that just hangs in a PTY nobody is
   * watching. See restoreCommand().
   */
  resume?: (sessionId: string) => string;

  /**
   * Command that starts the CLI with an opening prompt already in hand.
   *
   * Same rule as `resume`: only fill this in where the syntax is verified,
   * because a wrong flag doesn't error — it starts a session that silently
   * ignores the prompt, or worse, runs headless and exits. When this is
   * absent Canopy launches the CLI bare and types the prompt into it once
   * the TUI is up, which works everywhere but is a beat slower.
   */
  prompt?: (text: string) => string;

  /**
   * Registry endpoint whose JSON carries the newest published version — npm's
   * `/<pkg>/latest` doc or PyPI's `/pypi/<pkg>/json`. Absent for CLIs shipped
   * by opaque installer scripts (agy, omp): there is no registry to ask, so
   * they simply never show an update badge — never guess a version source.
   */
  latestUrl?: string;

  /**
   * The CLI's own self-update command, when it has one. Preferred over
   * re-running `install`: an npm install can shadow a native install (claude's
   * curl installer vs npm), whereas the self-updater updates in place.
   */
  update?: string;
}

/** Single-quote a string for a POSIX shell. */
export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const AGENT_CLIS: AgentCli[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    icon: "✳",
    install: "npm install -g @anthropic-ai/claude-code",
    latestUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
    // Verified: `claude update` self-updates both the npm and native installs.
    update: "claude update",
    // Verified: `-r, --resume [value]  Resume a conversation by session ID`.
    resume: (id) => `claude --resume ${id}`,
    // Verified: claude takes the opening prompt as a positional argument and
    // stays interactive.
    prompt: (text) => `claude ${shellQuote(text)}`,
  },
  {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    icon: "⌬",
    install: "npm install -g @openai/codex",
    latestUrl: "https://registry.npmjs.org/@openai/codex/latest",
    // Verified: `codex resume <SESSION_ID>` — subcommand, id is positional and
    // takes a UUID or a session name.
    resume: (id) => `codex resume ${id}`,
    // Verified: codex takes a positional prompt and stays interactive.
    // (`codex exec` is the headless one — deliberately not that.)
    prompt: (text) => `codex ${shellQuote(text)}`,
  },
  {
    id: "amp",
    name: "Amp",
    bin: "amp",
    icon: "⚡",
    install: "npm install -g @sourcegraph/amp",
    latestUrl: "https://registry.npmjs.org/@sourcegraph/amp/latest",
    // Verified: `amp threads continue <threadId>`; thread ids look like T-<uuid>.
    resume: (id) => `amp threads continue ${id}`,
  },
  {
    id: "aider",
    name: "Aider",
    bin: "aider",
    icon: "a",
    // `-U` makes this the update command too.
    install: "python3 -m pip install -U aider-chat",
    latestUrl: "https://pypi.org/pypi/aider-chat/json",
  },
  // Gemini CLI is gone from this list on purpose: Google killed its "Login
  // with Google" path for individuals (2026-06-18, "migrate to the Antigravity
  // suite") and Antigravity below is its named successor. Offering both meant
  // new users installed the deprecated one. Terminals running `gemini` are
  // still detected as agents (AGENT_PATTERN keeps the name).
  // Antigravity ships as a single Go binary — the npm package some guides cite
  // doesn't exist.
  {
    id: "agy",
    name: "Antigravity CLI",
    bin: "agy",
    icon: "◇",
    install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    // Verified: `--conversation <uuid>` resumes by id (`-c` takes the most
    // recent). It is NOT `--resume`.
    resume: (id) => `agy --conversation ${id}`,
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    icon: "▣",
    install: "npm install -g opencode-ai",
    latestUrl: "https://registry.npmjs.org/opencode-ai/latest",
    // Verified: `opencode upgrade` self-updates regardless of install method.
    update: "opencode upgrade",
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

/** Matches process names that are agent CLIs. Derived from the registry so a
 *  newly added CLI can never be missed by detection again — the Antigravity
 *  launch shipped with `agy` absent from a hand-maintained copy of this regex,
 *  so its sessions showed as plain shells. The extras cover agents users run
 *  by hand that we don't ship a launcher entry for. */
const EXTRA_AGENT_BINS = ["gemini", "goose", "copilot", "cursor-agent", "qwen", "droid"];
export const AGENT_PATTERN = new RegExp(
  `\\b(${[...AGENT_CLIS.map((c) => c.bin), ...EXTRA_AGENT_BINS].join("|")})\\b`,
  "i",
);

/** Interactive shells — the process sitting at the root of a plain terminal.
 *  Lets us tell "the shell is idle at a prompt" (only shells running) from "the
 *  shell is doing real work" (a server, a build), so a spent agent shell can be
 *  reaped without closing one you're actively using. Login shells arrive as
 *  "-zsh", hence the optional leading dash. */
export const SHELL_PATTERN = /^-?(zsh|bash|sh|fish|dash|tcsh|csh|ksh|nu|pwsh|powershell|cmd)$/i;

export async function checkInstalledClis(): Promise<Record<string, boolean>> {
  try {
    return await invoke<Record<string, boolean>>("which_check", {
      commands: AGENT_CLIS.map((c) => c.bin),
    });
  } catch {
    return {};
  }
}

// ---------- prerequisites (Git, Node/npm) ----------

export type Platform = "macos" | "windows" | "linux";

/** Which OS the webview runs on, for picking a per-platform install command.
 *  Mirrors the navigator.platform check settings.ts already uses for ⌘D-vs-Alt+D
 *  (WebKit reports "MacIntel" even on Apple Silicon, "Win32" on all Windows). */
export function currentPlatform(): Platform {
  const p =
    typeof navigator !== "undefined" ? navigator.platform.toUpperCase() : "";
  if (p.includes("MAC")) return "macos";
  if (p.includes("WIN")) return "windows";
  return "linux";
}

/** A tool the agent CLIs (and Canopy's git features) depend on but that Canopy
 *  can't bundle — installed once via the platform's own package manager. */
export interface Prereq {
  id: string;
  name: string;
  /** Command to probe on PATH. */
  bin: string;
  /** One line: what needs it. */
  why: string;
  /** The install command to run in a terminal, per platform. */
  install: Record<Platform, string>;
}

/** The foundations the one-click CLI installers themselves rely on: without
 *  Node, `npm install -g …` dies with "'npm' is not recognized". Each `install`
 *  runs in a terminal (visible, interruptible), exactly like a CLI install. */
export const PREREQS: Prereq[] = [
  {
    id: "git",
    name: "Git",
    bin: "git",
    why: "branches, worktrees, diffs and pull requests",
    install: {
      macos: "xcode-select --install",
      windows: "winget install --id Git.Git -e --source winget",
      linux: "sudo apt-get update && sudo apt-get install -y git",
    },
  },
  {
    id: "node",
    name: "Node.js",
    bin: "node",
    why: "installing and running npm-based CLIs (Claude Code, Codex, Amp, OpenCode)",
    install: {
      macos: "brew install node",
      windows: "winget install --id OpenJS.NodeJS.LTS -e --source winget",
      linux: "sudo apt-get update && sudo apt-get install -y nodejs npm",
    },
  },
];

/** Which prerequisites are present on PATH — same probe as the CLIs. */
export async function checkInstalledPrereqs(): Promise<Record<string, boolean>> {
  try {
    return await invoke<Record<string, boolean>>("which_check", {
      commands: PREREQS.map((p) => p.bin),
    });
  } catch {
    return {};
  }
}

// ---------- CLI update detection ----------

export interface CliUpdate {
  /** Version reported by `<bin> --version`, when parseable. */
  installed?: string;
  /** Newest version the CLI's registry publishes, when it has a registry. */
  latest?: string;
  /** `latest` is strictly newer than `installed` (both sides known). */
  hasUpdate: boolean;
  /** Package manager that owns the install, when detected ("homebrew"). */
  managedBy?: string;
  /** Upgrade command matched to the install source (e.g. `brew upgrade
   *  claude-code`); overrides the CLI's own updater when present. */
  updateCmd?: string;
}

const LATEST_CACHE_KEY = "canopy.cliLatest.v1";
/** Registries publish a handful of releases a day at most; 6h keeps the badge
 *  fresh without a network round-trip on every launcher open. */
const LATEST_TTL_MS = 6 * 60 * 60 * 1000;

/** Dot-segment numeric compare; >0 when `a` is newer. Registry versions and
 *  `--version` output are both plain x.y.z for every CLI in the registry. */
const cmpVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/**
 * Installed vs latest version for every registered CLI. Installed versions are
 * probed natively (`<bin> --version` on the login-shell PATH); latest versions
 * come from each CLI's registry, cached for LATEST_TTL_MS so reopening the
 * launcher doesn't hammer npm/PyPI. CLIs without a `latestUrl` never flag an
 * update — unknown is unknown.
 */
export async function checkCliUpdates(): Promise<Record<string, CliUpdate>> {
  let cached: { at: number; latest: Record<string, string> } | null = null;
  try {
    cached = JSON.parse(localStorage.getItem(LATEST_CACHE_KEY) ?? "null");
  } catch {
    // Corrupt cache — treat as absent and re-fetch.
  }
  const fresh =
    cached != null &&
    typeof cached.at === "number" &&
    typeof cached.latest === "object" &&
    cached.latest != null &&
    Date.now() - cached.at < LATEST_TTL_MS;
  try {
    const res = await invoke<
      Record<
        string,
        {
          installed: string | null;
          latest: string | null;
          managedBy?: string | null;
          update?: string | null;
        }
      >
    >("cli_versions", {
      queries: AGENT_CLIS.map((c) => ({
        bin: c.bin,
        latestUrl: fresh ? null : (c.latestUrl ?? null),
      })),
    });
    const latest: Record<string, string> = fresh ? cached!.latest : {};
    if (!fresh) {
      for (const [bin, v] of Object.entries(res)) {
        if (v.latest) latest[bin] = v.latest;
      }
      localStorage.setItem(
        LATEST_CACHE_KEY,
        JSON.stringify({ at: Date.now(), latest }),
      );
    }
    const out: Record<string, CliUpdate> = {};
    for (const [bin, v] of Object.entries(res)) {
      const installed = v.installed ?? undefined;
      const newest = latest[bin];
      out[bin] = {
        installed,
        latest: newest,
        hasUpdate: !!(installed && newest && cmpVersions(newest, installed) > 0),
        managedBy: v.managedBy ?? undefined,
        updateCmd: v.update ?? undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** The command that updates `cli` — its self-updater when verified, else its
 *  installer (idempotent for npm -g and pip -U). */
export const updateCommand = (cli: AgentCli) => cli.update ?? cli.install;

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
/**
 * How to start `agentId` working on `text`.
 *
 * Returns the command to run, plus whether the prompt still needs typing in
 * afterwards. Every agent can be started this way — the ones without verified
 * prompt syntax simply launch bare and get the text typed into them, rather
 * than being excluded from the feature (which is what hardcoding one CLI
 * amounted to).
 */
export function startCommand(
  agentId: string,
  text: string,
): { command: string; typePrompt: boolean } | null {
  const cli = AGENT_CLIS.find((c) => c.id === agentId);
  if (!cli) return null;
  return cli.prompt
    ? { command: cli.prompt(text), typePrompt: false }
    : { command: cli.bin, typePrompt: true };
}

export function restoreCommand(agentId: string, sessionId: string): string | null {
  const id = sessionId.trim();
  if (!id) return null;
  return AGENT_CLIS.find((c) => c.id === agentId)?.resume?.(id) ?? null;
}

/** The session id a terminal's command carries when it was launched to resume a
 *  conversation, or null for a fresh start. Inverted from each CLI's own `resume`
 *  builder (via a sentinel), so it can never drift from the command that was
 *  actually spawned. This is a restart-proof session identity: the command names
 *  the session outright, so it holds even after a relaunch reassigns pty ids and
 *  before the resumed agent has emitted its first hook event. */
export function resumeSessionId(command: string | null | undefined): string | null {
  const cmd = (command ?? "").trim();
  if (!cmd) return null;
  const SENTINEL = "__CANOPY_SID__";
  for (const c of AGENT_CLIS) {
    const tmpl = c.resume?.(SENTINEL);
    if (!tmpl) continue;
    const at = tmpl.indexOf(SENTINEL);
    if (at < 0) continue;
    const prefix = tmpl.slice(0, at);
    const suffix = tmpl.slice(at + SENTINEL.length);
    if (!cmd.startsWith(prefix) || !cmd.endsWith(suffix)) continue;
    const id = cmd.slice(prefix.length, cmd.length - suffix.length).trim();
    // A genuine id is one non-empty token — this rejects a command that merely
    // shares the prefix (e.g. a bare `claude`) but isn't a resume.
    if (id && !/\s/.test(id)) return id;
  }
  return null;
}
