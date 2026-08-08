// Small persistent settings, stored in localStorage. Keep this flat and cheap.
import type { CustomMicroTask } from "./microTasks";
// Type-only, so the projects.ts ↔ settings.ts pair stays a compile-time cycle
// and never a runtime one.
import type { CustomAgentCli } from "./projects";
// Type-only for the same reason, and the cycle is the same shape: companion.ts
// reads settings to resolve the name, the CLI and the authority.
import type { CompanionAuthority, CompanionSpot } from "./companion";
import type { BrowserEngine } from "./browserBounds";
// Type-only for the same reason as projects.ts above: mascots.ts reads
// getSettings(), so this pair must stay a compile-time cycle only.
import type { MascotId } from "./mascots";
import type { CaptureMode } from "./pageCapture";
import { IS_MAC } from "./platform";
import { SKINS, type SkinId } from "./skins/registry";
import {
  formatChord,
  isShortcutProfile,
  keyLabel as chordKeyLabel,
  matchesChord,
  modifierLabel,
  requireKeyChord,
  type ShortcutProfile,
} from "./shortcuts";

/** Every skin in the roster, plus the one id that isn't a skin: "auto",
 *  which resolves to one of them. Adding a skin to src/skins/registry.ts adds
 *  it here.
 *
 *  Retiring one is just as cheap and needs no migration: a stored id that has
 *  left the roster stops matching any CSS block, so the app falls through to
 *  the `:root` contract, and skinDef() answers with the base skin for the
 *  terminal and Monaco.
 *
 *  "custom" used to live here — the base skin with the user's accent written
 *  in at runtime. It was a skin-shaped hole in a list of skins: it had no
 *  palette of its own, no terminal or Monaco theme, and picking it silently
 *  swapped whatever skin you were on for Gotham. The accent override it
 *  existed for was never actually tied to it — `customAccent` applies over
 *  ANY skin (see applyTheme), which is the model that makes sense: Ember with
 *  a teal accent is a legitimate thing to want and never required giving up
 *  Ember. `migrateTheme` moves anyone still holding the id. */
export type Theme = "auto" | SkinId;

/** A stored theme id, as a Theme — mapping the retired "custom" onto what it
 *  actually rendered as. Custom was the base skin plus an accent, and the
 *  accent lives on separately, so Gotham is not an approximation of what that
 *  user was looking at: it is the same window. */
export function migrateTheme(stored: unknown): Theme {
  return stored === "custom" ? "gotham" : (stored as Theme);
}

/** What "auto" means right now: Gotham when macOS is in dark mode, Daylight
 *  in light mode. Every consumer of the skin (CSS data-theme, terminal
 *  palettes, Monaco) works off the resolved value — "auto" itself never
 *  reaches them. */
export function resolveTheme(theme: Theme): Exclude<Theme, "auto"> {
  if (theme !== "auto") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "gotham"
    : "daylight";
}

/** Re-apply the skin when the OS flips day/night while the setting is Auto.
 *  Returns an unsubscribe. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const s = getSettings();
    if (s.theme === "auto") applyTheme("auto", s.customAccent);
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export const THEMES: { id: Theme; label: string }[] = [
  { id: "auto", label: "Auto" },
  ...SKINS.map((s) => ({ id: s.id as Theme, label: s.label })),
];

/** Shared across Monaco and xterm even though neither uses these names
 *  natively — Monaco calls "bar" "line", xterm doesn't have Monaco's
 *  line-thin/block-outline variants. Personalize.tsx maps to whichever each
 *  engine actually wants. */
export type CursorStyle = "block" | "underline" | "bar";

/** What the held Ctrl+Tab switcher walks.
 *
 * "recent" answers "where was I?" and makes a quick press return to the
 * previous context. "order" answers "what is next to this?" and follows the
 * user's stable tab arrangement. "items" answers "what was I working on?" —
 * it walks clusters of tabs joined on recorded edges (a session, its
 * workspace, its PR, its preview, its files; see workItems.ts). Direct
 * Next/Previous Tab commands stay positional whichever mode is selected. */
export type TabSwitchMode = "recent" | "order" | "items";

/** A dictation hotkey as captured from a keydown: the modifier flags plus the
 *  physical `KeyboardEvent.code` (layout-independent, so it survives non-US
 *  keyboards). */
export interface Hotkey {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  code: string;
}

/** Fallback chord for people who explicitly choose combo mode. */
export const DEFAULT_DICTATION_HOTKEY: Hotkey = requireKeyChord("dictation");

