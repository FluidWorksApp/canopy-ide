// The companion's live session: one per app, outside React.
//
// Outside React for the same reason CollabManager is: the session outlives
// every component that shows it. The floating mascot unmounts when the setting
// is switched off, the chat panel unmounts every time it is closed, and a
// conversation that reset on either would not be a companion. React subscribes
// (useSyncExternalStore) rather than owning.
//
// The transcript here is a *view*. The conversation itself lives in the CLI,
// against the session id in settings, and survives quitting the app — which is
// what makes tomorrow's companion the same one as today's. What this holds is
// what to draw right now.

import * as ipc from "./ipc";
import {
  actionPolicy,
  companionSessionId,
  forgetCompanionSession,
  tierFor,
  type CompanionAuthority,
  type CompanionLaunch,
} from "./companion";
import { buildCompanionPrompt, type PromptProject } from "./companionPrompt";
import {
  startStructured,
  startTerminal,
  type CompanionEvent,
  type CompanionTransport,
} from "./companionTransport";
import { getSettings } from "./settings";
import { AGENT_CLIS, shellBin, shellQuote } from "./projects";

export type CompanionStatus =
  | "off"
  /** Process spawned, agent not yet reporting ready. */
  | "starting"
  | "ready"
  /** Mid-turn: a reply is being written. */
  | "working"
  /** It could not start, or it died. `error` says why. */
  | "failed"
  /** There is no agent CLI on this machine to run it on.
   *
   *  Distinct from `failed` because it is not a fault and there is nothing to
   *  report: the companion is on by default, so on a machine with no CLI yet
   *  this is simply the ordinary state. Surfaces render nothing for it rather
   *  than a mascot wearing a permanent error face. */
  | "unavailable";

export interface CompanionTool {
  name: string;
  detail?: string;
}

export interface CompanionMessage {
  id: string;
  who: "you" | "ash";
  text: string;
  /** Tools this reply ran, in order. Rendered as chips above the prose so the
   *  answer can be read without them, but where it came from is visible. */
  tools?: CompanionTool[];
  /** A message that reports a failure rather than an answer. */
  failed?: boolean;
}

/** Something the companion proposes to do, waiting on the user.
 *
 *  Held here rather than in the chat component because the agent is *blocked*
 *  on it: closing the panel must not lose the question, and the mascot has to
 *  be able to show that something is waiting even when nothing is open. */
export interface CompanionProposal {
  action: string;
  project?: string | null;
  detail?: string | null;
  timeoutMs?: number | null;
  /** The attention item raised alongside it, so answering can retire it. */
  attentionId?: string;
  resolve: (answer: { accepted: boolean; note?: string }) => void;
}

export interface CompanionState {
  status: CompanionStatus;
  messages: CompanionMessage[];
  /** Set when `status` is "failed", or when a turn reported a problem. */
  error: string | null;
  /** Which CLI is carrying it, for the panel header. */
  cliName: string;
  /** Bumped on restart so a stale transcript cannot look like a continuation. */
  generation: number;
}

const EMPTY: CompanionState = {
  status: "off",
  messages: [],
  error: null,
  cliName: "",
  generation: 0,
};

let state: CompanionState = EMPTY;
let transport: CompanionTransport | null = null;
/** Guards against two launches racing — the setting can be toggled faster than
 *  a CLI starts, and two children would both hold the same session id. */
let starting: Promise<void> | null = null;
/** What the current launch attempted, so a death can be diagnosed rather than
 *  just reported. A resume that dies before the session ever reports ready is
 *  a *stale session id*, not a broken CLI — and those need opposite responses. */
let attempt: { cliId: string; resumed: boolean; ready: boolean } | null = null;
/** Set while a failed resume is being retried from scratch, so the retry
 *  cannot itself trigger another retry. */
let healing = false;

export const COMPANION_EVENT = "canopy:companion";

const listeners = new Set<() => void>();

