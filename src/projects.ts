// Project model + persistence. A project is the unit of work: a name plus one
// or more labeled component directories (frontend, backend, ...). The whole
// workspace (projects, which are open, which is active) persists via the Rust
// core to ~/.canopy/projects.json.
import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./settings";

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
  /**
   * The executable to run. This is the *resolved* binary: an entry the user has
   * rebound (Settings → Agents) carries their command here, not the name the
   * vendor ships. Read it freely — every consumer gets the override for free,
   * which is the whole point of resolving once at the registry rather than
   * teaching twenty call sites about overrides.
   */
  bin: string;
  /** Fallback glyph for the terminal tab strip; the menu uses the brand SVG
   *  registered under the same `id` in components/icons.tsx. */
  icon: string;
  /**
   * One-click install command, when there is a package Canopy knows how to
   * fetch. Absent for an entry the user added themselves: nothing here knows
   * where an in-house CLI comes from, so the launcher must say "not found"
   * rather than offer an install that cannot exist.
   */
  install?: string;
  /**
   * Packages that ship this CLI, as the resolver reports them (see
   * agentid.rs): `npm:<name>` from the nearest package.json, `brew:<formula>`
   * from the Cellar path, `py:<module>` from a console script's entry import.
   *
   * This is what identifies a CLI that was installed under another name — an
   * enterprise build of Claude Code invoked as `acme-claude` still resolves to
   * `npm:@anthropic-ai/claude-code`. Derived from `install` above, so it stays
   * as verified as the rest of the entry; CLIs shipped as opaque single
   * binaries (agy) have no package to name and are matched by `bin` alone.
   */
  pkgs?: string[];
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

  /** True when `bin` came from the user's override rather than the entry's own
   *  name. Suppresses the update badge: `latestUrl` points at the public
   *  registry, and nagging someone to overwrite a sanctioned enterprise build
   *  with a public release is worse than showing no version at all. */
  rebound?: boolean;

  /** True for an entry the user added rather than one Canopy ships (see
   *  CustomAgentCli). Read where "we know nothing else about this CLI" changes
   *  what a surface may claim — there is no installer to offer and no vendor
   *  whose logo it could wear. */
  custom?: boolean;

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

/**
 * A registry entry as authored, before the user's binary override is applied.
 *
 * `resume` and `prompt` take the binary as a second argument rather than
 * spelling it out, so a rebound entry builds `acme-claude --resume <id>` instead
 * of launching a `claude` that isn't there. Writing the name twice is exactly
 * the drift the resolver exists to prevent — and a resume command naming the
 * wrong binary is the silent-failure mode these entries are documented against.
 */
export interface AgentCliDef extends Omit<AgentCli, "resume" | "prompt" | "rebound"> {
  resume?: (sessionId: string, bin: string) => string;
  prompt?: (text: string, bin: string) => string;
}

/** Single-quote a string for a POSIX shell. */
export const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** A binary as it must appear at the head of a shell command line.
 *
 *  Quoted only when it has to be. A rebound CLI can name a path with a space
 *  in it — `/Applications/Acme CLI/bin/claude`, or the `C:\Program Files\…`
 *  that is the standard enterprise install on Windows — and written raw the
 *  shell reads that as a command plus arguments. Everything else is left
 *  exactly as it was: quoting is per-shell (cmd.exe knows nothing of single
 *  quotes) and a bare `claude` needs none, so the quoting only happens for the
 *  values that cannot launch at all today. */
export function shellBin(bin: string): string {
  if (!/\s/.test(bin)) return bin;
  return currentPlatform() === "windows" ? `"${bin}"` : shellQuote(bin);
}

/** The CLIs Canopy ships knowledge of, under the names their vendors use.
 *  Never read this directly to launch or probe anything — read AGENT_CLIS,
 *  which is this list with the user's overrides applied. */