/** Default hotkey for the recent-dictation picker: ⌃⌘V on Mac (SuprFlow's
 *  binding, and free of any system paste), ⌃⌥V elsewhere — Ctrl+Shift+V is
 *  terminal paste on Windows and Linux, so it is deliberately avoided. */
export const DEFAULT_DICTATION_HISTORY_HOTKEY: Hotkey = IS_MAC
  ? { meta: true, ctrl: true, alt: false, shift: false, code: "KeyV" }
  : { meta: false, ctrl: true, alt: true, shift: false, code: "KeyV" };

/** How dictation is triggered.
 *
 *  "combo" — a configurable chord, pressed to start and again to insert.
 *
 *  "hold" — push-to-talk on ONE bare modifier: hold it, speak, release and the
 *  text lands. Double-tapping the same key instead latches recording on so you
 *  can let go (SuprFlow's "hands-free"); the next tap ends it.
 *
 *  "doubleTap" — two quick taps of one bare modifier starts a latched
 *  recording, a single tap ends it. Nothing is held while you speak.
 *
 *  The bare-modifier modes exist because a modifier is the only key you can
 *  press on its own without also typing something. They are safe to bind
 *  because of the pollution rule in dictationTrigger.ts: a modifier that had
 *  any other key pressed while it was down was being used as a modifier, and
 *  never triggers. That is what keeps ⇧A from starting a recording. */
export type DictationTriggerMode = "combo" | "hold" | "doubleTap";

/** A single modifier that can carry a bare-key trigger. The bare names match
 *  either side of the keyboard; the sided ones (…Left/…Right) match exactly,
 *  which is how you bind a key you never otherwise touch. CapsLock is offered
 *  because it is dead weight for most people — but note it is a LATCHING key,
 *  so "hold CapsLock" means "caps on for as long as you speak". */
export type DictationModKey =
  | "Shift"
  | "ShiftLeft"
  | "ShiftRight"
  | "Control"
  | "ControlLeft"
  | "ControlRight"
  | "Alt"
  | "AltLeft"
  | "AltRight"
  | "CapsLock";

/** Left Shift is easy to reach and remains safe for ordinary typing because a
 *  press is discarded as soon as another key is used with it. */
export const DEFAULT_DICTATION_MOD_KEY: DictationModKey = "ShiftLeft";
const DICTATION_TRIGGER_REVISION = 2;

function isFormerDefaultDictationHotkey(h: Hotkey | undefined): boolean {
  if (!h || h.code !== "KeyD" || h.shift) return false;
  const current = DEFAULT_DICTATION_HOTKEY;
  if (
    h.meta === current.meta &&
    h.ctrl === current.ctrl &&
    h.alt === current.alt
  ) return true;
  // Before pane splitting took ⌘D, this was the shipped macOS default.
  return h.meta && !h.ctrl && !h.alt;
}

/** Display label for a bare-modifier trigger key. */
export function modKeyLabel(k: DictationModKey): string {
  const side = k.endsWith("Left")
    ? "Left "
    : k.endsWith("Right")
      ? "Right "
      : "";
  const base = k.replace(/(Left|Right)$/, "");
  if (base === "CapsLock") return "Caps Lock";
  return side + modifierLabel(base as "Shift" | "Control" | "Alt" | "Meta");
}

/** The visualiser drawn in the recording pill while the mic is live. Ported
 *  from SuprFlow's wave styles; each is a canvas renderer in waveStyles.ts. */
export type DictationWaveStyle =
  "classic" | "equalizer" | "particle" | "ribbon" | "pulse" | "neon";

export const DICTATION_WAVE_STYLES: {
  id: DictationWaveStyle;
  label: string;
  hint: string;
}[] = [
  { id: "classic", label: "Classic", hint: "Simple animated bars" },
  { id: "equalizer", label: "Equalizer", hint: "Audio bars with reflection" },
  { id: "particle", label: "Particle", hint: "Flowing wave with particles" },
  { id: "ribbon", label: "Ribbon", hint: "Filled gradient ribbon" },
  { id: "pulse", label: "Pulse", hint: "Concentric pulsing rings" },
  { id: "neon", label: "Neon", hint: "Glowing double sine" },
];

/** Render a hotkey for display, e.g. "⌘D" or "Alt+Shift+D". A Hotkey is
 *  structurally a resolved Chord, so display and comparison come from the
 *  registry — this is the one shortcut the user can rebind, which is why it is
 *  stored rather than looked up by id. */