export function subscribeCompanion(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function companionState(): CompanionState {
  return state;
}

function set(patch: Partial<CompanionState>): void {
  state = { ...state, ...patch };
  for (const cb of [...listeners]) cb();
}

let seq = 0;
const nextId = () => `m${++seq}`;

/** The last message, when it is Ash's and still being written into. */
function openReply(): CompanionMessage | null {
  const last = state.messages[state.messages.length - 1];
  return last && last.who === "ash" ? last : null;
}

function amendReply(fn: (m: CompanionMessage) => CompanionMessage): void {
  const messages = state.messages.slice();
  const last = messages[messages.length - 1];
  if (!last || last.who !== "ash") {
    messages.push(fn({ id: nextId(), who: "ash", text: "" }));
  } else {
    messages[messages.length - 1] = fn(last);
  }
  set({ messages });
}

function onEvent(event: CompanionEvent): void {
  switch (event.kind) {
    case "ready":
      // Marked here, and only here. Marking it at spawn time was the bug that
      // made this necessary: a launch that died a millisecond later still
      // counted as "this CLI has a conversation", so every later start resumed
      // a session that had never existed and exited instantly.
      if (attempt) {
        attempt.ready = true;
        markRun(attempt.cliId);
      }
      set({ status: state.status === "working" ? "working" : "ready" });
      return;
    case "delta":
      amendReply((m) => ({ ...m, text: m.text + event.text }));
      return;
    case "reply":
      amendReply((m) => ({ ...m, text: m.text ? `${m.text}\n${event.text}` : event.text }));
      return;
    case "tool":
      amendReply((m) => ({
        ...m,
        tools: [...(m.tools ?? []), { name: event.name, detail: event.detail }],
      }));
      return;
    case "turnEnd": {
      // A turn that produced nothing at all is a failure the user has to see,
      // not an empty bubble: it means the CLI accepted the message and said
      // nothing back, which is indistinguishable from being ignored.
      const reply = openReply();
      if (reply && !reply.text.trim() && !(reply.tools ?? []).length) {
        amendReply((m) => ({
          ...m,
          failed: true,
          text: "No reply came back. The agent may have hit a limit — try again, or check Settings → Agents.",
        }));
      }
      set({ status: "ready" });
      return;
    }
    case "error":
      // Attached to the reply rather than replacing it: an error part-way
      // through a good answer must not delete the part that was useful.
      set({ error: event.message });
      return;
    case "exit": {
      transport = null;
      // A resume that never got as far as `ready` means the id is stale — the
      // conversation it names is gone, or never existed. Start a fresh one
      // rather than showing "Not connected" forever: the user cannot be
      // expected to know that a session id they have never seen is the reason
      // their companion is dead.
      const stale = isStaleResume(attempt, healing);
      if (stale && attempt) {
        const cliId = attempt.cliId;
        attempt = null;
        healing = true;
        forgetCompanionSession(cliId);
        clearRun(cliId);
        set({ status: "starting", error: null });
        void (lastStart ? startCompanion(lastStart) : Promise.resolve()).finally(() => {
          healing = false;
        });
        return;
      }
      attempt = null;
      set({ status: "failed", error: state.error ?? "The companion's agent stopped." });
      return;
    }
  }
}

export interface StartOptions {
  /** Every project in the workspace — the companion's reach. */
  projects: PromptProject[];
  /** Whether each CLI is actually on this machine. */
  installed: (bin: string) => boolean;
  /** Tools the bridge will hand this session, for the brief. */
  tools: string[];
}

/** Bring the companion up. Safe to call repeatedly — a session that is already
 *  running is left alone, which is what lets every mount call it. */
/** Whether a death means "the session id is stale" rather than "the CLI is
 *  broken".
 *
 *  A resume that never reached `ready` names a conversation the CLI does not
 *  have — it prints "No conversation found" and exits at once. That is
 *  recoverable (start a fresh one); a CLI that genuinely cannot run is not, and
 *  retrying it forever would be a spawn loop. `healing` is what stops the retry
 *  from retrying itself.
 *
 *  Exported for its test: this is the branch that decides between silently
 *  fixing itself and giving up, and it is not reachable from a unit test
 *  through the module's own state. */
export function isStaleResume(
  attempt: { resumed: boolean; ready: boolean } | null,
  healing: boolean,
): boolean {
  return Boolean(attempt && attempt.resumed && !attempt.ready && !healing);
}

let lastStart: StartOptions | null = null;

export async function startCompanion(opts: StartOptions): Promise<void> {
  if (transport || starting) return starting ?? undefined;
  lastStart = opts;
  starting = (async () => {
    const s = getSettings();
    const cli =
      AGENT_CLIS.find((c) => c.id === s.companionCli && opts.installed(c.bin)) ??
      AGENT_CLIS.find((c) => c.id === s.defaultAgent && opts.installed(c.bin)) ??
      AGENT_CLIS.find((c) => opts.installed(c.bin));
    if (!cli) {
      // Not an error, and deliberately not shown as one — see "unavailable".
      set({
        status: "unavailable",
        error: null,
      });
      return;
    }

    const roots = opts.projects.flatMap((p) => p.roots);
    const authority: CompanionAuthority = s.companionAuthority;
    const sessionId = companionSessionId(cli.id);
    const systemPrompt = buildCompanionPrompt({
      projects: opts.projects,
      authority,
      tools: opts.tools,
      cliName: cli.name,
    });
    const launch: CompanionLaunch = {
      bin: cli.bin,
      sessionId,
      systemPrompt,
      roots,
      model: s.companionModel,
      authority,
    };

    // CANOPY_COMPANION is what makes the session invisible: canopy_hook writes
    // no digest for it, so it appears in no listing — not the Agents panel, not
    // `canopy_agents`, not anything written later. It is also what unlocks the
    // companion-only tools. Both are properties of the session, carried by the
    // environment so they survive a resume.
    const env: [string, string][] = [
      ["CANOPY_COMPANION", "1"],
      ["CANOPY_COMPANION_AUTHORITY", authority],
      ["CANOPY_COMPANION_POLICY", actionPolicy(authority)],
    ];
    // No cwd: the Rust side puts it in ~/.canopy/companion. Starting it in a
    // project root made it inherit that repo's CLAUDE.md — one project's
    // coding-agent rules governing an assistant that answers about all of
    // them. Every root still reaches it through --add-dir.
    const cwd = undefined;

    set({
      status: "starting",
      error: null,
      cliName: cli.name,
      generation: state.generation + 1,
    });

    try {
      if (tierFor(cli.id) === "structured") {
        // Resume when there is a conversation to resume — which there is on
        // every launch after the first, and is the whole of "remembers who it
        // is". A first run has the id but no transcript behind it yet.
        const resume = Boolean(s.companionSessions[cli.id]) && hasRun(cli.id);
        attempt = { cliId: cli.id, resumed: resume, ready: false };
        transport = await startStructured(cli.id, launch, { emit: onEvent }, {
          resume,
          cwd,
          env,
        });
      } else {
        // No flag carries a brief for these, so it is typed in as the opening
        // message — see the tier note in companion.ts.
        // `cli.prompt` is already bound to the resolved binary (see AgentCli),
        // so it takes the text alone — the two-argument form is the registry's
        // internal one and would silently name the wrong executable here.
        const command = cli.prompt
          ? cli.prompt(systemPrompt)
          : `${shellBin(cli.bin)} ${shellQuote(systemPrompt)}`;
        attempt = { cliId: cli.id, resumed: false, ready: false };
        transport = await startTerminal({ emit: onEvent }, { command, cwd, env });
      }
    } catch (err) {
      transport = null;
      set({ status: "failed", error: String(err) });
    }
  })();
  try {
    await starting;
  } finally {
    starting = null;
  }
}

/** Whether this CLI's companion session has actually run before, as opposed to
 *  merely having an id minted for it. Resuming an id the CLI has never seen
 *  fails with "no conversation found", which would present as a companion that
 *  cannot start at all. */
const RUN_KEY = "canopy.companion.ran";
function hasRun(cliId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(RUN_KEY) ?? "[]") as string[]).includes(cliId);
  } catch {
    return false;
  }
}
function markRun(cliId: string): void {
  try {
    const seen = new Set(
      JSON.parse(localStorage.getItem(RUN_KEY) ?? "[]") as string[],
    );
    seen.add(cliId);
    localStorage.setItem(RUN_KEY, JSON.stringify([...seen]));
  } catch {
    // A companion that cannot remember it has run merely starts fresh.
  }
}