export const BUILTIN_AGENT_CLIS: AgentCliDef[] = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    icon: "✳",
    install: "npm install -g @anthropic-ai/claude-code",
    pkgs: ["npm:@anthropic-ai/claude-code"],
    latestUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
    // Verified: `claude update` self-updates both the npm and native installs.
    update: "claude update",
    // Verified: `-r, --resume [value]  Resume a conversation by session ID`.
    resume: (id, bin) => `${bin} --resume ${id}`,
    // Verified: claude takes the opening prompt as a positional argument and
    // stays interactive.
    prompt: (text, bin) => `${bin} ${shellQuote(text)}`,
  },
  {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    icon: "⌬",
    install: "npm install -g @openai/codex",
    pkgs: ["npm:@openai/codex"],
    latestUrl: "https://registry.npmjs.org/@openai/codex/latest",
    // Verified: `codex resume <SESSION_ID>` — subcommand, id is positional and
    // takes a UUID or a session name.
    resume: (id, bin) => `${bin} resume ${id}`,
    // Verified: codex takes a positional prompt and stays interactive.
    // (`codex exec` is the headless one — deliberately not that.)
    prompt: (text, bin) => `${bin} ${shellQuote(text)}`,
  },
  {
    id: "amp",
    name: "Amp",
    bin: "amp",
    icon: "⚡",
    install: "npm install -g @sourcegraph/amp",
    pkgs: ["npm:@sourcegraph/amp"],
    latestUrl: "https://registry.npmjs.org/@sourcegraph/amp/latest",
    // Verified: `amp threads continue <threadId>`; thread ids look like T-<uuid>.
    resume: (id, bin) => `${bin} threads continue ${id}`,
  },
  {
    id: "aider",
    name: "Aider",
    bin: "aider",
    icon: "a",
    // `-U` makes this the update command too.
    install: "python3 -m pip install -U aider-chat",
    // The console script imports `aider`; `aider-chat` is only the
    // distribution name, which nothing on disk states.
    pkgs: ["py:aider"],
    latestUrl: "https://pypi.org/pypi/aider-chat/json",
  },
  // Gemini CLI is gone from this list on purpose: Google killed its "Login
  // with Google" path for individuals (2026-06-18, "migrate to the Antigravity
  // suite") and Antigravity below is its named successor. Offering both meant
  // new users installed the deprecated one. Terminals running `gemini` are
  // still detected as agents (EXTRA_AGENT_BINS keeps the name).
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
    resume: (id, bin) => `${bin} --conversation ${id}`,
  },
  {
    id: "opencode",
    name: "OpenCode",
    bin: "opencode",
    icon: "▣",
    install: "npm install -g opencode-ai",
    pkgs: ["npm:opencode-ai"],
    latestUrl: "https://registry.npmjs.org/opencode-ai/latest",
    // Verified: `opencode upgrade` self-updates regardless of install method.
    update: "opencode upgrade",
    // Verified: `-s, --session <id>` = "session id to continue". Treat the id as
    // opaque — enumerate via `opencode session list --format json`.
    resume: (id, bin) => `${bin} --session ${id}`,
  },
  // oh-my-pi. NB: the bare `omp` npm package is an unrelated squat — the
  // official installer is the omp.sh script.
  {
    id: "omp",
    name: "oh-my-pi",
    bin: "omp",
    icon: "π",
    install: "curl -fsSL https://omp.sh/install | sh",
    // Also published as a Homebrew formula (can1357/tap).
    pkgs: ["brew:omp"],
    // Verified: `-r, --resume=<value>  Resume a session (by ID prefix, path...)`.
    resume: (id, bin) => `${bin} --resume ${id}`,
  },
];

/** Agents users run by hand that we don't ship a launcher entry for. Their id
 *  is their bin: enough to name a row and pick an icon where one exists. */
const EXTRA_AGENT_BINS = ["gemini", "goose", "copilot", "cursor-agent", "qwen", "droid"];

/** Last path segment of a command, folded the same way the process resolver
 *  folds what it observes (case, `.exe`), so an override written as a full path
 *  — `/opt/acme/bin/claude`, `C:\acme\Claude.exe` — matches the plain basename
 *  that identification actually has in hand. */