export function formatHotkey(h: Hotkey): string {
  return formatChord(h);
}

/** Human label for a KeyboardEvent.code (KeyD → "D", Digit1 → "1"). */
export function keyLabel(code: string): string {
  return chordKeyLabel(code);
}

/** Does this keydown match the configured hotkey? */
export function matchesHotkey(e: KeyboardEvent, h: Hotkey): boolean {
  return matchesChord(e, h);
}

export const TERMINAL_FONT_DEFAULT =
  "'SF Mono', Menlo, Monaco, 'JetBrains Mono', 'Fira Code', monospace";
export const EDITOR_FONT_DEFAULT =
  "'SF Mono', Menlo, Monaco, 'JetBrains Mono', 'Fira Code', monospace";

export interface Settings {
  scrollback: number;
  /** Workbench shortcut preset. Imported editor-specific customizations can be
   * layered above this later without changing the semantic command catalog. */
  keymapProfile: ShortcutProfile;
  /** Terminal font size — kept under its original name for backward compat
   *  with everyone who already has it in localStorage. */
  fontSize: number;
  // Runaway-process guard thresholds (per PTY session process tree)
  runawayCpuPercent: number;
  runawayMemBytes: number;
  ptyHighWater: number;
  /** Per-tracker secrets for the Issue Trackers panel, keyed by provider id
   *  (see src/trackers.ts). Local-only: sent nowhere but the tracker's own
   *  API, straight from this machine. */
  trackerKeys: Record<string, string>;
  theme: Theme;
  /** Highlight color, applied on top of WHATEVER skin is active — a skin
   *  sets the whole palette, the accent is one colour within it, and there
   *  is no reason picking a purple should force you off Daylight. Empty
   *  string means "use the skin's own accent". A luminance-derived
   *  --on-accent rides along so accent-filled buttons stay legible without
   *  the user having to pick a second colour. */
  customAccent: string;
  // ---- The companion (companion.ts) ----
  /** Whether the mascot is a *companion* — floating over every project, with a
   *  session of its own — rather than only the face other surfaces wear.
   *
   *  On by default: the companion is the point of the mascot, and a feature
   *  nobody finds is a feature nobody has. It does start a real agent CLI that
   *  stays running and spends tokens, so two things keep that honest — it only
   *  starts once a CLI is actually installed, and its default authority asks
   *  before it changes anything (see CompanionAuthority).
   *
   *  Note this reaches new installs only. Stored settings win over defaults
   *  (see getSettings), so anyone who has already switched it off stays off,
   *  which is the correct outcome — a preference somebody set is not a
   *  question to re-ask on upgrade. */
  companionEnabled: boolean;
  /** What the user calls it. Empty means the mascot's own name (see
   *  companionName), which is what keeps a second mascot from arriving
   *  nameless. */
  companionName: string;
  /** Registry id of the CLI it runs on. Empty follows `defaultAgent`, so
   *  someone who never opens this screen gets the agent they already use. */
  companionCli: string;
  /** Model for that CLI. Empty means the CLI's own default — the only honest
   *  value for a CLI whose catalogue is per-account (see agentModels.ts). */
  companionModel: string;
  /** What it may do without asking. See CompanionAuthority: the default asks
   *  before anything that changes the world, because this is the one agent
   *  that can act in a project the user is not looking at. */
  companionAuthority: CompanionAuthority;
  /** Where it was left, as a fraction of the window (see CompanionSpot).
   *  Fractions rather than pixels so the position survives a resize. */
  companionSpot: CompanionSpot;
  /** Its conversation, per CLI — the companion's memory of the user is that
   *  transcript, so the id has to outlive the app. Keyed by registry id
   *  because a session id belongs to the CLI that issued it: switching agent
   *  and switching back returns to the right conversation rather than losing
   *  both. */
  companionSessions: Record<string, string>;

  /** Which mascot the app wears (mascots.ts). Stored as an id rather than
   *  anything drawable, so a build that adds or drops one reads an old
   *  settings file fine — `currentMascot` falls back when the id is unknown.
   *  Not a boolean: "which" is the question, and a second mascot should be a
   *  registry entry rather than a schema change. */
  mascot: MascotId;