/** Forget that a CLI has run, so the next start is a first one. Paired with
 *  forgetting the session id — the two have to move together or a fresh id gets
 *  resumed and fails. */
export function clearRun(cliId: string): void {
  try {
    const seen = (JSON.parse(localStorage.getItem(RUN_KEY) ?? "[]") as string[]).filter(
      (id) => id !== cliId,
    );
    localStorage.setItem(RUN_KEY, JSON.stringify(seen));
  } catch {
    // Nothing to do — the next start simply behaves as a resume and recovers.
  }
}

export async function stopCompanion(): Promise<void> {
  const t = transport;
  transport = null;
  set({ ...EMPTY, generation: state.generation });
  await t?.stop().catch(() => {});
  await ipc.companionKill().catch(() => {});
}

/** Send a message. Adds the user's turn and an empty reply for the stream to
 *  fill, so the chat shows the question landing immediately rather than after
 *  the first token. */
export async function sendToCompanion(text: string): Promise<void> {
  const body = text.trim();
  if (!body || !transport || state.status === "working") return;
  set({
    status: "working",
    error: null,
    messages: [
      ...state.messages,
      { id: nextId(), who: "you", text: body },
      { id: nextId(), who: "ash", text: "" },
    ],
  });
  try {
    await transport.send(body);
  } catch (err) {
    set({ status: "ready", error: String(err) });
  }
}

/** Clear what is on screen. Deliberately not a new conversation: the CLI still
 *  holds the transcript, so this is tidying the panel, and the companion still
 *  remembers. Starting over is `forgetCompanionSession`, in Settings. */
export function clearCompanionView(): void {
  set({ messages: [], error: null });
}