export const binName = (bin: string) =>
  (bin.split(/[/\\]/).pop() ?? bin).replace(/\.exe$/i, "").toLowerCase();

// ---------- CLIs the user adds ----------

/**
 * An agent CLI Canopy ships no knowledge of, described by the person running it
 * — an in-house tool, or a vendor we haven't got to yet.
 *
 * Deliberately a much smaller shape than the entries above, because everything
 * missing from it is something that cannot be discovered and must not be
 * invented. No `install` (there is no package we know how to fetch), no
 * `latestUrl` or `pkgs` (no registry to ask, so no version badge and no
 * package-identity rung), and no hook or MCP wiring at all — those are
 * per-vendor config formats, one arm each in agents.rs, and a wrong guess
 * writes into someone's real config file.
 *
 * What is left is exactly what only the user can state: what to run, what to
 * call it, and the two argument shapes worth knowing. So a custom CLI launches,
 * is recognised while it runs, and resumes if they say how — and its state
 * reaches the Agents rail only once its own hooks point at the bridge file,
 * which stays a thing they do rather than a thing we pretend to have done.
 */
export interface CustomAgentCli {
  /** Stable registry id, assigned when the entry is first named and never
   *  rewritten afterwards — `defaultAgent` and every recorded task run refer to
   *  a CLI by id, so a rename must not orphan them. */
  id: string;
  name: string;
  /** The executable: a command name on PATH, or a full path. */
  bin: string;
  /**
   * Arguments that reopen a session, `{id}` marking where the session id goes
   * — `--resume {id}`, `threads continue {id}`. Blank when the CLI can't do it,
   * which is the honest answer: see AgentCli.resume for why a guessed flag is
   * worse than offering nothing.
   */
  resumeArgs?: string;
  /**
   * Arguments that start it with an opening prompt, `{prompt}` marking the
   * text. Blank means Canopy launches it bare and types the prompt in once the
   * TUI is up — slower, but it works everywhere.
   */
  promptArgs?: string;
}

/** Ids nothing may take: the built-ins, and the bare binaries that already name
 *  themselves. Two entries answering to one id makes identification a coin
 *  toss, and the loser is whichever the user actually launched. */
export function agentIdTaken(id: string): boolean {
  return BUILTIN_AGENT_CLIS.some((d) => d.id === id) || EXTRA_AGENT_BINS.includes(id);
}

/**
 * A registry id for a newly added custom CLI, slugged from its name and
 * uniquified against everything already registered.
 *
 * Slugged rather than opaque so that a CLI whose hooks the user wires by hand
 * can report `agent: "<id>"` and land on their own entry — the same rung that
 * names an enterprise build today (see agentIdentity.ts).
 */