  // ---- Side panel behaviour (Appearance). Three independent choices about
  // one panel: how it opens, how it closes, and whether it covers the work or
  // moves it aside.
  /** Settle the pointer on a rail icon and the panel comes out on its own. Off
   *  by default: a panel that appears because you passed over an icon on the
   *  way somewhere else is a panel you didn't ask for. */
  sidebarHover: boolean;
  /** A click in the content area puts the panel away. On by default — while
   *  the panel overlays the editor, a click past it is someone reaching for
   *  what's underneath, and having to click twice is the one thing an overlay
   *  must not do. */
  sidebarClickOutsideCloses: boolean;
  /** The panel floats over the content instead of taking a column from it. On
   *  by default: docking it reflows the main area every time it opens, which
   *  re-wraps every terminal in it. Turn it off to have the panel push the
   *  editor aside and stay out of its way. */
  sidebarOverlay: boolean;

  // ---- Personalize: font + cursor, Editor (Monaco) and Terminal (xterm)
  // independently — different rendering engines, so neither shares the
  // other's font metrics or cursor vocabulary. Applied to newly opened
  // terminals/editor tabs, same as `fontSize`/`scrollback` already were —
  // there's no live-remount of what's already open, consistent with how
  // those two settings have always behaved (no Settings screen has ever
  // pushed a change into an already-open Term/Monaco instance).
  terminalFontFamily: string;
  terminalCursorStyle: CursorStyle;
  terminalCursorBlink: boolean;
  editorFontFamily: string;
  editorFontSize: number;
  editorCursorStyle: CursorStyle;
  editorCursorBlink: boolean;
  /** File pattern -> Monaco language id, the user's own overrides only
   *  (Settings → Editor → File associations). Canopy's shipped table lives in
   *  fileAssociations.ts and is deliberately NOT copied in here: storing it
   *  would freeze today's list into every existing install, so a mapping added
   *  in a later version would never reach anyone who has opened this screen.
   *  Re-pointing a shipped pattern writes an entry under the same key. */
  fileAssociations: Record<string, string>;
  /** Which agent CLI starts work on a ticket (registry id in projects.ts).
   *  Was hardcoded to claude, which quietly made every other agent a
   *  second-class citizen in a product built to run all of them. */
  defaultAgent: string;
  /** Launch every agent with its CLI's own skip-permissions flag (claude
   *  --dangerously-skip-permissions, codex
   *  --dangerously-bypass-approvals-and-sandbox, …see skipPermissions in
   *  projects.ts), so nothing stops to ask before acting. Off by default and
   *  it must stay that way: this removes the one confirmation standing
   *  between an agent and the machine, so it has to follow a decision the
   *  user made in front of the warning, never an upgrade. Read at
   *  command-build time, so flipping it affects the next launch — sessions
   *  already running keep the mode they started with. A CLI with no verified
   *  flag (amp) launches unchanged. */
  dangerouslySkipPermissions: boolean;
  /** Registry id -> the executable this machine actually has, for CLIs whose
   *  binary isn't the name the vendor ships: an enterprise build of Claude Code
   *  installed as `acme-claude`, or a wrapper at an absolute path. Without it
   *  the launcher probes the stock name, finds nothing, and offers to install a
   *  second copy the user often isn't allowed to authenticate.
   *
   *  Machine-wide rather than per-project: an enterprise wrapper is a property
   *  of the workstation. A single executable or path only — arguments belong in
   *  a launch command, and a multi-token value would break both `command -v`
   *  and the basename match that recognises the CLI once it is running. */
  cliBins: Record<string, string>;
  /** The account every agent CLI launches under (see profiles.ts).
   *
   *  One switch rather than one per CLI: "who am I working as" is a single
   *  question. A CLI the account has no login for still launches and asks you
   *  to sign in, which the switcher and ＋ menu say up front. "default" exports
   *  no environment at all. */
  activeProfile: string;
  /** Agent CLIs Canopy ships no entry for, described by the user (Settings →
   *  Agents). Machine-wide for the same reason as `cliBins`: an in-house agent
   *  is a property of the workstation, not of one repo. See CustomAgentCli for
   *  what an entry can and deliberately cannot say. */
  customClis: CustomAgentCli[];
  /** Display name on the team relay, remembered from the last host/join. */
  relayName: string;
  /** Last relay address joined, prefilled on the next join. */
  relayAddr: string;
  /** Reclaim memory from finished background agents automatically. Off by
   *  default: hibernating kills the terminal, and a terminal's scrollback
   *  exists nowhere else — so this stays a choice, never a surprise. When on,
   *  only sessions that are idle or ended (never mid-turn) and beyond
   *  `maxLiveAgents`, oldest first, are hibernated; each stays resumable. */
  autoHibernate: boolean;
  /** Offer sessions whose agent tab the user explicitly closed. Off by default:
   *  Restorable is primarily crash/app-shutdown recovery, and repeatedly opening
   *  and closing work should not grow that list. */
  restoreUserClosedSessions: boolean;
  /** How many agent terminals to keep live per project before auto-hibernation
   *  starts reclaiming the stalest idle ones. */
  maxLiveAgents: number;
  /** Fold the agent tab strip into Needs you / Working / Idle stacks instead of
   *  leaving it in open order. The tab you are looking at never changes when it
   *  restacks — only where it sits in the strip, and it is never the one folded
   *  away. */
  groupTabsByStatus: boolean;
  /** Ordering used by the held Ctrl+Tab switcher. */
  tabSwitchMode: TabSwitchMode;
  /** How long an agent has to stay quiet before its tab falls into the Idle
   *  stack. Promotions (a question, fresh work) are always immediate; only the
   *  fall is delayed, so an agent pausing between tool calls doesn't shuffle
   *  the strip under your pointer. */
  idleGroupDelaySeconds: number;
  /** Where the user's own micro-tasks used to live, back when they were
   *  app-wide. They belong to a project now (`Project.customTasks`), and
   *  adoptLegacyCustomTasks() empties this on first launch. Kept so that
   *  migration has something to read; nothing writes tasks here any more. */
  customMicroTasks: CustomMicroTask[];
  /** Let an agent-requested reveal select its project and tab. Off keeps files,
   * previews, and run tabs available in the background without interrupting
   * whatever the user is doing. Questions and notices still reach the shared
   * attention queue; this only controls automatic focus changes. */
  agentAskForAttention: boolean;
  /** canopy_* MCP tools the user switched off (Settings → Agents). Stored as
   *  the exceptions, not the whole set, so a tool added in a later version is
   *  on by default rather than invisible to everyone who ever opened this
   *  screen. Published to the bridge, where the sidecar filters its tool list —
   *  a disabled tool costs the agent no context at all. */
  disabledTools: string[];

  /** Adopt loose Markdown files under open project roots into Research. On by
   *  default so existing project knowledge becomes findable; path-based
   *  deduplication makes repeated sweeps safe. */
  autoImportMarkdownResearch: boolean;

  // ---- SpotSearch (⌘K) ----
  /** Sources the omnibox must not ask (ids from spotSources.ts). Stored as the
   *  exceptions, like `disabledTools`, so a source added in a later version is
   *  searched by default rather than invisible to everyone who has ever opened
   *  this screen. */
  spotDisabledSources: string[];
  /** Agent CLIs whose conversations must not be indexed, by registry id. Also
   *  exceptions-only, so an agent Canopy learns to read later is covered
   *  without anyone revisiting this screen. Switching one off purges what is
   *  already indexed on the next ingest — "don't index my conversations with X"
   *  has to mean the ones already in there too. */
  spotDisabledAgents: string[];
  /** Index live terminal scrollback. Same purge-on-off rule. */
  spotIndexTerminals: boolean;
  /** Search every project's history, not just the one you have open. Off by
   *  default: a palette floating over one project that answers from another is
   *  surprising, and the rows open a directory you weren't in. */
  spotSearchAllProjects: boolean;
  /** Drop indexed messages older than this many days. 0 keeps everything,
   *  which is the default — this is a search index over your own work, not a
   *  log to be rotated. */
  spotRetentionDays: number;

  // ---- Clipboard history ----
  /** Keep what you copy, so ⌘K can hand it back. Off by default and it must
   *  stay that way: the first programmatic pasteboard read is what raises
   *  macOS's pasteboard alert, and that has to follow a decision the user
   *  made rather than an upgrade. */
  clipboardHistory: boolean;
  /** Write the history to ~/.canopy/clipboard.sqlite. Off keeps it in memory
   *  for the session only — and deletes the file that was there. */
  clipboardPersist: boolean;
  /** How many clips to keep. */
  clipboardKeep: number;
  /** Drop clips older than this many days. 0 keeps them all (up to the count). */
  clipboardRetentionDays: number;
  /** Skip clips that look like credentials — a known key prefix, a named
   *  `TOKEN=` line, a high-entropy token. Clips marked concealed by their
   *  producer are skipped whatever this says. */
  clipboardSkipSecrets: boolean;