export function newCustomCliId(name: string, existing: string[]): string {
  const base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cli";
  let id = base;
  for (let n = 2; agentIdTaken(id) || existing.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Put `value` where `token` says, or on the end when the template never
 * mentions it.
 *
 * Appending rather than rejecting, because `--resume` typed on its own plainly
 * means "the id goes after this" — and the alternative is building `acme
 * --resume` with no id at all, which is precisely the silent failure every
 * `resume` entry above is documented against: a *fresh* session, started while
 * the UI says the conversation was restored.
 */
function expandArgs(template: string, token: string, value: string): string {
  const t = template.trim();
  return (t.includes(token) ? t.replaceAll(token, value) : `${t} ${value}`).trim();
}

/** A value that names arguments rather than one executable. `acme run agent`
 *  probes as a single file of that name — so it reports "not found" with
 *  nothing to say why — and would be launched the same way. A path may hold
 *  spaces (`/opt/Acme CLI/agent`); a bare name that does is arguments. */
export const namesArguments = (value: string) =>
  !!value && !/[/\\]/.test(value) && /\s/.test(value);

/**
 * Why a custom entry can't be registered, or null when it can. `earlier` is the
 * entries above it in the list — first one wins, so editing a row can only ever
 * invalidate itself.
 *
 * Only two rules, and both are about what the field has to be rather than what
 * the CLI does: whether the value is one executable, and whether something else
 * already answers to that name. Nothing here can tell you the binary is really
 * an agent, or that the resume flag is right — running an unknown CLI to find
 * out is not a thing a settings field may do, and a guess would be worse than
 * the "✗ not found" the PATH probe gives honestly.
 *
 * A built-in's binary is refused because that entry already launches it and
 * would then be identified as this one. The bare-binary list (gemini, droid, …)
 * is deliberately NOT refused: those name themselves precisely because Canopy
 * ships no launcher for them, so adding one is the point.
 */
export function customCliIssue(
  entry: CustomAgentCli,
  earlier: CustomAgentCli[],
): "arguments" | "duplicate" | null {
  const bin = entry.bin.trim();
  if (!bin) return null;
  if (namesArguments(bin)) return "arguments";
  const name = binName(bin);
  const clash =
    BUILTIN_AGENT_CLIS.some((d) => d.bin === name) ||
    earlier.some((o) => o.bin.trim() && binName(o.bin) === name);
  return clash ? "duplicate" : null;
}

/** The user's own entries, as registry definitions. */
export function customCliDefs(): AgentCliDef[] {
  const all = getSettings().customClis;
  return all.flatMap((c, i): AgentCliDef[] => {
    const id = c.id.trim();
    const bin = c.bin.trim();
    // A half-filled or unusable row never reaches the registry: the settings
    // list keeps the draft so it can be finished, but a launcher entry that
    // runs nothing — or that steals another entry's identity — is worse than no
    // entry at all.
    if (!id || !bin || customCliIssue(c, all.slice(0, i))) return [];
    const name = c.name.trim() || binName(bin);
    const resumeArgs = c.resumeArgs?.trim();
    const promptArgs = c.promptArgs?.trim();
    return [
      {
        id,
        name,
        bin,
        // No brand mark exists for a CLI we've never heard of — AgentIcon falls
        // back to a terminal glyph, and this is the tab strip's fallback: the
        // initial, which at least tells two custom entries apart.
        icon: (name[0] ?? "▷").toUpperCase(),
        custom: true,
        resume: resumeArgs
          ? (sessionId, b) => `${b} ${expandArgs(resumeArgs, "{id}", sessionId)}`
          : undefined,
        prompt: promptArgs
          ? (text, b) => `${b} ${expandArgs(promptArgs, "{prompt}", shellQuote(text))}`
          : undefined,
      },
    ];
  });
}

/** Every entry as authored — what Canopy ships, then what the user added.
 *  Read this rather than BUILTIN_AGENT_CLIS anywhere the answer has to include
 *  a CLI Canopy has no knowledge of. */
export function agentCliDefs(): AgentCliDef[] {
  return [...BUILTIN_AGENT_CLIS, ...customCliDefs()];
}

/** Bind a definition to the binary this machine actually has. */
function bindCli(def: AgentCliDef, bin: string): AgentCli {
  const { resume, prompt, ...rest } = def;
  // `bin` stays raw on the entry — it is the key every probe answer and every
  // identity comparison is looked up under. Only the templates, which build a
  // line for a shell to read, get the quoted form.
  const arg = shellBin(bin);
  return {
    ...rest,
    bin,
    rebound: bin !== def.bin,
    resume: resume && ((id: string) => resume(id, arg)),
    prompt: prompt && ((text: string) => prompt(text, arg)),
  };
}

/**
 * The registry every consumer reads: the built-ins with the user's binary
 * overrides applied.
 *
 * Mutated in place by refreshAgentClis() rather than reassigned, because a
 * couple of dozen modules hold this array by import and would otherwise keep
 * pointing at the pre-override version.
 */
export const AGENT_CLIS: AgentCli[] = [];

/** Fired after the registry is re-resolved, so open menus re-render with the
 *  new binary rather than waiting for an unrelated state change. */
export const AGENT_CLIS_CHANGED_EVENT = "canopy:agentClis";

/** Fired when an installer or updater finishes, so every launcher re-probes.
 *
 *  A window event rather than a call, because what changed is a property of the
 *  machine and every open project shows its own launcher: installing Amp from
 *  one project used to leave every other project's card saying "install" until
 *  that view was remounted, which reads as the install having failed. */
export const CLI_INSTALLS_CHANGED_EVENT = "canopy:cliInstalls";

/** Announce that what's on PATH may have changed (see the event above). */
export function announceCliInstallsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CLI_INSTALLS_CHANGED_EVENT));
  }
}