  // ---- Voice dictation ----
  /** Hotkey that toggles dictation (start/insert). Used by "combo" mode. */
  dictationHotkey: Hotkey;
  /** How the mic is armed — see DictationTriggerMode. */
  dictationTriggerMode: DictationTriggerMode;
  /** Which bare modifier carries the trigger in "hold"/"doubleTap" mode. */
  dictationModKey: DictationModKey;
  /** Internal revision for one-time trigger-default migrations. */
  dictationTriggerRevision: number;
  /** Hotkey that opens the recent-dictation picker. Hold its modifiers and tap
   *  its key to walk back through what you said; release to paste. */
  dictationHistoryHotkey: Hotkey;
  /** Registry id of the ASR model to use (see dictation.rs MODELS). Empty
   *  means "the default model" so a stored blank never pins a missing id. */
  dictationModel: string;
  /** Optional BCP-47 language hint passed at transcription time. Empty =
   *  auto-detect (what multilingual models do anyway). */
  dictationLanguage: string;
  /** Re-decode a rolling tail of the audio while you speak and show it in the
   *  pill. Off by default: it is a second inference loop running the whole
   *  time you talk, which costs a core. It changes nothing about the text that
   *  finally lands — that always comes from one clean decode of the whole
   *  recording. This is a preview, not a faster path. */
  dictationStreaming: boolean;
  /** Which visualiser the recording pill draws. */
  dictationWaveStyle: DictationWaveStyle;
  /** Silence the speakers while the mic is open, so whatever is playing does
   *  not end up in the transcript. Mutes the default output device — it cannot
   *  pause a player, and it is system-wide, not just Canopy. Restored the
   *  moment recording ends. */
  dictationMuteOutput: boolean;

  // ---- Remote access ----
  /** Reach for the remote control panel: "local" (this network only) or
   *  "internet" (public link via a tunnel). The server toggle and the tunnel
   *  are backend state, but this is a UI selection that would otherwise reset
   *  to "local" every time Settings is reopened. */
  remoteReach: "local" | "internet";
  /** Which tunnel provider the Public link section had selected (see TUNNELS
   *  in SettingsDialog.tsx). Persisted alongside remoteReach so reopening
   *  Settings restores the whole choice, not just the running link. */
  remoteTunnelProvider: string;

  // ---- Embedded browser ----
  /** Which engine preview tabs run on.
   *
   *  "proxy" is an iframe on a loopback reverse proxy: ordinary DOM, so
   *  panels and menus paint over it, screenshots see it, and nothing has to
   *  be hidden for anything. The cost is that every site is served from one
   *  origin, so sessions are shared and do not survive a restart.
   *
   *  "webview" is a real child webview at the page's real origin with a
   *  persistent profile — log into a site once and stay logged in. It buys
   *  that with two limits neither this app nor Tauri can lift:
   *
   *    * a child webview is composited ABOVE the whole window and there is no
   *      z-order API for it (tauri-apps/tauri#9798; Electron's BrowserView is
   *      the same), so anything drawn over it forces the page off screen;
   *    * a hidden WKWebView does not render and cannot be made to — Apple
   *      exposes no API for offscreen rendering — so a page that loads behind
   *      a panel comes back blank until something forces a repaint.
   *
   *  Everything in browserHost.ts, browserFrame.ts and the freeze-frame
   *  machinery exists to soften those two facts. The proxy needs none of it —
   *  VS Code's Simple Browser is an iframe for exactly that reason — which is
   *  what makes it the right fallback when a session does not matter.
   *
   *  The default, because a preview of your own app is usually a preview of
   *  it logged in, and that is the only engine that can hold a session. The
   *  compensation above is the price; opening a preview closes the panel that
   *  would cover it, which is the case that actually bit. */
  browserEngine: BrowserEngine;

  /** What the preview's Screenshot button grabs when clicked without opening
   *  its menu. Remembered rather than fixed: whichever mode you picked last is
   *  almost always the one you want next, and a mode chooser you have to
   *  re-answer every time is a mode chooser nobody uses. */
  previewCaptureMode: CaptureMode;

  // ---- Workspaces ----
  /** The number the repo's own checkout serves on. Workspaces lease offsets
   *  from it, so a second checkout of the same repo can run its dev server
   *  alongside the first instead of losing the port race. */
  workspaceBasePort: number;
  /** Leased offsets, `repo path -> workspace path -> offset`. Persisted because
   *  a port that moves between restarts is a bookmark that stops working. */
  workspacePorts: Record<string, Record<string, number>>;
  /** Carry the gitignored config and clone the dependencies into a new
   *  workspace, so it can build the moment it exists. Off means a bare
   *  `git worktree add`, which is what this used to do. */
  workspaceBootstrap: boolean;

  // ---- Crash reporting ----
  /** Opt-in, default off: when a panel crashes (or a native panic is found on
   *  the next launch), offer to send an anonymous report — message + stack,
   *  app version, OS/arch — to the collector baked into the build. Nothing
   *  leaves the machine unless this is on. */
  crashReporting: boolean;
}

// NB: stored settings override these (see getSettings), so flipping a default
// does nothing for anyone who already has the key in localStorage. A setting
// that must actually change for existing users has to be removed outright —
// which is exactly why `webgl` is gone rather than defaulted to false.
export const DEFAULTS: Settings = {
  scrollback: 5_000,
  keymapProfile: "canopy",
  fontSize: 13,
  runawayCpuPercent: 300,
  runawayMemBytes: 4 * 1024 * 1024 * 1024,
  ptyHighWater: 2 * 1024 * 1024,
  defaultAgent: "claude",
  dangerouslySkipPermissions: false,
  cliBins: {},
  activeProfile: "default",
  customClis: [],
  relayName: "",
  relayAddr: "",
  autoHibernate: false,
  restoreUserClosedSessions: false,
  maxLiveAgents: 8,
  groupTabsByStatus: true,
  tabSwitchMode: "recent",
  idleGroupDelaySeconds: 60,
  customMicroTasks: [],
  agentAskForAttention: false,
  disabledTools: [],
  autoImportMarkdownResearch: true,
  trackerKeys: {},
  theme: "gotham",
  customAccent: "",
  companionEnabled: true,
  companionName: "",
  companionCli: "",
  companionModel: "",
  companionAuthority: "confirm",
  // The literal, not `DEFAULT_SPOT`, for the same reason as `mascot` below:
  // companion.ts reads settings, so importing its value here at module scope
  // would make the compile-time cycle a runtime one. companion.test.ts asserts
  // the two stay in agreement.
  companionSpot: { x: 0.97, y: 0.86 },
  companionSessions: {},
  // The literal, not `DEFAULT_MASCOT`: mascots.ts reads settings, so importing
  // a *value* back from it would be a live cycle evaluated while this very
  // object is being built. The type import below is erased and safe, and
  // mascots.test.ts asserts the two stay in agreement.
  mascot: "ash",
  sidebarHover: false,
  sidebarClickOutsideCloses: true,
  sidebarOverlay: true,
  terminalFontFamily: TERMINAL_FONT_DEFAULT,
  terminalCursorStyle: "block",
  terminalCursorBlink: true,
  editorFontFamily: EDITOR_FONT_DEFAULT,
  editorFontSize: 13,
  editorCursorStyle: "bar",
  editorCursorBlink: true,
  fileAssociations: {},
  spotDisabledSources: [],
  spotDisabledAgents: [],
  spotIndexTerminals: true,
  spotSearchAllProjects: false,
  spotRetentionDays: 0,
  clipboardHistory: false,
  clipboardPersist: true,
  clipboardKeep: 200,
  clipboardRetentionDays: 0,
  clipboardSkipSecrets: true,
  dictationHotkey: DEFAULT_DICTATION_HOTKEY,
  dictationTriggerMode: "hold",
  dictationModKey: DEFAULT_DICTATION_MOD_KEY,
  dictationTriggerRevision: DICTATION_TRIGGER_REVISION,
  dictationHistoryHotkey: DEFAULT_DICTATION_HISTORY_HOTKEY,
  dictationModel: "",
  dictationLanguage: "",
  dictationStreaming: false,
  dictationWaveStyle: "classic",
  dictationMuteOutput: true,
  remoteReach: "local",
  remoteTunnelProvider: "cloudflare",
  browserEngine: "webview",
  previewCaptureMode: "visible",
  workspaceBasePort: 5173,
  workspacePorts: {},
  workspaceBootstrap: true,
  crashReporting: false,
};

/** Hard renderer ownership boundary. The settings UI lets the user explicitly
 * raise scrollback within this range, but persisted/hand-edited state must not
 * turn xterm's row retention into an unbounded allocation. */
export const TERMINAL_SCROLLBACK_MIN_ROWS = 1_000;
export const TERMINAL_SCROLLBACK_MAX_ROWS = 100_000;

const boundedScrollback = (value: unknown): number => {
  const rows = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULTS.scrollback;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX_ROWS,
    Math.max(TERMINAL_SCROLLBACK_MIN_ROWS, rows),
  );
};

const KEY = "canopy.settings";