/** Re-resolve the registry against the current settings. Called at boot and
 *  whenever an override is edited. */
export function refreshAgentClis(): void {
  const overrides = getSettings().cliBins;
  AGENT_CLIS.splice(
    0,
    AGENT_CLIS.length,
    ...agentCliDefs().map((d) => bindCli(d, overrides[d.id]?.trim() || d.bin)),
  );
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AGENT_CLIS_CHANGED_EVENT));
  }
}

refreshAgentClis();

/** Executable name -> agent id, matched exactly.
 *
 *  Exactly, and never as a substring or a prefix: this used to be a regex of
 *  alternatives tested against whole executable *paths*, where `\bomp\b` is a
 *  match inside `~/.omp/hooks/run.py` and `startsWith("amp")` is a match for
 *  `ampere`. A near-miss must produce no brand at all — see agentIdentity.ts.
 *
 *  A function rather than the frozen map it replaced: an override can change
 *  which name belongs to which CLI at runtime. Both names resolve — the vendor's
 *  and the user's — because a terminal remembered from before the override was
 *  set still carries the stock command. */
export function agentForBin(bin: string): string | undefined {
  const name = binName(bin);
  // A CLI the user added by hand outranks the bare-binary list: if they have
  // told us what `droid` is on this machine, that is what it is.
  const custom = AGENT_CLIS.find((c) => c.custom && binName(c.bin) === name);
  if (custom) return custom.id;
  if (EXTRA_AGENT_BINS.includes(name)) return name;
  const hit =
    AGENT_CLIS.find((c) => binName(c.bin) === name) ??
    BUILTIN_AGENT_CLIS.find((d) => d.bin === name);
  return hit?.id;
}

/** Package identity -> agent id. The rung that survives renaming: whatever an
 *  enterprise build calls its binary, it still ships from a package we know. */
export function agentForPkg(pkg: string): string | undefined {
  return BUILTIN_AGENT_CLIS.find((d) => (d.pkgs ?? []).includes(pkg))?.id;
}

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
        // A rebound binary is compared against nothing: `latestUrl` is the
        // vendor's public registry, and an enterprise build's version numbering
        // is its own. Probing it anyway would badge a sanctioned install as out
        // of date and offer to overwrite it with a public release.
        latestUrl: fresh || c.rebound ? null : (c.latestUrl ?? null),
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
    : { command: shellBin(cli.bin), typePrompt: true };
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
 *  before the resumed agent has emitted its first hook event.
 *
 *  Both the resolved and the stock binary are tried, so a terminal remembered
 *  from before an override was set still yields its session id — the command on
 *  disk names whichever binary was current when it was spawned. */
export function resumeSessionId(command: string | null | undefined): string | null {
  const cmd = (command ?? "").trim();
  if (!cmd) return null;
  const SENTINEL = "__CANOPY_SID__";
  const templates = agentCliDefs().flatMap((d) => {
    const bins = new Set([AGENT_CLIS.find((c) => c.id === d.id)?.bin ?? d.bin, d.bin]);
    // Each spelling as written *and* as quoted: a path with a space in it goes
    // to the shell quoted, so that is the form a remembered resume command
    // carries — while an id from before the override is still bare.
    return [...new Set([...bins].flatMap((bin) => [bin, shellBin(bin)]))].map((bin) =>
      d.resume?.(SENTINEL, bin),
    );
  });
  for (const tmpl of templates) {
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