/** Parsed-settings cache, keyed on the raw stored string: getSettings is
 *  called from render paths, and re-parsing per call added up. Keying on the
 *  raw string (rather than invalidating on our own writes) stays correct when
 *  something else touches the key — tests do. Also makes the returned object
 *  identity-stable between writes. */
let settingsCache: { raw: string | null; value: Settings } | null = null;

export function getSettings(): Settings {
  const raw = localStorage.getItem(KEY);
  if (settingsCache && settingsCache.raw === raw) return settingsCache.value;
  let value: Settings;
  try {
    const stored = JSON.parse(raw ?? "{}") as Partial<Settings>;
    value = { ...DEFAULTS, ...stored };
    value.scrollback = boundedScrollback(stored.scrollback);
    if (stored.dictationTriggerRevision !== DICTATION_TRIGGER_REVISION) {
      // Full settings snapshots made the old combo look user-selected on every
      // existing install. Move only its unchanged default to the new gesture;
      // a customized combo remains customized.
      if (
        stored.dictationTriggerMode === "combo" &&
        isFormerDefaultDictationHotkey(stored.dictationHotkey)
      ) {
        value.dictationTriggerMode = "hold";
      }
      // Command is reserved for application and system shortcuts, so retired
      // bare-Command selections fall back to the new safe default.
      if (String(stored.dictationModKey ?? "").startsWith("Meta")) {
        value.dictationModKey = DEFAULT_DICTATION_MOD_KEY;
      }
      value.dictationTriggerRevision = DICTATION_TRIGGER_REVISION;
    }
    // The one stored value that can name something that no longer exists.
    value.theme = migrateTheme(value.theme);
    if (!isShortcutProfile(value.keymapProfile)) value.keymapProfile = "canopy";
    // The chromium engine is gone; anyone who had it selected gets the
    // default back rather than an unknown value every chooseEngine call
    // would have to defend against.
    if ((value.browserEngine as string) === "chromium") value.browserEngine = "webview";
  } catch {
    value = { ...DEFAULTS };
  }
  settingsCache = { raw, value };
  return value;
}

/** Fired after any settings write. Most settings are read where they're used
 *  and need nothing; the ones that change how a live surface behaves (the side
 *  panel's three) are held in component state, and this is how they hear. */
export const SETTINGS_CHANGE_EVENT = "canopy:settings-changed";

/** Subscribe form of SETTINGS_CHANGE_EVENT, for `useSyncExternalStore`. Here
 *  rather than in each component so the event name has one spelling. */
export function subscribeSettings(cb: () => void): () => void {
  window.addEventListener(SETTINGS_CHANGE_EVENT, cb);
  return () => window.removeEventListener(SETTINGS_CHANGE_EVENT, cb);
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  next.scrollback = boundedScrollback(next.scrollback);
  localStorage.setItem(KEY, JSON.stringify(next));
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(SETTINGS_CHANGE_EVENT));
  return next;
}

/** Relative luminance (WCAG) from a #rrggbb hex string — used to decide
 *  whether text sitting on a filled accent color should be black or white,
 *  so a "Custom" accent stays legible without the user picking two colors. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const [r, g, b] = m.slice(1, 4).map((h) => parseInt(h, 16) / 255);
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Event name Term.tsx listens for to recolor already-open terminals live —
 *  everything else picks up a new theme (or a new/cleared/re-dimmed
 *  wallpaper) for free via CSS custom properties, but xterm renders to a
 *  canvas and needs its JS-side theme object pushed explicitly. Dispatched by
 *  applyTheme(). See terminalThemes.ts. */
export const THEME_CHANGE_EVENT = "canopy:theme";

/** Stamps the theme onto <html data-theme="…">, which is all index.css needs
 *  to flip every color: one attribute, not a re-render or a re-mount. Call on
 *  boot, and again whenever the theme or the accent override changes. */

export function applyTheme(theme: Theme, customAccent?: string): void {
  document.documentElement.dataset.theme = resolveTheme(theme);
  const root = document.documentElement.style;
  const accent = (customAccent ?? "").trim();
  if (accent) {
    // Orthogonal to the skin, and always was: Gotham with a teal accent is a
    // legitimate thing to want, and forcing a skin change to get one was the
    // wrong model — which is what the retired "custom" theme made you do.
    root.setProperty("--accent", accent);
    root.setProperty(
      "--on-accent",
      luminance(accent) > 0.5 ? "#12131c" : "#ffffff",
    );
  } else {
    // No override — fall back to whatever the skin's stylesheet block says.
    root.removeProperty("--accent");
    root.removeProperty("--on-accent");
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}
