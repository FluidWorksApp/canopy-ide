// One open project: icon rail + collapsible side panel (components / changes /
// agents) + the main area where the AGENT is the hero. Agents and reference
// docs are sub-tabs; plain shells and long-running commands sit in compact
// right-hand rails (single chip, or a dropdown once there's more than one).
// Terminals stay mounted so TUIs keep running. Bottom status tray shows git
// branch, agents, model, tokens, cost.
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import * as ipc from "../../ipc";
import { format, matches, matchesModifierClick } from "../../shortcuts";
import {
  equalizeSplits,
  layoutSplit,
  leafIds,
  mapSplitTabIds,
  paneDropZone,
  remapTerminalGroups,
  neighborPane,
  removeLeaf,
  splitLeaf,
  splitId,
  swapLeaves,
  updateSplitRatio,
  type PaneDirection,
  type PaneDropZone,
  type SplitDivider,
  type SplitAxis,
  type TerminalGroup,
  type TerminalSplitNode,
} from "../../terminalGroups";
import { getSettings, SETTINGS_CHANGE_EVENT } from "../../settings";
import {
  TAB_USE_DWELL_MS,
  groupTabSwitch,
  pruneTabUses,
  recordTabUse,
  resolveTabSwitch,
  stepTabSwitch,
  stepTabSwitchAcrossRows,
  stepTabSwitchInRow,
  tabSwitchSnapshot,
  type TabSwitchRow,
} from "../../tabSwitchOrder";
import {
  clusterWorkItems,
  stepWorkItem,
  workItemSnapshot,
  type WorkItemJoins,
} from "../../workItems";
import { applyHints, buildWorkItemDigest } from "../../workItemHints";
import { brainHints, noteWorkItems } from "../../workItemBrain";
import { cardStatus } from "../../tabCardStatus";
import {
  DOC_STACKS,
  STATUS_LABEL,
  STATUS_ORDER,
  docStackFor,
  shownInStack,
  useSettledGroups,
  type TabStatus,
} from "../../tabGroups";
import {
  NO_ATTENTION,
  POLICY,
  bucketFor,
  declaredQuiet,
  ringFor,
  type Attention,
  type Life,
  type LifeState,
} from "../../../shared/agentLife";
import {
  lifeFor,
  signalFor,
  useAttentionMemory,
  useFirstSeen,
  useStableViews,
  type AgentLifeView,
} from "../../agentLifeStore";
import {
  clearAgentWatchdogAttention,
  tickAgentWatchdogAttention,
  type AgentWatchdogTarget,
} from "../../agentWatchdogAttention";
import { DIGEST_FALLBACK_MS, subscribeSessionDigests } from "../../sessionDigests";

/** The one CPU floor. There used to be four numbers answering this question in
 *  this file and its neighbours — 0, 2, 10 and 300 — for two genuinely
 *  different questions ("is anything running" and "is this runaway") that had
 *  drifted into sharing a threshold. */
const QUIET_CPU = POLICY.quietCpuPercent;
import { contentLeft, expandedStackScroll, GROUP_ATTR, revealScroll } from "../../tabSticky";
import { clearActiveTab, setActiveTab } from "../../activeView";
import { useFlipStrip } from "../../tabFlip";
import { modelFor, monaco, languageForPath } from "../../monaco-setup";
import { getCaret, subscribeCaret } from "../../editorState";
import { setCompanionSpotlight } from "../../companionContext";
import { useEscapeBackstop, useEscapeLayer } from "../../useEscape";
import {
  getSnapshot as prWatchSnapshot,
  subscribe as prWatchSubscribe,
} from "../../prWatchStore";
import { GuestSession, OwnerSession } from "../../collab";
import { CollabView } from "../CollabView";
import { SharedProjectView } from "../SharedProjectView";
import type { AgentCli } from "../../projects";
import {
  envReachesProfile,
  reloadPlan,
  reloading,
  reloadSummary,
  type ReloadItem,
} from "../../accountSwitch";
import {
  activeProfile,
  DEFAULT_PROFILE,
  launchEnv,
  launchEnvSync,
  launchProfile,
  primeLaunchEnv,
  supportsProfiles,
  PROFILE_CHANGE_EVENT,
} from "../../profiles";
import { fleetGate, type FleetKind } from "../../fleetState";
import {
  inspectFleetRoute,
  type FleetRouteSnapshot,
} from "../../fleetSnapshot";
import { pickLaunchCli, startCommandParked } from "../../agentSeed";
import {
  AGENT_CLIS,
  announceCliInstallsChanged,
  binName,
  SHELL_PATTERN,
  currentPlatform,
  PREREQS,
  restoreCommand,
  resumeSessionId,
  launchCommand,
  shellBin,
  updateCommand,
} from "../../projects";
import {
  AgentIcon,
  AgentsIcon,
  CheckIcon,
  ChevronIcon,
  FailIcon,
  FilesIcon,
  GitBranchIcon,
  GlobeIcon,
  IssueIcon,
  LiveDot,
  PlayIcon,
  PullRequestIcon,
  RestartIcon,
  StopIcon,
  TeamIcon,
  TerminalIcon,
} from "../icons";
import type { AgentEventEntry, Notify, OpenFile } from "../../types";
import {
  derivePending,
  eventsForProject,
  isStopFor,
  lastStepFor,
  pendingForRoots,
  type PendingItem,
} from "../../notifications";
import { isOutstanding } from "../../attention";
import { useAttention } from "../../useAttention";
import {
  findRun,
  patchRun,
  runNote,
  withRun,
  withoutRun,
  type MicroRun,
} from "../../microRuns";
import { renderPtyText } from "../../ptyText";
import { scheduleReap } from "../../runReap";
import { watchFailedRestore } from "../../restoreReap";
import { followLink, type DeepLink } from "../../deepLinks";
import {
  addressPrCommentsTask,
  adhocLabel,
  ADHOC_TASK_ID,
  adhocTaskDef,
  customTaskDef,
  fixCiTask,
  implementResearchTask,
  microTaskProtocol,
  oneLine,
  progressBrief,
  prReviewTask,
  resolveConflictsTask,
  runLabelFor,
  raisePrTask,
  noteTask,
  researchTask,
  reviewPrTask,
  type CustomMicroTask,
  type MicroTaskDef,
  type MicroTaskEnv,
} from "../../microTasks";
import { TasksPanel, type RunningMicroTask } from "../TasksPanel";
import { NotesPanel } from "../NotesPanel";
import { NoteView } from "../NoteView";
import { ResearchPanel } from "../ResearchPanel";
import { ResearchImportCta } from "../ResearchImportCta";
import { ResearchView } from "../ResearchView";
import {
  cached as researchCached,
  implementContext,
  link as researchLinkEntry,
  reconcileMerged,
  refresh as researchRefresh,
  setStatus as researchSetStatus,
  settleIfRunning as researchSettleIfRunning,
  start as researchStart,
} from "../../research";
import { resolveWikilink } from "../../wikilinks";
import {
  NEXT_STATUSES as NEXT_NOTE_STATUSES,
  cached as notesCached,
  create as createNote,
  noteContext,
  reconcileMerged as reconcileNotesMerged,
  refresh as refreshNotes,
  setStatus as setNoteStatus,
} from "../../notes";
import { TaskHistoryView } from "../TaskHistoryView";
import { InstructionsView } from "../InstructionsView";
import {
  adoptTaskReservation,
  endAbandonedRun,
  hydrateTaskHistory,
  recordTaskEnd,
  researchEntryForFile,
  runTitle,
  updateTaskRun,
  type TaskRun,
} from "../../taskHistory";
import {
  reserveTask,
  taskGet,
  TASK_ENVELOPES_EVENT,
} from "../../taskEnvelopes";
import { record as recordProvenance } from "../../provenance";
import { resolveAgentForPr, type PrAgent } from "../../agentForPr";
import { cached as provenanceCached, parsePrUrl } from "../../provenance";
import { toPrInfo, type PrQuickAction } from "../../prInbox";
import {
  askedLine,
  hasIdentity,
  identityPatch,
  taskDescription,
  taskIdentity,
} from "../../taskIdentity";
import {
  hasTasksToList,
  taskMenuItem,
  taskMenuItems,
  type TaskChoice,
} from "../../taskMenu";
import { viewerKindFor } from "../viewers";
import { basename } from "../../paths";
import {
  blockForOpen,
  looksBinary,
  sizeLimitFor,
  type OpenBlock,
} from "../../fileOpen";
import { ensureLanguageServer } from "../../lsp/client";
import { Term, type TermHandle } from "../Term";
import { ContextMenu, useContextMenu, type MenuItem } from "../ContextMenu";
import { FileTree } from "../FileTree";
import { FileView, hasDiffToolbar } from "../FileView";
import { ChangesPanel, type ChangeGroup } from "../ChangesPanel";
import { Dialog } from "../Dialog";
import { BranchSwitchProvider, useBranchSwitch } from "../../useBranchSwitch";
import { askDialog } from "../../branchSwitch";
import { useTabDragGroups, applyOrder } from "../../tabDrag";
import { agentIdForCommand, identifyAgent } from "../../agentIdentity";
import {
  agentDisplayName,
  tabNamesByPty,
  shellTitle,
} from "../../agentDisplayName";
import {
  modelCommandLine,
  modelSwitchFor,
  type ModelChoice,
} from "../../agentModels";
import { refreshChoices } from "../../modelCatalog";
import { AgentsPanel } from "../AgentsPanel";
import { AgentsView } from "../AgentsView";
import { digestBySurface } from "../../agentSessions";
import { StatusBar } from "../StatusBar";
import { Palette, type PaletteMode } from "../Palette";
import { LaunchPalette } from "../LaunchPalette";
import { SpotSearch } from "../SpotSearch";
import type { SpotAction } from "../../spotSources";
import { capturePageContext, composeTaskBrief } from "../../spotContext";
import {
  digitFromCode,
  hintModifierOnly,
  useHeldModifier,
} from "../../useHeldModifier";
import { GitPanel } from "../GitPanel";
import { TicketsPanel, type AgentTarget } from "../TicketsPanel";
import { PrsPanel } from "../PrsPanel";
import { ServersPanel } from "../ServersPanel";
import {
  groupServers,
  runningCount,
  type ComponentWorkspace,
  type ServerEntry,
} from "../../servers";
import {
  agentsIn,
  ensureLeases,
  portEnv,
  portForPath,
} from "../../workspaces";
import { needsYouCount } from "../../prInbox";
import { usePrWatch } from "../../usePrWatch";
import { TicketView } from "../TicketView";
import { CommitView } from "../CommitView";
import { ReviewView, type ReviewPayload } from "../ReviewView";
import { BranchView } from "../BranchView";
import { AgentWorkspaceView } from "../AgentWorkspaceView";
import { AgentBrowserPip, pipOwnerVisible } from "../AgentBrowserPip";
import { BROWSER_INPUT_EVENT, PreviewView } from "../PreviewView";
import DeviceView from "../DeviceView";
import type { PreviewServer } from "../../preview";
import { dispatchBrowserOp } from "../../previewAgent";
import { suppressBrowserViewsOver, useBrowserEngine } from "../../browserHost";
import { OPEN_URL_EVENT, type OpenUrlDetail } from "../../links";
import { resolveGitLink } from "../../gitLinks";
import { previewAgentTarget, serverForUrl } from "../../preview";
import { TRACKERS, ticketBranch, ticketContext, ticketResearchQuestion, ticketTaskLabel, ticketWorktree } from "../../trackers";
import { prConflictContext, prReviewContext } from "../../prs";
import {
  fileDiffContext,
  reviewContext,
  sessionChangesContext,
} from "../../diffContext";
import { AgentQueryBar } from "../AgentQueryBar";
import { AgentCloseUndo } from "../AgentCloseUndo";
import {
  AGENT_CLOSE_UNDO_MS,
  pendingAgentTabIds,
  type PendingAgentClose,
} from "../../agentClose";
import {
  forgetSessions,
  markRestored,
  markUserClosed,
  restorableFrom,
  resumeCwd,
  type Restorable,
} from "../../restorable";
import {
  buildSnapshot,
  terminalLaunch,
  wakeSteps,
  writeHibernation,
  HIBERNATE_EVENT,
  HIBERNATED_EVENT,
  type SnapshotTab,
} from "../../hibernation";
import {
  forgetTerminals,
  rememberTerminals,
  rememberedTerminalState,
  terminalResumeCards,
  type RememberedTerminal,
  type TerminalResumeCard,
  type TerminalResumeLeaf,
} from "../../terminalMemory";
import { PrView } from "../PrView";
import { ErrorBoundary } from "../ErrorBoundary";
import { TeamPanel } from "../TeamPanel";
import { McpToolsPanel } from "../McpToolsPanel";
import { McpView } from "../McpView";
import { ClaimView } from "../ClaimView";
import { claimOwnerPty } from "../../claims";
import { ChatView } from "../ChatView";
import { Coachmark } from "../Coachmark";
import { shouldShowTip, markTipSeen, type CoachTip } from "../../coachmarks";
import { ActivityRail } from "../ActivityRail";
import { PaneBar } from "../PaneBar";
import { VibeBuilderPane } from "../VibeBuilderPane";
import { createVibeBuilderSession } from "../../vibeBuilderSession";
import {
  createVibeTargetQuestionSession,
  createVibeTargetStatusSession,
  inferVibeTarget,
  type VibePackageFacts,
} from "../../vibeTargetInference";
import { loadVibePackageFacts } from "../../vibePackageScripts";
import { TabSwitcher } from "../TabSwitcher";
import { switchRowKey, tabKind } from "../../tabKind";

/** Work items join PRs through the provenance cache — synchronous on purpose,
 *  like every read the gesture path makes. A PR tab loads its edges on open,
 *  so by switch time the cache answer is the store's. */
const workItemJoins: WorkItemJoins = {
  prEdge: (repo, number) => {
    const edge = provenanceCached(repo, number)?.[0];
    return edge ? { sessionId: edge.session_id, cwd: edge.cwd } : undefined;
  },
};

/** Model hints may home only reference tabs; sessions and workspaces found
 *  items, and a plain shell is ambiguous by nature. */
const hintMovable = (tab: { type: string } | undefined) =>
  !!tab && tab.type !== "terminal" && tab.type !== "agent";
import { useCliLauncher } from "./hooks/useCliLauncher";

import {
  ago,
  describeTab,
  deviceLabel,
  previewLabel,
  restoredFront,
  tabDisplayLabel,
  tabId,
  tabPrefs as readTabPrefs,
  type SideTab,
  type StripGroup,
  type SubTab,
  type DocSubTab,
  type TermSubTab,
  type FileSubTab,
  type TicketSubTab,
  type NoteSubTab,
  type ResearchSubTab,
  type BranchSubTab,
  type CommitSubTab,
  type PrSubTab,
  type ReviewSubTab,
  type AgentSubTab,
  type TaskHistorySubTab,
  type InstructionsSubTab,
  type McpSubTab,
  type ClaimSubTab,
  type ChatSubTab,
  type CollabSubTab,
  type SharedProjectSubTab,
  type PreviewSubTab,
  type DeviceSubTab,
  type RailChip,
  type ProjectViewProps,
  sidebarPrefs,
  matchesVibeRun,
  pickBrowserTab,
  resolveVibeTarget,
} from "./helpers";
import { Button } from "../ui";
export { tabDisplayLabel, previewLabel, deviceLabel };
export type {
  SideTab,
  SubTab,
  TermSubTab,
  FileSubTab,
  TicketSubTab,
  ResearchSubTab,
  BranchSubTab,
  CommitSubTab,
  PrSubTab,
  ReviewSubTab,
  AgentSubTab,
  TaskHistorySubTab,
  InstructionsSubTab,
  McpSubTab,
  ClaimSubTab,
  ChatSubTab,
  CollabSubTab,
  SharedProjectSubTab,
  PreviewSubTab,
  DeviceSubTab,
  RailChip,
  StripGroup,
};

/** A document stack wears its kind's icon where a status stack wears a dot —
 *  the same icon its tabs carry, so a folded stack still says what is in it. */
const DOC_STACK_ICONS: Record<string, ReactNode> = {
  workspaces: <AgentsIcon size={11} />,
  files: <FilesIcon size={11} />,
  browser: <GlobeIcon size={11} />,
  tasks: <IssueIcon size={11} />,
  reviews: <PullRequestIcon size={11} />,
  history: <GitBranchIcon size={11} />,
  team: <TeamIcon size={11} />,
};

const decoder = new TextDecoder();

/** How a doc tab's host is hidden when it isn't the front tab.
 *
 *  `display: none` for everything, with one exception: a preview tab running
 *  the PROXY engine keeps its box. A `display: none` iframe has no layout at
 *  all — every element in the previewed page reports a zero rect — so a
 *  backgrounded preview would answer canopy_browser_snapshot with an empty page
 *  and click the wrong coordinates. `visibility: hidden` keeps the page laid
 *  out (and unpainted) so an agent can drive it while the user works in another
 *  tab; absolute + no pointer events keeps it out of the flow and out of the
 *  way of the tab that is in front.
 *
 *  The webview engine needs none of that: its page lives in a native view whose
 *  layout has nothing to do with this div, so `display: none` is exactly right
 *  and browserHost hides the view itself. */
function hostStyle(front: boolean, keepLaidOut: boolean): CSSProperties {
  if (front) return { display: "block" };
  if (!keepLaidOut) return { display: "none" };
  return {
    display: "block",
    position: "absolute",
    inset: 0,
    visibility: "hidden",
    pointerEvents: "none",
  };
}

/** Endpoints a shell is actually serving, offered where you are looking.
 *
 *  The ports are already known — `lsof` collects them for the resource
 *  breakdown — but they were only ever shown in side panels, so starting a dev
 *  server still meant reading its banner and retyping the URL. Rendered as an
 *  overlay rather than a bar above the grid on purpose: the terminal's size is
 *  what the pty is told, and anything that changes its height risks the
 *  wrap-at-the-wrong-column class of bug. An absolute chip changes nothing. */
/** The activity rail's width, and so where the overlay peek starts —
 *  `.side-peek-layer { left: 54px }` in index.css. */
const RAIL_W = 54;

/** How long the peek takes to leave (`--peek-out`, 150ms) plus a frame or two,
 *  so the page does not come back through a panel still on its way out. */
const PEEK_EXIT_MS = 220;

function TermPorts({
  ptyId,
  stats,
  onPreview,
}: {
  ptyId: number | null | undefined;
  stats: ipc.SessionStats[];
  /** Open in the in-app preview tab; plain click. Cmd-click (Ctrl-click off a
   *  Mac) still goes to the system browser for the times a real browser is the
   *  point. */
  onPreview: (url: string) => void;
}) {
  if (ptyId == null) return null;
  const ports = stats.find((s) => s.id === ptyId)?.ports ?? [];
  if (ports.length === 0) return null;
  return (
    <div className="term-ports">
      {ports.map((p) => (
        <button
          key={p}
          className="term-port"
          title={`Preview http://localhost:${p} in Canopy — ${format(
            "open-external",
          )}-click for your browser`}
          onClick={(e) => {
            if (matchesModifierClick(e, "open-external")) {
              void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
                openUrl(`http://localhost:${p}`),
              );
            } else {
              onPreview(`http://localhost:${p}`);
            }
          }}
        >
          localhost:{p}
        </button>
      ))}
    </div>
  );
}

/** How long the pointer must rest ON a rail icon before its panel slides out —
 *  and it has to be resting, not merely passing: leaving the icon cancels the
 *  clock, so crossing the rail on the way elsewhere never opens anything.
 *  Long enough to be a decision, short enough to still feel like hover. */
const HOVER_INTENT_MS = 280;
/** The grace period after the pointer leaves both rail and panel. Generous on
 *  purpose: the gap between "reading the file tree" and "reaching for it again"
 *  is longer than a menu's flyout delay. */
const PEEK_CLOSE_MS = 1500;
/** The pointer is still in the rail but has moved off the tabs — it has said
 *  where it's going, so there is nothing left to wait for. Short enough that the
 *  panel is gone before a tooltip can appear over where it was. */
const PEEK_LEAVE_MS = 220;
const SIDE_DEFAULT_W = 300;
const SIDE_MIN_W = 200;
const SIDE_MAX_W = 560;

/** How the body hands its "point the files at this workspace" action up to the
 *  funnel that wraps it. A ref rather than lifted state: `worktreeEnv` and the
 *  side panel belong to the body, a provider can't be consumed by the component
 *  that renders it, and this file already passes closeTab and openFile back up
 *  the same way. */
type UseWorktreeRef = {
  current: (repo: string, path: string, branch: string) => void;
};

// Memoized: App re-renders on every agent event, relay tick and toast, and
// every open project's view — visible or not — used to re-render with it.
// Every prop is either data that should re-render this view or a handler App
// keeps identity-stable.
const ProjectViewBody = memo(function ProjectViewBody({
  project,
  visible,
  zen,
  events,
  hookPath,
  allProjects,
  dismissedPending,
  onDismissPending,
  onEdit,
  onNotice: onNoticeRaw,
  onShareContext,
  onSaveCustomTasks,
  onPersistVibeTarget,
  relay,
  restore,
  onRestoreStep,
  onRestored,
  useWorktreeRef,
}: ProjectViewProps & { useWorktreeRef: UseWorktreeRef }) {
  // Every notice raised inside a project speaks for that project. Stamped here
  // — once, at the seam the whole tree receives — rather than asking each of
  // the dozens of call sites below to remember, which is how the notification
  // list filled with rows that couldn't say which project they were about.
  const onNotice = useCallback<Notify>(
    (text, kind, opts) =>
      onNoticeRaw(text, kind, { projectId: project.id, ...opts }),
    [onNoticeRaw, project.id],
  );
  // Which engine preview tabs run on — it decides how a backgrounded preview
  // has to be hidden, which is a layout question, so it belongs up here.
  const browserEngine = useBrowserEngine();
  const [sideTab, setSideTab] = useState<SideTab>("files");
  // One pip per agent session, not one shared between them. Two agents driving
  // browsers are driving two different pages, and a single pip would show
  // whichever of them acted last while claiming — with its icon — to be the
  // other. Keyed by tab because the tab IS the browser session; a session that
  // moves to another tab takes its pip with it rather than leaving a second one
  // streaming a page it no longer looks at.
  const [browserPips, setBrowserPips] = useState<{ tabId: string; ptyId: number }[]>([]);
  const dismissedBrowserPips = useRef(new Set<string>());
  /** Which preview tab each session is ON, which is not the same list as the
   *  pips: closing a pip hides the view, it does not move the agent off the page
   *  it was driving. Routing reads this and the pip is a view of it, so the two
   *  can never name different pages — which is the whole point of recording it
   *  rather than inferring "the newest tab it owns". A ref because the only
   *  reader is an event handler. */
  const sessionPreview = useRef(new Map<number, string>());
  const showBrowserPip = useCallback((tabId: string, ptyId: number) => {
    sessionPreview.current.set(ptyId, tabId);
    if (dismissedBrowserPips.current.has(tabId)) return;
    setBrowserPips((prev) =>
      prev.some((p) => p.tabId === tabId && p.ptyId === ptyId)
        ? prev
        : [...prev.filter((p) => p.tabId !== tabId && p.ptyId !== ptyId), { tabId, ptyId }],
    );
  }, []);
  // The side panel is a hover overlay, not a docked column. `pinned` is the
  // click/Cmd+B latch that keeps it out; `peeking` is the transient hover state
  // that the debounce below retracts. Either one shows it.
  const [pinned, setPinned] = useState(false);
  const [peeking, setPeeking] = useState(false);
  /** Close the side panel, whatever is holding it open. Kept in a ref because
   *  the thing that needs it most — opening a preview — is defined long before
   *  the peek timers it has to cancel. */
  const dismissPeekRef = useRef<() => void>(() => {});
  /** How the user wants the panel to behave (Settings → Appearance). Held in
   *  state rather than read inline: these decide what effects are registered,
   *  and a change has to take hold without reopening the project. */
  const [sidePrefs, setSidePrefs] = useState(sidebarPrefs);
  const [autoImportMarkdownResearch, setAutoImportMarkdownResearch] = useState(
    () => getSettings().autoImportMarkdownResearch,
  );
  const [restoreUserClosedSessions, setRestoreUserClosedSessions] = useState(
    () => getSettings().restoreUserClosedSessions,
  );
  useEffect(() => {
    const refresh = () => {
      setSidePrefs(sidebarPrefs());
      setAutoImportMarkdownResearch(getSettings().autoImportMarkdownResearch);
      setRestoreUserClosedSessions(getSettings().restoreUserClosedSessions);
    };
    window.addEventListener(SETTINGS_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(SETTINGS_CHANGE_EVENT, refresh);
  }, []);
  const [sideWidth, setSideWidth] = useState(SIDE_DEFAULT_W);
  const sideWidthRef = useRef(SIDE_DEFAULT_W);
  const vibe = project.vibe?.enabled === true;
  const vibeTarget = resolveVibeTarget(project);
  const vibePackageKey = project.components
    .map((component) => `${component.id}:${component.path}`)
    .join("|");
  const [vibePackageState, setVibePackageState] = useState<{
    key: string;
    facts: VibePackageFacts;
  }>({ key: "", facts: {} });
  const vibeInference = useMemo(
    () =>
      vibeTarget.kind === "ready" || project.vibe?.version !== 1
        ? null
        : inferVibeTarget(
            project.components,
            vibePackageState.key === vibePackageKey
              ? vibePackageState.facts
              : {},
          ),
    [
      vibeTarget.kind,
      project.vibe?.version,
      project.components,
      vibePackageKey,
      vibePackageState,
    ],
  );
  const vibePackageIds =
    vibeInference?.kind === "needs-package-facts"
      ? vibeInference.componentIds.join("|")
      : "";
  useEffect(() => {
    if (!vibe || !vibePackageIds) return;
    let cancelled = false;
    void loadVibePackageFacts(
      project.components,
      vibePackageIds.split("|"),
    ).then((facts) => {
      if (!cancelled) setVibePackageState({ key: vibePackageKey, facts });
    });
    return () => {
      cancelled = true;
    };
  }, [vibe, vibePackageIds, vibePackageKey, project.components]);
  const inferredSelection =
    vibeInference?.kind === "persist" ? vibeInference.selection : null;
  const inferredSelectionKey = inferredSelection
    ? `${inferredSelection.componentId}:${inferredSelection.runCommandId}`
    : "";
  const persistedInference = useRef<string | null>(null);
  const inferenceFailures = useRef<{ key: string; count: number }>({
    key: "",
    count: 0,
  });
  const [inferenceRetry, setInferenceRetry] = useState(0);
  useEffect(() => {
    if (!inferredSelection || !inferredSelectionKey) {
      persistedInference.current = null;
      return;
    }
    if (!vibe) return;
    if (persistedInference.current === inferredSelectionKey) return;
    persistedInference.current = inferredSelectionKey;
    let cancelled = false;
    let retry: number | undefined;
    void onPersistVibeTarget(inferredSelection).then((saved) => {
      if (cancelled) return;
      if (saved) {
        inferenceFailures.current = { key: "", count: 0 };
        return;
      }
      persistedInference.current = null;
      const previous = inferenceFailures.current;
      const count = previous.key === inferredSelectionKey ? previous.count + 1 : 1;
      inferenceFailures.current = { key: inferredSelectionKey, count };
      if (count < 3) {
        retry = window.setTimeout(
          () => setInferenceRetry((value) => value + 1),
          count * 500,
        );
      }
    });
    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [
    vibe,
    inferredSelection,
    inferredSelectionKey,
    inferenceRetry,
    onPersistVibeTarget,
  ]);
  const vibeTargetQuestionSession = useMemo(
    () =>
      vibeInference?.kind === "ask"
        ? createVibeTargetQuestionSession(vibeInference, onPersistVibeTarget)
        : null,
    [vibeInference, onPersistVibeTarget],
  );
  const vibeTargetStatus =
    project.components.length === 0
      ? "Add an app component in Engineer mode first."
      : project.vibe?.version !== 1
        ? "This Build configuration needs a newer version of Canopy."
        : vibeInference?.kind === "unavailable"
          ? "I couldn't find a dev or start script in the project."
          : "I'm finding the app and starting it for you.";
  const retryInferredTarget = useCallback(() => {
    persistedInference.current = null;
    inferenceFailures.current = { key: "", count: 0 };
    setInferenceRetry((value) => value + 1);
  }, []);
  const vibeTargetStatusSession = useMemo(
    () =>
      createVibeTargetStatusSession(
        vibeTargetStatus,
        inferredSelection ? retryInferredTarget : undefined,
      ),
    [vibeTargetStatus, inferredSelection, retryInferredTarget],
  );
  const sideOpen = !zen && !vibe && (pinned || peeking);

  // The overlay peek slides over the pane, and a child webview cannot be drawn
  // under it — so the panel has to be announced, not discovered. The occlusion
  // walk re-measures every 60ms and the hide is a round trip to the compositor,
  // while the panel is in motion for 340ms firing nothing the observer can
  // sample: measured, the page painted over the panel for 157ms every time it
  // opened. Claiming the rect the panel will occupy, at the moment the state
  // changes, takes the race off the table.
  useEffect(() => {
    if (!sidePrefs.overlay || !sideOpen) return;
    const release = suppressBrowserViewsOver({
      x: RAIL_W,
      y: 0,
      width: sideWidthRef.current,
      height: window.innerHeight,
    });
    return () => {
      // Held through the exit transition: releasing on the state change alone
      // brings the page back over a panel that is still sliding out — the same
      // bug pointing the other way. The release is idempotent, so a peek that
      // reopens before this lands is still balanced.
      window.setTimeout(release, PEEK_EXIT_MS);
    };
  }, [sidePrefs.overlay, sideOpen]);
  const [tabs, setTabs] = useState<SubTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [pendingAgentCloses, setPendingAgentCloses] = useState(
    new Map<string, PendingAgentClose>(),
  );
  const pendingAgentClosesRef = useRef(pendingAgentCloses);
  pendingAgentClosesRef.current = pendingAgentCloses;
  const pendingAgentIds = useMemo(
    () => pendingAgentTabIds(pendingAgentCloses),
    [pendingAgentCloses],
  );
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => !pendingAgentIds.has(tab.id)),
    [tabs, pendingAgentIds],
  );
  /** Every pip whose tab still exists — what gets RENDERED, including the one
   *  whose tab is in front. That one is rendered hidden rather than dropped:
   *  where the user dragged it, how wide they made it and whether it is
   *  minimized live inside the component, and unmounting it threw all three
   *  away every time they looked at the full page. */
  const livePips = useMemo(
    () =>
      browserPips.filter((p) =>
        tabs.some((t) => t.id === p.tabId && t.type === "preview"),
      ),
    [browserPips, tabs],
  );
  /** The ones actually on screen, in a stable order — the layout deals each a
   *  different corner offset from its place in this list, so a pip must not hop
   *  a slot because an unrelated one closed, and a hidden one must not hold a
   *  slot open.
   *
   *  A pip whose tab is in front is not among them: the full browser IS the live
   *  view there, and the small duplicate would only cover its corner. */
  const shownBrowserPips = useMemo(
    () => {
      const terminals = visibleTabs.filter(
        (tab): tab is TermSubTab => tab.type === "terminal",
      );
      return livePips.filter(
        (pip) =>
          pip.tabId !== activeTabId &&
          pipOwnerVisible(pip.ptyId, terminals, activeTabId),
      );
    },
    [livePips, activeTabId, visibleTabs],
  );
  const [terminalGroups, setTerminalGroups] = useState<Record<string, TerminalGroup>>({});
  const terminalGroupsRef = useRef(terminalGroups);
  terminalGroupsRef.current = terminalGroups;
  /** Briefly ringed after a jump — with several similar terminal tabs open,
   *  activating one is not enough to show WHICH one you landed on. */
  const [flashTabId, setFlashTabId] = useState<string | null>(null);
  // Change feed comes from git, grouped by component (see refreshChanges).
  const [changeGroups, setChangeGroups] = useState<ChangeGroup[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  // Which tab is being renamed inline, and the working text. Null = none.
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Right-click on the empty area below the file list creates here (the last
  // component's root — the tree that space sits under). Null = closed.
  const [rootCreate, setRootCreate] = useState<{
    dir: string;
    kind: "file" | "dir";
    value: string;
  } | null>(null);
  const [cliMenuOpen, setCliMenuOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareProjectMenuOpen, setShareProjectMenuOpen] = useState(false);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [fleetLaunchNote, setFleetLaunchNote] = useState<{
    kind: FleetKind;
    text: string;
  } | null>(null);
  const {
    installed,
    prereqs,
    getInstalled,
    getInstalledForLaunch,
    cliUpdates,
    refreshInstalled,
    refreshUpdates,
  } = useCliLauncher();
  // The account profiles this machine has. One entry (the default) is the
  // normal case and the launcher renders exactly as it did before profiles
  // existed; the list only grows when the user makes a second login.
  const [profiles, setProfiles] = useState<ipc.AgentProfile[]>([]);
  const [activeAccounts, setActiveAccounts] = useState<ipc.AccountStatus[]>([]);
  const [activeProfileId, setActiveProfileId] = useState(activeProfile());
  useEffect(() => {
    const pull = () => {
      const id = activeProfile();
      setActiveProfileId(id);
      // Primed on the signals that change it, so launches never await IPC.
      void primeLaunchEnv();
      void ipc.profilesList().then(setProfiles).catch(() => {});
      void ipc.profileAccounts(id).then(setActiveAccounts).catch(() => {});
    };
    pull();
    // The event covers create/switch; focus covers a sign-in, which finishes
    // in a shell we can't observe.
    window.addEventListener(PROFILE_CHANGE_EVENT, pull);
    window.addEventListener("focus", pull);
    return () => {
      window.removeEventListener(PROFILE_CHANGE_EVENT, pull);
      window.removeEventListener("focus", pull);
    };
  }, []);

  // Offer to bring the agents already running over to the account just
  // switched to. Only the project in front asks: the others are left running
  // as they are, which is what "don't touch them" has to mean for a switch
  // made from a global chip.
  const [reloadAsk, setReloadAsk] = useState<{
    profile: string;
    label: string;
    plan: ReloadItem[];
  } | null>(null);
  useEffect(() => {
    const onSwitch = (e: Event) => {
      const to = (e as CustomEvent).detail?.profileId as string | undefined;
      // Creating a profile fires the same event without a target.
      if (!to || !visibleRef.current) return;
      const open = agentTargetsRef.current.map((a) => ({
        tabId: a.tabId,
        agentId: a.agentId,
        cwd: a.cwd,
        label: a.title,
      }));
      if (open.length === 0) return;
      void Promise.all([
        ipc.profileAccounts(to),
        ipc.sessionDigests(rootsRef.current),
      ])
        .then(([accounts, digests]) => {
          const plan = reloadPlan({
            open,
            accounts,
            restorables: restorableFrom(
              digests,
              statsRef.current,
              liveSessionIdsRef.current,
            ),
            profile: to,
          });
          // Nothing this account can take over — say nothing rather than open
          // a dialog whose only answer is "no".
          if (reloading(plan).length === 0) return;
          setReloadAsk({
            profile: to,
            label: profilesRef.current.find((p) => p.id === to)?.label ?? to,
            plan,
          });
        })
        .catch(() => {});
    };
    window.addEventListener(PROFILE_CHANGE_EVENT, onSwitch);
    return () => window.removeEventListener(PROFILE_CHANGE_EVENT, onSwitch);
  }, []);


  /** What the ＋ menu says about the account it launches into. Null on the
   *  default one. `missing` is the footgun: an account holding a Claude login
   *  but no Codex one is legitimate, and a surprise login prompt isn't. */
  const accountBanner = useMemo(() => {
    if (activeProfileId === "default") return null;
    const label =
      profiles.find((p) => p.id === activeProfileId)?.label ?? activeProfileId;
    const missing = AGENT_CLIS.filter(
      (c) =>
        supportsProfiles(c.id) &&
        activeAccounts.find((a) => a.agent === c.id)?.state === "out",
    ).map((c) => c.id);
    return { label, missing };
  }, [activeProfileId, profiles, activeAccounts]);

  const profilesRef = useRef<ipc.AgentProfile[]>([]);
  profilesRef.current = profiles;

  /** One name per account, wherever it appears. */
  const profileLabels = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p.label])),
    [profiles],
  );
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  /** The ⌘N launcher — the ＋ menu as a type-and-Enter list. */
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [pendingSplit, setPendingSplit] = useState<{
    sourceTabId: string;
    axis: SplitAxis;
  } | null>(null);
  const pendingSplitRef = useRef(pendingSplit);
  pendingSplitRef.current = pendingSplit;
  /** SpotSearch (⌘K) — the omnibox over everything this project knows. */
  const [spotOpen, setSpotOpen] = useState(false);
  /** Holding the tab-jump modifier reveals the direct-jump numbers in the bar. */
  const tabHints = useHeldModifier("tabs", visible);
  /** Ctrl+Tab held: a frozen ID order and the tab release would land on. IDs,
   *  rather than an index into the live array, keep a tab closing mid-gesture
   *  from silently redirecting the selection to whichever tab shifted into
   *  its slot. Nothing switches until release. */
  const [switcher, setSwitcher] = useState<{
    ids: string[];
    /** Grouped strips for recent mode, frozen with the snapshot; null keeps
     *  the flat strip (order mode). */
    rows: TabSwitchRow[] | null;
    selectedId: string;
  } | null>(null);
  const switcherRef = useRef(switcher);
  switcherRef.current = switcher;
  // When set, the whole project's file surface (tree, quick-open, search, new
  // terminals) points at this worktree instead of the main checkout — so an
  // agent's worktree becomes the environment you actually work in.
  const [worktreeEnv, setWorktreeEnv] = useState<{
    repo: string;
    path: string;
    branch: string;
  } | null>(null);
  // The one funnel, mounted by the wrapper below this component. Every route
  // into a ref that moves goes through it, so a refusal arrives as a question
  // in one dialog instead of raw stderr in a toast.
  const { switchTo, ask, version: switchVersion } = useBranchSwitch();
  /** Perform the redirection: the project's files, search and new terminals
   *  come from this workspace instead of the main checkout. The funnel owns the
   *  label and the notice, which is why every surface calls its `openThere` and
   *  nothing calls this directly. */
  const useWorktreeHere = useCallback(
    (repo: string, path: string, branch: string) => {
      void ipc.workspaceAdd(path).catch(() => {});
      setWorktreeEnv({ repo, path, branch });
      setSideTab("files");
    },
    [],
  );
  useWorktreeRef.current = useWorktreeHere;
  /** The only way out of that redirection, and it used to be silent: a bare ✕
   *  that moved the file tree, the search index and every new terminal back
   *  without a word, while the editors and terminals already open stayed rooted
   *  where they were. Asked in the same dialog as everything else.
   *
   *  ("move-here" is the funnel's id for "bring it back to this checkout"; ids
   *  never reach the screen, only labels do.) */
  const leaveWorktreeEnv = useCallback(
    async (env: { path: string }) => {
      const name = basename(env.path) || env.path;
      const action = await ask(
        askDialog({
          title: "Go back to your own checkout?",
          body: `Files, search and new terminals stop coming from ${name}. Anything already open there stays open.`,
          detail: env.path,
          choices: [
            {
              action: "move-here",
              label: "Go back",
              sub: "Nothing there is changed or removed — this only stops pointing at it.",
              recommended: true,
            },
            { action: "cancel", label: "Stay here" },
          ],
        }),
      );
      if (action === "move-here") setWorktreeEnv(null);
    },
    [ask],
  );
  /** Coming back from hibernation, a stored redirection is a claim about a
   *  folder we haven't looked at since the project went to sleep — it may have
   *  been removed, pruned, or moved to another branch in the meantime. Restore
   *  it only if it is still there and still on the branch it was on; otherwise
   *  say so, because the alternative is a file tree rooted at a path that no
   *  longer resolves and nothing on screen explaining why. */
  const wakeWorktreeEnv = useCallback(
    async (env: { repo: string; path: string; branch: string }) => {
      const worktrees = await ipc
        .gitWorktrees(env.repo)
        .catch(() => [] as ipc.WorktreeInfo[]);
      const still = worktrees.some(
        (w) => w.path === env.path && w.branch === env.branch,
      );
      if (still) {
        setWorktreeEnv(env);
        return;
      }
      const action = await ask(
        askDialog({
          title: "The workspace this project was using is gone",
          body: `${basename(env.path) || env.path} isn't there any more, so this project's files come from your own checkout. Nothing you had open has been touched.`,
          detail: `${env.path} — was on ${env.branch}`,
          choices: [
            {
              action: "cancel",
              label: "Work in the main checkout",
              sub: "Files, search and new terminals come from this project's own checkout.",
              recommended: true,
            },
            {
              action: "open-there",
              label: "Show me what's there",
              sub: "Opens the list of workspaces this project has.",
            },
          ],
        }),
      );
      if (action === "open-there") {
        setSideTab("git");
        setPinned(true);
      }
    },
    [ask],
  );
  /** Read by the wake effect, which must not take these as dependencies: a new
   *  identity there would tear down a restore that is halfway through. */
  const wakeWorktreeEnvRef = useRef(wakeWorktreeEnv);
  wakeWorktreeEnvRef.current = wakeWorktreeEnv;

  const baselines = useRef(new Map<string, string>());
  const recentSaves = useRef(new Map<string, number>());
  const termHandles = useRef(new Map<string, TermHandle | null>());
  /** The live tail of a terminal tab, for its thumbnail: a read of the xterm
   *  buffer that is already in memory. No capture and no screenshot — what it
   *  returns is what the pty has painted by the moment it is asked, which is
   *  what makes a card of an agent mid-run move while you hold the key. */
  const termTailFor = useCallback(
    (id: string) => termHandles.current.get(id)?.captureText(4000) ?? null,
    [],
  );
  /** The view's own root, for SpotSearch's page screenshot — its rect is what
   *  "the page behind the palette" means. */
  const rootRef = useRef<HTMLDivElement>(null);
  /** The pane area every tab is mounted in. The switcher's thumbnails are found
   *  and sized through it: one rect for all of them, because every pane is the
   *  same box. */
  const contentRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  /** Committed activity, newest first. This is session memory rather than a
   *  workspace preference: after a restart there is no honest "previous tab"
   *  until the user has moved between two of them. */
  const recentTabsRef = useRef<string[]>([]);
  // Dwell gate: a tab passed through on the way somewhere else never enters
  // the recency list. Depends on activeTabId alone — a tabs-array change must
  // not restart the timer and fake a dwell; pruning closed tabs is the
  // separate effect below.
  useEffect(() => {
    if (!activeTabId) return;
    const timer = window.setTimeout(() => {
      recentTabsRef.current = recordTabUse(
        recentTabsRef.current,
        activeTabId,
        tabsRef.current.map((t) => t.id),
      );
    }, TAB_USE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [activeTabId]);
  useEffect(() => {
    recentTabsRef.current = pruneTabUses(
      recentTabsRef.current,
      visibleTabs.map((t) => t.id),
    );
  }, [visibleTabs]);
  // Feed the switcher brain in Work items mode: a compact digest of the
  // deterministic grouping, off the gesture path. The brain debounces and
  // floors the CLI turns itself; identical digests never leave this effect.
  useEffect(() => {
    if (getSettings().tabSwitchMode !== "items") return;
    const byId = new Map(visibleTabs.map((t) => [t.id, t]));
    const digest = buildWorkItemDigest(clusterWorkItems(visibleTabs, workItemJoins), (id) => {
      const tab = byId.get(id);
      return tab ? `${tabKind(tab).label} ${tabDisplayLabel(tab)}` : id;
    });
    noteWorkItems(digest);
  }, [visibleTabs]);
  /** The tabs in the order the pane bar draws them — what ⌘1..9 counts, and
   *  filled in below once the groups are known. */
  const barTabsRef = useRef<SubTab[]>([]);
  const closeTabRef = useRef<(
    id: string,
    origin?: "automatic" | "user",
  ) => void>(() => {});
  const isAgentTabRef = useRef<(tab: SubTab) => boolean>(() => false);
  const splitActiveRef = useRef<(axis: SplitAxis) => void>(() => {});
  const focusPaneRef = useRef<(direction: PaneDirection) => void>(() => {});
  const movePaneRef = useRef<(direction: PaneDirection) => void>(() => {});
  const togglePaneZoomRef = useRef<() => void>(() => {});
  const equalizePanesRef = useRef<() => void>(() => {});
  const closeActivePaneRef = useRef<() => void>(() => {});
  const closeActiveGroupRef = useRef<() => void>(() => {});
  /** Set from stopMicroRun below, for the teardown paths that run before it is
   *  in scope (hibernation, unmount) — a detached task must never outlive the
   *  project it was launched from. */
  const stopMicroRunRef = useRef<(ptyId: number) => void>(() => {});
  const openFileRef = useRef<
    (path: string, opts?: { diff?: boolean; activate?: boolean }) => Promise<void>
  >(async () => {});

  // Process stats for THIS project's terminals only. Subscribed here rather
  // than in App: the monitor emits every 2s, and holding the array at App
  // level re-rendered every mounted ProjectView (tab strips, file trees, git
  // panels — for every open project) on every tick. Filtering at the door
  // also lets a project with no terminals skip the setState entirely, so it
  // never re-renders from stats at all.
  const [stats, setStats] = useState<ipc.SessionStats[]>([]);
  const statsRef = useRef(stats);
  statsRef.current = stats;
  // What the human has not dealt with, per terminal — the other axis. Held here
  // rather than on the tab because it must survive a tab re-render and must
  // NOT survive the terminal: `forget` runs when a pty goes.
  const {
    push: pushAttention,
    memory: attentionMemory,
    version: attentionVersion,
  } = useAttentionMemory();
  const attentionRef = useRef(pushAttention);
  attentionRef.current = pushAttention;
  // One clock for every lifecycle verdict in this view. A verdict decays with
  // time (a working claim past its trust window stops being believed), so
  // something has to re-render for the decay to land; a single 5s tick is that
  // something, rather than each surface keeping its own.
  const [lifeClock, setLifeClock] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setLifeClock(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);
  // Hook-free waiting detection, for agents with no event integration — the
  // Antigravity permission prompt sat invisible because only some CLIs emit
  // hook events. An agent that burned real CPU and has now been near-idle for 3
  // straight ticks (~6s) may be blocked on a prompt.
  //
  // Two things changed about it. It now feeds the attention axis rather than
  // setting a flag that outranked live state, and it is gated on the CLI: a
  // `quiet` input is dropped for any agent whose manifest says it can report
  // being blocked (see reduceAttention). Before both, this fired against
  // claude and codex sessions whose digests correctly read "working" — six
  // seconds under 10% CPU is exactly what a model thinking looks like — and
  // filed them under "Needs you" until the tab was clicked.
  const idleWatch = useRef(
    new Map<number, { busy: boolean; idle: number; flagged: boolean }>(),
  );
  // A plain shell that an agent ran inside of is classified as an agent only
  // while that process lives (see agentPtyIds in the render). Once the agent
  // exits, the still-open shell would silently demote into the SHELLS rail and
  // bump its count "by itself". Track ptys that have hosted an agent and, once
  // the agent has been gone two ticks (guards a stats-sampling blip), close the
  // tab instead of letting it reappear as a shell.
  const agentLife = useRef(new Map<number, number>());
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    const sub = ipc.onPtyStats((all) => {
      const ids = new Set(
        tabsRef.current
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((t) => t.ptyId)
          .filter((id): id is number => id != null),
      );
      const mine = all.filter((s) => ids.has(s.id));
      for (const s of mine) {
        const hasAgent = !!identifyAgent(s.agent_hint);
        if (hasAgent) {
          agentLife.current.set(s.id, 0);
        } else if (agentLife.current.has(s.id)) {
          // The agent is gone. If the user has since put this shell to real
          // work — a server, a build, any non-shell/non-agent process still
          // running — it's a working shell now, not a spent agent shell:
          // stop tracking it and never auto-close it out from under them.
          const hasRealWork = s.procs.some((p) => !SHELL_PATTERN.test(p.name));
          if (hasRealWork) {
            agentLife.current.delete(s.id);
          } else {
            const gone = (agentLife.current.get(s.id) ?? 0) + 1;
            if (gone >= 2) {
              agentLife.current.delete(s.id);
              const tab = tabsRef.current.find(
                (t): t is TermSubTab =>
                  t.type === "terminal" && t.ptyId === s.id,
              );
              // A launched agent tab (command matches) or a run stays put; only
              // an idle plain shell that hosted a now-exited agent gets closed.
              if (tab && !tab.run && !agentIdForCommand(tab.command)) {
                closeTabRef.current(tab.id);
              }
            } else {
              agentLife.current.set(s.id, gone);
            }
          }
        }
        if (!hasAgent) {
          idleWatch.current.delete(s.id);
          continue;
        }
        const w = idleWatch.current.get(s.id) ?? {
          busy: false,
          idle: 0,
          flagged: false,
        };
        if (s.total_cpu > QUIET_CPU) {
          idleWatch.current.set(s.id, { busy: true, idle: 0, flagged: false });
        } else if (w.busy && !w.flagged && ++w.idle >= 3) {
          w.flagged = true;
          idleWatch.current.set(s.id, w);
          const tab = tabsRef.current.find(
            (t): t is TermSubTab => t.type === "terminal" && t.ptyId === s.id,
          );
          // A ring on the tab you're watching is noise (same rule as OSC).
          if (
            tab &&
            !(tab.id === activeTabIdRef.current && visibleRef.current)
          ) {
            // An input, not a verdict. The reducer drops it outright for a CLI
            // that has a way to say it is blocked, and the agent painting again
            // retracts it without anyone having to click.
            attentionRef.current(
              s.id,
              { t: "quiet", at: Date.now() },
              identifyAgent(s.agent_hint)?.id ?? null,
            );
          }
        } else {
          idleWatch.current.set(s.id, w);
        }
      }
      // Bail when nothing moved: this lands every 2s for every open project,
      // and a fresh array here re-renders the whole view.
      setStats((prev) =>
        prev.length === mine.length &&
        JSON.stringify(prev) === JSON.stringify(mine)
          ? prev
          : mine,
      );
    });
    return () => void sub.then((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A worktree mirrors its repo's tree, so a component inside the repo maps to
  // the same relative path inside the worktree.
  const components = project.components.map((c) => {
    if (
      worktreeEnv &&
      (c.path === worktreeEnv.repo || c.path.startsWith(worktreeEnv.repo + "/"))
    ) {
      return {
        ...c,
        path: worktreeEnv.path + c.path.slice(worktreeEnv.repo.length),
      };
    }
    return c;
  });
  const roots = components.map((c) => c.path);
  const rootsKey = roots.join("\n");
  // Cmd+T's listener is registered once; without this it closes over the
  // components from mount and opens shells in the main checkout even after a
  // worktree is activated — disagreeing with the panel's own terminal button.
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const rootsRef = useRef(roots);
  rootsRef.current = roots;

  // Loose Markdown is research wherever it was written. Sweep on open and
  // root changes, then again after a short quiet period when a watcher reports
  // a Markdown write. The backend resolves by canonical path, so duplicate
  // watcher events and overlapping component roots remain idempotent.
  useEffect(() => {
    if (!autoImportMarkdownResearch) return;
    let alive = true;
    let timer: number | undefined;
    const sweep = () => {
      if (!alive) return;
      void ipc.researchSweep({
        projectId: project.id,
        projectName: project.name,
        roots: rootsRef.current,
      }).catch(() => {});
    };
    sweep();
    const sub = ipc.onFsChange((event) => {
      const normalizedRoot = event.root.replaceAll("\\", "/").replace(/\/$/, "");
      const belongs = rootsRef.current.some((root) => {
        const normalized = root.replaceAll("\\", "/").replace(/\/$/, "");
        return (
          normalized === normalizedRoot ||
          normalized.startsWith(normalizedRoot + "/") ||
          normalizedRoot.startsWith(normalized + "/")
        );
      });
      if (
        !belongs ||
        event.kind === "remove" ||
        !event.paths.some((path) => path.toLowerCase().endsWith(".md"))
      ) {
        return;
      }
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(sweep, 500);
    });
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
      void sub.then((unlisten) => unlisten());
    };
  }, [autoImportMarkdownResearch, project.id, project.name, rootsKey]);
  // Set from the memo below; the restore loader reads it without having to
  // re-subscribe every time an event arrives.
  const liveSessionIdsRef = useRef<string[]>([]);

  // ---------- terminals ----------

  // Pending self-closes for finished chore runs, by tab id. Held so leaving the
  // project doesn't leave a timer holding a closure over tabs that are gone.
  const reapTimers = useRef(new Map<string, number>());
  const agentCloseTimers = useRef(new Map<string, number>());
  const agentCloseSequence = useRef(0);
  // Restores still waiting to see whether the CLI accepts them, by tab id.
  const restoreWatches = useRef(new Map<string, () => void>());
  // CLIs without a prompt argument (OpenCode, Amp, Aider, etc.) must receive
  // their opening brief through the TUI. Queue it by tab until Term reports the
  // actual PTY: timing this from addTerminal raced terminal mounting and could
  // silently leave a freshly opened agent with no context at all.
  const pendingTerminalPrompts = useRef(new Map<string, string>());
  useEffect(
    () => () => {
      for (const t of reapTimers.current.values()) window.clearTimeout(t);
      reapTimers.current.clear();
      for (const t of agentCloseTimers.current.values()) window.clearTimeout(t);
      agentCloseTimers.current.clear();
      for (const cancel of restoreWatches.current.values()) cancel();
      restoreWatches.current.clear();
    },
    [],
  );

  /** Watch a resume the CLI may refuse, and take both the dead tab and the row
   *  that offered it away if it does — see restoreReap.ts for why all three of
   *  its conditions are needed. Armed from addTerminal rather than from each
   *  Restore button because every surface that reopens a session funnels
   *  through there, and the command names the session outright. */
  const armRestoreReap = useCallback((tab: string, sessionId: string) => {
    restoreWatches.current.get(tab)?.();
    const cancel = watchFailedRestore({
      sessionId,
      ptyId: () =>
        tabsRef.current.find(
          (t): t is TermSubTab => t.type === "terminal" && t.id === tab,
        )?.ptyId ?? null,
      read: (ptyId) => ipc.ptyOutput(ptyId, 16 * 1024),
      look: (ptyId) => {
        const s = statsRef.current.find((x) => x.id === ptyId);
        return s
          ? {
              agentRunning: s.agent_hint != null,
              sinceInputMs: s.since_input_ms,
            }
          : undefined;
      },
      reap: () => {
        restoreWatches.current.delete(tab);
        closeTabRef.current(tab);
        // Tombstone at the transcript's current mtime, which is the reversible
        // half of Forget: a session genuinely written to again comes back.
        // Nothing on disk is deleted — deleting the digest is the user's call,
        // and the digest is also the record of what that session cost.
        void ipc
          .sessionDigests(rootsRef.current)
          .then((all) => {
            const d = all.find((x) => x.session_id === sessionId);
            if (d) forgetSessions([d]);
          })
          .catch(() => {});
      },
    });
    restoreWatches.current.set(tab, cancel);
  }, []);

  const addTerminal = useCallback(
    (
      cwd: string,
      command?: string,
      title?: string,
      icon?: string,
      // "chore" is a run with one thing to say — an install, an update — which
      // closes itself once it says it (see runReap.ts). Spelled as a value of
      // this argument rather than another positional flag: a chore is a kind of
      // run, and the two could never be set independently.
      run: boolean | "chore" = false,
      // Stamped on top of the workspace port. Usually derived below.
      extraEnv?: [string, string][],
      profile?: string,
      activate = true,
      paneGroup?: string,
      runIdentity?: { componentId: string; runCommandId: string },
    ) => {
      const id = tabId();
      // Every terminal opened inside a workspace gets that workspace's port,
      // not just the ones started from the Servers panel — an agent told to
      // "run the dev server and check it" is the case that matters most, and it
      // types the command itself. Derived from the path alone (see
      // workspaces.portForPath) so this stays a synchronous, IPC-free lookup.
      // The account is derived from the command, not passed in: every
      // launcher funnels through here, and asking each to remember is how half
      // end up on the default login. An explicit `profile` still wins — a
      // resume or a wake reopens a conversation owned by a specific account.
      const launchedCli = agentIdForCommand(command);
      const accountEnv =
        extraEnv ?? (launchedCli ? launchEnvSync(launchedCli) : []);
      const accountProfile =
        profile ??
        (launchedCli && accountEnv.length ? launchProfile(launchedCli) : undefined) ??
        undefined;
      const env = [...portEnv(portForPath(cwd)), ...accountEnv];
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "terminal",
          cwd,
          title: title ?? "shell",
          ptyId: null,
          command,
          icon,
          env: env.length ? env : undefined,
          profile: accountProfile,
          run: run !== false,
          chore: run === "chore" || undefined,
          paneGroup,
          componentId: runIdentity?.componentId,
          runCommandId: runIdentity?.runCommandId,
        },
      ]);
      if (activate) setActiveTabId(id);
      // A resume the CLI refuses leaves a dead shell in this tab and a row that
      // will offer the same doomed button tomorrow. The command carries the
      // session id, so nothing has to be passed in for this to know which
      // conversation was asked for.
      const resuming = resumeSessionId(command);
      if (resuming) armRestoreReap(id, resuming);
      // Returned so callers that must talk to the new terminal (seeding an
      // agent with an opening prompt) can find its pty once it spawns.
      return id;
    },
    [armRestoreReap],
  );

  /** Open (or re-focus) a tab attached to a PTY that already exists — one the
   *  remote portal spawned, or a detached micro-task the user wants to watch.
   *  Idempotent by pty id, so a re-dispatched event just re-focuses the existing
   *  tab rather than stacking duplicates. Returns the tab's id, which is how a
   *  caller that opened a viewer can close it again. */
  const attachTerminal = useCallback(
    (
      ptyId: number,
      cwd: string,
      title: string,
      icon = "📱",
      activate = true,
      killOnClose = false,
    ): string => {
      const existing = tabsRef.current.find(
        (t): t is TermSubTab => t.type === "terminal" && t.attachId === ptyId,
      );
      if (existing) {
        if (activate) setActiveTabId(existing.id);
        return existing.id;
      }
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "terminal",
          cwd,
          title: title || "agent",
          ptyId,
          attachId: ptyId,
          killAttachedOnClose: killOnClose || undefined,
          icon,
        },
      ]);
      if (activate) setActiveTabId(id);
      return id;
    },
    [],
  );

  // A PTY spawned from the phone (App routes pty:spawned to the project whose
  // components own its cwd). Not gated on `visible`: a remote spawn can target a
  // project sitting in the background, and the tab should be waiting there.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        projectId: string;
        ptyId: number;
        cwd: string;
        title: string;
        activate?: boolean;
      };
      if (d?.projectId !== project.id) return;
      attachTerminal(d.ptyId, d.cwd, d.title, "📱", d.activate !== false);
    };
    window.addEventListener("canopy:attach-terminal", onAttach);
    return () => window.removeEventListener("canopy:attach-terminal", onAttach);
  }, [project.id, attachTerminal]);

  /** Open a pull request as its own tab, reusing one already open for it. */
  const openPr = useCallback((repo: string, pr: ipc.PrInfo) => {
    const existing = tabsRef.current.find(
      (t): t is PrSubTab =>
        t.type === "pr" && t.repo === repo && t.pr.number === pr.number,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "pr", repo, pr }]);
    setActiveTabId(id);
  }, []);

  /** Open a PR we only know the number of — what a research entry's links
   *  carry. Native tab when the PR is still open (the list the watcher already
   *  has), and the browser when it is not: a merged PR has no native view here,
   *  and a link that does nothing is worse than one that leaves the app. */
  const openPrByNumber = useCallback(
    async (repo: string, number: number, url?: string) => {
      // Relay deep links carry the origin URL, not the receiver's local path.
      // Resolve it against this project's repos before asking gh for the PR.
      const paths = componentsRef.current.map((component) => component.path);
      const localRepo = paths.includes(repo)
        ? repo
        : await Promise.all(
            paths.map(async (path) => ({
              path,
              remote: await ipc.gitRemoteUrl(path).catch(() => ""),
            })),
          ).then((repos) =>
            repos.find((r) => r.remote.toLowerCase() === repo.toLowerCase())?.path,
          );
      if (!localRepo) {
        if (url) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url));
        return;
      }
      const pr = await ipc
        .ghPrList(localRepo)
        .then((list) => list.find((p) => p.number === number))
        .catch(() => undefined);
      if (pr) {
        openPr(localRepo, pr);
        return;
      }
      if (url)
        void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
          openUrl(url),
        );
    },
    [openPr],
  );

  /** Open a code-review request that arrived over the relay — the diff came
   *  with it, so there is nothing to fetch. */
  const openReview = useCallback((review: ReviewPayload) => {
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "review", review }]);
    setActiveTabId(id);
  }, []);

  const patchTabRaw = useCallback((id: string, patch: Partial<SubTab>) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? ({ ...t, ...patch } as SubTab) : t)),
    );
  }, []);

  /** Open an embedded-browser preview tab. With no URL the tab opens on the
   *  pick-a-server form; a URL (a run rail's detected server, a reopened tab)
   *  loads immediately. Returns the new tab's id (agent ops target it). */
  const openPreview = useCallback(
    (url = "", initiatorPtyId?: number | null, activate = true) => {
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "preview",
          url,
          annotations: [],
          ...(initiatorPtyId != null ? { initiatorPtyId } : {}),
        },
      ]);
      if (activate) setActiveTabId(id);
      // The panel that opened this is almost always still over the pane, and a
      // browser view cannot be drawn under it — so the page you just asked for
      // would be hidden by the thing you asked with. Closing it is what the user
      // was about to do anyway.
      if (activate) dismissPeekRef.current();
      return id;
    },
    [],
  );

  /** Open an Android device tab. With no serial it opens on the pick-a-device
   *  form; the project defaults to the first component, which is what resolves
   *  the SDK (a project's local.properties pins one). */
  const openDevice = useCallback((serial = "") => {
    const id = tabId();
    setTabs((prev) => [
      ...prev,
      {
        id,
        type: "device",
        serial,
        projectDir: componentsRef.current[0]?.path ?? "",
        annotations: [],
      },
    ]);
    setActiveTabId(id);
    dismissPeekRef.current();
    return id;
  }, []);

  /** Open a relay conversation as its own tab — the everyone channel (peer
   *  null) or a DM — reusing one already open for it. */
  const openChat = useCallback((peer: string | null, name: string) => {
    const existing = tabsRef.current.find(
      (t): t is ChatSubTab => t.type === "chat" && t.peer === peer,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "chat", peer, name }]);
    setActiveTabId(id);
  }, []);

  // ---- live editing ----
  // Owner-side sessions this project started, keyed by path. Outside React
  // state on purpose: an OwnerSession holds a Monaco model subscription and
  // per-keystroke state, and copying it on every render would break both.
  const shared = useRef(new Map<string, OwnerSession>());
  // closeTab is a stable callback but needs the manager, which arrives as a
  // prop. The instance itself never changes; the ref is just how a [] callback
  // reaches it.
  const collabRef = useRef(relay.collab);
  collabRef.current = relay.collab;
  const ownerCursorAt = useRef(0);

  const sharedDocFor = useCallback(
    (path: string) => shared.current.get(path),
    [],
  );

  const sendOwnerCursor = useCallback(
    (path: string, anchor: number, head: number) => {
      const s = shared.current.get(path);
      if (!s) return;
      // Same 50ms floor the guest view uses: presence is droppable, and a caret
      // dragged across a file must not become a frame per pixel.
      const now = Date.now();
      if (now - ownerCursorAt.current < 50) return;
      ownerCursorAt.current = now;
      s.sendCursor(anchor, head);
    },
    [],
  );

  /** Share the open file with a member, live. This is the ONLY place a path
   *  becomes a shareable document, and it is reachable only from a click. */
  const shareFileLive = useCallback(
    (path: string, name: string, member: string, memberName: string) => {
      let session = shared.current.get(path);
      if (!session) {
        const model = monaco.editor.getModel(monaco.Uri.file(path));
        if (!model) {
          onNotice(
            "Open the file in the editor before sharing it live.",
            "error",
          );
          return;
        }
        session = relay.collab.share(path, model);
        shared.current.set(path, session);
      }
      session.offerTo(member, name, languageForPath(path) ?? null);
      onNotice(
        `Offered ${name} to ${memberName} — live once they accept.`,
        "success",
      );
    },
    [onNotice, relay],
  );

  /** Share the whole project with a member. The teammate browses the file tree
   *  and opens any file on demand; each open resolves to the same live-edit
   *  path as `shareFileLive`. Setting `onServeFile` here makes THIS project the
   *  one that answers those opens. */
  const shareProjectLive = useCallback(
    (member: string, memberName: string) => {
      const root = rootsRef.current[0];
      if (!root) {
        onNotice("This project has no folder to share.", "error");
        return;
      }
      relay.collab.onServeFile = async (r, relPath, to) => {
        const abs = r.endsWith("/") ? r + relPath : `${r}/${relPath}`;
        // Open it in our own editor and bring it to the front, so the sharer
        // sees and can follow whatever a teammate opens.
        await openFileRef.current(abs);
        let session = shared.current.get(abs);
        if (!session) {
          let model = monaco.editor.getModel(monaco.Uri.file(abs));
          if (!model) {
            try {
              model = modelFor(abs, await ipc.fsReadText(abs));
            } catch {
              onNotice(`Couldn't open ${relPath} to share.`, "error");
              return;
            }
          }
          session = relay.collab.share(abs, model);
          shared.current.set(abs, session);
        }
        session.offerTo(
          to,
          basename(relPath) || relPath,
          languageForPath(abs) ?? null,
        );
        const opener =
          relay.status.members.find((m) => m.id === to)?.name ?? "A teammate";
        onNotice(`${opener} opened ${basename(relPath) || relPath}`);
      };
      relay.collab.shareProject(root, project.name, member);
      onNotice(
        `Sharing "${project.name}" with ${memberName} — they can open any file live.`,
        "success",
      );
    },
    [onNotice, relay, project.name],
  );

  // Keep our owned-file handles in step with the manager: when a share ends
  // (the "Collaborating" cross, a closed tab, the relay dropping), drop the
  // stale entry so the file's "Share live" button stops reading as "Sharing".
  useEffect(() => {
    for (const [path, session] of [...shared.current]) {
      if (!relay.collab.get(session.doc)) shared.current.delete(path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.collabTick]);

  // A guest session appears only when the owner answers our `open` with a
  // snapshot, so the tab is opened from the manager's state rather than at the
  // moment we accept — there is nothing to show until the text arrives.
  useEffect(() => {
    const open = tabsRef.current.filter(
      (t): t is CollabSubTab => t.type === "collab",
    );
    for (const [doc, meta] of relay.collab.liveGuests()) {
      if (open.some((t) => t.doc === doc)) continue;
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        { id, type: "collab", doc, name: meta.name, ownerName: meta.ownerName },
      ]);
      setActiveTabId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.collabTick]);

  // A teammate shared their whole project: open one browser for it in the
  // project that's in front (guarding on `visible` keeps it from opening a
  // duplicate in every other mounted project).
  useEffect(() => {
    if (!visible) return;
    const open = tabsRef.current.filter(
      (t): t is SharedProjectSubTab => t.type === "shared-project",
    );
    for (const [doc, meta] of relay.collab.joinedProjects) {
      if (open.some((t) => t.doc === doc)) continue;
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "shared-project",
          doc,
          name: meta.name,
          ownerName: meta.fromName,
        },
      ]);
      setActiveTabId(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.collabTick, visible]);

  // Tell App which conversation is in front so it can skip toasts for it —
  // only the visible project speaks, or every mounted one would overwrite it.
  const activeTabForChat = tabs.find((t) => t.id === activeTabId);
  const activeChatPeer =
    visible && activeTabForChat?.type === "chat"
      ? activeTabForChat.peer
      : undefined;
  useEffect(() => {
    if (!visible) return;
    relay.reportActiveChat(activeChatPeer);
    return () => relay.reportActiveChat(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, activeChatPeer]);

  // Ring chat tabs that received something while not in front.
  //
  // Identity, not position. This tracked a running index into the transcript,
  // but App caps that transcript at 500 and empties it on disconnect — so once
  // 500 messages had gone by, the length stopped growing, `slice(500)` was
  // forever empty, and chat tabs never rang again for the rest of the session.
  // Disconnecting broke it the other way: the index pointed past the end of a
  // now-empty array, and nothing rang until 500 fresh messages had arrived.
  // Comparing ids against what we've already seen survives both, because it
  // never assumes the transcript only grows.
  const chatSeen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const seen = chatSeen.current;
    // First run seeds without ringing: history loaded before this view existed
    // is not "new", it is just history.
    chatSeen.current = new Set(relay.chat.map((m) => m.id));
    if (seen === null) return;
    const fresh = relay.chat.filter((m) => !seen.has(m.id));
    if (fresh.length === 0) return;
    const selfId = relay.status.self_id;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.type !== "chat" || (t.id === activeTabId && visible)) return t;
        const mine = fresh.some((m) =>
          t.peer === null
            ? m.to === null && m.from !== selfId
            : m.from === t.peer && m.to === selfId,
        );
        return mine ? { ...t, unread: true } : t;
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.chat]);

  /** Act on a relay command: open-pr finds the local checkout whose origin
   *  matches the sender's repo and opens the PR natively in it. */
  const openInboxItem = useCallback(
    async (item: ipc.RelayCommandMsg) => {
      // A review request carries its own diff — open it directly, no repo
      // lookup needed (the reviewer may not even have the code).
      if (item.kind === "review") {
        openReview({
          ...(item.payload as ReviewPayload),
          from: item.from_name,
        });
        relay.dismissInbox(item.id);
        return;
      }
      if (item.kind !== "open-pr") {
        relay.dismissInbox(item.id);
        return;
      }
      const payload = item.payload as { repo?: string; pr?: ipc.PrInfo };
      if (!payload.pr) {
        onNotice("That request is missing its PR payload.", "error");
        return;
      }
      try {
        const repos = await ipc.gitRepos(
          componentsRef.current.map(
            (c) => [c.label, c.path] as [string, string],
          ),
        );
        for (const r of repos) {
          const url = await ipc.gitRemoteUrl(r.path).catch(() => "");
          if (
            url &&
            payload.repo &&
            url.toLowerCase() === payload.repo.toLowerCase()
          ) {
            openPr(r.path, payload.pr);
            relay.dismissInbox(item.id);
            return;
          }
        }
        onNotice(
          `No component in this project has origin ${payload.repo ?? "?"} — open the matching project and try from there.`,
          "warn",
        );
      } catch (err) {
        onNotice(String(err), "error");
      }
    },
    [onNotice, openPr, openReview, relay],
  );

  // Repo toplevels for this project's components, resolved once per component
  // set: the PR inbox needs them to tell one of this project's PRs (open it
  // here) from another project's (ask App to switch first).
  const [repoPaths, setRepoPaths] = useState<string[]>([]);
  const componentKey = project.components.map((c) => c.path).join("|");
  useEffect(() => {
    let live = true;
    void ipc
      .gitRepos(
        project.components.map((c) => [c.label, c.path] as [string, string]),
      )
      .then((repos) => live && setRepoPaths(repos.map((r) => r.path)))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentKey]);

  // Every workspace of every repo this project spans. Loaded when the set can
  // actually have changed — the component set, or the switch funnel saying it
  // moved something — never polled: listing costs a `git status` per workspace
  // and a repo can easily have twenty.
  //
  // This is what makes the Servers panel able to offer a workspace's dev server
  // without you having to switch into that workspace first, which is the whole
  // of "run two features side by side".
  const [allWorktrees, setAllWorktrees] = useState<
    { repo: string; trees: ipc.WorktreeInfo[] }[]
  >([]);
  const repoKey = repoPaths.join("|");
  useEffect(() => {
    if (repoPaths.length === 0) {
      setAllWorktrees([]);
      return;
    }
    let live = true;
    void Promise.all(
      repoPaths.map((repo) =>
        ipc
          .gitWorktrees(repo)
          .then((trees) => ({ repo, trees }))
          .catch(() => ({ repo, trees: [] as ipc.WorktreeInfo[] })),
      ),
    ).then((all) => {
      if (!live) return;
      setAllWorktrees(all);
      for (const { repo, trees } of all) ensureLeases(repo, trees);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey, switchVersion]);

  // The rail badge counts what THIS project's panel would show — the badge and
  // the list must agree, or the badge is just noise you can't clear from here.
  // Other projects' queues are one line at the bottom of the panel, not a
  // number on a rail you're looking at while working somewhere else.
  const prsRows = usePrWatch((s) => s.rows);
  const prsBadge = useMemo(
    () => needsYouCount(prsRows.filter((r) => repoPaths.includes(r.repo))),
    [prsRows, repoPaths],
  );

  // Component roots plus every workspace's copy of them. The digest poll reads
  // this rather than `roots`, so an agent working in a worktree is still seen.
  // A ref because the poll is registered once and must not re-subscribe every
  // time a worktree appears.
  const digestRootsRef = useRef<string[]>([]);

  // Session digests + this launch's tag, so the "Agent Workspace" overlay can
  // resolve the agent behind the active terminal the same way AgentsPanel does
  // (by PTY surface id). Polled while an agent terminal is open; idle otherwise.
  const [wsDigests, setWsDigests] = useState<ipc.SessionDigest[]>([]);
  const [thisInstance, setThisInstance] = useState<string | null>(null);
  /** Which agent terminals have their workspace overlay open, by ptyId.
   *
   *  Per-terminal, not one global flag. Opening the workspace is a statement
   *  about the agent you opened it on — with a single boolean, switching to
   *  another agent's terminal found the overlay already up and silently
   *  re-pointed at that agent, so you'd land on a workspace you never asked to
   *  see, covering the terminal you did. A Set also means A stays open when you
   *  duck over to B and come back. */
  const [wsOpenPtys, setWsOpenPtys] = useState<ReadonlySet<number>>(new Set());
  // Mirrored for the agent-action handler, which is mounted once and must not
  // re-subscribe every time a digest poll lands.
  const wsDigestsRef = useRef(wsDigests);
  wsDigestsRef.current = wsDigests;
  const thisInstanceRef = useRef(thisInstance);
  thisInstanceRef.current = thisInstance;
  useEffect(() => {
    void ipc
      .instanceId()
      .then(setThisInstance)
      .catch(() => {});
  }, []);
  useEffect(() => {
    const load = () =>
      void ipc
        // Every workspace's directory too, not just the active one's. Filtered
        // to the active roots, an agent working in another worktree was dropped
        // here — which is exactly why a run could never be tied back to the
        // agent behind it.
        .sessionDigests(digestRootsRef.current)
        .then((d) => {
          // On any directory the session names, not only the one it last
          // reported from: `cwd` drifts (a cd, a relocation into a worktree, a
          // resume that ran in the wrong place), and matching on it alone drops
          // the session out of the very surfaces that would put it right.
          const mine = d.filter((x) =>
            [x.resume_cwd, x.launch_cwd, x.cwd].some(
              (dir) =>
                !!dir &&
                digestRootsRef.current.some(
                  (r) => dir === r || dir.startsWith(r + "/"),
                ),
            ),
          );
          // Bail when unchanged — otherwise this was an unconditional full
          // re-render of every open project, every 4 seconds, forever.
          setWsDigests((prev) =>
            prev.length === mine.length &&
            JSON.stringify(prev) === JSON.stringify(mine)
              ? prev
              : mine,
          );
        })
        .catch(() => {});
    load();
    // Event-driven via the change channel; the interval is only the fallback
    // for store-only CLIs whose digests move with no hook event to pulse on.
    // Hidden projects still need digests (job_done handling reads them) — the
    // pulse serves them too, at no polling cost.
    const un = subscribeSessionDigests(load);
    const t = setInterval(load, visible ? DIGEST_FALLBACK_MS : 60_000);
    return () => {
      un();
      clearInterval(t);
    };
  }, [visible]);

  // Restorable agent sessions, loaded while the launcher (empty state) is on
  // screen — that is precisely the moment "you left three agents mid-thought"
  // is worth saying, and it costs nothing the rest of the time.
  const [restorable, setRestorable] = useState<Restorable[]>([]);
  useEffect(() => {
    if (tabs.length > 0 || !visible) return;
    let live = true;
    const load = () =>
      void ipc
        .sessionDigests(rootsRef.current)
        .then((d) => {
          if (!live) return;
          const mine = d.filter((x) =>
            rootsRef.current.some(
              (r) => x.cwd === r || (x.cwd ?? "").startsWith(r + "/"),
            ),
          );
          setRestorable(
            restorableFrom(
              mine,
              statsRef.current,
              liveSessionIdsRef.current,
              restoreUserClosedSessions,
            ),
          );
        })
        .catch(() => live && setRestorable([]));
    load();
    const un = subscribeSessionDigests(load);
    const t = setInterval(load, DIGEST_FALLBACK_MS);
    return () => {
      live = false;
      un();
      clearInterval(t);
    };
  }, [tabs.length, visible, restoreUserClosedSessions]);

  // Remember the terminal layout so it can be offered back on the empty
  // state. Snapshotted on change rather than on unmount: a crash or a force
  // quit never runs cleanup, and those are precisely the cases this exists
  // for.
  // Micro-task tabs are excluded: they're one-shot and ephemeral, so
  // "reopen it" would re-run a task that already finished. Chore runs go for
  // the same reason — "restore my terminals" must not mean "install that again".
  useEffect(() => {
    const open: RememberedTerminal[] = tabs
      .filter(
        (t): t is TermSubTab =>
          t.type === "terminal" && !t.exited && !t.micro && !t.chore,
      )
      .map((t) => ({
        cwd: t.cwd,
        command: t.command,
        title: t.customTitle ?? t.title,
        icon: t.icon,
        run: t.run,
        componentId: t.componentId,
        runCommandId: t.runCommandId,
        tabId: t.id,
        paneGroup: t.paneGroup,
        sessionId:
          (t.ptyId != null ? liveSessionByPtyRef.current.get(t.ptyId) : undefined) ??
          resumeSessionId(t.command) ??
          undefined,
        profile: t.profile,
      }));
    rememberTerminals(project.id, open, terminalGroups);
  }, [tabs, terminalGroups, project.id, events]);

  const [remembered, setRemembered] = useState<RememberedTerminal[]>([]);
  const [rememberedLayouts, setRememberedLayouts] = useState<
    Record<string, TerminalGroup>
  >({});
  useEffect(() => {
    if (tabs.length > 0 || !visible) return;
    const memory = rememberedTerminalState(project.id);
    // The command marker drops micro-tasks snapshotted before they were
    // excluded above — they'd otherwise sit in the list until overwritten.
    setRemembered(
      memory.terminals.filter(
        (t) => !(t.command ?? "").includes("CANOPY_MICRO_TASK="),
      ),
    );
    setRememberedLayouts(memory.terminalGroups);
  }, [tabs.length, visible, project.id]);

  const resumeCards = useMemo(
    () => terminalResumeCards(remembered, rememberedLayouts, restorable),
    [remembered, rememberedLayouts, restorable],
  );

  const reopenTerminal = useCallback(
    (t: RememberedTerminal, activate = true) => {
      const id = addTerminal(
        t.cwd,
        t.command,
        t.title,
        t.icon,
        t.run,
        undefined,
        undefined,
        activate,
        undefined,
        t.componentId && t.runCommandId
          ? { componentId: t.componentId, runCommandId: t.runCommandId }
          : undefined,
      );
      return id;
    },
    [addTerminal],
  );

  const resumeSession = useCallback(
    async (r: Restorable, activate = true): Promise<string | null> => {
      if (!r.command || !r.cwd) return null;
      // Already open — focus that tab instead of spawning a second identical
      // resume. The resume command carries the session id, so command+cwd
      // uniquely identifies the terminal running this exact session; without
      // this, "Restore all", a double-click, or the row reappearing all stack
      // duplicate tabs of the same conversation.
      const open = tabsRef.current.find(
        (t): t is TermSubTab =>
          t.type === "terminal" &&
          ((t.ptyId != null &&
            liveSessionByPtyRef.current.get(t.ptyId) === r.digest.session_id) ||
            resumeSessionId(t.command) === r.digest.session_id),
      );
      if (open) {
        if (activate) setActiveTabId(open.id);
        return open.id;
      }
      // Hide it immediately rather than waiting for the next poll; the mark
      // is a bridge until the agent shows up in the process list, after which
      // the row's presence tracks whether that terminal is still open.
      markRestored(r.digest.session_id);
      setRestorable((prev) =>
        prev.filter((x) => x.digest.session_id !== r.digest.session_id),
      );
      // The account that owns the conversation, not the one selected now:
      // `--resume <id>` resolves inside the CLI's own config dir.
      const env =
        r.profile && r.profile !== "default"
          ? await ipc.profileEnv(r.agentId, r.profile).catch(() => [])
          : [];
      const id = addTerminal(
        r.cwd,
        r.command,
        r.digest.agent ?? "agent",
        AGENT_CLIS.find((c) => c.id === r.agentId)?.icon,
        false,
        env,
        env.length ? r.profile : undefined,
        activate,
      );
      return id;
    },
    [addTerminal],
  );

  const restoreResumeCard = useCallback(
    async (card: TerminalResumeCard, only?: TerminalResumeLeaf) => {
      const leaves = only ? [only] : card.leaves;
      const ids = new Map<string, string>();
      // Every tab that came back, in strip order. The map above only holds the
      // ones that carry a remembered tabId — a resumed agent session has none —
      // so it can never be what decides which tab ends up in front.
      const opened: (string | null)[] = [];
      for (const leaf of leaves) {
        const id = leaf.restorable
          ? await resumeSession(leaf.restorable, false)
          : leaf.remembered
            ? reopenTerminal(leaf.remembered, false)
            : null;
        opened.push(id);
        if (id && leaf.remembered?.tabId) ids.set(leaf.remembered.tabId, id);
      }

      const root = card.group && !only ? mapSplitTabIds(card.group.root, ids) : null;
      const memberIds = root ? leafIds(root) : [];
      if (card.group && root && memberIds.length >= 2) {
        const group: TerminalGroup = {
          ...card.group,
          root,
          activeTabId: ids.get(card.group.activeTabId) ?? memberIds[0],
          zoomedTabId: card.group.zoomedTabId
            ? ids.get(card.group.zoomedTabId)
            : undefined,
        };
        setTabs((prev) =>
          prev.map((tab) =>
            tab.type === "terminal" && memberIds.includes(tab.id)
              ? { ...tab, paneGroup: group.id }
              : tab,
          ),
        );
        terminalGroupsRef.current = {
          ...terminalGroupsRef.current,
          [group.id]: group,
        };
        setTerminalGroups(terminalGroupsRef.current);
        setActiveTabId(group.activeTabId);
      } else {
        const front = restoredFront(opened, null);
        if (front) setActiveTabId(front);
      }
    },
    [reopenTerminal, resumeSession],
  );

  /** Carry out an accepted reload: each eligible agent's terminal is replaced
   *  by one running under the new account, in the same directory. The old
   *  session is not lost — its transcript stays in the account that made it,
   *  and it comes back on that account's restorable list. */
  const runReload = useCallback(async (ask: NonNullable<typeof reloadAsk>) => {
    setReloadAsk(null);
    await primeLaunchEnv();
    for (const item of reloading(ask.plan)) {
      const cli = AGENT_CLIS.find((c) => c.id === item.agent.agentId);
      if (!cli || !item.action) continue;
      const env = launchEnvSync(cli.id);
      // No env means the account could not be resolved after all; leaving the
      // agent where it is beats moving it somewhere we cannot name. The default
      // account is the exception: it carries no env by design.
      if (!envReachesProfile(ask.profile, env)) continue;
      closeTabRef.current(item.agent.tabId);
      if (item.action.kind === "resume") markRestored(item.action.sessionId);
      addTerminal(
        item.action.kind === "resume" ? item.action.cwd : item.agent.cwd,
        item.action.kind === "resume" ? item.action.command : launchCommand(cli),
        cli.name,
        cli.icon,
        false,
        env,
        ask.profile === DEFAULT_PROFILE ? undefined : ask.profile,
      );
    }
  }, [addTerminal]);

  // Which rows "Restore all" would actually reopen. Every row in the block, in
  // the order the block renders them, each with the thunk that opens it — so
  // the button, the checkboxes and the confirmation all count the same things.
  const resumeItems = useMemo(
    () =>
      resumeCards.map((card) => ({
        key: card.key,
        count: card.leaves.length,
        open: () => restoreResumeCard(card),
      })),
    [resumeCards, restoreResumeCard],
  );

  // Past a handful, "reopen everything" stops being a convenience and becomes a
  // way to start a dozen agents by accident, so each row grows a checkbox and
  // the button restores the selection instead. Below that the list is short
  // enough to read at a glance and the checkboxes are just clutter.
  const RESUME_PICK_FROM = 5;
  // A machine can take a few agents starting at once; ten is where it stops
  // being a choice you can take back, so that one gets confirmed.
  const RESUME_CONFIRM_OVER = 10;
  const resumeTerminalCount = resumeItems.reduce((sum, item) => sum + item.count, 0);
  const pickable = resumeTerminalCount > RESUME_PICK_FROM;
  const [picked, setPicked] = useState<string[]>([]);
  // Rows come and go as sessions are restored or forgotten; a key left behind
  // would keep "Restore selected (3)" claiming a row nobody can see.
  const chosen = pickable ? picked.filter((k) => resumeItems.some((i) => i.key === k)) : [];
  const [confirmResume, setConfirmResume] = useState<{
    count: number;
    go: () => void;
  } | null>(null);

  /** The row's checkbox, or nothing while the list is short. Stops propagation:
   *  the row itself is still click-to-reopen, and ticking a box must not do
   *  the very thing the box exists to hold back. */
  const pickBox = (key: string) =>
    pickable ? (
      <input
        type="checkbox"
        className="resume-pick"
        checked={chosen.includes(key)}
        title="Select for Restore selected"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) =>
          setPicked((prev) =>
            e.target.checked ? [...prev, key] : prev.filter((k) => k !== key),
          )
        }
      />
    ) : null;

  const runResume = useCallback(
    (items: { count: number; open: () => void | Promise<void> }[]) => {
      if (items.length === 0) return;
      const count = items.reduce((sum, item) => sum + item.count, 0);
      const go = async () => {
        for (const item of items) await item.open();
        setPicked([]);
      };
      if (count > RESUME_CONFIRM_OVER) setConfirmResume({ count, go });
      else void go();
    },
    [],
  );

  // Worktrees for the ticket tab's cross-reference. Loaded when a ticket tab
  // opens rather than polled — the Issues panel keeps its own copy for rows.
  const [ticketWorktrees, setTicketWorktrees] = useState<ipc.WorktreeInfo[]>(
    [],
  );
  const ticketRepo = useCallback(async () => {
    const repos = await ipc.gitRepos(
      componentsRef.current.map((c) => [c.label, c.path] as [string, string]),
    );
    return repos[0]?.path ?? null;
  }, []);

  /** Create or reuse the ticket's worktree and start an agent in it. The one
   *  implementation both the Issues panel and the ticket tab call. */
  const startTicketWork = useCallback(
    async (ticket: ipc.TicketInfo, requestedRepo: string, agentId?: string) => {
      const repo = requestedRepo || await ticketRepo();
      if (!repo) {
        onNotice("No git repository in this project.");
        return;
      }
      // The chosen agent, else the user's default — one rule, shared with every
      // other launcher, and never a hardcoded vendor name (see pickLaunchCli).
      const installedHere = getInstalled();
      const cli = pickLaunchCli(agentId, (bin) => Boolean(installedHere[bin]));
      if (!cli) {
        onNotice(`Unknown agent "${agentId}".`);
        return;
      }
      const agent = cli.id;
      // Parked in `repo` rather than the workspace, which does not exist yet:
      // the pointer is an absolute path, so it reads the same from either.
      const start = await startCommandParked(agent, ticketContext(ticket), repo);
      if (!start) {
        onNotice(`Unknown agent "${agent}".`);
        return;
      }
      const worktrees = await ipc
        .gitWorktrees(repo)
        .catch(() => [] as ipc.WorktreeInfo[]);
      const existing = ticketWorktree(ticket, worktrees);
      const title = `${ticket.id} · ${cli.name}`;
      if (existing) {
        const id = addTerminal(existing.path, start.command, title, cli.icon);
        setTicketWorktrees(worktrees);
        if (id && start.typePrompt)
          pendingTerminalPrompts.current.set(id, ticketContext(ticket));
        return;
      }
      // The funnel owns where a workspace goes and what to do when git won't
      // make one — a branch another workspace already holds, a folder already
      // at that name, a checkout mid-merge. Each of those used to arrive here
      // as raw stderr behind "Couldn't start work on".
      //
      // A ticket you have never started has no branch yet, so `create` is what
      // makes "start work on this" mean it. Without it the funnel asks whether
      // to look for the branch on GitHub — a question about a branch that was
      // never meant to exist before this click.
      const branch = ticketBranch(ticket);
      const branches = await ipc
        .gitBranches(repo)
        .catch(() => [] as ipc.BranchInfo[]);
      const r = await switchTo(
        repo,
        { kind: "workspace", branch, create: !branches.some((b) => b.name === branch) },
        { because: `the ticket ${ticket.id}` },
      );
      if (r.kind !== "settled") return; // already asked and answered on screen
      setTicketWorktrees(await ipc.gitWorktrees(repo).catch(() => worktrees));
      const id = addTerminal(r.path, start.command, title, cli.icon);
      if (id && start.typePrompt)
        pendingTerminalPrompts.current.set(id, ticketContext(ticket));
    },
    [ticketRepo, addTerminal, onNotice, getInstalled, switchTo],
  );

  /** Put a PR's head in a workspace of its own (reusing one already holding it)
   *  and start an agent there to review it. The mirror of startTicketWork —
   *  same workspace-then-agent shape — but the PR already carries its branch,
   *  so there's nothing to invent, and the workspace stays at the PR's head
   *  rather than claiming the branch: git allows a branch in one place at a
   *  time, and that place is usually this checkout already. */
  // `mode` only swaps the prompt it is seeded with (review vs.
  // resolve-the-conflicts); the workspace and the seeding are identical.
  const startPrAgent = useCallback(
    async (
      mode: "review" | "resolve",
      repo: string,
      pr: ipc.PrInfo,
      agentId?: string,
    ) => {
      const installedHere = getInstalled();
      const cli = pickLaunchCli(agentId, (bin) => Boolean(installedHere[bin]));
      if (!cli) {
        onNotice(`Unknown agent "${agentId}".`);
        return;
      }
      const agent = cli.id;
      // The funnel reuses a workspace already holding this PR and otherwise
      // makes an ephemeral one at the PR's head — fork-safe, and without moving
      // the main checkout's branch. Only a workspace IT created is disposable,
      // which is exactly what `created` says, so only then do we tell the agent
      // to remove it.
      const r = await switchTo(repo, {
        kind: "pr-workspace",
        number: pr.number,
        branch: pr.branch,
      });
      if (r.kind !== "settled") return; // already asked and answered on screen
      const cleanup = r.created ? { repo, worktree: r.path } : undefined;
      const context =
        mode === "resolve"
          ? prConflictContext(pr, cleanup)
          : prReviewContext(pr, cleanup);
      const start = await startCommandParked(agent, context, r.path);
      if (!start) {
        onNotice(`Unknown agent "${agent}".`);
        return;
      }
      const title = `PR #${pr.number} · ${cli.name}`;
      const id = addTerminal(r.path, start.command, title, cli.icon);
      if (id && start.typePrompt)
        pendingTerminalPrompts.current.set(id, context);
    },
    [addTerminal, onNotice, getInstalled, switchTo],
  );
  const startPrReview = useCallback(
    (repo: string, pr: ipc.PrInfo, agentId?: string) =>
      startPrAgent("review", repo, pr, agentId),
    [startPrAgent],
  );
  const startPrConflictResolve = useCallback(
    (repo: string, pr: ipc.PrInfo, agentId?: string) =>
      startPrAgent("resolve", repo, pr, agentId),
    [startPrAgent],
  );

  /** Open a branch as its own tab — its uncommitted work, its commits, and
   *  its diff against the base. */
  const openBranch = useCallback(
    (repo: string, branch: ipc.BranchWork) => {
      const existing = tabsRef.current.find(
        (t): t is BranchSubTab =>
          t.type === "branch" && t.branch.branch === branch.branch,
      );
      if (existing) {
        // The audit's copy is fresher (dirty counts move); take it.
        patchTabRaw(existing.id, { branch } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "branch", repo, branch }]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open a commit as its own tab, reusing one already open for it. */
  const openCommit = useCallback(
    (
      repo: string,
      commit: { hash: string; short: string; subject: string },
    ) => {
      const existing = tabsRef.current.find(
        (t): t is CommitSubTab => t.type === "commit" && t.hash === commit.hash,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "commit", repo, ...commit }]);
      setActiveTabId(id);
    },
    [],
  );

  /** Open an agent's workspace as its own tab — the files it changed, its
   *  commits, and the PR from its branch. Identity is the live agent (the
   *  process running in the terminal), never a stale hook digest; the digest,
   *  when present, is only enrichment. The repo is matched from the agent's
   *  cwd; the backend's worktree authorization is the real gate, so a wrong
   *  guess degrades to an error banner, not someone else's diff. */
  const openAgent = useCallback(
    async (p: {
      agent: string;
      cwd: string;
      ptyId?: number;
      sessionId?: string;
      digest?: ipc.SessionDigest;
    }) => {
      // One workspace per live terminal; fall back to session id for the rare
      // terminal-less case.
      const existing = tabsRef.current.find(
        (t): t is AgentSubTab =>
          t.type === "agent" &&
          (p.ptyId != null ? t.ptyId === p.ptyId : t.sessionId === p.sessionId),
      );
      if (existing) {
        // The panel's copy is fresher (agent, cwd, state and branch all move).
        patchTabRaw(existing.id, {
          agent: p.agent,
          cwd: p.cwd,
          sessionId: p.sessionId,
          digest: p.digest,
          ptyId: p.ptyId,
        } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      let repo: string | null = null;
      try {
        const repos = await ipc.gitRepos(
          componentsRef.current.map(
            (c) => [c.label, c.path] as [string, string],
          ),
        );
        const cwd = p.cwd;
        repo =
          repos.find((r) => cwd === r.path || cwd.startsWith(`${r.path}/`))
            ?.path ??
          // Sibling worktrees follow the `<repo>-wt-<branch>` convention.
          repos.find((r) => cwd.startsWith(`${r.path}-wt-`))?.path ??
          repos[0]?.path ??
          null;
      } catch {
        repo = null;
      }
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "agent",
          repo,
          agent: p.agent,
          cwd: p.cwd,
          sessionId: p.sessionId,
          digest: p.digest,
          ptyId: p.ptyId,
        },
      ]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open the completed-tasks tab, or focus it if it's already up. Only ever
   *  one — it's a view of a single app-wide log, so a second would be a copy. */
  const openTaskHistory = useCallback(
    (runId?: string) => {
      const focus = runId ? { runId, nonce: Date.now() } : undefined;
      const existing = tabsRef.current.find((t) => t.type === "task-history");
      if (existing) {
        // Already open: hand it the run anyway, so a click from the panel lands
        // on that row instead of wherever the tab was last left.
        if (focus) patchTabRaw(existing.id, { focus } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "task-history", focus }]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open the agent-instructions tab, focused on one file when a panel row
   *  asked for it. One per project, like the history tab. */
  const openInstructions = useCallback(
    (focus?: string) => {
      const existing = tabsRef.current.find((t) => t.type === "instructions");
      if (existing) {
        if (focus) patchTabRaw(existing.id, { focus } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "instructions", focus }]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open the agents page, or focus it if it's already up. One per project:
   *  it is a view of this project's sessions, so a second would be a copy. */
  const openAgentsPage = useCallback(() => {
    const existing = tabsRef.current.find((t) => t.type === "agents");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = tabId();
    setTabs((prev) => [...prev, { id, type: "agents" }]);
    setActiveTabId(id);
  }, []);

  const openCollectionPage = useCallback((type: "research-list" | "notes-list" | "prs-list" | "issues-list") => {
    const existing = tabsRef.current.find((t) => t.type === type);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = tabId();
    setTabs((prev) => [...prev, { id, type }]);
    setActiveTabId(id);
  }, []);

  /** Open one MCP server as its own tab, reusing the one already open for it.
   *  Identity is the server key — the same server reached through two CLIs is
   *  one server, and opening it from either row should land on one tab. */
  const openMcpServer = useCallback(
    (server: ipc.McpServer) => {
      const existing = tabsRef.current.find(
        (t): t is McpSubTab => t.type === "mcp" && t.server.key === server.key,
      );
      if (existing) {
        // The panel's copy is the fresher read of the configs.
        patchTabRaw(existing.id, { server } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "mcp", server }]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open one advisory file claim as its own tab. Keyed on the claim id, not
   *  the owner: an agent that releases and claims again has two claims, and the
   *  tab you opened on the first must keep showing the first. */
  const openClaim = useCallback(
    (claim: ipc.AgentClaim) => {
      const existing = tabsRef.current.find(
        (t): t is ClaimSubTab => t.type === "claim" && t.claimId === claim.id,
      );
      if (existing) {
        // The list's copy is the fresher read of the same row.
        patchTabRaw(existing.id, { claim } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "claim", claimId: claim.id, claim }]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open an issue as its own tab, reusing one already open for it. */
  const openTicket = useCallback(
    (ticket: ipc.TicketInfo, source: string, requestedRepo?: string) => {
      const existing = tabsRef.current.find(
        (t): t is TicketSubTab =>
          t.type === "ticket" &&
          t.source === source &&
          t.ticket.id === ticket.id &&
          (!requestedRepo || !t.repo || t.repo === requestedRepo),
      );
      if (existing) {
        // Refresh the payload: the panel's copy is newer than the tab's.
        patchTabRaw(existing.id, {
          ticket,
          repo: requestedRepo ?? existing.repo,
        } as Partial<SubTab>);
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        { id, type: "ticket", ticket, source, repo: requestedRepo },
      ]);
      setActiveTabId(id);
      void (requestedRepo ? Promise.resolve(requestedRepo) : ticketRepo()).then(
        (repo) => {
          if (repo && !requestedRepo)
            patchTabRaw(id, { repo } as Partial<SubTab>);
          if (repo)
            void ipc
              .gitWorktrees(repo)
              .then(setTicketWorktrees)
              .catch(() => {});
        },
      );
    },
    [patchTabRaw, ticketRepo],
  );

  /** Open a research entry as a tab. One tab per entry: the view re-reads the
   *  store on every change, so a second tab on the same id would be the same
   *  thing twice rather than two views of anything. */
  const openResearch = useCallback(
    (researchId: string, title: string) => {
      const existing = tabsRef.current.find(
        (t): t is ResearchSubTab =>
          t.type === "research" && t.researchId === researchId,
      );
      if (existing) {
        if (title && title !== existing.title) {
          patchTabRaw(existing.id, { title } as Partial<SubTab>);
        }
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "research", researchId, title }]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Open a note as a tab. Same shape as openResearch: the tab holds the id
   *  and the last known title, and the view re-reads the store itself. */
  const openNote = useCallback(
    (noteId: string, title: string) => {
      const existing = tabsRef.current.find(
        (t): t is NoteSubTab => t.type === "note" && t.noteId === noteId,
      );
      if (existing) {
        if (title && title !== existing.title) {
          patchTabRaw(existing.id, { title } as Partial<SubTab>);
        }
        setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [...prev, { id, type: "note", noteId, title }]);
      setActiveTabId(id);
    },
    [patchTabRaw],
  );

  /** Hand ticket context to an agent terminal that is already running. */
  const sendTicketToAgent = useCallback((target: AgentTarget, text: string) => {
    // Same two-write pattern as the model switcher: text, then Enter a beat
    // later so a TUI's autocomplete can't swallow the submit.
    void ipc.ptyWrite(target.ptyId, text);
    setTimeout(() => void ipc.ptyWrite(target.ptyId, "\r"), 250);
    setActiveTabId(target.tabId);
    setTimeout(() => termHandles.current.get(target.tabId)?.focus(), 50);
  }, []);

  const gateManagedLaunch = useCallback(
    async (
      cli: AgentCli,
      installed: Record<string, boolean>,
    ): Promise<{
      allowed: boolean;
      route: FleetRouteSnapshot;
      env: [string, string][];
    }> => {
      await primeLaunchEnv();
      const env = launchEnvSync(cli.id);
      const profile = launchProfile(cli.id) ?? DEFAULT_PROFILE;
      const route = await inspectFleetRoute(cli, profile, installed);
      const gate = fleetGate(route.state);
      const profileName =
        profile === DEFAULT_PROFILE
          ? "default"
          : (profilesRef.current.find((item) => item.id === profile)?.label ?? profile);
      const label = `${cli.name} · ${profileName}`;
      if (!gate.allowed) {
        const text = `${label} can't start: ${gate.why ?? "route unavailable"}.`;
        setFleetLaunchNote({ kind: "unusable", text });
        onNotice(text, "error");
        return { allowed: false, route, env };
      }
      if (gate.why) {
        const text = `${label}: ${gate.why}. Launching anyway.`;
        setFleetLaunchNote({ kind: route.state.kind, text });
        onNotice(text, "warn");
      } else {
        setFleetLaunchNote(null);
      }
      return { allowed: true, route, env };
    },
    [onNotice],
  );

  /** Start a fresh agent CLI in `dir`, seeded with `seed`. The diff surfaces
   *  (session changes, a file diff, a relay review) work on the working tree
   *  that's already there, so unlike a PR/ticket there's no worktree to make —
   *  the agent just opens in the existing checkout. Same resolve-CLI-then-seed
   *  shape as startTicketWork/startPrAgent. */
  const startAgentInDir = useCallback(
    async (dir: string, agentId: string | undefined, seed: string, title: string) => {
      const installed = await getInstalledForLaunch();
      const cli = pickLaunchCli(agentId, (bin) => Boolean(installed[bin]));
      if (!cli) {
        onNotice(`Unknown agent "${agentId}".`);
        return false;
      }
      const agent = cli.id;
      const fleet = await gateManagedLaunch(cli, installed);
      if (!fleet.allowed) return false;
      const start = await startCommandParked(agent, seed, dir);
      if (!start) {
        onNotice(`Unknown agent "${agent}".`);
        return false;
      }
      const id = addTerminal(
        dir,
        start.command,
        `${title} · ${cli.name}`,
        cli.icon,
        false,
        fleet.env,
        fleet.route.profile === DEFAULT_PROFILE
          ? undefined
          : fleet.route.profile,
      );
      if (id && start.typePrompt)
        pendingTerminalPrompts.current.set(id, seed);
      return Boolean(id);
    },
    [addTerminal, onNotice, getInstalledForLaunch, gateManagedLaunch],
  );

  /** Micro-tasks running with no tab of their own. The Tasks panel is their
   *  surface; ProjectView owns their PTYs, which is why the list lives here.
   *  Ref and state move together so an event arriving between renders (a
   *  job_done, a pty exit) sees the list as it is now, not as it was painted. */
  const [microRuns, setMicroRuns] = useState<MicroRun[]>([]);
  const microRunsRef = useRef<MicroRun[]>(microRuns);
  const updateMicroRuns = useCallback(
    (fn: (runs: MicroRun[]) => MicroRun[]) => {
      microRunsRef.current = fn(microRunsRef.current);
      setMicroRuns(microRunsRef.current);
    },
    [],
  );
  useEffect(() => {
    const sync = (event: Event) => {
      const changed = (event as CustomEvent<{ runId?: string }>).detail?.runId;
      const runs = changed
        ? microRunsRef.current.filter((run) => run.runId === changed)
        : microRunsRef.current;
      for (const run of runs) {
        void taskGet(run.runId).then((detail) => {
          const state = detail?.attempts.find(
            (attempt) => attempt.attemptId === run.attemptId,
          )?.state;
          if (state)
            updateMicroRuns((current) =>
              patchRun(current, run.ptyId, { attemptState: state }),
            );
        });
      }
    };
    window.addEventListener(TASK_ENVELOPES_EVENT, sync);
    return () => window.removeEventListener(TASK_ENVELOPES_EVENT, sync);
  }, [updateMicroRuns]);
  // Ages the "· 2m" on each running row, and only while something is running:
  // a project with no task in flight should not repaint on a timer.
  const [microClock, setMicroClock] = useState(() => Date.now());
  useEffect(() => {
    if (microRuns.length === 0) return;
    setMicroClock(Date.now());
    const tick = window.setInterval(() => setMicroClock(Date.now()), 5_000);
    return () => window.clearInterval(tick);
  }, [microRuns.length]);

  /** Launch a micro-task: a one-shot agent seeded with the task's brief plus
   *  the completion protocol. CANOPY_MICRO_TASK reaches the MCP sidecar through
   *  PTY env inheritance and marks the session as one whose job_done must
   *  always be honored. Runs on the user's default agent like every other
   *  launcher — see pickLaunchCli, and the note there about the `claude` this
   *  used to put ahead of it.
   *
   *  Where it runs depends on whether it can report back. An agent with the
   *  bridge runs detached: no tab, no window taken over, just a row in Tasks
   *  that says what it's doing and what it found. Anything else keeps the
   *  ephemeral tab, which for those CLIs is the only place the run is visible
   *  at all. */
  /** Returns whether an agent actually started. Every surface that lights a
   *  button up on click needs to know, because the launch can still fall over
   *  afterwards — no CLI, a worktree that won't build, a spawn that fails — and
   *  a caller left guessing shows "Resolving…" over an error toast until a
   *  timeout rescues it. */
  const startMicroTask = useCallback(
    async <P,>(
      def: MicroTaskDef<P>,
      payload: P,
      userQuery: string,
      // Which CLI to run it on. Absent means "decide for me", which is every
      // caller that has no agent picker; the split-button surfaces pass the
      // one the user chose from its menu.
      preferAgent?: string,
      onReserved?: (ids: { runId: string; attemptId: string }) => void,
    ): Promise<boolean> => {
      await hydrateTaskHistory();
      const installed = await getInstalledForLaunch();
      const cli = pickLaunchCli(preferAgent, (bin) => Boolean(installed[bin]));
      const agent = cli?.id;
      if (!cli || !agent) {
        onNotice(`No agent CLI installed to run "${def.label}".`);
        return false;
      }
      const fleet = await gateManagedLaunch(cli, installed);
      if (!fleet.allowed) return false;
      // A task that edits files gets the PR's branch in a worktree of its own,
      // same deal as startPrAgent: reuse the worktree already holding it, else
      // make a throwaway the brief tells the agent to remove. If that fails we
      // stop rather than fall back to the shared checkout — the agent would
      // commit onto whatever branch happens to be sitting there.
      const requestedDir = def.cwd(payload);
      let dir = requestedDir;
      let env: MicroTaskEnv | undefined;
      if (def.isolation) {
        // Both isolation kinds want the same thing — this work, in a workspace
        // of its own — and differ only in what they start from: a PR's head, or
        // a branch that does not exist yet.
        const iso = def.isolation;
        const { repo } = iso.target(payload);
        const target =
          iso.kind === "pr-worktree"
            ? ({
                kind: "pr-workspace",
                number: iso.target(payload).pr.number,
                branch: iso.target(payload).pr.branch,
              } as const)
            : ({
                kind: "workspace",
                branch: iso.target(payload).branch,
                create: true,
              } as const);
        // `because` matters here: a task can arm itself with no click at all
        // (the review loop), so a dialog appearing out of nowhere has to say
        // what wanted it.
        const r = await switchTo(repo, target, {
          because: `the "${def.label}" task`,
        });
        // Not settled means the question was asked and answered on screen —
        // and the caller still needs the `false` to clear its pending pill.
        if (r.kind !== "settled") return false;
        dir = r.path;
        env = r.created ? { cleanup: { repo, worktree: r.path } } : undefined;
      }
      const brief = def.buildContext(payload, userQuery, env);
      const seed = oneLine(
        `${brief} ${progressBrief(def, payload)} ${microTaskProtocol()}`,
      );
      const start = await startCommandParked(agent, seed, dir);
      if (!start) {
        onNotice(`No agent CLI installed to run "${def.label}".`);
        return false;
      }
      // What to call this particular run — the question, the PR number — rather
      // than what to call the task. Resolved once so the history row, the
      // running chip and the tab title cannot disagree about which run this is.
      const runName = runLabelFor(def, payload, userQuery);
      const component = [...project.components]
        .filter(
          (candidate) =>
            requestedDir === candidate.path ||
            requestedDir.startsWith(`${candidate.path}/`) ||
            candidate.path.startsWith(`${requestedDir}/`),
        )
        .sort((a, b) => b.path.length - a.path.length)[0];
      const history = {
        taskId: def.id,
        label: runName,
        icon: def.icon,
        agent: cli.id,
        cwd: dir,
        projectId: project.id,
        projectName: project.name,
        brief,
        // A worktree we made for this run is one the brief tells the agent to
        // delete. The launcher's metadata is the only durable place that knows.
        ephemeralCwd: Boolean(env?.cleanup),
      };
      let reservation;
      let durableHistory;
      try {
        const appInstance = await ipc.instanceId();
        durableHistory = { ...history, appInstance };
        reservation = await reserveTask({
          kind: def.id,
          projectId: project.id,
          componentId: component?.id ?? project.id,
          worktreePath: dir,
          goal: brief,
          acceptance: def.steps?.map((step) => step.done) ?? [],
          taskClasses: { micro_task: 1 },
          contextSummary: `One-shot ${def.effect ?? "reads"} task launched from ${runName}.`,
          riskClass: def.effect ?? "reads",
          authorityPolicy: { effect: def.effect ?? "reads" },
          failoverPolicy: { automatic: false },
          attemptCap: 1,
          title: runName,
          metadata: { ...durableHistory, history: true },
          route: {
            cli: cli.id,
            profileId: launchProfile(agent) ?? "default",
            harnessVersion: "micro-task-v1",
            promptVersion: "micro-task-v1",
            toolPolicyVersion: "micro-task-v1",
            executionMode: "pty",
          },
        });
      } catch (err) {
        onNotice(`Couldn't reserve "${def.label}": ${String(err)}`, "error");
        return false;
      }
      const durableRun = adoptTaskReservation(reservation, durableHistory);
      const { runId, attemptId } = {
        runId: reservation.envelope.runId,
        attemptId: reservation.attempt.attemptId,
      };
      onReserved?.({ runId, attemptId });
      /** Type the brief in for a CLI that takes no prompt argument: write, then
       *  submit a beat later, once the agent has had time to come up. */
      const seedPrompt = (pty: number) => {
        void ipc.ptyWrite(pty, seed);
        setTimeout(() => void ipc.ptyWrite(pty, "\r"), 250);
      };

      // Spawns detached, bypassing addTerminal — so the account env is added
      // here. A micro-task spends the same quota as any other agent.
      const extraEnv: [string, string][] = [
        ...fleet.env,
        ...(def.env?.(payload) ?? []),
      ];
      // Which research entry this run is for, taken from the env the task
      // already declares rather than from a second channel — so the launcher
      // stays generic and any future task that binds an entry gets this free.
      const researchId = extraEnv.find(([k]) => k === "CANOPY_RESEARCH")?.[1];

      if (fleet.route.health?.mcp === "ours") {
        let pty: number;
        try {
          const res = await ipc.ptySpawnDetached({
            cwd: dir,
            command: start.command,
            env: [["CANOPY_MICRO_TASK", "1"], ...extraEnv],
            runId,
            attemptId,
          });
          pty = res.id;
        } catch (err) {
          onNotice(`Couldn't start "${def.label}": ${String(err)}`, "error");
          return false;
        }
        updateTaskRun(runId, { ptyId: pty, researchId });
        updateMicroRuns((runs) =>
          withRun(runs, {
            ptyId: pty,
            runId,
            attemptId,
            attemptState: "running",
            taskId: def.id,
            label: runName,
            icon: def.icon,
            cwd: dir,
            researchId,
            agent: cli.id,
            startedAt: Date.now(),
          }),
        );
        if (start.typePrompt) setTimeout(() => seedPrompt(pty), 2500);
        // Said once per launch because the alternative is a click that appears
        // to do nothing: the work is real, it is just not in front of you.
        onNotice(`“${runName}” is running — watch it in Tasks.`, "info", {
          where: { kind: "panel", panel: "tasks", projectId: project.id },
        });
        return true;
      }

      // The tab path prefixes the same variables onto the command line, since
      // there is no env channel here — single-quoted so a value with a space
      // (an entry directory under a path with one) survives the shell.
      const envPrefix = [["CANOPY_MICRO_TASK", "1"] as [string, string], ...extraEnv]
        .map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`)
        .join(" ");
      const id = addTerminal(
        dir,
        `${envPrefix} ${start.command}`,
        `${runName} · ${cli.name}`,
        def.icon,
        false,
        extraEnv,
        fleet.route.profile === DEFAULT_PROFILE
          ? undefined
          : fleet.route.profile,
      );
      if (!id) {
        recordTaskEnd(durableRun.id, { status: "stopped" });
        return false;
      }
      patchTabRaw(id, {
        micro: { taskId: def.id, runId, attemptId },
      } as Partial<SubTab>);
      if (start.typePrompt)
        pendingTerminalPrompts.current.set(id, seed);
      return true;
    },
    [
      addTerminal,
      patchTabRaw,
      onNotice,
      project.id,
      project.name,
      project.components,
      getInstalledForLaunch,
      gateManagedLaunch,
      updateMicroRuns,
      switchTo,
    ],
  );

  /** The PR inbox's context actions, each mapped to the micro-task it names. */
  const startPrQuickTask = useCallback(
    (action: PrQuickAction, repo: string, pr: ipc.PrInfo) => {
      const task = {
        review: prReviewTask,
        address: addressPrCommentsTask,
        "fix-ci": fixCiTask,
        "resolve-conflicts": resolveConflictsTask,
      }[action];
      void startMicroTask(task, { repo, pr }, "");
    },
    [startMicroTask],
  );

  /** Ask a question and put an agent on it.
   *
   *  The entry is created *before* the agent starts, not after it reports, for
   *  two reasons: the session has to be told which entry it is bound to (that
   *  binding is the harness), and a run that dies halfway still leaves the
   *  question and whatever it managed to record, which is the whole complaint
   *  this module answers. */
  /** Park what the user typed, with whatever was on screen and whatever they
   *  pasted. The third verb in ⌘K, and the only one that starts nothing.
   *
   *  Page context is captured as text only — no screenshot. The pixel capture
   *  is a native call that is macOS-only (issue #211) and costs a frame, and a
   *  picture of whatever page happened to be open is usually noise weeks later;
   *  the text half (active tab, caret, selection, terminal tail) is free and is
   *  the part that still means something when you come back. */
  const saveNote = useCallback(
    async (text: string, attachments: string[] = []) => {
      const body = text.trim();
      if (!body && attachments.length === 0) return;
      const dir = componentsRef.current[0]?.path;
      const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const termText =
        active?.type === "terminal"
          ? (termHandles.current.get(active.id)?.captureText(2000) ?? undefined)
          : undefined;
      try {
        const context = dir
          ? await capturePageContext({ activeTab: active, dir, termText, rect: null })
          : "";
        const note = await createNote({
          projectId: project.id,
          projectName: project.name,
          roots,
          // An image with nothing typed is still a thought worth keeping; it
          // just has to name itself something.
          title: body || "Pasted image",
          context,
          origin: "spot",
          cwd: roots[0],
        });
        // Copied one at a time and failures reported per image: a note that
        // saved but lost its screenshot should say so, not look like a success.
        let lost = 0;
        for (const path of attachments) {
          await ipc
            .notesAttachFile({ projectId: project.id, id: note.id, path, kind: "image" })
            .catch(() => {
              lost += 1;
            });
        }
        await refreshNotes(project.id);
        onNotice(
          lost > 0
            ? `Saved “${note.title}” — but ${lost} image${lost === 1 ? "" : "s"} could not be attached.`
            : `Saved “${note.title}” to the scratchpad.`,
          lost > 0 ? "error" : "success",
        );
      } catch (err) {
        onNotice(String(err), "error");
      }
    },
    [project.id, project.name, roots, onNotice],
  );

  /** Hand a note to an agent. Moves it to `doing` only when the launch
   *  actually happened and only when the store would accept the move — a note
   *  in the archive stays where it is rather than being quietly resurrected by
   *  a button press. */
  const workOnNote = useCallback(
    async (note: ipc.NoteDetail, userQuery = "", agentId?: string) => {
      const dir = await ipc
        .notesDir(project.id, note.id)
        .catch(() => note.dir);
      const ok = await startMicroTask(
        noteTask,
        {
          dir: roots[0] ?? "",
          projectId: project.id,
          noteId: note.id,
          title: note.title,
          brief: noteContext(note, dir),
        },
        userQuery,
        agentId,
      );
      if (ok && (NEXT_NOTE_STATUSES[note.status] ?? []).includes("doing")) {
        await setNoteStatus(
          project.id,
          note.id,
          "doing",
          "Canopy",
          "handed to an agent",
        ).catch(() => {});
      }
    },
    [project.id, roots, startMicroTask],
  );

  const startResearch = useCallback(
    async (question: string, userQuery = "", ticket?: ipc.ResearchTicketLink) => {
      const q = question.trim();
      if (!q) return;
      // The title is the question, shortened — an entry is cited by number
      // anyway, and asking the user to name it before it exists is a form to
      // fill in before any work has happened.
      const title = q.length > 80 ? `${q.slice(0, 77).trimEnd()}…` : q;
      try {
        const entry = await researchStart({
          projectId: project.id,
          projectName: project.name,
          roots,
          title,
          question: q,
          cwd: roots[0],
        });
        // Link before opening the tab, so the entry carries the ticket it
        // came from the first time anyone looks at it.
        if (ticket)
          await researchLinkEntry({ projectId: project.id, id: entry.id, ticket });
        const entryDir = await ipc.researchDir(project.id, entry.id);
        const ok = await startMicroTask(
          researchTask,
          {
            dir: roots[0] ?? "",
            entryId: entry.id,
            entryDir,
            title: entry.title,
            question: q,
            // What the question is being asked *about*. Without it the agent
            // has a working directory and no idea what project it is in, and
            // answers a product question as general software design.
            projectName: project.name,
            components: componentsRef.current.map((c) => ({
              label: c.label,
              path: c.path,
            })),
          },
          userQuery,
        );
        // The agent never started, so nothing will ever move this entry off
        // "researching". Say so on the entry rather than leaving a row that
        // looks live forever.
        if (!ok) {
          await researchSetStatus(project.id, entry.id, "blocked", "Canopy",
            "the agent never started");
        }
        openResearch(entry.id, entry.title);
      } catch (err) {
        onNotice(`Couldn't start research: ${String(err)}`, "error");
      }
    },
    [project.id, project.name, roots, startMicroTask, openResearch, onNotice],
  );

  /** Forward a ticket to research instead of to an implementer: the same
   *  startResearch path — harness, stage rail, blocked-on-failure — with the
   *  question composed from the ticket and the entry linked back to it.
   *  Nothing is written to the tracker; Canopy stays a reader of it. */
  const researchTicket = useCallback(
    async (ticket: ipc.TicketInfo) => {
      await startResearch(ticketResearchQuestion(ticket), "", {
        id: ticket.id,
        title: ticket.title,
        url: ticket.url,
      });
    },
    [startResearch],
  );

  /** Put an agent back on an entry that already exists.
   *
   *  Deliberately the same entry rather than a new one: the point of continuing
   *  is to go further on this question, and a second entry would split the
   *  answer across two rows that each look complete. The run is bound to it the
   *  same way a first run is, so the harness, the stage rail and the settling
   *  on job_done all apply unchanged — and the steer the user typed rides in as
   *  the run's user context, which is where every other task puts it. */
  const continueResearch = useCallback(
    async (entry: ipc.ResearchDetail, steer: string) => {
      try {
        const entryDir = await ipc.researchDir(project.id, entry.id);
        // Back to researching, so the rail and the polling wake up — and so a
        // finished entry does not sit at "researched" while an agent works.
        if (entry.status !== "researching")
          await researchSetStatus(project.id, entry.id, "researching", "you",
            steer ? `continued — ${steer}` : "continued");
        await startMicroTask(
          researchTask,
          {
            dir: roots[0] ?? "",
            entryId: entry.id,
            entryDir,
            title: entry.title,
            question: entry.question || entry.title,
            projectName: project.name,
            components: componentsRef.current.map((c) => ({
              label: c.label,
              path: c.path,
            })),
          },
          // What is already recorded is in the entry, which the brief tells it
          // to read — so this carries only what is new: where to go next.
          [
            `This continues research ${entry.id}, which already has findings —`,
            `read it with canopy_research get before adding anything, and build on`,
            `it rather than starting over.`,
            steer,
          ]
            .filter(Boolean)
            .join(" "),
        );
      } catch (err) {
        onNotice(`Couldn't continue research: ${String(err)}`, "error");
      }
    },
    [project.id, project.name, roots, startMicroTask, onNotice],
  );

  /** Hand a finished finding to an agent that will build it, on a branch of its
   *  own. Flips the entry to `implementing` — the PR the agent links is what
   *  later carries it the rest of the way. */
  const implementResearch = useCallback(
    async (entry: ipc.ResearchDetail, userQuery = "", agentId?: string) => {
      const repo = roots[0];
      if (!repo) return;
      const branch = `research/${entry.id}`;
      try {
        const ok = await startMicroTask(
          implementResearchTask,
          {
            dir: repo,
            repo,
            branch,
            entryId: entry.id,
            title: entry.title,
            brief: implementContext(entry),
          },
          userQuery,
          agentId,
        );
        if (!ok) return;
        await researchSetStatus(project.id, entry.id, "implementing", "you");
        await researchLinkEntry({ projectId: project.id, id: entry.id, branch });
      } catch (err) {
        onNotice(`Couldn't start implementation: ${String(err)}`, "error");
      }
    },
    [roots, startMicroTask, project.id, onNotice],
  );

  const raiseResearchPr = useCallback(
    async (entry: ipc.ResearchDetail) => {
      const repo = roots[0];
      if (!repo) return;
      try {
        const ok = await startMicroTask(
          raisePrTask,
          { repo, research: { entryId: entry.id, title: entry.title } },
          "",
        );
        if (!ok) return;
        await researchSetStatus(
          project.id,
          entry.id,
          "implementing",
          "you",
          "raising a pull request for the recorded local implementation",
        );
      } catch (err) {
        onNotice(`Couldn't raise pull request: ${String(err)}`, "error");
      }
    },
    [roots, startMicroTask, project.id, onNotice],
  );

  /** Run a brief that was composed on the spot (a diff surface's "ask about
   *  this" box, the Tasks panel's one-off composer) as a one-shot task — same
   *  lifecycle as a saved one, no entry in the registry. The context builder
   *  already folded the user's words in, so nothing more is passed. A label is
   *  only given where the surface has a better one than the brief's own head. */
  const runAdhocTask = useCallback(
    (brief: string, dir: string, label?: string) => {
      void startMicroTask(adhocTaskDef(brief, label), { dir }, "");
    },
    [startMicroTask],
  );

  /** Ticket work is a Task by default: prepare the same durable worktree a
   *  normal agent would receive, then let the one-shot lifecycle run there.
   *  The worktree is deliberately retained because the task reports back
   *  without committing or opening a PR. */
  const startTicketTask = useCallback(
    async (ticket: ipc.TicketInfo, requestedRepo?: string) => {
      const repo = requestedRepo || await ticketRepo();
      if (!repo) {
        onNotice("No git repository in this project.");
        return;
      }
      try {
        const worktrees = await ipc
          .gitWorktrees(repo)
          .catch(() => [] as ipc.WorktreeInfo[]);
        const existing = ticketWorktree(ticket, worktrees);
        let dir = existing?.path;
        if (!dir) {
          const branch = ticketBranch(ticket);
          const branches = await ipc
            .gitBranches(repo)
            .catch(() => [] as ipc.BranchInfo[]);
          const result = await switchTo(
            repo,
            {
              kind: "workspace",
              branch,
              create: !branches.some((item) => item.name === branch),
            },
            { because: `the ticket ${ticket.id}` },
          );
          if (result.kind !== "settled") return;
          dir = result.path;
        }
        setTicketWorktrees(await ipc.gitWorktrees(repo).catch(() => worktrees));
        const brief =
          `${ticketContext(ticket)} Implement it end-to-end and verify the changes. ` +
          `Leave the completed work in this worktree; do not commit or open a pull request ` +
          `unless the ticket explicitly asks for it.`;
        await startMicroTask(
          adhocTaskDef(brief, ticketTaskLabel(ticket)),
          { dir },
          "",
        );
      } catch (err) {
        onNotice(`Couldn't start task: ${String(err)}`, "error");
      }
    },
    [onNotice, startMicroTask, switchTo, ticketRepo],
  );

  /** Carry a finished task's conversation on as an ordinary agent session.
   *
   *  The whole design of a micro-task is that it ends: the tab closes, the
   *  session is forgotten, and the run becomes a row with a summary under it.
   *  That is right until the moment you read the summary and want to say "good
   *  — now do the other half", which today means starting a fresh agent and
   *  re-explaining everything the last one already worked out.
   *
   *  This is the door out of the one-shot. The agent's own transcript survives
   *  the teardown (session_forget only drops Canopy's digest), so resuming by
   *  the recorded session id reopens the conversation with every file it read
   *  and every conclusion it reached still in context — as a normal terminal,
   *  restorable and persistent, not a task. It ends where the task ended, which
   *  is the point: the next thing the user types is the next turn. */
  const continueTaskSession = useCallback(
    (run: TaskRun) => {
      if (!run.sessionId) {
        onNotice("This run never reported a session, so there is nothing to reopen.");
        return;
      }
      if (run.ephemeralCwd) {
        // Honest rather than hopeful: `--resume` is looked up inside the CLI's
        // config dir, keyed by the directory the conversation ran in, so a
        // throwaway worktree that has since been removed takes the only way
        // back with it. Better said here than as a CLI error in a new tab.
        onNotice(
          "This task ran in a temporary worktree that has been removed, so its conversation can't be reopened.",
        );
        return;
      }
      const cmd = restoreCommand(run.agent, run.sessionId);
      if (!cmd) {
        onNotice(`${run.agent} can't reopen a past conversation.`);
        return;
      }
      // Same guard as restoring any other session: command + cwd names this
      // exact conversation, so a second click focuses it instead of running a
      // second copy of the same agent against the same transcript.
      const open = tabsRef.current.find(
        (t): t is TermSubTab =>
          t.type === "terminal" && t.command === cmd && t.cwd === run.cwd,
      );
      if (open) {
        setActiveTabId(open.id);
        return;
      }
      const id = addTerminal(
        run.cwd,
        cmd,
        runTitle(run),
        AGENT_CLIS.find((c) => c.id === run.agent)?.icon,
      );
      if (id) onNotice(`Picked “${runTitle(run)}” back up where it left off.`);
    },
    [addTerminal, onNotice],
  );

  /** Micro-tasks waiting to be torn down: job_done was acknowledged, and we hold
   *  off killing the PTY until the agent's turn actually ends (its Stop hook)
   *  so the tool result and last words land — with a timer as backstop for a
   *  broken hook. Keyed by pty id; sid is captured at job_done time because the
   *  event stream goes quiet once the PTY dies. `tabId` is set only for a task
   *  that ran in a tab; a detached one has nothing to close. */
  const microFinish = useRef(
    new Map<
      number,
      { tabId?: string; sid?: string; since: number; timer: number }
    >(),
  );

  /** The transcript of a detached run, read off the PTY's own scrollback and
   *  replayed through a terminal parser — the equivalent of what closeTab
   *  captures from a tab's xterm buffer, and the last chance to take it: the
   *  session is gone the moment the PTY is killed. */
  const captureDetachedOutput = useCallback(
    async (ptyId: number, runId?: string) => {
      if (!runId) return;
      try {
        const raw = await ipc.ptyOutput(ptyId, 64 * 1024);
        const text = raw ? await renderPtyText(raw) : "";
        if (text) updateTaskRun(runId, { output: text });
      } catch {
        // A missing transcript is a smaller loss than a task that never settles.
      }
    },
    [],
  );

  const reapMicroTask = useCallback(
    (ptyId: number) => {
      const entry = microFinish.current.get(ptyId);
      if (!entry) return;
      microFinish.current.delete(ptyId);
      window.clearTimeout(entry.timer);
      const sid = entry.sid ?? liveSessionByPtyRef.current.get(ptyId);
      const detached = findRun(microRunsRef.current, ptyId);
      const kill = () =>
        // Grace-kill (SIGTERM + 2.5s) lets claude flush its transcript and run
        // its last hooks; pty:exit then auto-closes a tab like any spent
        // terminal, and settles a detached run's row.
        void ipc.ptyKill(ptyId).finally(() => {
          // The SessionEnd hook rewrites the digest as the CLI dies — forget
          // after that final write, or the delete would race it and the session
          // would resurface in restorables.
          if (sid)
            setTimeout(() => void ipc.sessionForget(sid).catch(() => {}), 500);
        });
      if (detached) {
        // Capture first, kill second: the scrollback dies with the session.
        void captureDetachedOutput(ptyId, detached.runId).finally(kill);
        updateMicroRuns((runs) => withoutRun(runs, ptyId));
        // A terminal the user opened onto this run has nothing left to show.
        if (detached.viewTabId) {
          const viewTabId = detached.viewTabId;
          setTimeout(() => closeTabRef.current(viewTabId), 4000);
        }
        return;
      }
      kill();
      // The promise is that the terminal closes itself, so don't leave that to
      // pty:exit alone: a CLI that wedges on its way out never reaches EOF, and
      // the finished task would sit there for good. A clean exit closes the tab
      // long before this fires, and closing an already-closed tab is a no-op.
      if (entry.tabId) {
        const tabId = entry.tabId;
        setTimeout(() => closeTabRef.current(tabId), 4000);
      }
    },
    [captureDetachedOutput, updateMicroRuns],
  );

  /** Begin the ending: wait out the turn, then reap. Idempotent per pty, so a
   *  task that reports twice still tears down once. */
  const finishMicroTask = useCallback(
    (ptyId: number, tabId?: string) => {
      if (microFinish.current.has(ptyId)) return;
      const timer = window.setTimeout(() => reapMicroTask(ptyId), 10_000);
      microFinish.current.set(ptyId, {
        tabId,
        sid: liveSessionByPtyRef.current.get(ptyId),
        since: Date.now(),
        timer,
      });
    },
    [reapMicroTask],
  );

  /** Ordinary sessions that asked to close themselves (canopy_close_session),
   *  keyed by pty. Same wait-for-Stop discipline as a micro-task's ending, for
   *  the same reason: the tool result and the agent's last words have to land
   *  before the terminal goes. What happens at the end differs, though — this
   *  is a session the user started, so it is *closed*, not reaped: the tab's
   *  unmount kills the PTY and the session stays in restorables. Unlike an
   *  explicit tab-close gesture, the agent asking to close itself is not a
   *  reason to suppress recovery. */
  const selfClose = useRef(
    new Map<number, { tabId: string; since: number; timer: number }>(),
  );

  const runSelfClose = useCallback(
    (ptyId: number) => {
      const entry = selfClose.current.get(ptyId);
      if (!entry) return;
      selfClose.current.delete(ptyId);
      window.clearTimeout(entry.timer);
      // Kill before closing rather than leaving it to the unmount: a tab that
      // only *attaches* to its pty (one spawned from the phone) detaches on
      // close and would leave the agent running — which is not what it asked
      // for. A grace kill either way, so the CLI still flushes the transcript
      // that keeps the session restorable.
      void ipc.ptyKill(ptyId).catch(() => {});
      // The tab is gone from under the user without them touching anything —
      // say who did it, since the only other record is scrollback that closing
      // takes with it.
      onNotice("The agent closed its own session, as you asked.");
      closeTabRef.current(entry.tabId);
    },
    [onNotice],
  );

  /** Begin a self-close: wait out the turn, then close the tab. Idempotent per
   *  pty, so an agent that calls the tool twice still closes one tab. */
  const beginSelfClose = useCallback(
    (ptyId: number, tabId: string) => {
      if (selfClose.current.has(ptyId)) return;
      const timer = window.setTimeout(() => runSelfClose(ptyId), 10_000);
      selfClose.current.set(ptyId, { tabId, since: Date.now(), timer });
    },
    [runSelfClose],
  );

  /** Call a detached run off: settle its history entry the way closing its tab
   *  would have, keep what it printed, then kill the PTY. */
  const stopMicroRun = useCallback(
    (ptyId: number) => {
      const run = findRun(microRunsRef.current, ptyId);
      if (!run) return;
      updateMicroRuns((runs) => withoutRun(runs, ptyId));
      const sid = liveSessionByPtyRef.current.get(ptyId);
      // Called off by the user: the entry is not researched, it is stuck, and
      // saying so is more use than leaving it looking live forever.
      if (run.researchId)
        void researchSettleIfRunning(
          project.id,
          run.researchId,
          "blocked",
          "the run was stopped before it finished",
        );
      void captureDetachedOutput(ptyId, run.runId).finally(() => {
        if (run.runId) endAbandonedRun(run.runId);
        void ipc.ptyKill(ptyId).finally(() => {
          if (sid)
            setTimeout(() => void ipc.sessionForget(sid).catch(() => {}), 500);
        });
      });
    },
    [captureDetachedOutput, updateMicroRuns],
  );
  stopMicroRunRef.current = stopMicroRun;

  // Closing the project (or quitting to it) takes its detached tasks with it.
  // Their PTYs belong to no tab, so nothing else would ever kill them, and an
  // agent still working for a project that is gone has nobody left to report to.
  useEffect(
    () => () => {
      for (const r of [...microRunsRef.current])
        stopMicroRunRef.current(r.ptyId);
    },
    [],
  );

  /** Look at a detached run: a terminal attached to its PTY, which streams the
   *  scrollback first, so opening it mid-run shows everything up to now. The
   *  viewer is a window onto the run, not the run itself — closing it detaches
   *  and the agent keeps going. */
  const showMicroRun = useCallback(
    (ptyId: number) => {
      const run = findRun(microRunsRef.current, ptyId);
      if (!run) return;
      const id = attachTerminal(
        ptyId,
        run.cwd,
        `${run.label} · task`,
        run.icon ?? "⚡",
      );
      updateMicroRuns((runs) => patchRun(runs, ptyId, { viewTabId: id }));
    },
    [attachTerminal, updateMicroRuns],
  );

  // A detached run whose agent quit on its own — it crashed, or the CLI exited
  // without ever calling job_done. Nothing is left to report, so settle the
  // history entry rather than leaving a row that will never finish. A no-op for
  // a run that already ended (a reap kills the pty, which lands here too).
  useEffect(() => {
    let un: (() => void) | undefined;
    void ipc
      .onPtyExit(({ id }) => {
        const run = findRun(microRunsRef.current, id);
        if (!run) return;
        updateMicroRuns((runs) => withoutRun(runs, id));
        if (run.runId) endAbandonedRun(run.runId);
        // The process died without reporting. job_done never arrived, so
        // nothing else is going to move this entry — and an entry that says
        // "researching" for a run that is not running is the failure the
        // status column exists to prevent. Re-entering a state is a no-op, so
        // a run that did finish and report loses nothing here.
        if (run.researchId)
          void researchSettleIfRunning(
            project.id,
            run.researchId,
            "blocked",
            "the run ended without reporting",
          );
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [updateMicroRuns]);

  // The wait-for-Stop half of the micro-task close: once the turn that called
  // job_done ends, reap. `ts >= since` skips Stop events from earlier turns of
  // the same session (a blocked task the user replied to, then finished).
  useEffect(() => {
    if (microFinish.current.size === 0) return;
    for (const [ptyId, entry] of microFinish.current) {
      if (events.some((e) => e.ts >= entry.since && isStopFor(e, ptyId))) {
        reapMicroTask(ptyId);
      }
    }
  }, [events, reapMicroTask]);

  // The same wait, for a session that asked to close itself.
  useEffect(() => {
    if (selfClose.current.size === 0) return;
    for (const [ptyId, entry] of selfClose.current) {
      if (events.some((e) => e.ts >= entry.since && isStopFor(e, ptyId))) {
        runSelfClose(ptyId);
      }
    }
  }, [events, runSelfClose]);

  /** A relay review's diff isn't in any local checkout, so an agent can't
   *  `git diff` for it — write the patch into the project (an authorized
   *  workspace, so the write is in scope) and hand the agent that path. Returns
   *  the file path, or null if there's nowhere to write it. */
  const writeReviewPatch = useCallback(
    async (review: ReviewPayload): Promise<string | null> => {
      const dir = componentsRef.current[0]?.path;
      if (!dir) {
        onNotice("No project directory to stage the review in.");
        return null;
      }
      const safe = (review.branch || "review").replace(
        /[^A-Za-z0-9._-]+/g,
        "-",
      );
      const path = `${dir}/.canopy-review-${safe}.patch`;
      try {
        await ipc.fsWriteFile(path, review.patch);
        return path;
      } catch (err) {
        onNotice(`Couldn't stage the review diff: ${String(err)}`, "error");
        return null;
      }
    },
    [onNotice],
  );

  /** Re-run a run tab's command in place, reusing the tab (and its position in
   *  the rail) rather than spawning a new one. */
  const restartRun = useCallback((
    id: string,
    configured?: Pick<
      ServerEntry,
      "command" | "name" | "componentId" | "runCommandId"
    >,
  ) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab?.type !== "terminal") return;
    const component = tab.componentId
      ? componentsRef.current.find((item) => item.id === tab.componentId)
      : undefined;
    const command = tab.runCommandId
      ? component?.commands?.find((item) => item.id === tab.runCommandId)
      : undefined;
    const current =
      component && command
        ? {
            command: command.command,
            name: command.name || command.command,
            componentId: component.id,
            runCommandId: command.id,
          }
        : undefined;
    const nextConfigured = configured ?? current;
    if (tab.ptyId != null) void ipc.ptyKill(tab.ptyId);
    // Remount Term with a fresh key by clearing the pty and exit state; the
    // effect below respawns it.
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id
          ? ({
              ...t,
              ptyId: null,
              exited: false,
              exitCode: undefined,
              epoch: (t as TermSubTab).epoch ?? 0,
              ...(nextConfigured
                ? {
                    command: nextConfigured.command,
                    title: nextConfigured.name,
                    componentId: nextConfigured.componentId ?? undefined,
                    runCommandId: nextConfigured.runCommandId ?? undefined,
                  }
                : {}),
            } as SubTab)
          : t,
      ),
    );
    setTimeout(() => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id && t.type === "terminal"
            ? // Re-clear exit state here too: the old pty's kill can emit a
              // late pty:exit in the gap since t=0 that flips `exited` back on.
              {
                ...t,
                epoch: (t.epoch ?? 0) + 1,
                exited: false,
                exitCode: undefined,
              }
            : t,
        ),
      );
    }, 200);
  }, []);

  // Looking at a tab is what marks it read. As an effect rather than something
  // hung off the tab's onClick, so every route in — clicking, Ctrl+Tab cycling,
  // a jump from the agents panel, closing the tab in front of it — clears the
  // ring without each one having to remember to.
  useEffect(() => {
    if (!visible || !activeTabId) return;
    // Chat tabs keep their own unread flag — a message you have not read is not
    // an agent lifecycle, and nothing about it was ever wrong.
    setTabs((prev) =>
      prev.some((t) => t.id === activeTabId && t.type === "chat" && t.unread)
        ? prev.map((t) =>
            t.id === activeTabId ? ({ ...t, unread: false } as SubTab) : t,
          )
        : prev,
    );
    // A terminal's ring lives on the attention axis. Focus may clear `unseen`
    // and may never clear `blocked`: glancing at a tab does not answer the
    // question on it.
    const t = tabsRef.current.find(
      (x): x is TermSubTab => x.type === "terminal" && x.id === activeTabId,
    );
    if (t?.ptyId != null) {
      attentionRef.current(
        t.ptyId,
        { t: "focus", at: Date.now(), visible: true },
        agentIdForCommand(t.command) ?? null,
      );
    }
  }, [activeTabId, visible, tabs]);

  useEffect(() => {
    const tab = tabs.find(
      (t): t is TermSubTab => t.type === "terminal" && t.id === activeTabId,
    );
    if (!tab?.paneGroup) return;
    setTerminalGroups((prev) => {
      const group = prev[tab.paneGroup!];
      if (!group || group.activeTabId === tab.id) return prev;
      const next = {
        ...prev,
        [group.id]: { ...group, activeTabId: tab.id },
      };
      terminalGroupsRef.current = next;
      return next;
    });
  }, [activeTabId, tabs]);

  // Menu shortcuts — only the visible project reacts.
  // Keep the active tab in view when it changes (cycling, jumping, closing) —
  // a strip that scrolls but doesn't follow leaves you looking at the wrong
  // tabs. The following itself is revealActiveTab, further down: it needs the
  // strip and the pinned chip, which are measured there.
  const activeTabElRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!visible) return;
    const closeTabHandler = () => {
      if (activeTabIdRef.current)
        closeTabRef.current(activeTabIdRef.current, "user");
    };
    const newTerminalHandler = () => {
      const first = componentsRef.current[0];
      if (first) addTerminal(first.path);
    };
    const toggleSidebarHandler = () => {
      setPinned((v) => !v);
      setPeeking(false);
    };
    const quickOpen = () => setPalette("files");
    const findInFiles = () => setPalette("search");
    const spotSearch = () => setSpotOpen(true);
    // ⌘N: the ＋ menu without the mouse. Re-probe on open for the same reason
    // the ＋ menu does — a stale "install" hint sends you to an installer for a
    // CLI you already have.
    const newLauncher = () => {
      refreshInstalled();
      refreshUpdates();
      setLauncherOpen(true);
    };
    const activateVisualTab = (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      const group =
        tab?.type === "terminal" && tab.paneGroup
          ? terminalGroupsRef.current[tab.paneGroup]
          : undefined;
      setActiveTabId(group?.activeTabId ?? id);
    };
    const visualTabs = () => {
      const seen = new Set<string>();
      return tabsRef.current.filter((tab) => {
        if (tab.type !== "terminal" || !tab.paneGroup) return true;
        if (seen.has(tab.paneGroup)) return false;
        seen.add(tab.paneGroup);
        return true;
      });
    };
    const cycleTabs = (dir: 1 | -1) => {
      const list = visualTabs();
      if (list.length < 2) return;
      const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const activeGroup = active?.type === "terminal" ? active.paneGroup : undefined;
      const i = list.findIndex(
        (t) => t.id === activeTabIdRef.current || (activeGroup && t.type === "terminal" && t.paneGroup === activeGroup),
      );
      activateVisualTab(list[(i + dir + list.length) % list.length].id);
    };
    // Ctrl+Tab's half of that: move the switcher's selection rather than the
    // tab. The panel it opens is what makes the difference visible — you pick
    // the tab you can see, and the switch happens once, when Ctrl comes up.
    const stepSwitcher = (dir: 1 | -1) => {
      const list = visualTabs();
      if (list.length < 2) return;
      const openIds = list.map((t) => t.id);
      const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const currentVisualId =
        active?.type === "terminal" && active.paneGroup
          ? list.find(
              (t) => t.type === "terminal" && t.paneGroup === active.paneGroup,
            )?.id ?? activeTabIdRef.current
          : activeTabIdRef.current;
      const current = switcherRef.current;
      const mode = getSettings().tabSwitchMode;
      let ids: string[];
      let rows: TabSwitchRow[] | null;
      if (current) {
        ({ ids, rows } = current);
      } else if (mode === "items") {
        // One row per work item, labeled by the brain where it has spoken and
        // by the founding tab otherwise. Frozen here like every snapshot.
        const items = applyHints(
          clusterWorkItems(list, workItemJoins),
          brainHints(),
          (id) => hintMovable(list.find((t) => t.id === id)),
        );
        const labels = brainHints().labels;
        rows = workItemSnapshot(
          items,
          openIds,
          currentVisualId,
          recentTabsRef.current,
        ).map((item) => {
          const founder = list.find((t) => t.id === item.key);
          return {
            key: item.key,
            ids: item.ids,
            label: labels[item.key] ?? (founder ? tabDisplayLabel(founder) : item.key),
          };
        });
        ids = rows.flatMap((row) => row.ids);
      } else {
        ids = tabSwitchSnapshot(openIds, currentVisualId, recentTabsRef.current, mode);
        rows =
          mode === "recent"
            ? groupTabSwitch(ids, (id) => {
                const tab = tabsRef.current.find((t) => t.id === id);
                return tab ? switchRowKey(tab) : "files";
              })
            : null;
      }
      const selectedId =
        mode === "items" && rows
          ? stepWorkItem(rows, current?.selectedId ?? currentVisualId, openIds, dir)
          : stepTabSwitch(ids, current?.selectedId ?? currentVisualId, openIds, dir);
      if (!selectedId) return;
      const next = { ids, rows, selectedId };
      switcherRef.current = next;
      setSwitcher(next);
    };
    // Arrow keys are panel-internal, and only the grouped (recent-mode) panel
    // has the second axis; with the panel closed they belong to whatever has
    // focus.
    const stepSwitcherArrow = (e: KeyboardEvent): boolean => {
      const current = switcherRef.current;
      if (!current?.rows) return false;
      const horiz =
        e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      const vert = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!horiz && !vert) return false;
      e.preventDefault();
      e.stopPropagation();
      const openIds = visualTabs().map((t) => t.id);
      const selectedId = horiz
        ? stepTabSwitchInRow(current.rows, current.selectedId, openIds, horiz as 1 | -1)
        : stepTabSwitchAcrossRows(current.rows, current.selectedId, openIds, vert as 1 | -1);
      if (selectedId && selectedId !== current.selectedId) {
        const next = { ...current, selectedId };
        switcherRef.current = next;
        setSwitcher(next);
      }
      return true;
    };
    // The tab-cycle chord is a native menu accelerator, but when focus is in
    // the webview (Monaco/xterm) macOS never routes it to the menu — the
    // unhandled key just rings the system bell ("tuk"). Handle it here in
    // capture phase, preventDefault to silence the bell, and record the time so
    // the menu handler (if it also fires, in a native-focus context) doesn't
    // double-cycle. The keydown path always acts, so key-repeat is never
    // dropped — only a paired menu event is suppressed.
    const lastKeydownNav = { t: 0 };
    const recentKeydown = () => Date.now() - lastKeydownNav.t < 150;
    const onKeydown = (e: KeyboardEvent) => {
      if (!visibleRef.current) return;
      if (stepSwitcherArrow(e)) return;
      // ⌘1..9 (Ctrl off macOS) — the digits the tabs show while the modifier is
      // held. Handled here rather than as a menu accelerator: nine menu rows for
      // this would be absurd, and the key must land even when focus is inside
      // xterm or Monaco, which is what the capture-phase listener is for.
      const digit = digitFromCode(e.code);
      if (digit !== null && hintModifierOnly(e, "tabs")) {
        const tab = barTabsRef.current[digit - 1];
        // Only swallow the key when it goes somewhere. With fewer tabs than
        // that, ⌘7 is still the terminal's to handle.
        if (!tab) return;
        e.preventDefault();
        activateVisualTab(tab.id);
        return;
      }
      const paneDirection: PaneDirection | null = matches(e, "focus-pane-left")
        ? "left"
        : matches(e, "focus-pane-right")
          ? "right"
          : matches(e, "focus-pane-up")
            ? "up"
            : matches(e, "focus-pane-down")
              ? "down"
              : null;
      if (paneDirection) {
        e.preventDefault();
        focusPaneRef.current(paneDirection);
        return;
      }
      const moveDirection: PaneDirection | null = matches(e, "move-pane-left")
        ? "left"
        : matches(e, "move-pane-right")
          ? "right"
          : matches(e, "move-pane-up")
            ? "up"
            : matches(e, "move-pane-down")
              ? "down"
              : null;
      if (moveDirection) {
        e.preventDefault();
        movePaneRef.current(moveDirection);
        return;
      }
      if (matches(e, "split-pane-right")) {
        e.preventDefault();
        splitActiveRef.current("horizontal");
        return;
      }
      if (matches(e, "split-pane-down")) {
        e.preventDefault();
        splitActiveRef.current("vertical");
        return;
      }
      if (matches(e, "toggle-pane-zoom")) {
        e.preventDefault();
        togglePaneZoomRef.current();
        return;
      }
      if (matches(e, "equalize-panes")) {
        e.preventDefault();
        equalizePanesRef.current();
        return;
      }
      if (matches(e, "close-pane-group")) {
        e.preventDefault();
        closeActiveGroupRef.current();
        return;
      }
      // SpotSearch — the menu accelerator never fires while focus is in
      // xterm/Monaco (same macOS routing gap as the tab-cycle chord below), so
      // the palette must also open from here. Opening an open palette is a
      // no-op.
      if (matches(e, "spot-search")) {
        e.preventDefault();
        setSpotOpen(true);
        return;
      }
      // Both tab-cycle pairs, and both out of the registry — so this is by
      // construction the same key the "Next/Previous Tab" accelerators
      // advertise, on Windows and Linux too, where they are Ctrl+PageDown/PageUp
      // rather than the Mac's ⌃⌘→/←. The hand-written test accepted
      // Ctrl+Alt+Arrow off a Mac, answering a chord the menu never offered.
      //
      // Ctrl+Tab / Ctrl+Shift+Tab is the pair every IDE and browser trains, and
      // Help advertised it for releases with nothing answering it. It is an
      // "app" shortcut rather than a menu one on purpose: muda gives macOS the
      // glyph "⇥" as Tab's key equivalent rather than the character the key
      // produces, so such a menu item renders perfectly and never fires. Here
      // is where it has to work anyway.
      const dir =
        matches(e, "next-tab") || matches(e, "cycle-tab-next")
          ? 1
          : matches(e, "prev-tab") || matches(e, "cycle-tab-prev")
            ? -1
            : 0;
      if (dir === 0) return;
      e.preventDefault();
      // Tab is the one chord here that means something downstream — xterm
      // would send it to the shell as a completion request, and it is the
      // browser's own focus key — so it stops at the capture phase rather than
      // merely losing its default action.
      if (e.code === "Tab") {
        e.stopPropagation();
        lastKeydownNav.t = Date.now();
        // Only the held chord gets the switcher. ⌃⌘→ and Ctrl+PageDown are
        // aimed moves — you press one and you are there — and putting a panel
        // in front of them would be a modal answer to a direct question.
        stepSwitcher(dir);
        return;
      }
      lastKeydownNav.t = Date.now();
      cycleTabs(dir);
    };
    const next = () => {
      if (recentKeydown()) return;
      cycleTabs(1);
    };
    const prev = () => {
      if (recentKeydown()) return;
      cycleTabs(-1);
    };
    window.addEventListener("keydown", onKeydown, true);
    // Settings asks for interactive CLI flows (gh auth login/logout, brew
    // install) to run somewhere the user can actually answer prompts.
    const runCommand = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        command?: string;
        title?: string;
        // Signing a profile in is one of these flows, and its whole point is
        // the environment: the same `claude` has to start against the new
        // account's config dir, or the login lands on the default one.
        env?: [string, string][];
        profile?: string;
      };
      const first = componentsRef.current[0];
      if (d?.command && first)
        addTerminal(
          first.path,
          d.command,
          d.title ?? d.command,
          "⚙",
          false,
          d.env,
          d.profile,
        );
    };
    window.addEventListener("canopy:run-command", runCommand);
    window.addEventListener("menu:close-tab", closeTabHandler);
    window.addEventListener("menu:new-terminal", newTerminalHandler);
    window.addEventListener("menu:toggle-sidebar", toggleSidebarHandler);
    window.addEventListener("menu:next-tab", next);
    window.addEventListener("menu:prev-tab", prev);
    window.addEventListener("menu:quick-open", quickOpen);
    window.addEventListener("menu:find-in-files", findInFiles);
    window.addEventListener("menu:spot-search", spotSearch);
    window.addEventListener("menu:new-launcher", newLauncher);
    return () => {
      window.removeEventListener("canopy:run-command", runCommand);
      window.removeEventListener("menu:close-tab", closeTabHandler);
      window.removeEventListener("menu:new-terminal", newTerminalHandler);
      window.removeEventListener("menu:toggle-sidebar", toggleSidebarHandler);
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("menu:next-tab", next);
      window.removeEventListener("menu:prev-tab", prev);
      window.removeEventListener("menu:quick-open", quickOpen);
      window.removeEventListener("menu:find-in-files", findInFiles);
      window.removeEventListener("menu:spot-search", spotSearch);
      window.removeEventListener("menu:new-launcher", newLauncher);
    };
  }, [visible, project.components, addTerminal, refreshInstalled, refreshUpdates]);

  const switcherOpen = switcher !== null;
  const visualOpenTabs = useMemo(() => {
    const groups = new Set<string>();
    return visibleTabs.filter((tab) => {
      if (tab.type !== "terminal" || !tab.paneGroup) return true;
      if (groups.has(tab.paneGroup)) return false;
      groups.add(tab.paneGroup);
      return true;
    });
  }, [visibleTabs]);
  const switcherTabs = useMemo(
    () =>
      switcher?.ids
        .map((id) => visualOpenTabs.find((tab) => tab.id === id))
        .filter((tab): tab is SubTab => Boolean(tab)) ?? [],
    [switcher, visualOpenTabs],
  );
  /** Letting go is the choice. One tab change, however far you walked. */
  const commitSwitcher = useCallback(() => {
    const current = switcherRef.current;
    switcherRef.current = null;
    setSwitcher(null);
    if (!current) return;
    const id = resolveTabSwitch(
      current.ids,
      current.selectedId,
      visualOpenTabs.map((tab) => tab.id),
    );
    if (id) {
      const tab = tabsRef.current.find((item) => item.id === id);
      const group =
        tab?.type === "terminal" && tab.paneGroup
          ? terminalGroupsRef.current[tab.paneGroup]
          : undefined;
      setActiveTabId(group?.activeTabId ?? id);
    }
  }, [visualOpenTabs]);
  const cancelSwitcher = useCallback(() => {
    switcherRef.current = null;
    setSwitcher(null);
  }, []);
  // Keep the preview and eventual commit honest if the selected tab closes
  // while Control is still down. The frozen traversal order itself does not
  // change; only the missing selection advances to its next surviving entry.
  useEffect(() => {
    const openIds = visualOpenTabs.map((tab) => tab.id);
    setSwitcher((current) => {
      if (!current || openIds.includes(current.selectedId)) return current;
      if (openIds.length < 2) {
        switcherRef.current = null;
        return null;
      }
      const selectedId = resolveTabSwitch(
        current.ids,
        current.selectedId,
        openIds,
      );
      if (!selectedId) {
        switcherRef.current = null;
        return null;
      }
      const next = { ...current, selectedId };
      switcherRef.current = next;
      return next;
    });
  }, [visualOpenTabs]);
  // A held panel ends the way a held key ends. Escape takes it back — you are
  // where you were — and so does the window losing focus: ⌘-tabbing away leaves
  // the modifier's keyup on the other side of the switch, so blur is the only
  // signal left that the hold is over.
  useEffect(() => {
    if (!switcherOpen) return;
    if (!visible) {
      cancelSwitcher();
      return;
    }
    const onKeyUp = (e: KeyboardEvent) => {
      // Tab's own keyup arrives with Ctrl still down: that is the walk, not the
      // end of it.
      if (e.key === "Control" || !e.getModifierState("Control"))
        commitSwitcher();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelSwitcher();
    };
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancelSwitcher);
    return () => {
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancelSwitcher);
    };
  }, [switcherOpen, visible, commitSwitcher, cancelSwitcher]);

  // An agent asked the IDE to do something through the MCP bridge — start a
  // run command, or open a preview. App routed it here by matching the action's
  // path to this project; act on it with the same handlers the UI buttons use.
  useEffect(() => {
    const onAction = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        projectId: string | null;
        action: ipc.AgentAction;
      };
      const a = d.action;
      // restart is keyed by terminal, not project: only the ProjectView that
      // owns that pty acts, whatever project it belongs to.
      if (a.kind === "restart_server") {
        const tab = tabsRef.current.find(
          (t): t is TermSubTab => t.type === "terminal" && t.ptyId === a.ptyId,
        );
        if (tab) restartRun(tab.id);
        return;
      }
      // An agent closing its own session, because the user told it to. Keyed by
      // terminal like restart, and the id came from the caller's environment,
      // so the only tab this can ever reach is the one it is running in — the
      // ProjectView that doesn't own that pty finds nothing and does nothing.
      if (a.kind === "close_session") {
        // A detached task first, and by pty rather than by tab: a viewer the
        // user opened onto it is a window, not the session, and closing that
        // would leave the agent running. Its ending is the fuller one anyway —
        // history settled, session forgotten — so hand it to the same path
        // job_done uses.
        const detached = findRun(microRunsRef.current, a.ptyId);
        if (detached) {
          finishMicroTask(detached.ptyId);
          return;
        }
        const tab = tabsRef.current.find(
          (t): t is TermSubTab =>
            t.type === "terminal" && a.ptyId != null && t.ptyId === a.ptyId,
        );
        if (tab?.ptyId == null) return;
        // A micro-task in a tab of its own: same teardown as job_done "done".
        if (tab.micro) finishMicroTask(tab.ptyId, tab.id);
        else beginSelfClose(tab.ptyId, tab.id);
        return;
      }
      // A task naming itself, mid-run. The row it renames may be a detached
      // run's (the usual case) or a tab's, and either way the history entry
      // takes the same name — a run that is renamed while it works and reverts
      // to the launcher's label the moment it finishes would be worse than
      // never having been renamed.
      if (a.kind === "task_named") {
        const named = taskIdentity(a);
        const description = taskDescription(a.description);
        if (!hasIdentity(named) && !description) return;
        const tab = tabsRef.current.find(
          (t): t is TermSubTab =>
            t.type === "terminal" &&
            a.ptyId != null &&
            t.ptyId === a.ptyId,
        );
        const detached = findRun(microRunsRef.current, a.ptyId);
        const ptyId = tab?.ptyId ?? detached?.ptyId;
        if (ptyId == null) return;
        if (tab && description) patchTabRaw(tab.id, { description });

        // Ordinary agent sessions publish only the hover line. Task identity
        // belongs to micro-task history and must not rename a normal terminal.
        if (!tab?.micro && !detached) return;
        if (!hasIdentity(named)) return;
        const runId = tab?.micro?.runId ?? detached?.runId;
        if (runId) updateTaskRun(runId, identityPatch(a));
        if (detached)
          updateMicroRuns((runs) =>
            patchRun(runs, ptyId, {
              label: named.title ?? detached.label,
              icon: named.icon ?? detached.icon,
            }),
          );
        else if (tab)
          patchTabRaw(tab.id, {
            customTitle: named.title
              ? `${named.title} · task`
              : tab.customTitle,
            icon: named.icon ?? tab.icon,
          } as Partial<SubTab>);
        return;
      }
      // A micro-task reported in (App already surfaced the notice). Done →
      // wait out the turn, then kill + forget, closing the tab if it had one.
      // Blocked → the agent wants the user: bring its tab forward, or mark the
      // Tasks row for a detached run, which is where the user goes to answer.
      // Only ever acts on a run Canopy started: a normal session that somehow
      // calls the tool gets the notice and nothing else.
      if (a.kind === "job_done") {
        const tab = tabsRef.current.find(
          (t): t is TermSubTab =>
            t.type === "terminal" &&
            a.ptyId != null &&
            t.ptyId === a.ptyId &&
            Boolean(t.micro),
        );
        const detached = findRun(microRunsRef.current, a.ptyId);
        const ptyId = tab?.ptyId ?? detached?.ptyId;
        if (ptyId == null) return;
        const runId = tab?.micro?.runId ?? detached?.runId;
        const attemptId = tab?.micro?.attemptId ?? detached?.attemptId;
        // A run that never called canopy_name_task can still name itself here,
        // and one that did may have learnt something since.
        const named = taskIdentity(a);
        const asked = askedLine(a.asked);
        const identity = {
          ...identityPatch(a),
          ...(asked ? { asked } : {}),
        };
        // The conversation behind the run, while there is still a live binding
        // to read it from: the session is forgotten seconds from now and the
        // pty→session map dies with the PTY.
        const sessionId = liveSessionByPtyRef.current.get(ptyId);
        // A run bound to a research entry has to move it. Nothing else will:
        // the agent may have finished without calling `status`, or — as
        // happened with a sidecar older than the research module — may never
        // have had the tool at all, and an entry that still says "researching"
        // an hour after its run ended is the exact failure the status column
        // exists to prevent. Re-entering a state is a no-op in the store, so
        // an agent that did set it loses nothing here.
        const bound = detached?.researchId;
        if (bound) {
          void researchSetStatus(
            project.id,
            bound,
            a.status === "blocked" ? "blocked" : "researched",
            "Canopy",
            a.summary || "the run reported it was finished",
          ).catch(() => {});
        }
        // Files the session touched, when a hook wrote a digest for it — the
        // same pty→digest binding the Agents panel uses.
        const digest = digestBySurface(
          wsDigestsRef.current,
          thisInstanceRef.current,
        ).get(String(ptyId));
        const files = digest?.files;
        // If it opened a PR, write down that this session did. Now, not later:
        // a micro-task is forgotten seconds from here (finishMicroTask →
        // sessionForget) and its worktree is deleted by its own last
        // instruction, so this is the last moment anything can join the two.
        // Blocked runs record too — a run that pushed a PR and then stopped to
        // ask something still produced the PR.
        const ranIn = digest?.cwd ?? a.cwd;
        void recordProvenance({
          // The directory it ran in, not a project component: Rust resolves any
          // directory of a repo to its main checkout, and a task's worktree is
          // the one thing we always know.
          repo: ranIn,
          url: a.url,
          branch: digest?.branch,
          sessionId,
          agent: digest?.agent,
          profile: digest?.profile,
          cwd: ranIn,
          via: "job_done",
        });
        if (a.status === "blocked") {
          if (attemptId) {
            void ipc
              .taskAttemptWait(attemptId)
              .then(() => {
                if (detached)
                  updateMicroRuns((runs) =>
                    patchRun(runs, ptyId, { attemptState: "waiting" }),
                  );
              })
              .catch(() => {});
          }
          // Blocked is not an ending — the agent is waiting on the user and the
          // run continues. Keep what it said and mark that it asked, so that if
          // the user walks away instead of answering, the run settles as
          // "blocked" rather than the flatter "stopped".
          if (runId)
            updateTaskRun(runId, {
              summary: a.summary,
              url: a.url,
              files,
              sessionId,
              askedForUser: true,
              ...identity,
            });
          // A detached run does not steal the window — the toast App raised
          // said what happened, and the Tasks row now says "Needs you" with the
          // terminal one click away.
          if (tab) {
            if (getSettings().agentAskForAttention) setActiveTabId(tab.id);
          } else {
            updateMicroRuns((runs) =>
              patchRun(runs, ptyId, {
                blocked: true,
                // A blocked run stays on screen, so a name it sent with the
                // block is worth taking; an absent one leaves what is there.
                ...(named.title ? { label: named.title } : {}),
                ...(named.icon ? { icon: named.icon } : {}),
              }),
            );
          }
        } else {
          if (runId)
            recordTaskEnd(runId, {
              status: "done",
              summary: a.summary,
              url: a.url,
              files,
              sessionId,
              ...identity,
            });
          finishMicroTask(ptyId, tab?.id);
        }
        return;
      }
      if (d?.projectId !== project.id) return;
      // The companion asking to reach whoever raised a PR, without knowing who
      // that was. Rust hands it over here because only this side holds the
      // pty→session binding and can reopen an ended conversation or open a tab
      // for a fresh one. Same route as the PR tab's "Send a change".
      if (a.kind === "message_agent" && a.pr && a.text) {
        const opId = a.opId;
        void routeToRaiser(a.pr, a.text).then(
          ({ delivered, note }) => {
            if (opId != null) void ipc.browserResult(opId, delivered, note);
          },
          (err) => {
            if (opId != null) void ipc.browserResult(opId, false, String(err));
          },
        );
        return;
      }
      if (a.kind === "open_preview" && a.url) {
        // Agent-owned browser activity is watched in the PiP, not by replacing
        // the tab the user is working in. A non-agent caller retains the normal
        // attention preference because there is no session to attach a PiP to.
        const id = openPreview(
          a.url,
          a.ptyId,
          a.ptyId == null && getSettings().agentAskForAttention,
        );
        if (a.ptyId != null) showBrowserPip(id, a.ptyId);
      } else if (a.kind === "start_server" && a.dir && a.command) {
        // `command` is the resolved command line, `name` its label — the same
        // pair the component-commands ▶ uses. Reuse a tab already on it.
        const existing = tabsRef.current.find(
          (t): t is TermSubTab =>
            t.type === "terminal" &&
            Boolean(t.run) &&
            t.cwd === a.dir &&
            (a.componentId &&
              a.runCommandId &&
              t.componentId &&
              t.runCommandId
              ? t.componentId === a.componentId && t.runCommandId === a.runCommandId
              : t.command === a.command),
        );
        const configured =
          a.componentId && a.runCommandId
            ? {
                command: a.command,
                name: a.name || a.command,
                componentId: a.componentId,
                runCommandId: a.runCommandId,
              }
            : undefined;
        if (existing && !existing.exited) {
          if (getSettings().agentAskForAttention) setActiveTabId(existing.id);
        }
        else if (existing) restartRun(existing.id, configured);
        else
          addTerminal(
            a.dir,
            a.command,
            a.name || a.command,
            "▶",
            true,
            undefined,
            undefined,
            getSettings().agentAskForAttention,
            undefined,
            configured,
          );
      } else if ((a.kind === "open_file" || a.kind === "show_diff") && a.path) {
        // "Look at line 340" — put the file in front of the user and land on
        // the line. The reveal is an event because the tab may already be open,
        // and because opening is async either way.
        const path = a.path;
        const line = a.line;
        void openFileRef
          .current(path, {
            diff: a.kind === "show_diff",
            activate: getSettings().agentAskForAttention,
          })
          .then(() => {
            if (line)
              requestAnimationFrame(() =>
                window.dispatchEvent(
                  new CustomEvent("canopy:reveal-line", {
                    detail: { path, line },
                  }),
                ),
              );
          });
      }
    };
    window.addEventListener("canopy:agent-action", onAction);
    return () => window.removeEventListener("canopy:agent-action", onAction);
  }, [
    project.id,
    openPreview,
    addTerminal,
    restartRun,
    finishMicroTask,
    beginSelfClose,
    updateMicroRuns,
    patchTabRaw,
    showBrowserPip,
  ]);

  // The companion asking for a coding session on a brief (canopy_start_session).
  // App resolved and opened the project; this is the only layer that can
  // actually start one, because the run needs tabs, a worktree and a place in
  // the task history. The answer goes back on the ticket it came with — the
  // caller is holding its tool call open for it, so a launch that silently did
  // or did not happen is the one outcome this must never produce.
  useEffect(() => {
    // The request is re-announced until it is answered, because a project that
    // was closed when it was made had nothing mounted to hear it. One run per
    // ticket, however many times it arrives.
    const seen = new Set<number>();
    const onStart = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        projectId: string;
        ticket: number;
        dir: string;
        prompt: string;
        label?: string;
        agent?: string;
      };
      if (d?.projectId !== project.id || seen.has(d.ticket)) return;
      seen.add(d.ticket);
      const answer = (started: boolean, note: string) =>
        window.dispatchEvent(
          new CustomEvent("canopy:start-session-result", {
            detail: { ticket: d.ticket, started, note },
          }),
        );
      void startMicroTask(
        adhocTaskDef(d.prompt, d.label),
        { dir: d.dir },
        "",
        d.agent,
      ).then(
        (ok) =>
          answer(
            ok,
            ok
              ? `Started an agent in ${d.dir}.`
              : // startMicroTask has already told the user why on screen; the
                // caller gets the fact, which is what it can act on.
                `Couldn't start an agent in ${d.dir} — Canopy refused the launch (no agent CLI installed, or the workspace it needed could not be prepared).`,
          ),
        (err) => answer(false, `Couldn't start an agent in ${d.dir}: ${String(err)}`),
      );
    };
    window.addEventListener("canopy:start-session", onStart);
    return () => window.removeEventListener("canopy:start-session", onStart);
  }, [project.id, startMicroTask]);

  // The tail of a deep link (deepLinks.ts): App resolved the project and
  // opened it, and this lands on the actual thing — the terminal an agent was
  // running in, the panel that holds the answer, the conversation, the file.
  //
  // Every step degrades on purpose, because a target is a description of the
  // world as it was when a notification went out. A terminal that has since
  // exited falls back to the panel that still knows about the run; a peer who
  // has left falls back to the Team panel. The user is already in the right
  // project by the time this runs, so the worst case is a short walk rather
  // than a dead end — but it says which fallback it took, so a click that
  // didn't do what the banner promised never looks like the app ignoring it.
  useEffect(() => {
    const onLink = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        projectId: string;
        link: DeepLink;
      };
      if (d?.projectId !== project.id) return;
      const act = followLink(d.link, {
        terminals: tabsRef.current
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((t) => ({ id: t.id, ptyId: t.ptyId, attachId: t.attachId })),
        detachedPtys: microRunsRef.current.map((r) => r.ptyId),
        members: relay.status.members.map((m) => ({
          key: m.key,
          name: m.name,
        })),
      });
      if (act.do === "tab") {
        setActiveTabId(act.tabId);
      } else if (act.do === "panel") {
        setSideTab(act.panel);
        setPinned(true);
        // Keyed on the fallback, not the click: re-clicking the same stale
        // notification refreshes one explanation instead of stacking a new
        // "that terminal has closed" row per click.
        if (act.note)
          onNotice(act.note, "info", {
            projectId: project.id,
            dedupe: `link-fallback:${project.id}:${act.panel}`,
          });
      } else if (act.do === "chat") {
        openChat(act.peer, act.name);
      } else if (act.do === "pr") {
        // Re-resolved against the live list: still open → its native tab,
        // merged or closed since → the URL in the browser.
        void openPrByNumber(act.repo, act.number, act.url);
      } else if (act.do === "note") {
        // The note tab reads the store itself and says so if the note is gone,
        // so the title is only a label until it loads — no round trip here
        // just to open a tab.
        openNote(act.noteId, "");
      } else if (act.do === "research") {
        openResearch(act.researchId, "");
      } else if (act.do === "task") {
        openTaskHistory(act.runId);
      } else if (act.do === "issue") {
        const provider = TRACKERS.find((tracker) => tracker.id === act.source);
        const repo = act.repo ?? repoPaths[0];
        if (!provider || !repo) {
          setSideTab("trackers");
          setPinned(true);
        } else {
          void provider.fetch(repo).then((tickets) => {
            const ticket = tickets.find((item) => item.id === act.issueId);
            if (ticket) openTicket(ticket, act.source);
            else {
              setSideTab("trackers");
              setPinned(true);
              onNotice(`Issue ${act.issueId} is no longer in the active list.`, "info", {
                projectId: project.id,
                dedupe: `link-fallback:${project.id}:trackers`,
              });
            }
          }).catch(() => {
            setSideTab("trackers");
            setPinned(true);
          });
        }
      } else if (act.do === "file") {
        const { path, line } = act;
        void openFileRef.current(path).then(() => {
          if (line)
            requestAnimationFrame(() =>
              window.dispatchEvent(
                new CustomEvent("canopy:reveal-line", {
                  detail: { path, line },
                }),
              ),
            );
        });
      }
    };
    window.addEventListener("canopy:deep-link", onLink);
    return () => window.removeEventListener("canopy:deep-link", onLink);
  }, [
    project.id,
    openChat,
    openNote,
    openResearch,
    openTaskHistory,
    openTicket,
    openPrByNumber,
    onNotice,
    repoPaths,
    relay.status.members,
  ]);

  // A browser-control op (canopy_browser_*): pick the preview tab it targets —
  // by origin when it names a URL, else the active/first preview tab, creating
  // one when navigation asks for a page and none is open — and hand the op to
  // the PreviewView through the queueing bus. Everything else, including
  // answering the bridge, happens in the view; only the no-tab case must answer
  // here or the agent would wait out the bridge's timeout.
  //
  // No op steals the front tab, navigation included. A new agent-owned preview
  // opens behind the user's work and is surfaced by the passive PiP instead.
  // An agent that snapshots its own work every few seconds must never yank the
  // user off the file they are editing.
  //
  // An open preview tab stays laid out while it's in the background (see the
  // doc-host styling below) so its page keeps real geometry and the ops that
  // need it — snapshot, click, type, eval — work unwatched.
  //
  // Screenshot included, under the webview engine: a child webview paints its
  // own snapshot in the web process, so it answers with its page whether or not
  // it is the tab on screen. Only the proxy engine, where the page is an iframe
  // and the only pixels available are this window's, has to refuse — see
  // planAgentShot, which holds both halves of that rule.
  useEffect(() => {
    const onBrowserOp = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        projectId: string;
        op: ipc.AgentBrowserOp;
      };
      if (d?.projectId !== project.id) return;
      const op = d.op;
      const previews = tabsRef.current.filter(
        (t): t is PreviewSubTab => t.type === "preview",
      );
      // Each session gets a page of its own, and stays on the one it is on —
      // see pickBrowserTab for why both halves matter.
      const tab = pickBrowserTab(
        previews,
        {
          url: op.url,
          ptyId: op.ptyId,
          navigating: op.op === "navigate" && !!op.url,
          currentTabId:
            op.ptyId == null ? null : sessionPreview.current.get(op.ptyId) ?? null,
        },
        activeTabIdRef.current,
      );
      if (tab) {
        // An agent navigating an empty picker is creating the session just as
        // surely as open_preview does. Never overwrite an existing preview's
        // provenance merely because another agent later drives its page.
        if (tab.initiatorPtyId == null && op.ptyId != null) {
          patchTabRaw(tab.id, { initiatorPtyId: op.ptyId } as Partial<SubTab>);
        }
        if (op.ptyId != null) showBrowserPip(tab.id, op.ptyId);
        dispatchBrowserOp(tab.id, op);
      } else if (op.op === "navigate" && op.url) {
        const id = openPreview(op.url, op.ptyId, false);
        if (op.ptyId != null) showBrowserPip(id, op.ptyId);
        dispatchBrowserOp(id, op);
      } else {
        void ipc.browserResult(
          op.id,
          false,
          "No preview page is open in this project. Call canopy_browser_navigate with a url first — canopy_project's runServers lists the addresses.",
        );
      }
    };
    window.addEventListener("canopy:agent-browser", onBrowserOp);
    return () =>
      window.removeEventListener("canopy:agent-browser", onBrowserOp);
  }, [project.id, openPreview, patchTabRaw, showBrowserPip]);

  /** A pull request, commit, issue or file on a git host, opened as the tab
   *  Canopy already has for it rather than as a page of github.com. False for
   *  everything that isn't openable *right now* — someone else's repository, a
   *  fork's PR, a commit never fetched, a path on a branch we don't have — and
   *  the caller shows the page instead. resolveGitLink decides; this only
   *  supplies the lookups and opens what comes back. */
  const openGitLink = useCallback(
    async (url: string): Promise<boolean> => {
      const action = await resolveGitLink(url, {
        repos: componentsRef.current.map((component) => component.path),
        remoteUrl: (repo) => ipc.gitRemoteUrl(repo),
        prs: (repo) => ipc.ghPrList(repo),
        issues: (repo) => ipc.ghIssueList(repo),
        commit: (repo, hash) => ipc.gitCommitDetail(repo, hash),
        fileExists: (repo, path) =>
          ipc.fsStat(`${repo.replace(/\/+$/, "")}/${path}`).then((s) => !s.is_dir),
      });
      if (!action) return false;
      switch (action.do) {
        case "pr":
          openPr(action.repo, action.pr);
          return true;
        case "ticket":
          openTicket(action.ticket, "github", action.repo);
          return true;
        case "commit":
          // The abbreviated hash in a URL is not the one a tab is keyed on —
          // the resolved commit carries the full one.
          openCommit(action.repo, {
            hash: action.commit.hash,
            short: action.commit.short,
            subject: action.commit.subject,
          });
          return true;
        case "file": {
          const path = `${action.repo.replace(/\/+$/, "")}/${action.path}`;
          const line = action.line;
          await openFileRef.current(path);
          if (line)
            requestAnimationFrame(() =>
              window.dispatchEvent(
                new CustomEvent("canopy:reveal-line", { detail: { path, line } }),
              ),
            );
          return true;
        }
      }
    },
    [openPr, openTicket, openCommit],
  );

  // A link the user clicked, from anywhere in the app: main.tsx delegates every
  // anchor through links.ts, which asks here first when Settings → Browser says
  // links open in Canopy.
  //
  // Only the project in front answers — every open project has one of these
  // mounted, and a link clicked in the one you are looking at must not open a
  // tab in a project you are not. Cancelling is the answer: links.ts reads a
  // dispatch that nobody cancelled as "there was no view to take this" and
  // sends it to the OS browser, so a click is never swallowed.
  //
  // A URL that names something we have a real view for (a PR, a commit, an
  // issue, a file) opens that view instead of a web page — see openGitLink.
  // The claim is made synchronously either way: whether the native tab is
  // possible takes a round trip to git, and a link must never escape to the OS
  // browser because the answer was slow.
  useEffect(() => {
    if (!visible) return;
    const onUrl = (e: Event) => {
      const url = (e as CustomEvent<OpenUrlDetail>).detail?.url;
      if (!url) return;
      e.preventDefault();
      void openGitLink(url)
        .catch(() => false)
        .then((opened) => {
          if (!opened) openPreview(url);
        });
    };
    window.addEventListener(OPEN_URL_EVENT, onUrl);
    return () => window.removeEventListener(OPEN_URL_EVENT, onUrl);
  }, [visible, openGitLink, openPreview]);

  const patchTab = useCallback(
    (id: string, patch: Partial<TermSubTab> & Partial<FileSubTab>) => {
      setTabs((prev) =>
        prev.map((t) => (t.id === id ? ({ ...t, ...patch } as SubTab) : t)),
      );
    },
    [],
  );

  const patchFile = useCallback((path: string, patch: Partial<OpenFile>) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.type === "file" && t.file.path === path
          ? { ...t, file: { ...t.file, ...patch } }
          : t,
      ),
    );
  }, []);

  const commitPendingAgentCloses = useCallback(
    (next: Map<string, PendingAgentClose>) => {
      pendingAgentClosesRef.current = next;
      setPendingAgentCloses(next);
    },
    [],
  );

  const dropPendingAgentTab = useCallback(
    (tabId: string) => {
      const current = pendingAgentClosesRef.current;
      const entry = [...current.values()].find((close) =>
        close.tabIds.includes(tabId),
      );
      if (!entry) return;
      const next = new Map(current);
      const tabIds = entry.tabIds.filter((id) => id !== tabId);
      if (tabIds.length === 0) {
        const timer = agentCloseTimers.current.get(entry.id);
        if (timer != null) window.clearTimeout(timer);
        agentCloseTimers.current.delete(entry.id);
        next.delete(entry.id);
      } else {
        const groups: Record<string, TerminalGroup> = {};
        for (const [groupId, group] of Object.entries(entry.groups)) {
          const root = removeLeaf(group.root, tabId);
          if (!root || leafIds(root).length < 2) continue;
          groups[groupId] = {
            ...group,
            root,
            activeTabId:
              group.activeTabId === tabId ? leafIds(root)[0] : group.activeTabId,
            zoomedTabId:
              group.zoomedTabId === tabId ? undefined : group.zoomedTabId,
          };
        }
        next.set(entry.id, {
          ...entry,
          tabIds,
          groups,
          restoreTabId:
            entry.restoreTabId === tabId ? tabIds[0] : entry.restoreTabId,
        });
      }
      commitPendingAgentCloses(next);
    },
    [commitPendingAgentCloses],
  );

  const finalizeTabClose = useCallback((
    id: string,
    origin: "automatic" | "user" = "automatic",
  ) => {
    const pendingClose = [...pendingAgentClosesRef.current.values()].find(
      (close) => close.tabIds.includes(id),
    );
    if (pendingClose && Object.keys(pendingClose.groups).length > 0) {
      const restored = {
        ...terminalGroupsRef.current,
        ...pendingClose.groups,
      };
      terminalGroupsRef.current = restored;
      setTerminalGroups(restored);
    }
    // A process can exit while its tab is in the grace period. Remove only that
    // member from the pending transaction; surviving panes can still be
    // restored until their shared deadline.
    dropPendingAgentTab(id);
    // The last moment the terminal's scrollback exists: the handle goes on the
    // next line and the buffer dies with the unmount. Both endings pass through
    // here — job_done's self-close and the user closing the tab — so capturing
    // once here covers a finished task and an abandoned one alike. recordTaskEnd
    // ignores a run that already settled, so "stopped" can't clobber "done".
    const closingTab = tabsRef.current.find((t) => t.id === id);
    if (
      origin === "user" &&
      closingTab?.type === "terminal" &&
      closingTab.ptyId != null &&
      (closingTab.attachId == null || closingTab.killAttachedOnClose)
    ) {
      // Hook events are the authoritative bond. Store-only agents have no
      // events, so fall back to the current-launch digest for this surface.
      const sessionId =
        liveSessionByPtyRef.current.get(closingTab.ptyId) ??
        digestBySurface(
          wsDigestsRef.current,
          thisInstanceRef.current,
        ).get(String(closingTab.ptyId))?.session_id;
      if (sessionId) markUserClosed(sessionId);
    }
    if (closingTab?.type === "terminal" && closingTab.micro?.runId) {
      const runId = closingTab.micro.runId;
      const output =
        termHandles.current.get(id)?.captureText(8000) || undefined;
      if (output) updateTaskRun(runId, { output });
      // A no-op for a run that already reported done; otherwise it settles as
      // "blocked" if the agent had asked for the user, else "stopped".
      endAbandonedRun(runId, output);
    }
    termHandles.current.delete(id);
    const closingGroup =
      closingTab?.type === "terminal" && closingTab.paneGroup
        ? terminalGroupsRef.current[closingTab.paneGroup]
        : undefined;
    const nextGroupRoot = closingGroup
      ? removeLeaf(closingGroup.root, id)
      : null;
    const nextGroupIds = nextGroupRoot ? leafIds(nextGroupRoot) : [];
    const nextGroupActive = closingGroup
      ? closingGroup.activeTabId === id
        ? nextGroupIds[0] ?? null
        : closingGroup.activeTabId
      : null;
    if (closingGroup) {
      setTerminalGroups((prev) => {
        const next = { ...prev };
        if (!nextGroupRoot || nextGroupIds.length < 2) delete next[closingGroup.id];
        else {
          next[closingGroup.id] = {
            ...closingGroup,
            root: nextGroupRoot,
            activeTabId: nextGroupActive ?? nextGroupIds[0],
            zoomedTabId:
              closingGroup.zoomedTabId === id
                ? undefined
                : closingGroup.zoomedTabId,
          };
        }
        terminalGroupsRef.current = next;
        return next;
      });
    }
    setTabs((prev) => {
      const closing = prev.find((t) => t.id === id);
      if (
        closing?.type === "terminal" &&
        closing.micro &&
        closing.ptyId != null
      ) {
        // A micro-task session never reaches restorables, however it ends —
        // that includes the user closing the tab mid-run. Forget after the
        // unmount-kill's grace window so the delete lands on the CLI's final
        // digest write instead of racing it.
        const sid = liveSessionByPtyRef.current.get(closing.ptyId);
        if (sid)
          setTimeout(() => void ipc.sessionForget(sid).catch(() => {}), 4000);
      }
      if (closing?.type === "file") {
        // Closing the tab disposes the model the OwnerSession is subscribed
        // to, so the share has to end first — otherwise it sits there holding
        // a dead model and every remote edit throws.
        const share = shared.current.get(closing.file.path);
        if (share) {
          collabRef.current.close(share.doc);
          shared.current.delete(closing.file.path);
        }
        monaco.editor.getModel(monaco.Uri.file(closing.file.path))?.dispose();
        baselines.current.delete(closing.file.path);
      }
      if (closing?.type === "collab") {
        collabRef.current.close(closing.doc);
        monaco.editor
          .getModels()
          .find(
            (m) =>
              m.uri.scheme === "canopy-collab" &&
              m.uri.path.startsWith(`/${closing.doc}/`),
          )
          ?.dispose();
      }
      if (closing?.type === "shared-project") {
        collabRef.current.leaveProject(closing.doc);
      }
      const closingIndex = prev.findIndex((t) => t.id === id);
      const next = prev
        .filter((t) => t.id !== id)
        .map((t) =>
          closingGroup && nextGroupIds.length === 1 && t.id === nextGroupIds[0]
            ? ({ ...t, paneGroup: undefined } as SubTab)
            : t,
        );
      setActiveTabId((active) => {
        if (active !== id) return active;
        if (nextGroupActive && next.some((t) => t.id === nextGroupActive))
          return nextGroupActive;
        if (next.length === 0) return null;
        // Land on the neighbour that took the closed tab's place (the tab to
        // its right), or the new last one when the last tab was closed — so
        // closing left-to-right stays predictable instead of jumping away.
        return next[Math.min(closingIndex, next.length - 1)].id;
      });
      return next;
    });
  }, [dropPendingAgentTab]);

  const finalizePendingAgentClose = useCallback(
    (closeId: string) => {
      const close = pendingAgentClosesRef.current.get(closeId);
      if (!close) return;
      const timer = agentCloseTimers.current.get(closeId);
      if (timer != null) window.clearTimeout(timer);
      agentCloseTimers.current.delete(closeId);
      if (Object.keys(close.groups).length > 0) {
        const restored = { ...terminalGroupsRef.current, ...close.groups };
        terminalGroupsRef.current = restored;
        setTerminalGroups(restored);
      }
      const next = new Map(pendingAgentClosesRef.current);
      next.delete(closeId);
      commitPendingAgentCloses(next);
      for (const id of close.tabIds) finalizeTabClose(id, "user");
      // The members finalize in one React turn, so each close can observe the
      // same pre-close group ref. Reconcile once from the captured tree instead
      // of allowing the last queued update to resurrect an already-closed leaf.
      const groupRemainders = new Map<string, string[]>();
      for (const group of Object.values(close.groups)) {
        let root: TerminalSplitNode | null = group.root;
        for (const id of close.tabIds) {
          if (!root) break;
          root = removeLeaf(root, id);
        }
        const ids = root ? leafIds(root) : [];
        groupRemainders.set(group.id, ids);
        setTerminalGroups((prev) => {
          const reconciled = { ...prev };
          if (!root || ids.length < 2) delete reconciled[group.id];
          else {
            reconciled[group.id] = {
              ...group,
              root,
              activeTabId: ids.includes(group.activeTabId)
                ? group.activeTabId
                : ids[0],
              zoomedTabId:
                group.zoomedTabId && ids.includes(group.zoomedTabId)
                  ? group.zoomedTabId
                  : undefined,
            };
          }
          terminalGroupsRef.current = reconciled;
          return reconciled;
        });
      }
      if (groupRemainders.size > 0) {
        setTabs((prev) =>
          prev.map((tab) => {
            if (tab.type !== "terminal" || !tab.paneGroup) return tab;
            const remaining = groupRemainders.get(tab.paneGroup);
            return remaining && remaining.length < 2
              ? { ...tab, paneGroup: undefined }
              : tab;
          }),
        );
      }
    },
    [commitPendingAgentCloses, finalizeTabClose],
  );

  const requestAgentClose = useCallback(
    (requestedIds: string[]): boolean => {
      const alreadyPending = pendingAgentTabIds(pendingAgentClosesRef.current);
      const closingTabs = requestedIds
        .filter((id) => !alreadyPending.has(id))
        .map((id) => tabsRef.current.find((tab) => tab.id === id))
        .filter((tab): tab is SubTab => Boolean(tab));
      if (
        closingTabs.length === 0 ||
        !closingTabs.some((tab) => isAgentTabRef.current(tab))
      ) {
        return false;
      }

      const tabIds = closingTabs.map((tab) => tab.id);
      const hidden = new Set([...alreadyPending, ...tabIds]);
      const groups: Record<string, TerminalGroup> = {};
      for (const tab of closingTabs) {
        if (tab.type !== "terminal" || !tab.paneGroup) continue;
        const group = terminalGroupsRef.current[tab.paneGroup];
        if (group) groups[group.id] = group;
      }

      // Remove pending panes from the effective split immediately, but retain
      // the original group in the transaction. The terminal hosts stay mounted.
      if (Object.keys(groups).length > 0) {
        setTerminalGroups((prev) => {
          const next = { ...prev };
          for (const group of Object.values(groups)) {
            let root: TerminalSplitNode | null = group.root;
            for (const id of tabIds) {
              if (!root) break;
              root = removeLeaf(root, id);
            }
            const ids = root ? leafIds(root) : [];
            if (!root || ids.length < 2) delete next[group.id];
            else {
              next[group.id] = {
                ...group,
                root,
                activeTabId: ids.includes(group.activeTabId)
                  ? group.activeTabId
                  : ids[0],
                zoomedTabId:
                  group.zoomedTabId && ids.includes(group.zoomedTabId)
                    ? group.zoomedTabId
                    : undefined,
              };
            }
          }
          terminalGroupsRef.current = next;
          return next;
        });
      }

      const id = `agent-close:${Date.now()}:${agentCloseSequence.current++}`;
      const groupRestoreTabId = Object.values(groups)
        .map((group) => group.activeTabId)
        .find((tabId) => tabIds.includes(tabId));
      const restoreTabId = tabIds.includes(activeTabIdRef.current ?? "")
        ? (activeTabIdRef.current as string)
        : groupRestoreTabId ?? tabIds[0];
      const first = closingTabs[0];
      const baseTitle =
        first.type === "terminal"
          ? first.customTitle ?? first.title
          : "Agent";
      const close: PendingAgentClose = {
        id,
        tabIds,
        title: tabIds.length > 1 ? `${baseTitle} +${tabIds.length - 1}` : baseTitle,
        deadline: Date.now() + AGENT_CLOSE_UNDO_MS,
        restoreTabId,
        groups,
      };
      const next = new Map(pendingAgentClosesRef.current);
      next.set(id, close);
      commitPendingAgentCloses(next);
      agentCloseTimers.current.set(
        id,
        window.setTimeout(
          () => finalizePendingAgentClose(id),
          AGENT_CLOSE_UNDO_MS,
        ),
      );

      if (tabIds.includes(activeTabIdRef.current ?? "")) {
        const remaining = tabsRef.current.filter((tab) => !hidden.has(tab.id));
        const firstIndex = tabsRef.current.findIndex((tab) => tab.id === tabIds[0]);
        setActiveTabId(
          remaining.length === 0
            ? null
            : remaining[Math.min(Math.max(firstIndex, 0), remaining.length - 1)].id,
        );
      }
      return true;
    },
    [commitPendingAgentCloses, finalizePendingAgentClose],
  );

  const restorePendingAgentClose = useCallback(
    (closeId: string) => {
      const close = pendingAgentClosesRef.current.get(closeId);
      if (!close) return;
      const timer = agentCloseTimers.current.get(closeId);
      if (timer != null) window.clearTimeout(timer);
      agentCloseTimers.current.delete(closeId);
      const next = new Map(pendingAgentClosesRef.current);
      next.delete(closeId);
      commitPendingAgentCloses(next);
      if (Object.keys(close.groups).length > 0) {
        setTerminalGroups((prev) => {
          const restored = { ...prev, ...close.groups };
          terminalGroupsRef.current = restored;
          return restored;
        });
      }
      const restoreId = close.tabIds.includes(close.restoreTabId)
        ? close.restoreTabId
        : close.tabIds[0];
      if (tabsRef.current.some((tab) => tab.id === restoreId))
        setActiveTabId(restoreId);
    },
    [commitPendingAgentCloses],
  );

  const closeTab = useCallback((
    id: string,
    origin: "automatic" | "user" = "automatic",
  ) => {
    if (origin === "user" && requestAgentClose([id])) return;
    finalizeTabClose(id, origin);
  }, [finalizeTabClose, requestAgentClose]);
  closeTabRef.current = closeTab;

  const splitActiveTerminal = useCallback(
    (axis: SplitAxis) => {
      const active = tabsRef.current.find(
        (t): t is TermSubTab => t.id === activeTabIdRef.current && t.type === "terminal",
      );
      if (!active || active.run) return;
      const pending = { sourceTabId: active.id, axis };
      pendingSplitRef.current = pending;
      setPendingSplit(pending);
      setLauncherOpen(true);
    },
    [],
  );
  splitActiveRef.current = splitActiveTerminal;

  const completePendingSplit = useCallback(
    (terminal: {
      command?: string;
      title?: string;
      icon?: string;
      env?: [string, string][];
      profile?: string;
    }) => {
      const pending = pendingSplitRef.current;
      if (!pending) return null;
      const source = tabsRef.current.find(
        (t): t is TermSubTab =>
          t.id === pending.sourceTabId && t.type === "terminal",
      );
      if (!source) {
        pendingSplitRef.current = null;
        setPendingSplit(null);
        return null;
      }
      const current = source.paneGroup
        ? terminalGroupsRef.current[source.paneGroup]
        : undefined;
      const groupId = current?.id ?? splitId();
      const nextId = addTerminal(
        source.cwd,
        terminal.command,
        terminal.title,
        terminal.icon,
        false,
        terminal.env,
        terminal.profile,
        true,
        groupId,
      );
      setTabs((prev) =>
        prev.map((t) =>
          t.id === source.id ? ({ ...t, paneGroup: groupId } as SubTab) : t,
        ),
      );
      const root = current?.root ?? { type: "leaf" as const, tabId: source.id };
      const next: TerminalGroup = {
        id: groupId,
        root: splitLeaf(root, source.id, nextId, pending.axis),
        activeTabId: nextId,
      };
      terminalGroupsRef.current = {
        ...terminalGroupsRef.current,
        [groupId]: next,
      };
      setTerminalGroups(terminalGroupsRef.current);
      setActiveTabId(nextId);
      pendingSplitRef.current = null;
      setPendingSplit(null);
      return nextId;
    },
    [addTerminal],
  );

  const focusPane = useCallback((direction: PaneDirection) => {
    const active = tabsRef.current.find(
      (t): t is TermSubTab => t.id === activeTabIdRef.current && t.type === "terminal",
    );
    if (!active?.paneGroup) return;
    const group = terminalGroupsRef.current[active.paneGroup];
    if (!group) return;
    const target = neighborPane(group.root, active.id, direction);
    if (!target) return;
    const next = { ...group, activeTabId: target };
    terminalGroupsRef.current = {
      ...terminalGroupsRef.current,
      [group.id]: next,
    };
    setTerminalGroups(terminalGroupsRef.current);
    setActiveTabId(target);
    setTimeout(() => termHandles.current.get(target)?.focus(), 50);
  }, []);
  focusPaneRef.current = focusPane;

  const movePane = useCallback((direction: PaneDirection) => {
    const active = tabsRef.current.find(
      (t): t is TermSubTab =>
        t.id === activeTabIdRef.current && t.type === "terminal",
    );
    if (!active?.paneGroup) return;
    const group = terminalGroupsRef.current[active.paneGroup];
    if (!group) return;
    const target = neighborPane(group.root, active.id, direction);
    if (!target) return;
    const next = {
      ...group,
      root: swapLeaves(group.root, active.id, target),
      activeTabId: active.id,
    };
    terminalGroupsRef.current = {
      ...terminalGroupsRef.current,
      [group.id]: next,
    };
    setTerminalGroups(terminalGroupsRef.current);
  }, []);
  movePaneRef.current = movePane;

  const togglePaneZoom = useCallback(() => {
    const active = tabsRef.current.find(
      (t): t is TermSubTab => t.id === activeTabIdRef.current && t.type === "terminal",
    );
    if (!active?.paneGroup) return;
    const group = terminalGroupsRef.current[active.paneGroup];
    if (!group) return;
    const next = {
      ...group,
      zoomedTabId: group.zoomedTabId === active.id ? undefined : active.id,
    };
    terminalGroupsRef.current = {
      ...terminalGroupsRef.current,
      [group.id]: next,
    };
    setTerminalGroups(terminalGroupsRef.current);
  }, []);
  togglePaneZoomRef.current = togglePaneZoom;

  const equalizePanes = useCallback(() => {
    const active = tabsRef.current.find(
      (t): t is TermSubTab => t.id === activeTabIdRef.current && t.type === "terminal",
    );
    if (!active?.paneGroup) return;
    const group = terminalGroupsRef.current[active.paneGroup];
    if (!group) return;
    const next = { ...group, root: equalizeSplits(group.root) };
    terminalGroupsRef.current = {
      ...terminalGroupsRef.current,
      [group.id]: next,
    };
    setTerminalGroups(terminalGroupsRef.current);
  }, []);
  equalizePanesRef.current = equalizePanes;

  const [confirmCloseGroup, setConfirmCloseGroup] = useState<{
    groupId: string;
    live: number;
  } | null>(null);

  const closeTerminalGroupNow = useCallback(
    (groupId: string) => {
      const group = terminalGroupsRef.current[groupId];
      if (!group) return;
      const ids = leafIds(group.root);
      // An agent group is one visual tab and one undo transaction. Do not send
      // the eager kills used by ordinary terminal groups: its mounted Terms are
      // the resources Restore preserves during the grace period.
      if (requestAgentClose(ids)) return;
      for (const id of ids) {
        const tab = tabsRef.current.find(
          (t): t is TermSubTab => t.id === id && t.type === "terminal",
        );
        if (
          tab?.ptyId != null &&
          (tab.attachId == null || tab.killAttachedOnClose) &&
          !tab.exited
        ) {
          void ipc.ptyKill(tab.ptyId).catch(() => {});
        }
      }
      for (const id of ids) closeTabRef.current(id, "user");
      setTerminalGroups((prev) => {
        const next = { ...prev };
        delete next[groupId];
        terminalGroupsRef.current = next;
        return next;
      });
    },
    [requestAgentClose],
  );

  const closeTerminalGroup = useCallback(
    (groupId: string) => {
      const group = terminalGroupsRef.current[groupId];
      if (!group) return;
      const live = leafIds(group.root).filter((id) => {
        const tab = tabsRef.current.find(
          (t): t is TermSubTab => t.id === id && t.type === "terminal",
        );
        return (
          tab?.ptyId != null &&
          (tab.attachId == null || tab.killAttachedOnClose) &&
          !tab.exited
        );
      }).length;
      if (live > 0) {
        setConfirmCloseGroup({ groupId, live });
        return;
      }
      closeTerminalGroupNow(groupId);
    },
    [closeTerminalGroupNow],
  );

  const closeActivePane = useCallback(() => {
    const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (!active) return;
    closeTabRef.current(active.id, "user");
  }, []);
  closeActivePaneRef.current = closeActivePane;

  const breakPaneOut = useCallback((tabId: string) => {
    const tab = tabsRef.current.find(
      (t): t is TermSubTab => t.id === tabId && t.type === "terminal",
    );
    if (!tab?.paneGroup) return;
    const group = terminalGroupsRef.current[tab.paneGroup];
    if (!group) return;
    const root = removeLeaf(group.root, tabId);
    const remaining = root ? leafIds(root) : [];
    setTabs((prev) =>
      prev.map((item) =>
        item.type === "terminal" &&
        (item.id === tabId || (remaining.length === 1 && item.id === remaining[0]))
          ? { ...item, paneGroup: undefined }
          : item,
      ),
    );
    setTerminalGroups((prev) => {
      const next = { ...prev };
      if (!root || remaining.length < 2) delete next[group.id];
      else {
        next[group.id] = {
          ...group,
          root,
          activeTabId: remaining[0],
          zoomedTabId: undefined,
        };
      }
      terminalGroupsRef.current = next;
      return next;
    });
    setActiveTabId(tabId);
  }, []);

  const closeActiveGroup = useCallback(() => {
    const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (active?.type === "terminal" && active.paneGroup)
      closeTerminalGroup(active.paneGroup);
    else if (active) closeTabRef.current(active.id, "user");
  }, [closeTerminalGroup]);
  closeActiveGroupRef.current = closeActiveGroup;

  // The owner stopped sharing (or we left from elsewhere): close any shared
  // -project tab whose project is no longer joined.
  useEffect(() => {
    for (const t of tabsRef.current) {
      if (
        t.type === "shared-project" &&
        !relay.collab.joinedProjects.has(t.doc)
      ) {
        closeTabRef.current(t.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay.collabTick]);

  // ---------- files ----------

  const openFile = useCallback(
    async (
      path: string,
      opts?: { diff?: boolean; force?: boolean; activate?: boolean },
    ) => {
      const existing = tabsRef.current.find(
        (t) => t.type === "file" && t.file.path === path,
      ) as FileSubTab | undefined;
      const kind = viewerKindFor(path);
      // Ask the size before reading the bytes. A .zip or a multi-gigabyte log
      // used to be pulled across IPC in full and only then found unrenderable,
      // by which point the tab was already frozen and the memory already spent.
      let blocked: OpenBlock | null = null;
      let bytes: Uint8Array | null = null;
      try {
        const stat = await ipc.fsStat(path);
        blocked = opts?.force ? null : blockForOpen(path, kind, stat.size);
        if (!blocked) {
          bytes = await ipc.fsReadFile(path);
          // Extensions that claim nothing (.dat, .pack, no extension at all)
          // only give themselves away in the bytes.
          if (kind === "code" && looksBinary(bytes)) {
            blocked = {
              reason: "binary",
              size: stat.size,
              limit: sizeLimitFor(kind),
            };
            bytes = null;
          }
        }
      } catch (err) {
        // Silence here is what made the task-history chips look inert: a path
        // that had been deleted with its worktree, or that sits outside every
        // registered root, logged to a console nobody has open and returned.
        // Say which of the two it was, because they need different things of
        // the user.
        console.warn("open failed", path, err);
        onNotice(
          `Can't open ${basename(path)} — ${
            String(err).includes("outside")
              ? "it's outside this project's folders."
              : "it may have been moved or deleted."
          }`,
          "error",
        );
        return;
      }
      // Proper diff for changed files: baseline is git HEAD. Any text-ish file
      // qualifies — gating on code/json/markdown silently denied a diff to
      // things like .gitignore, Dockerfile or .env, which are exactly the files
      // people click in the git panel.
      let diffOriginal: string | null = null;
      const diffable = !["pdf", "image", "sheet", "docx"].includes(kind);
      if (!blocked && bytes && opts?.diff && diffable) {
        diffOriginal = await ipc.gitHeadContent(path).catch(() => null);
      }
      if (bytes && (kind === "code" || diffOriginal != null)) {
        const text = decoder.decode(bytes);
        if (!baselines.current.has(path)) baselines.current.set(path, text);
        modelFor(path, text);
        const root = roots.find((r) => path.startsWith(r + "/"));
        if (root && kind === "code") void ensureLanguageServer(path, root);
      }
      if (existing) {
        patchFile(path, {
          bytes,
          blocked,
          ...(diffOriginal != null
            ? { view: "diff" as const, diffOriginal }
            : {}),
        });
        if (opts?.activate !== false) setActiveTabId(existing.id);
        return;
      }
      const id = tabId();
      setTabs((prev) => [
        ...prev,
        {
          id,
          type: "file",
          file: {
            path,
            name: basename(path) || path,
            kind,
            view:
              diffOriginal != null
                ? "diff"
                : kind === "code"
                  ? "source"
                  : "preview",
            diffOriginal,
            dirty: false,
            external: null,
            bytes,
            blocked,
          },
        },
      ]);
      if (opts?.activate !== false) setActiveTabId(id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootsKey, patchFile],
  );
  openFileRef.current = openFile;

  /** Follow a `[[wikilink]]` from any surface that owns its text.
   *
   *  One handler for all of them, so a link resolves identically in a note and
   *  in a research write-up. An unresolved target becomes a new note — that is
   *  Obsidian's behaviour and the reason the syntax earns its place: linking to
   *  a thought is how you record it before you have written it. */
  const followWikilink = useCallback(
    async (target: string) => {
      // The file list is fetched per click rather than held: following a
      // wikilink is a rare, deliberate act, and a corpus kept warm for it would
      // be a tree walk's worth of strings resident for the life of the tab.
      const files = await ipc.fsListFiles(roots).catch(() => [] as string[]);
      const hit = resolveWikilink(target, {
        notes: notesCached(project.id),
        research: researchCached(project.id),
        files,
      });
      switch (hit.kind) {
        case "note":
          openNote(hit.id, hit.title);
          return;
        case "research":
          openResearch(hit.id, hit.title);
          return;
        case "file":
          void openFile(hit.path);
          return;
        case "new":
          if (!hit.title) return;
          void createNote({
            projectId: project.id,
            projectName: project.name,
            roots,
            title: hit.title,
            origin: "wikilink",
            cwd: roots[0],
          })
            .then((n) => openNote(n.id, n.title))
            .catch((e) => onNotice(String(e), "error"));
      }
    },
    [project.id, project.name, roots, openNote, openResearch, openFile, onNotice],
  );

  const saveFile = useCallback(
    async (path: string) => {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      if (!model) return;
      const content = model.getValue();
      recentSaves.current.set(path, Date.now());
      try {
        await ipc.fsWriteFile(path, content);
        baselines.current.set(path, content);
        patchFile(path, { dirty: false });
      } catch (err) {
        console.error("save failed", path, err);
      }
    },
    [patchFile],
  );

  const findFile = (path: string): OpenFile | undefined => {
    const tab = tabsRef.current.find(
      (t) => t.type === "file" && t.file.path === path,
    ) as FileSubTab | undefined;
    return tab?.file;
  };

  const acceptExternal = useCallback(
    (path: string) => {
      const file = findFile(path);
      if (!file?.external) return;
      monaco.editor.getModel(monaco.Uri.file(path))?.setValue(file.external);
      baselines.current.set(path, file.external);
      patchFile(path, { external: null, dirty: false });
    },
    [patchFile],
  );

  const keepMine = useCallback(
    (path: string) => {
      const file = findFile(path);
      if (!file?.external) return;
      baselines.current.set(path, file.external);
      patchFile(path, { external: null, dirty: true });
    },
    [patchFile],
  );

  const toggleView = useCallback(
    (path: string) => {
      const file = findFile(path);
      if (!file) return;
      if (file.view === "preview" && file.bytes) {
        const text = decoder.decode(file.bytes);
        if (!baselines.current.has(path)) baselines.current.set(path, text);
        modelFor(path, text);
      }
      patchFile(path, {
        view: file.view === "preview" ? "source" : "preview",
        diffOriginal: null,
      });
    },
    [patchFile],
  );

  // ---------- diff-first: external changes scoped to this project ----------

  // The change feed is whatever git reports as changed, one group per
  // component. Git — not the raw fs watcher — is the source of truth, so the
  // list already honours .gitignore (including nested ones like
  // src-tauri/.gitignore) and never shows build output, object files or the
  // editor's atomic-write temp files. Two components resolving to the same repo
  // are collapsed to the first, so a file is never listed twice.
  const refreshChanges = useCallback(async () => {
    const comps = componentsRef.current;
    setChangesLoading(true);
    try {
      const results = await Promise.all(
        comps.map((c) =>
          ipc
            .gitRepoStatus(c.path)
            .then((s) => {
              const files = [
                ...s.conflicted,
                ...s.staged,
                ...s.unstaged,
                ...s.untracked,
              ];
              const seen = new Set<string>();
              const unique = files.filter((f) => {
                if (seen.has(f.path)) return false;
                seen.add(f.path);
                return true;
              });
              return {
                component: c.label,
                repo: s.path,
                files: unique,
              } as ChangeGroup;
            })
            .catch(() => null),
        ),
      );
      const seenRepo = new Set<string>();
      const groups = results.filter(
        (g): g is ChangeGroup =>
          g != null &&
          g.files.length > 0 &&
          !seenRepo.has(g.repo) &&
          (seenRepo.add(g.repo), true),
      );
      // Bail when unchanged. `git:change` fires for every commit, stage and
      // branch switch an agent makes, and a fresh array with identical contents
      // re-renders the whole project for nothing.
      setChangeGroups((prev) =>
        JSON.stringify(prev) === JSON.stringify(groups) ? prev : groups,
      );
    } finally {
      setChangesLoading(false);
    }
  }, []);

  // Query git on mount and whenever the component set changes.
  useEffect(() => {
    void refreshChanges();
  }, [refreshChanges, rootsKey]);

  // The fs watcher no longer *builds* the feed — it only live-diffs files that
  // are already open in a tab. Re-querying git is `git:change`'s job: it fires
  // for the same edits *and* for the commits, stages and switches an agent
  // makes in a terminal, which write inside .git and so never reach fs:change
  // at all. Its debounce is the Rust one, replacing the 400ms timer here.
  useEffect(() => {
    // Only when it was one of *our* repos. The event names the root that moved,
    // and every project used to re-shell `git status` for all its components on
    // any repo's commit — including the projects sitting behind `display: none`.
    const gitSub = ipc.onGitChange((e) => {
      const mine = rootsRef.current.some(
        (r) => e.root === r || r.startsWith(e.root + "/") || e.root.startsWith(r + "/"),
      );
      if (mine) void refreshChanges();
    });
    const unlisten = ipc.onFsChange(async (e) => {
      const now = Date.now();
      for (const path of e.paths) {
        if (!roots.some((r) => path.startsWith(r + "/"))) continue;
        const saved = recentSaves.current.get(path);
        if (saved && now - saved < 1500) continue;
        const file = findFile(path);
        if (!file || e.kind === "remove") continue;
        // A tab that refused to load the file in the first place must not
        // re-read it every time something touches it on disk.
        if (file.blocked) continue;
        try {
          const bytes = await ipc.fsReadFile(path);
          if (file.kind === "code") {
            const newText = decoder.decode(bytes);
            const model = monaco.editor.getModel(monaco.Uri.file(path));
            if (!model || model.getValue() === newText) {
              baselines.current.set(path, newText);
              continue;
            }
            patchFile(path, { external: newText });
          } else {
            patchFile(path, { bytes });
          }
        } catch {
          // mid-write; next event catches it
        }
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
      void gitSub.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, patchFile, refreshChanges]);

  // ---------- render ----------

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  // A full strip with nothing in front renders a blank workspace, and every
  // path that opens tabs without activating one can leave it there. The invariant
  // is worth holding here rather than at each of them: if there are tabs, one of
  // them is on screen.
  useEffect(() => {
    if (activeTab || tabs.length === 0) return;
    setActiveTabId(tabs[0].id);
  }, [activeTab, tabs]);
  // Publish the tab in front to the one channel anything can subscribe to
  // (activeView.ts). Only the visible project publishes — every open project
  // keeps a ProjectView mounted, and a backgrounded one announcing its own tab
  // would make "what is the user looking at" depend on render order.
  useEffect(() => {
    if (!visible) return;
    setActiveTab(project.id, activeTab?.id ?? null, activeTab?.type ?? null);
  }, [visible, project.id, activeTab?.id, activeTab?.type]);
  // Closing the project clears it, but only if this project is still the one on
  // record — see clearActiveTab.
  useEffect(() => () => clearActiveTab(project.id), [project.id]);

  // The pty of the terminal tab in front, so the Agents panel can highlight its
  // row — relating the tab you're looking at back to its entry in the list.
  const activePty = activeTab?.type === "terminal" ? activeTab.ptyId : null;
  // Every running pty's tab name, so the Agents panel can name its rows the
  // way the tab strip does: the CLI's own title for the tab, or the user's
  // rename over it.
  const tabNames = useMemo(() => tabNamesByPty(tabs), [tabs]);
  const runTabs = useMemo(
    () =>
      tabs.filter(
        (t): t is TermSubTab => t.type === "terminal" && Boolean(t.run),
      ),
    [tabs],
  );
  // Every pty this project owns. Detached micro-task runs are in here too, and
  // have to be: this set is what filters the global hook stream down to ours,
  // and a run with no tab would otherwise have no state, no last step, and no
  // session to forget when it ends.
  const ptyIds = useMemo(
    () =>
      new Set([
        ...tabs
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((t) => t.ptyId)
          .filter((id): id is number => id != null),
        ...microRuns.map((r) => r.ptyId),
      ]),
    [tabs, microRuns],
  );
  const projectStats = stats; // already filtered to this project's ptys at the door
  // Hooks are global, so the raw stream carries every agent on the machine.
  // Everything below this line sees only what our own terminals raised.
  // Memoized so the derived pending/urgent arrays keep a stable identity —
  // that's what lets the memoized ActivityRail skip unrelated re-renders.
  const projectEvents = useMemo(
    () => eventsForProject(events, ptyIds, roots),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, ptyIds, rootsKey],
  );
  // Session ids seen on this project's live terminals during this app run. A
  // digest not in here has no terminal — either it ended, or the IDE died with
  // it running, which is exactly the case restore exists for. Derived from
  // events rather than stored, because pty ids restart from 1 each launch and
  // would otherwise collide with a previous run's.
  const liveSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of projectEvents) {
      if (e.data?.sessionId) ids.add(e.data.sessionId);
    }
    return [...ids];
  }, [projectEvents]);
  // The session actually running in each live terminal, keyed by the pty id the
  // hook stamped on its events *this* launch (`canopy_pty`) — not the digest's
  // `surface`, which is the pty from whenever the hook last wrote and goes stale
  // across a restart/restore. This is the authoritative terminal→session bond:
  // it can never bind a tab to an unrelated session whose recycled pty number
  // happens to collide. Latest event per pty wins.
  const liveSessionByPty = useMemo(() => {
    // Seeded from each terminal's own launch command first: a tab restored as
    // `codex resume <id>` names its session outright, and Canopy typed that
    // command into that pty, so the bond holds from the first frame. Without
    // the seed, a resumed CLI that emits no hook event until its next prompt
    // (codex does exactly this) leaves its tab unbound after every restart —
    // the digest it wrote sits on disk saying "idle" while the strip, seeing
    // no digest at all, reads the resume banner's paint burst as "working".
    const m = new Map<number, string>();
    for (const t of tabs) {
      if (t.type !== "terminal" || t.ptyId == null) continue;
      const sid = resumeSessionId(t.command);
      if (sid) m.set(t.ptyId, sid);
    }
    const latest = new Map<number, { sid: string; ts: number }>();
    for (const e of projectEvents) {
      const d = e.data;
      if (!d || d.pty == null || !d.sessionId) continue;
      const prev = latest.get(d.pty);
      if (!prev || e.ts >= prev.ts)
        latest.set(d.pty, { sid: d.sessionId, ts: e.ts });
    }
    // The event stamp wins where both speak: it is from this launch by
    // construction and follows the session even if the CLI swaps ids.
    for (const [pty, v] of latest) m.set(pty, v.sid);
    return m;
  }, [projectEvents, tabs]);
  liveSessionIdsRef.current = liveSessionIds;
  const liveSessionByPtyRef = useRef(liveSessionByPty);
  liveSessionByPtyRef.current = liveSessionByPty;

  // The fast lane: hook events land on the attention axis within the bridge's
  // 500ms batch, rather than waiting seconds for the digest poll. This is what
  // makes `blocked` — and with it bucketFor's event-stream promotion — real:
  // the reducer has spoken this input's type from the start, but nothing ever
  // produced it, so a permission prompt only reached the strip when the digest
  // caught up. `signalFor` is the same mapping the producer uses.
  //
  // A WeakSet, not an index: the buffer is capped and App drops old entries
  // from the front, so a position would drift; an entry's identity doesn't.
  const seenHookEvents = useRef(new WeakSet<AgentEventEntry>());
  useEffect(() => {
    for (const e of projectEvents) {
      const d = e.data;
      if (!d || d.pty == null) continue;
      if (seenHookEvents.current.has(e)) continue;
      seenHookEvents.current.add(e);
      const signal = signalFor(d);
      if (!signal) continue;
      const cli = d.agent || null;
      attentionRef.current(d.pty, { t: "hook", at: e.ts, signal }, cli);
      // A flag raised by the tab you are watching is already seen (same rule
      // as the OSC and quiet paths): looking clears `unseen`, and you are
      // looking. A `blocked` survives this on purpose — glancing at a
      // question does not answer it.
      const tab = tabsRef.current.find(
        (t): t is TermSubTab => t.type === "terminal" && t.ptyId === d.pty,
      );
      if (tab && tab.id === activeTabIdRef.current && visibleRef.current)
        attentionRef.current(d.pty, { t: "focus", at: e.ts, visible: true }, cli);
    }
  }, [projectEvents]);

  /** Every session that is up, and how to reach it: its terminal here, or null
   *  when it is running somewhere this window cannot type into.
   *
   *  Both halves are needed by the PR tab's "Raised by" (agentForPr.ts). A
   *  session with no terminal here is not the same as one that has ended — it
   *  must not be offered as reachable, and it must NOT be resumed either, since
   *  a second process on one conversation id is how you corrupt it. */
  const liveSessions = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const d of wsDigests) {
      if (!d.session_id) continue;
      if (lifeFor({ digest: d as never, now: lifeClock / 1000 }).state === "ended")
        continue;
      m.set(d.session_id, null);
    }
    // A terminal in this window beats the digest's word: it is the binding the
    // hook stamped this launch, so it cannot name a recycled pty.
    for (const [pty, sid] of liveSessionByPty) {
      if (sid && projectStats.some((s) => s.id === pty)) m.set(sid, pty);
    }
    return m;
  }, [wsDigests, liveSessionByPty, projectStats, lifeClock]);
  // Read from the agent-action handler, which is not re-created per render.
  const liveSessionsRef = useRef(liveSessions);
  liveSessionsRef.current = liveSessions;

  /** Write each running task's conversation id into its history entry, as soon
   *  as the CLI's first hook event reveals it.
   *
   *  Stamped while the run is alive because there is no later. When a task
   *  ends, Canopy forgets its session (session_forget, so a one-shot never
   *  turns up in restorables) and the pty dies, taking the pty→session binding
   *  with it — but the CLI's own transcript stays on disk, and this id is the
   *  only handle left on it. That is what "Continue as a session" resumes.
   *
   *  Guarded by a set rather than by comparing the store: updateTaskRun writes
   *  localStorage and fires the history event, and doing that on every poll for
   *  every running task would repaint every panel watching it, forever. */
  const sessionStamped = useRef(new Set<string>());
  useEffect(() => {
    const stamp = (runId: string | undefined, ptyId: number) => {
      if (!runId || sessionStamped.current.has(runId)) return;
      const sid = liveSessionByPty.get(ptyId);
      if (!sid) return;
      sessionStamped.current.add(runId);
      updateTaskRun(runId, { sessionId: sid });
    };
    for (const r of microRuns) stamp(r.runId, r.ptyId);
    for (const t of tabs)
      if (t.type === "terminal" && t.micro?.runId && t.ptyId != null)
        stamp(t.micro.runId, t.ptyId);
  }, [liveSessionByPty, microRuns, tabs]);

  // ---------- hibernation ----------
  // Sits here rather than up with the other tab plumbing because a snapshot is
  // only worth taking once it can name the conversation live in each terminal
  // (liveSessionByPty, just above) — that binding is what brings an agent back
  // mid-thought instead of at a fresh prompt.

  // `pinned`, not `peeking`: the latch is the user's standing decision about
  // the side panel, where a peek is just where the pointer happened to be when
  // the project was put to sleep.
  const snapshotState = useRef({
    activeTabId,
    sideTab,
    pinned,
    worktreeEnv,
  });
  snapshotState.current = { activeTabId, sideTab, pinned, worktreeEnv };

  useEffect(() => {
    const onHibernate = (e: Event) => {
      const d = (e as CustomEvent).detail as { projectId?: string } | null;
      if (d?.projectId !== project.id) return;
      const {
        activeTabId: active,
        sideTab: side,
        pinned: sideOut,
        worktreeEnv: wt,
      } = snapshotState.current;
      const snap = buildSnapshot({
        tabs: tabsRef.current,
        activeTabId: active,
        sideTab: side,
        sidePinned: sideOut,
        worktree: wt,
        sessionFor: (pty) => liveSessionByPtyRef.current.get(pty),
        terminalGroups: terminalGroupsRef.current,
      });
      // App waits for this before closing the project: a snapshot that could
      // not be stored must leave the project open, because closing it would
      // throw the work away rather than put it away.
      const ok = writeHibernation(project.id, snap);
      // Put the workspace down properly rather than letting the unmount do it.
      // Unmounting kills the PTYs but nothing else: the editor models, the
      // diff baselines and any live share would all be left holding memory,
      // which for a feature whose whole point is reclaiming it would be a
      // strange thing to skip. closeTab already knows how to end each kind.
      if (ok) for (const t of [...tabsRef.current]) closeTabRef.current(t.id);
      // Detached runs have no tab to close, and no way home either: a
      // micro-task session is never restored (resuming a finished job re-runs
      // it), so a task in flight when the project goes to sleep ends the same
      // way its tab-bound cousin just did — stopped, and recorded as such.
      if (ok)
        for (const r of [...microRunsRef.current])
          stopMicroRunRef.current(r.ptyId);
      window.dispatchEvent(
        new CustomEvent(HIBERNATED_EVENT, {
          detail: { projectId: project.id, ok },
        }),
      );
    };
    window.addEventListener(HIBERNATE_EVENT, onHibernate);
    return () => window.removeEventListener(HIBERNATE_EVENT, onHibernate);
  }, [project.id]);

  // Warm the research and scratchpad caches once per project, so ⌘K can offer
  // "this has already been looked into" on the first keystroke rather than
  // after a round trip. One directory read of a few dozen small files each.
  //
  // Then close the loop for both: what a linked PR says gets brought up to
  // date, and an entry or note whose PRs have all merged moves to
  // "implemented" / "done". Driven off the PR watcher's ticks rather than a
  // timer of its own — it is the thing that already knows when PR state moved.
  // The `gh pr view` behind it is cached per PR and never repeated for one that
  // merged (prLinkState.ts), so a tick over settled work costs nothing.
  //
  // The scratchpad half was written and never called: `notes.reconcileMerged`
  // existed with tests and no caller, which is why every note's linked PR sat
  // on the state it was linked with forever.
  useEffect(() => {
    const sweep = () => {
      void reconcileMerged(project.id);
      void reconcileNotesMerged(project.id);
    };
    void Promise.all([
      researchRefresh(project.id),
      refreshNotes(project.id),
    ]).then(sweep);
    return prWatchSubscribe(sweep);
  }, [project.id]);

  /** Rebuild one snapshotted tab and answer with its id, so the tab that was in
   *  front can be found again once the whole strip is back. */
  const restoreTab = useCallback(
    async (t: SnapshotTab): Promise<string | null> => {
      const push = (tab: SubTab) => {
        setTabs((prev) => [...prev, tab]);
        return tab.id;
      };
      switch (t.kind) {
        case "terminal": {
          // A headless PTY from the phone outlived hibernation — we never
          // spawned it, so we never killed it. Reattach when it is still there;
          // otherwise there is nothing to attach to and the tab is dropped.
          if (t.attachId != null) {
            if (!statsRef.current.some((s) => s.id === t.attachId)) return null;
            return push({
              id: tabId(),
              type: "terminal",
              cwd: t.cwd,
              title: t.title,
              ptyId: t.attachId,
              attachId: t.attachId,
              icon: t.icon ?? "📱",
              paneGroup: t.paneGroup,
              componentId: t.componentId,
              runCommandId: t.runCommandId,
            });
          }
          const { command } = terminalLaunch(t);
          // Back on the account it slept on, or the resume command is right
          // and the store it reads is wrong.
          const env =
            t.agentId && t.profile && t.profile !== "default"
              ? await ipc.profileEnv(t.agentId, t.profile).catch(() => [])
              : [];
          return addTerminal(
            t.cwd,
            command,
            t.title,
            t.icon,
            t.run,
            env,
            env.length ? t.profile : undefined,
            true,
            t.paneGroup,
            t.componentId && t.runCommandId
              ? { componentId: t.componentId, runCommandId: t.runCommandId }
              : undefined,
          );
        }
        case "file": {
          await openFileRef.current(t.path, { diff: t.view === "diff" });
          // openFile appends through setTabs, which React commits after the
          // current task — so yield before reading the strip back. A file that
          // no longer exists on disk simply never appears, and is skipped.
          await new Promise((r) => window.setTimeout(r, 0));
          const tab = tabsRef.current.find(
            (x) => x.type === "file" && x.file.path === t.path,
          );
          if (tab && t.view !== "diff") patchFile(t.path, { view: t.view });
          return tab?.id ?? null;
        }
        case "preview":
          return push({
            id: tabId(),
            type: "preview",
            url: t.url,
            annotations: [],
          });
        case "pr":
          return push({ id: tabId(), type: "pr", repo: t.repo, pr: t.pr });
        case "ticket":
          return push({
            id: tabId(),
            type: "ticket",
            ticket: t.ticket,
            source: t.source,
            // Older snapshots predate repository identity on ticket tabs.
            repo: t.repo ?? await ticketRepo(),
          });
        case "commit":
          return push({
            id: tabId(),
            type: "commit",
            repo: t.repo,
            hash: t.hash,
            short: t.short,
            subject: t.subject,
          });
        case "branch":
          return push({
            id: tabId(),
            type: "branch",
            repo: t.repo,
            branch: t.branch,
          });
        case "review":
          return push({ id: tabId(), type: "review", review: t.review });
        case "agent":
          return push({
            id: tabId(),
            type: "agent",
            repo: t.repo,
            agent: t.agent,
            cwd: t.cwd,
            sessionId: t.sessionId,
            digest: t.digest,
          });
        case "agents":
          return push({ id: tabId(), type: "agents" });
        case "research-list":
          return push({ id: tabId(), type: "research-list" });
        case "notes-list":
          return push({ id: tabId(), type: "notes-list" });
        case "prs-list":
          return push({ id: tabId(), type: "prs-list" });
        case "issues-list":
          return push({ id: tabId(), type: "issues-list" });
        case "task-history":
          return push({ id: tabId(), type: "task-history" });
        case "instructions":
          return push({ id: tabId(), type: "instructions", focus: t.focus });
        case "mcp":
          return push({ id: tabId(), type: "mcp", server: t.server });
        case "claim":
          return push({ id: tabId(), type: "claim", claimId: t.claim.id, claim: t.claim });
        case "chat":
          return push({
            id: tabId(),
            type: "chat",
            peer: t.peer,
            name: t.name,
          });
      }
    },
    [addTerminal, patchFile, ticketRepo],
  );

  // Wake: rebuild the workspace step by step while the frost (rendered by App,
  // above this view) stays put. In snapshot order, so the strip comes back
  // left-to-right as it was, and paced — eight PTYs spawned in the same frame
  // is a stall the user watches, and each one wants its own beat on screen.
  const restoring = useRef(false);
  const restoreStepRef = useRef(onRestoreStep);
  restoreStepRef.current = onRestoreStep;
  const restoredRef = useRef(onRestored);
  restoredRef.current = onRestored;
  useEffect(() => {
    if (!restore || restoring.current) return;
    restoring.current = true;
    let cancelled = false;
    const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    void (async () => {
      const steps = wakeSteps(restore);
      restoreStepRef.current?.(0, steps.length, steps[0]?.label ?? "Ready");
      // Checked before it is trusted — the snapshot's shape is unchanged, but a
      // workspace can be removed or moved to another branch while a project
      // sleeps, and restoring one that is gone points the whole file surface at
      // a path that no longer resolves.
      if (restore.worktree) void wakeWorktreeEnvRef.current(restore.worktree);
      setSideTab(restore.sideTab);
      setPinned(restore.sidePinned);
      const ids: (string | null)[] = [];
      const restoredTerminalIds = new Map<string, string>();
      for (const [i, step] of steps.entries()) {
        if (cancelled) return;
        let id: string | null = null;
        try {
          id = await restoreTab(step.tab);
        } catch (err) {
          // One tab that can't come back (a deleted file, a dead attach) must
          // never strand the rest of the workspace asleep.
          console.warn("restore failed", step.label, err);
        }
        ids.push(id);
        if (id && step.tab.kind === "terminal" && step.tab.tabId)
          restoredTerminalIds.set(step.tab.tabId, id);
        // A terminal has a PTY to spawn; a document tab is a render. Pace them
        // differently so a workspace of files doesn't crawl.
        await wait(step.tab.kind === "terminal" ? 260 : 90);
        if (cancelled) return;
        restoreStepRef.current?.(
          i + 1,
          steps.length,
          steps[i + 1]?.label ?? "Ready",
        );
      }
      if (restore.terminalGroups) {
        const restoredGroups = remapTerminalGroups(
          restore.terminalGroups,
          restoredTerminalIds,
        );
        terminalGroupsRef.current = restoredGroups;
        setTerminalGroups(restoredGroups);
      }
      const front = restoredFront(ids, restore.activeIndex);
      if (front) setActiveTabId(front);
      restoredRef.current?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [restore, restoreTab]);

  // Deliver a message (a workspace review, today) to the agent that owns a
  // session: typed into its live PTY when it has one, else the session is
  // resumed and the text delivered once it reports back. Best-effort — returns
  // whether it landed plus a line to show the user. The two-write (text, then a
  // beat, then Enter) is the same pattern the agent seeder uses so the TUI has
  // settled the paste before it submits.
  const messageAgent = useCallback(
    async (opts: {
      ptyId?: number | null;
      sessionId?: string;
      agentId?: string;
      cwd: string;
      text: string;
    }): Promise<{ delivered: boolean; note: string; ptyId?: number }> => {
      const { sessionId, cwd, text } = opts;
      const agentId = opts.agentId ?? "agent";
      const alive = (pty: number | null | undefined): pty is number =>
        pty != null && statsRef.current.some((s) => s.id === pty);
      const typeInto = (pty: number) => {
        void ipc.ptyWrite(pty, text);
        window.setTimeout(() => void ipc.ptyWrite(pty, "\r"), 350);
      };
      const livePtyForSession = () =>
        [...liveSessionByPtyRef.current.entries()].find(
          ([p, sid]) => sid === sessionId && alive(p),
        )?.[0];
      // 1) The workspace's own terminal, if it's still live.
      if (alive(opts.ptyId)) {
        typeInto(opts.ptyId);
        return {
          delivered: true,
          note: `Sent to ${agentId}.`,
          ptyId: opts.ptyId,
        };
      }
      // 2) Any live terminal running this session (it may have moved tabs).
      const moved = sessionId ? livePtyForSession() : undefined;
      if (moved != null) {
        typeInto(moved);
        return { delivered: true, note: `Sent to ${agentId}.`, ptyId: moved };
      }
      // 3) Ended: resume, wait for the session to report a PTY, then deliver.
      if (!sessionId) {
        return {
          delivered: false,
          note: "No live agent to receive the comments — open its terminal first.",
        };
      }
      const cmd = restoreCommand(agentId, sessionId);
      if (!cmd) {
        return {
          delivered: false,
          note: `${agentId} can't be resumed to receive the comments.`,
        };
      }
      // Where the conversation is filed, not the directory the caller happens
      // to be showing it in. The two are the same only until the session moves
      // — a worktree, a cd — and callers hand over whichever they hold: a
      // workspace tab's cwd, a provenance edge's. Asked for at the moment of
      // resuming rather than read off a poll, because this is one IPC call on a
      // rare click and the alternative is opening the wrong directory whenever
      // the poll is idle.
      const digest = (
        await ipc.sessionDigests(digestRootsRef.current).catch(() => [])
      ).find((d) => d.session_id === sessionId);
      // `restoreCommand` only says the CLI can reopen by id; `resumable` is the
      // backend's verdict on whether this particular transcript can still be
      // reached (agents.rs resume_location) — false when the directory it is
      // filed under is gone, a deleted worktree being the everyday case. Spawn
      // anyway and the pty falls back to ~, the resume answers "No conversation
      // found", and that run's hooks write the home directory onto the digest,
      // so every later attempt starts from ~ too. The restorable list drops such
      // rows for the same reason (restorable.ts).
      if (digest?.resumable === false) {
        return {
          delivered: false,
          note: `${agentId} can't be resumed — its directory is gone, so there's nothing to resume.`,
        };
      }
      const runIn = resumeCwd(digest, cwd);
      addTerminal(
        runIn,
        cmd,
        agentId,
        AGENT_CLIS.find((c) => c.id === agentId)?.icon,
      );
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const back = livePtyForSession();
        if (back != null) {
          // A moment past first paint before pasting into the resumed TUI.
          await new Promise((r) => setTimeout(r, 800));
          typeInto(back);
          return {
            delivered: true,
            note: `Resumed ${agentId} and sent the comments.`,
            ptyId: back,
          };
        }
      }
      return {
        delivered: false,
        note: "Resumed the session, but it didn't come back in time — your comments are still saved.",
      };
    },
    [addTerminal],
  );

  /** Send a change request about a PR back to the session that raised it.
   *
   *  The point of the whole provenance track: before this, "amend this PR"
   *  meant starting a fresh agent in a fresh worktree that had to rediscover
   *  everything the first one already knew. `to` comes from agentForPr.ts —
   *  the same resolver the companion uses, so both agree on who owns a PR.
   *
   *  A cold PR still gets an agent; it just gets one that is told what it is
   *  picking up, rather than one that is pretending to be the original. */
  const sendToRaiser = useCallback(
    async (
      repo: string,
      pr: ipc.PrInfo,
      to: PrAgent,
      text: string,
    ): Promise<{ delivered: boolean; note: string }> => {
      const brief =
        `About pull request #${pr.number} "${pr.title}" (${pr.url}), which you opened from ` +
        `${pr.branch}: ${text}\n\nWhen the change is made, push so the PR updates.`;
      if (to.kind === "cold" || !to.sessionId) {
        const started = await startMicroTask(
          addressPrCommentsTask,
          { repo, pr },
          text,
        );
        const note = started
          ? `No conversation left to reopen — started a fresh agent on #${pr.number}.`
          : `Couldn't start an agent for #${pr.number}.`;
        onNotice(note);
        return { delivered: started, note };
      }
      const { delivered, note } = await messageAgent({
        ptyId: to.ptyId,
        sessionId: to.sessionId,
        agentId: to.agent ?? undefined,
        cwd: to.cwd ?? "",
        text: brief,
      });
      onNotice(note);
      return { delivered, note };
    },
    [messageAgent, onNotice, startMicroTask],
  );

  /** The same, entered by PR number or url rather than from the PR's own tab —
   *  which is how the companion asks (`canopy_message_agent({pr})`). */
  const routeToRaiser = useCallback(
    async (pr: string, text: string): Promise<{ delivered: boolean; note: string }> => {
      const number = Number(parsePrUrl(pr)?.number ?? pr.replace(/^#/, ""));
      if (!Number.isSafeInteger(number) || number <= 0) {
        const note = `"${pr}" isn't a pull request I can look up.`;
        onNotice(note);
        return { delivered: false, note };
      }
      // Through the watcher's rows, so a number alone resolves to the repo it
      // belongs to — the companion names a PR, not a checkout.
      const row = prWatchSnapshot().rows.find(
        (r) =>
          r.number === number &&
          rootsRef.current.some(
            (x) => x === r.repo || x.startsWith(`${r.repo}/`),
          ),
      );
      if (!row) {
        const note = `No open PR #${number} in this project.`;
        onNotice(note);
        return { delivered: false, note };
      }
      const edges = await ipc.provenanceForPr(row.repo, number).catch(() => []);
      const dirs = await Promise.all(
        edges.map((e) => ipc.fsStat(e.cwd).then(() => e.cwd, () => null)),
      );
      const alive = new Set(dirs.filter(Boolean) as string[]);
      const to = resolveAgentForPr(edges, {
        live: liveSessionsRef.current,
        dirExists: (dir) => alive.has(dir),
      });
      return sendToRaiser(row.repo, toPrInfo(row), to, text);
    },
    [onNotice, sendToRaiser],
  );
  const runningAgents = useMemo(
    () =>
      projectStats.flatMap((s) => {
        const agent = identifyAgent(s.agent_hint);
        return agent ? [{ name: agent.label, cpu: s.total_cpu }] : [];
      }),
    [projectStats],
  );
  const changedPaths = useMemo(
    () => new Set(changeGroups.flatMap((g) => g.files.map((f) => f.abs))),
    [changeGroups],
  );
  const changeCount = changeGroups.reduce((n, g) => n + g.files.length, 0);
  // Files teammates are editing live in a project we're sharing — no git
  // presence until saved, scoped to this project's roots.
  const collabChanges = useMemo(
    () =>
      relay.collab
        .ownerChanges()
        .filter((c) =>
          rootsRef.current.some(
            (r) => c.path === r || c.path.startsWith(r + "/"),
          ),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay.collabTick, rootsKey],
  );
  const collabEditedCount = collabChanges.filter((c) => c.edited).length;
  const collabPaths = useMemo(
    () => new Set(collabChanges.filter((c) => c.edited).map((c) => c.path)),
    [collabChanges],
  );
  const teamBadge =
    relay.inbox.length + Object.values(relay.unread).reduce((a, b) => a + b, 0);
  const sectionOpen = (path: string) => openSections[path] ?? true;
  const pending = useMemo(
    () =>
      pendingForRoots(derivePending(projectEvents), roots).filter(
        (i) => !dismissedPending.has(i.key),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectEvents, rootsKey, dismissedPending],
  );
  // Blocked-on-you items drive the urgent styling; completions are quiet.
  //
  // Read off the attention channel rather than counted here from the hook
  // stream a second time. The rail badge, this project's tab pill and the bell
  // in the title bar are three views of one number, and while each derived its
  // own they could disagree — and did, because only this one could see an
  // agent, while a micro-task that stopped to ask was invisible to all three.
  // `roots` is the same set the channel attributes a project by, so nothing
  // that used to be counted here stops being counted.
  const urgentCount = useAttention(
    useCallback(
      (items) =>
        items.filter((x) => x.projectId === project.id && isOutstanding(x))
          .length,
      [project.id],
    ),
  );

  // Stable ActivityRail handlers. Identity only changes with pinned/sideTab
  // (a user action), not on every render — so the memoized rail stays put while
  // terminals stream, agents tick, and stats update.
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const resizing = useRef(false);

  const cancelPeekClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const schedulePeekClose = useCallback(
    (delay = PEEK_CLOSE_MS) => {
      cancelPeekClose();
      // Not while a width drag is in flight: the pointer routinely leaves the
      // panel mid-drag, and retracting it out from under the grip is maddening.
      if (resizing.current) return;
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setPeeking(false);
      }, delay);
    },
    [cancelPeekClose],
  );
  const cancelPeekOpen = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  // One way to close the panel, shared by everything that closes it: a press
  // in the page, a press outside it, and opening a preview it would cover.
  // Assigned on every render so it always closes over current state.
  dismissPeekRef.current = () => {
    cancelPeekOpen();
    cancelPeekClose();
    setPeeking(false);
    setPinned(false);
  };
  /** Escape puts the overlay panel away — the keyboard's answer to the click
   *  outside that already dismisses it. Only in overlay mode: a docked panel
   *  covers nothing, so there is nothing to get out from under, and Escape is
   *  worth more to the terminal it would otherwise be taken from. */
  const escapeSidePanel = useCallback(() => dismissPeekRef.current(), []);
  useEscapeBackstop(escapeSidePanel, sidePrefs.overlay && sideOpen);
  useEffect(
    () => () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  /** Hover-intent, not hover. A panel is only committed once the pointer has
   *  settled on an icon — otherwise sweeping the rail on the way to Settings
   *  would mount every panel behind it, and the trackers panel mounting means
   *  a round trip to GitHub/Jira for a tab you never meant to open.
   *
   *  A pinned panel ignores hover entirely. Pinning says "keep THIS one out",
   *  and a pointer drifting over the rail on its way somewhere else has no
   *  business swapping it — a peek is transient, a pin is a choice. */
  const hoverSideTab = useCallback(
    (tab: SideTab) => {
      // Off by default (Appearance → "Hover to view"): a panel that comes out
      // because you passed an icon on your way somewhere else is a panel you
      // didn't ask for. With it off the rail opens on click only.
      if (pinned || !sidePrefs.hover) return;
      cancelPeekClose();
      cancelPeekOpen();
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        setSideTab(tab);
        setPeeking(true);
      }, HOVER_INTENT_MS);
    },
    [cancelPeekClose, cancelPeekOpen, pinned, sidePrefs.hover],
  );
  const leaveSideHover = useCallback(
    (prompt?: boolean) => {
      cancelPeekOpen();
      schedulePeekClose(prompt ? PEEK_LEAVE_MS : PEEK_CLOSE_MS);
    },
    [cancelPeekOpen, schedulePeekClose],
  );

  /** A click anywhere else dismisses the panel on the spot — pinned included.
   *  The panel covers the editor, so a click past it is someone reaching for
   *  what's underneath; leaving it up to be clicked through twice is the one
   *  thing an overlay must not do. The grace period is for a wandering pointer,
   *  and a click says the pointer has arrived somewhere on purpose.
   *
   *  Clicks inside the panel or on the rail are exempt — the panel's own
   *  context menus and dialogs are descendants of it, so they are covered too.
   *  On pointerdown, not click: waiting for mouseup leaves the panel sitting
   *  over whatever you are in the middle of pressing. */
  useEffect(() => {
    // Appearance → "Click outside to close". On by default, and off is a real
    // choice once the panel is docked: a pane that isn't covering anything has
    // no reason to close because you clicked in the editor.
    if (!sideOpen || !sidePrefs.clickOutsideCloses) return;
    const dismiss = dismissPeekRef.current;
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (
        target instanceof Element &&
        // The docked grip is a sibling of the panel, not a child of it, so it
        // has to be named here too — pressing it is the start of a resize, not
        // a click past the panel.
        target.closest(".side-peek, .side-dock, .side-dock-grip, .rail")
      )
        return;
      dismiss();
    };
    window.addEventListener("pointerdown", onDown, true);
    // The in-app browser is a hole in that listener: its page is a native view
    // over the window under one engine and a cross-origin frame under the
    // other, so a press in it produces no pointerdown here at all and the
    // panel would sit over the page while you clicked it. PreviewView forwards
    // the press back out; it can only have come from the page, which is never
    // the panel, so there is nothing left to test.
    window.addEventListener(BROWSER_INPUT_EVENT, dismiss);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener(BROWSER_INPUT_EVENT, dismiss);
    };
  }, [sideOpen, cancelPeekOpen, cancelPeekClose, sidePrefs.clickOutsideCloses]);

  // Click is the latch: it pins the panel open so it survives the pointer
  // leaving. Clicking the pinned tab again puts it away.
  const selectSideTab = useCallback(
    (tab: SideTab) => {
      cancelPeekOpen();
      cancelPeekClose();
      if (pinned && sideTab === tab) {
        setPinned(false);
        setPeeking(false);
      } else {
        setSideTab(tab);
        setPinned(true);
      }
    },
    [cancelPeekClose, cancelPeekOpen, pinned, sideTab],
  );
  const openSettings = useCallback(
    () => window.dispatchEvent(new CustomEvent("canopy:open-settings")),
    [],
  );
  const toggleSidebar = useCallback(() => {
    cancelPeekOpen();
    cancelPeekClose();
    setPinned((v) => !v);
    setPeeking(false);
  }, [cancelPeekClose, cancelPeekOpen]);

  /** The one place the panel's width is written. Neither mode is in the
   *  PanelGroup any more — the overlay is out of flow and the dock is a
   *  fixed-width column — so the width is plain pixels in both. */
  const applySideWidth = useCallback((w: number) => {
    const next = Math.max(SIDE_MIN_W, Math.min(SIDE_MAX_W, Math.round(w)));
    sideWidthRef.current = next;
    setSideWidth(next);
  }, []);

  /** Drag the panel's right edge, in either mode. */
  const startSideResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sideWidthRef.current;
      const grip = e.currentTarget;
      // Docked, the drag is over the editor from its first pixel — without the
      // capture the gesture is lost to whatever the pointer lands on.
      grip.setPointerCapture?.(e.pointerId);
      resizing.current = true;
      document.body.classList.add("resizing-side");
      let frame = 0;
      let pending = startW;
      const move = (ev: PointerEvent) => {
        pending = startW + ev.clientX - startX;
        // Coalesced to one write per frame: docked, every width change reflows
        // the main area, and that re-wraps every terminal in it. A pointermove
        // stream is faster than the frames it would be drawn on.
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          applySideWidth(pending);
        });
      };
      const up = () => {
        resizing.current = false;
        document.body.classList.remove("resizing-side");
        if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
        applySideWidth(pending);
        if (grip.hasPointerCapture?.(e.pointerId))
          grip.releasePointerCapture(e.pointerId);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [applySideWidth],
  );

  /** The separator is focusable, so it answers the arrow keys too — a width
   *  that can only be set by dragging an 8px strip is one a keyboard can't
   *  reach at all. */
  const onSideResizeKey = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 48 : 16;
      if (e.key === "ArrowLeft") applySideWidth(sideWidthRef.current - step);
      else if (e.key === "ArrowRight")
        applySideWidth(sideWidthRef.current + step);
      else if (e.key === "Home") applySideWidth(SIDE_MIN_W);
      else if (e.key === "End") applySideWidth(SIDE_MAX_W);
      else return;
      e.preventDefault();
    },
    [applySideWidth],
  );

  // Jump to the terminal running the agent that raised the item: prefer a
  // terminal whose PTY tree contains an agent process, then match by cwd.
  /** Focus the tab a given pty is running in, and flash it so the eye lands
   *  on which of several near-identical tabs just became active. */
  const jumpToPty = useCallback(
    (ptyId: number) => {
      const target = tabsRef.current.find(
        (t): t is TermSubTab => t.type === "terminal" && t.ptyId === ptyId,
      );
      // A detached micro-task has no tab to jump to — open one onto it, so a
      // row in the Agents panel is never a click that does nothing.
      if (!target) {
        if (findRun(microRunsRef.current, ptyId)) showMicroRun(ptyId);
        else {
          const running = statsRef.current.find((stat) => stat.id === ptyId);
          if (running) {
            const agent = identifyAgent(running.agent_hint);
            const icon = AGENT_CLIS.find((cli) => cli.id === agent?.id)?.icon;
            const id = attachTerminal(
              ptyId,
              running.cwd,
              running.title || agent?.label || "agent",
              icon ?? "📱",
              true,
              true,
            );
            if (agent?.id) patchTabRaw(id, { command: shellBin(agent.id) });
          }
        }
        return;
      }
      setActiveTabId(target.id);
      setFlashTabId(target.id);
      window.setTimeout(
        () => setFlashTabId((c) => (c === target.id ? null : c)),
        1200,
      );
      setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
    },
    [showMicroRun, attachTerminal, patchTabRaw],
  );

  /** The terminal a pending card came from, as a pty and (when there is one) the
   *  tab showing it. Order matters: the event's own pty stamp is an identity,
   *  and a detached micro-task's pty has to be checked against it *before* any
   *  cwd guessing — otherwise a permission prompt raised by a task with no tab
   *  falls through to "some terminal in the same directory", and the keystroke
   *  that answers it lands in another agent's session. */
  const pendingTerminal = useCallback(
    (item: PendingItem): { ptyId: number; tabId?: string } | null => {
      const termTabs = tabsRef.current.filter(
        (t): t is TermSubTab => t.type === "terminal",
      );
      const byPty = termTabs.find(
        (t) => t.ptyId != null && t.ptyId === item.pty,
      );
      if (byPty?.ptyId != null) return { ptyId: byPty.ptyId, tabId: byPty.id };
      const detached = findRun(microRunsRef.current, item.pty);
      if (detached) return { ptyId: detached.ptyId };
      const byCwd = termTabs.find(
        (t) => item.cwd === t.cwd || item.cwd.startsWith(t.cwd + "/"),
      );
      return byCwd?.ptyId != null
        ? { ptyId: byCwd.ptyId, tabId: byCwd.id }
        : null;
    },
    [],
  );

  /** Put the terminal a card came from in front — opening one onto a detached
   *  run if that is where it came from. */
  const revealPending = useCallback(
    (found: { ptyId: number; tabId?: string }) => {
      if (!found.tabId) {
        showMicroRun(found.ptyId);
        return;
      }
      const tabId = found.tabId;
      setActiveTabId(tabId);
      setTimeout(() => termHandles.current.get(tabId)?.focus(), 50);
    },
    [showMicroRun],
  );

  const jumpToTerminal = useCallback(
    (item: PendingItem) => {
      const found = pendingTerminal(item);
      if (found) {
        revealPending(found);
        return;
      }
      // Nothing matched by pty, by run, or by directory: fall back to an agent
      // terminal in this project, which is where an unstamped event (a CLI whose
      // hooks can't carry the pty) most likely came from.
      const termTabs = tabsRef.current.filter(
        (t): t is TermSubTab => t.type === "terminal",
      );
      const agentPtyIds = new Set(
        stats.filter((s) => identifyAgent(s.agent_hint)).map((s) => s.id),
      );
      const target =
        termTabs.find((t) => t.ptyId != null && agentPtyIds.has(t.ptyId)) ??
        termTabs[0];
      if (target) {
        setActiveTabId(target.id);
        setTimeout(() => termHandles.current.get(target.id)?.focus(), 50);
      }
    },
    [stats, pendingTerminal, revealPending],
  );

  // Answer a questionnaire straight from the panel by synthesising the
  // keystrokes the user would type into the agent's terminal. Claude's ask UI
  // selects an option by its digit and confirms with Enter; a multi-question
  // form advances to the next question on each Enter and ends on a Submit tab
  // the final Enter presses; a multi-select question toggles each chosen digit
  // before its confirming Enter. `selections[q]` is the option index(es) picked
  // for question q — one for single-select, zero-or-more for multi-select.
  //
  // Keystrokes are spaced out: the TUI needs a beat to register a key and
  // repaint before the next lands. The card dismisses immediately — the hook
  // stream resolves it for real once the tool call completes, and the terminal
  // is right there if a key mis-lands (best-effort, by design).
  const answerQuestions = useCallback(
    (item: PendingItem, selections: number[][]) => {
      const found = pendingTerminal(item);
      if (!found) {
        onNotice(
          "Can't find the terminal this question came from — answer there.",
        );
        return;
      }
      // Only a single-page form is answered here. Multi-question forms need
      // page-to-page navigation the synthesised keystrokes can't keep in sync
      // (the CLI records "declined"), so the panel routes those to the terminal
      // and never calls this — the guard just makes that invariant explicit.
      if ((item.questions?.length ?? 0) > 1) {
        revealPending(found);
        return;
      }
      const ptyId = found.ptyId;
      let delay = 0;
      const press = (keys: string) => {
        const at = delay;
        setTimeout(() => void ipc.ptyWrite(ptyId, keys), at);
        delay += 150;
      };
      for (const chosen of selections) {
        for (const oi of chosen) press(String(oi + 1)); // highlight/toggle option(s)
        press("\r"); // confirm the single-page answer
      }
      onDismissPending(item.key);
      revealPending(found);
    },
    [onNotice, onDismissPending, pendingTerminal, revealPending],
  );

  // Respond to a permission prompt straight from the panel by synthesising the
  // keystroke the user would type: Allow presses the accept option (first in
  // claude/codex's numbered prompt), Deny sends Escape — which cancels the tool
  // in both and can never miscount into a "yes, don't ask again". Same PTY-write
  // path as answerQuestion, so it inherits the same terminal-focus behaviour.
  const respondPermission = useCallback(
    (item: PendingItem, decision: "approve" | "deny") => {
      const found = pendingTerminal(item);
      if (!found) {
        onNotice(
          "Can't find the terminal this prompt came from — answer there.",
        );
        return;
      }
      const ptyId = found.ptyId;
      if (decision === "approve") {
        void ipc.ptyWrite(ptyId, "1");
        setTimeout(() => void ipc.ptyWrite(ptyId, "\r"), 150);
      } else {
        void ipc.ptyWrite(ptyId, "\x1b");
      }
      onDismissPending(item.key);
      revealPending(found);
    },
    [onNotice, onDismissPending, pendingTerminal, revealPending],
  );

  // Looking at the terminal clears its *calm* cards — a "finished" notice has
  // done its job once your eye is on the tab. But an urgent card (a question,
  // a permission prompt) is the agent BLOCKED on you: focusing the terminal is
  // not answering it, and clearing it there is exactly how a question vanishes
  // from the panel the moment you glance at the tab it's in — the bug where a
  // visible prompt never shows in "Needs your input". Those stay until they
  // self-resolve: the answer produces a later hook event, which clears the
  // card in derivePending. Manual ✕ is always available in the meantime.
  useEffect(() => {
    if (!visible || !activeTabId) return;
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (tab?.type !== "terminal" || tab.ptyId == null) return;
    for (const item of pending) {
      if (item.kind === "idle" && item.pty != null && item.pty === tab.ptyId) {
        onDismissPending(item.key);
      }
    }
  }, [activeTabId, visible, pending, onDismissPending]);

  // The session the tray's model control acts on: the terminal you are looking
  // at, when it runs a CLI whose model Canopy knows how to change; otherwise
  // the first such terminal in the project, for the tabs that are not terminals
  // at all. One derivation feeds both the chip and the click, so the menu can
  // never describe one session while the keystrokes go to another — which is
  // what happened while the two were worked out separately, and every `/model`
  // landed in the leftmost Claude tab.
  //
  // Claude ships no way to list its own models, so its menu starts as the
  // checked-in seed and is refined once per session from a donor CLI's
  // catalogue if the user has one (see modelCatalog.ts). Probed lazily — the
  // first time a Claude session is actually in front — so a project with no
  // Claude tab never shells out at all, and never more than once either way.
  const [claudeModels, setClaudeModels] = useState<ModelChoice[] | null>(null);
  const claudeProbed = useRef(false);
  useEffect(() => {
    if (claudeProbed.current) return;
    const hasClaude = tabs.some((t) => {
      if (t.type !== "terminal" || t.ptyId == null) return false;
      const s = projectStats.find((x) => x.id === t.ptyId);
      return (s ? identifyAgent(s.agent_hint)?.id : null) === "claude";
    });
    if (!hasClaude) return;
    claudeProbed.current = true;
    void refreshChoices("anthropic", ipc.modelCatalog).then(setClaudeModels);
  }, [tabs, projectStats]);

  const modelTarget = useMemo(() => {
    const agentOf = (t: TermSubTab) => {
      if (t.ptyId == null) return null;
      const s = projectStats.find((x) => x.id === t.ptyId);
      const agent = s ? (identifyAgent(s.agent_hint)?.id ?? null) : null;
      let sw = modelSwitchFor(agent);
      // The donor's answer replaces the seed only when one arrived; a failed
      // probe leaves the menu exactly as it was rather than emptying it.
      if (agent === "claude" && claudeModels && sw?.kind === "inline") {
        sw = { ...sw, choices: claudeModels };
      }
      if (!agent || !sw) return null;
      // A bare binary Canopy ships no entry for (gemini) has no registry name
      // to borrow, so it is named by the id — which is its command anyway.
      const label = AGENT_CLIS.find((c) => c.id === agent)?.name ?? agent;
      return { tabId: t.id, ptyId: t.ptyId, agent, label, sw };
    };
    const termTabs = tabs.filter((t): t is TermSubTab => t.type === "terminal");
    const active = termTabs.find((t) => t.id === activeTabId);
    if (active) return agentOf(active);
    for (const t of termTabs) {
      const hit = agentOf(t);
      if (hit) return hit;
    }
    return null;
  }, [tabs, activeTabId, projectStats, claudeModels]);
  const modelTargetRef = useRef(modelTarget);
  modelTargetRef.current = modelTarget;

  // Which CLI the front terminal is running, resolved independently of
  // modelTarget: that one is null for any CLI Canopy can't switch models on
  // (Codex among them), and the plan chip has to work there too.
  // The CLI *and* the account, resolved together off the same terminal. Read
  // separately they drift: this falls back to the first terminal when the front
  // tab isn't one, so taking the id from here and the account from the active
  // tab would pair one session's CLI with another session's login — and the
  // plan chip would report headroom belonging to neither.
  const activeAgent = useMemo(() => {
    const termTabs = tabs.filter((t): t is TermSubTab => t.type === "terminal");
    const active = termTabs.find((t) => t.id === activeTabId) ?? termTabs[0];
    if (!active || active.ptyId == null) return { id: null, profile: null };
    const s = projectStats.find((x) => x.id === active.ptyId);
    return {
      id: s ? (identifyAgent(s.agent_hint)?.id ?? null) : null,
      profile: active.profile ?? null,
    };
  }, [tabs, activeTabId, projectStats]);
  const activeAgentId = activeAgent.id;

  // Change that session's model by typing the CLI's own command into its
  // terminal — the same thing the user would type, so the CLI's confirmations,
  // pickers and context-size warnings appear right there. The terminal is
  // focused afterwards so they are actually seen.
  const setAgentModel = useCallback(
    (model?: string) => {
      const target = modelTargetRef.current;
      if (!target) {
        onNotice("No agent session here to switch.");
        return;
      }
      const { ptyId, tabId, sw } = target;
      void ipc.ptyWrite(ptyId, modelCommandLine(sw, model));
      // Enter goes separately, a beat later: the slash-command menu opens while
      // the text streams in, and an Enter in the same write can select the
      // menu's highlighted entry instead of submitting the typed command.
      setTimeout(() => void ipc.ptyWrite(ptyId, "\r"), 250);
      setActiveTabId(tabId);
      setTimeout(() => termHandles.current.get(tabId)?.focus(), 50);
    },
    [onNotice],
  );

  // Launch an agent CLI in the project's first component — or, if it isn't on
  // PATH, run its install command in a terminal and re-probe afterwards.
  /** Launch an agent CLI. `at` defaults to the first component; right-clicking a
   *  component header passes that component's path so it starts in the right
   *  directory rather than wherever the ＋ menu would have put it. */
  const launchCli = useCallback(
    async (cli: AgentCli, at?: string) => {
      const cwd = at ?? componentsRef.current[0]?.path;
      if (!cwd) return;
      if (installed[cli.bin]) {
        // Before the terminal opens: the CLI reads the config-dir variable at
        // startup, so exporting it afterwards is too late.
        const profile = activeProfile();
        const env = await launchEnv(cli.id);
        const terminal = {
          command: launchCommand(cli),
          title: cli.name,
          icon: cli.icon,
          env,
          profile: env.length ? profile : undefined,
        };
        if (pendingSplitRef.current) completePendingSplit(terminal);
        else
          addTerminal(
            cwd,
            terminal.command,
            terminal.title,
            terminal.icon,
            false,
            terminal.env,
            terminal.profile,
          );
      } else if (cli.rebound || !cli.install) {
        pendingSplitRef.current = null;
        setPendingSplit(null);
        // Two cases, one answer: an override points somewhere the vendor's
        // installer can never satisfy, and a custom entry has no installer at all
        // — so an "install" offer would repeat forever, which is the loop these
        // settings exist to end. Send them to the setting that is actually wrong.
        onNotice(
          `${cli.name} is set to \`${cli.bin}\`, which isn't on this machine — check Settings → Agents.`,
        );
      } else {
        pendingSplitRef.current = null;
        setPendingSplit(null);
        // A run tab, so the installer exits when done — and that exit is the
        // signal to re-probe (see onExited below). No timers, no staleness.
        addTerminal(cwd, cli.install, `install ${cli.name}`, "⬇", "chore");
      }
    },
    [installed, addTerminal, completePendingSplit, onNotice],
  );

  /** Run `cli`'s updater in a run tab. Its exit re-probes versions (see
   *  onExited), so the badge clears the moment the update lands — no timers. */
  const runCliUpdate = useCallback(
    (cli: AgentCli, at?: string) => {
      const cwd = at ?? componentsRef.current[0]?.path;
      if (!cwd) return;
      // Route to the command matched to the install source (e.g. `brew upgrade`);
      // fall back to the CLI's own updater when the source is a plain registry.
      const cmd = cliUpdates[cli.bin]?.updateCmd ?? updateCommand(cli);
      // Nothing to run: an entry with neither an updater nor an installer (a
      // custom CLI) never badges an update in the first place, so this is the
      // belt to that brace rather than a state a user can reach.
      if (!cmd) return;
      addTerminal(cwd, cmd, `update ${cli.name}`, "⬆", "chore");
    },
    [cliUpdates, addTerminal],
  );

  /** The launcher list — shell plus every agent CLI — for a given directory.
   *  Shared by the ＋ menu, the empty-state grid and the component right-click
   *  menu so the three can't drift apart. */
  const launcherItems = (cwd: string): MenuItem[] => [
    {
      label: "Shell",
      icon: <TerminalIcon size={15} />,
      onClick: () => addTerminal(cwd),
    },
    { label: "", separator: true },
    ...AGENT_CLIS.map((cli) => ({
      label: cli.name,
      icon: <AgentIcon id={cli.id} size={15} />,
      // Informational: a context-menu row has one click target, and the ＋
      // menu carries the clickable badge. The account is the status bar's job.
      hint: installed[cli.bin]
        ? cliUpdates[cli.bin]?.hasUpdate
          ? `⇡ ${cliUpdates[cli.bin]?.latest}`
          : undefined
        : "install",
      onClick: () => void launchCli(cli, cwd),
    })),
  ];

  const compMenu = useContextMenu();
  const tabMenu = useContextMenu();
  const termMenu = useContextMenu();
  /** Prefill for the Tasks panel's composer — set when the user makes a task
   *  out of something they're looking at (selected terminal text, a file in the
   *  tree, a tab). `mode` picks which composer opens: the full create form, or
   *  the one-off box that runs the brief and saves nothing. The nonce re-opens
   *  it even for the same seed twice. */
  const [taskSeed, setTaskSeed] = useState<{
    brief: string;
    mode: "save" | "once";
    nonce: number;
  } | null>(null);
  const openTaskComposer = useCallback(
    (brief: string, mode: "save" | "once") => {
      setPinned(true);
      setSideTab("tasks");
      setTaskSeed((prev) => ({ brief, mode, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [],
  );
  const seedTaskFrom = useCallback(
    (brief: string) => openTaskComposer(brief, "save"),
    [openTaskComposer],
  );
  /** The "Tasks ▸" submenu for a right-clicked row, wherever it lives: write a
   *  new task about it, run a one-off about it, then the two groups of tasks.
   *  The surfaces stay ignorant of the task registry — they ask for the item
   *  and splice it into their menu. */
  const firstRoot = roots[0] ?? "";
  /** The same rows as `taskMenu`, without the "Tasks ▸" hop — for a control
   *  that is already the task menu. */
  const taskRows = useCallback(
    (seed: string, dir: string, runnable?: TaskChoice[], query = "") =>
      taskMenuItems({
        seed,
        runnable,
        saved: project.customTasks ?? [],
        onNewTask: seedTaskFrom,
        onOneOff: (brief) => openTaskComposer(brief, "once"),
        // In the directory the surface is about, not the first root: the bar
        // sits on one repo's changes and that is where its tasks belong.
        // `query` is what a saved task is told about this particular item —
        // empty for a surface whose seed is only a prefix ("About the changes
        // in `x`: "), the whole brief for one that already has the full story.
        onRunSaved: (t) => void startMicroTask(customTaskDef(t), { dir }, query),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seedTaskFrom, openTaskComposer, startMicroTask, project.customTasks],
  );

  const taskMenu = useCallback(
    (seed: string, runnable?: TaskChoice[]) =>
      taskMenuItem({
        seed,
        runnable,
        saved: project.customTasks ?? [],
        onNewTask: seedTaskFrom,
        onOneOff: (brief) => openTaskComposer(brief, "once"),
        onRunSaved: (t) =>
          void startMicroTask(customTaskDef(t), { dir: firstRoot }, ""),
      }),
    [
      seedTaskFrom,
      openTaskComposer,
      startMicroTask,
      firstRoot,
      project.customTasks,
    ],
  );

  const submitRootCreate = async () => {
    if (!rootCreate) return;
    const name = rootCreate.value.trim();
    const { dir, kind } = rootCreate;
    setRootCreate(null);
    if (!name || name.includes("/")) return;
    const target = `${dir}/${name}`;
    try {
      if (kind === "file") {
        await ipc.fsCreateFile(target);
        void openFile(target);
      } else {
        await ipc.fsCreateDir(target);
      }
    } catch (e) {
      onNotice(String(e), "error");
    }
  };

  const startRename = useCallback((tab: TermSubTab) => {
    setRenamingTabId(tab.id);
    setRenameDraft(tab.customTitle ?? tab.title);
  }, []);
  // Empty draft clears the custom name and falls back to the auto title.
  const commitRename = useCallback(() => {
    if (renamingTabId)
      patchTab(renamingTabId, { customTitle: renameDraft.trim() || undefined });
    setRenamingTabId(null);
  }, [renamingTabId, renameDraft, patchTab]);
  const cancelRename = useCallback(() => setRenamingTabId(null), []);

  // Agents are the crux of this IDE, so they own the main strip. Detection is
  // by launch command OR by what's actually running in the pty tree, so a
  // `claude` typed by hand into a shell promotes that tab too. Plain shells and
  // long-running commands are demoted to their own right-hand rails (below);
  // reference docs (files, PRs, tickets) form a quieter group after the agents.
  // Detection uses the agentIdentity module (agent_hint from stats, command
  // for launched tabs). Content-keyed: `stats` re-samples every ~4s, but this
  // set only earns a new identity when the set of agent-bearing ptys actually
  // changes — so the memoized PaneBar isn't repainted by a sample that changed
  // nothing.
  const agentPtyList = projectStats
    .filter((s) => identifyAgent(s.agent_hint))
    .map((s) => s.id);
  const agentPtyKey = agentPtyList
    .slice()
    .sort((a, b) => a - b)
    .join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const agentPtyIds = useMemo(() => new Set(agentPtyList), [agentPtyKey]);
  const isAgentTab = useCallback(
    (t: SubTab): t is TermSubTab =>
      t.type === "terminal" &&
      tabs.some(
        (member) =>
          member.type === "terminal" &&
          (member.id === t.id ||
            (Boolean(t.paneGroup) && member.paneGroup === t.paneGroup)) &&
          (!!agentIdForCommand(member.command) ||
            (member.ptyId != null && agentPtyIds.has(member.ptyId))),
      ),
    [agentPtyIds, tabs],
  );
  isAgentTabRef.current = isAgentTab;
  // The one verdict for a terminal, from every channel at once: what the CLI's
  // hooks proved, whether its process is still there, whether it is painting,
  // and what its CPU is doing — ranked, in shared/agentLife.
  //
  // The map of stats by pty is content-keyed so its identity only changes when
  // a number the ladder actually reads changes; stats land every 2s for every
  // terminal in every open project, and a fresh object per tick re-renders
  // every strip in the app.
  const statsKey = projectStats
    .map((s) => `${s.id}:${Math.round(s.total_cpu)}:${s.quiet_ms ?? -1}:${s.agent_hint ? 1 : 0}`)
    .sort()
    .join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statsByPty = useMemo(
    () => new Map(projectStats.map((s) => [s.id, s])),
    [statsKey],
  );
  const firstSeen = useFirstSeen(projectStats.map((s) => s.id));
  // Re-read on every render: the memory is a ref, and `useAttentionMemory`
  // bumps a counter when it changes, so this is always current.
  const attention = attentionMemory.current;
  // The same memory as a per-pty lookup for the agent surfaces (panel and
  // page), which live too far down to read the ref themselves. Keyed on the
  // version, not the map: the map is mutated in place, so its identity can
  // never invalidate a consumer's memo — the version is what says an
  // attention-only change happened.
  const attentionFor = useCallback(
    (ptyId: number): Attention => attentionMemory.current.get(ptyId) ?? NO_ATTENTION,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attentionVersion],
  );
  const lifeForPty = useCallback(
    (ptyId: number | null | undefined): Life => {
      const stats = ptyId != null ? statsByPty.get(ptyId) : undefined;
      const sid = ptyId != null ? liveSessionByPty.get(ptyId) : undefined;
      const digest = sid
        ? wsDigests.find((d) => d.session_id === sid)
        : undefined;
      return lifeFor({
        digest: (digest ?? null) as never,
        stats,
        firstSeen: ptyId != null ? firstSeen.get(ptyId) : undefined,
        now: lifeClock / 1000,
      });
    },
    [statsByPty, liveSessionByPty, wsDigests, firstSeen, lifeClock],
  );
  const watchdogViews = useStableViews(() => {
    const views: AgentLifeView[] = [];
    for (const tab of tabs) {
      if (tab.type !== "terminal" || tab.ptyId == null || !isAgentTab(tab)) continue;
      const life = lifeForPty(tab.ptyId);
      views.push({
        ptyId: tab.ptyId,
        sessionId: liveSessionByPty.get(tab.ptyId) ?? null,
        life,
        attention: attentionFor(tab.ptyId),
      });
    }
    return views;
  }, [attentionFor, isAgentTab, lifeForPty, liveSessionByPty, tabs]);
  const watchdogTargets = useMemo(() => {
    const targets = new Map<number, AgentWatchdogTarget>();
    const lives = new Map(watchdogViews.map((view) => [view.ptyId, view.life]));
    for (const tab of tabs) {
      if (tab.type !== "terminal" || tab.ptyId == null || !lives.has(tab.ptyId))
        continue;
      const life = lives.get(tab.ptyId)!;
      targets.set(tab.ptyId, {
        tabId: tab.id,
        label: agentDisplayName({
          tab,
          agentLabel: life.agent ?? undefined,
        }),
        path: tab.cwd,
      });
    }
    return targets;
  }, [tabs, watchdogViews]);
  useEffect(() => {
    tickAgentWatchdogAttention({
      views: watchdogViews,
      targets: watchdogTargets,
      projectId: project.id,
      projectName: project.name,
      at: lifeClock,
    });
  }, [lifeClock, project.id, project.name, watchdogTargets, watchdogViews]);
  useEffect(
    () => () => clearAgentWatchdogAttention(project.id),
    [project.id],
  );
  const tabLife = useCallback(
    (t: TermSubTab): Life => {
      const members = t.paneGroup
        ? tabs.filter(
            (member): member is TermSubTab =>
              member.type === "terminal" && member.paneGroup === t.paneGroup,
          )
        : [t];
      const lives = members.map((member) => lifeForPty(member.ptyId));
      const order: LifeState[] = [
        "waiting",
        "working",
        "starting",
        "idle",
        "unknown",
        "ended",
      ];
      return (
        order
          .map((state) => lives.find((life) => life.state === state))
          .find((life): life is Life => Boolean(life)) ?? lifeForPty(t.ptyId)
      );
    },
    [lifeForPty, tabs],
  );
  const tabState = useCallback(
    (t: TermSubTab): LifeState => tabLife(t).state,
    [tabLife],
  );
  // Everything the Tasks panel's Running list shows: the tasks running detached
  // (the usual case — no tab, this row is where they live) and the ones that
  // kept a tab because their agent can't report its own ending. Same state
  // resolution as the tab dots, so a task that does have a tab never disagrees
  // with it. Re-derived on `now` so the "· 2m" ages while you watch it.
  const runningMicro: RunningMicroTask[] = useMemo(
    () => [
      ...microRuns.map((r) => {
        // Through the ladder, exactly like the tab dots — a detached run with
        // no digest is `unknown`, never a confident "idle" (that coercion is
        // what the guard test bans: "we have no record" is not "finished").
        const state = lifeForPty(r.ptyId).state;
        return {
          ptyId: r.ptyId,
          title: r.label,
          state,
          icon: r.icon,
          note: runNote(
            r,
            state,
            lastStepFor(projectEvents, r.ptyId),
            microClock,
          ),
          blocked: Boolean(r.blocked) || state === "waiting",
          watching: Boolean(r.viewTabId),
        };
      }),
      ...tabs
        .filter(
          (t): t is TermSubTab => t.type === "terminal" && Boolean(t.micro),
        )
        .map((t) => ({
          tabId: t.id,
          title: t.customTitle || t.title,
          state: tabState(t),
          icon: t.icon,
        })),
    ],
    [
      microRuns,
      tabs,
      tabState,
      lifeForPty,
      projectEvents,
      microClock,
    ],
  );
  const stripTabs = useMemo(() => {
    const seen = new Set<string>();
    const out: SubTab[] = [];
    for (const tab of visibleTabs) {
      if (tab.type === "terminal" && tab.run) continue;
      if (tab.type !== "terminal" || !tab.paneGroup) {
        out.push(tab);
        continue;
      }
      if (seen.has(tab.paneGroup)) continue;
      seen.add(tab.paneGroup);
      const group = terminalGroups[tab.paneGroup];
      if (!group) {
        out.push(tab);
        continue;
      }
      const ids = leafIds(group.root);
      const focused =
        tabs.find(
          (member): member is TermSubTab =>
            member.type === "terminal" && member.id === group.activeTabId,
        ) ?? tab;
      out.push({
        ...tab,
        multiplexCount: ids.length,
        multiplexTitle: tab.customTitle
          ? `${tab.customTitle} · ${ids.length}`
          : `${focused.customTitle ?? focused.title} +${ids.length - 1}`,
      });
    }
    return out;
  }, [visibleTabs, tabs, terminalGroups]);
  const activeVisualTabId = useMemo(() => {
    if (activeTab?.type !== "terminal" || !activeTab.paneGroup) return activeTabId;
    return (
      stripTabs.find(
        (tab) => tab.type === "terminal" && tab.paneGroup === activeTab.paneGroup,
      )?.id ?? activeTabId
    );
  }, [activeTab, activeTabId, stripTabs]);
  const shellTabs = useMemo(
    () =>
      stripTabs.filter(
        (t): t is TermSubTab => t.type === "terminal" && !isAgentTab(t),
      ),
    [stripTabs, isAgentTab],
  );
  const agentTabs = useMemo(
    () => stripTabs.filter(isAgentTab),
    [stripTabs, isAgentTab],
  );
  const refTabs = useMemo(
    () => stripTabs.filter((t) => t.type !== "terminal"),
    [stripTabs],
  );

  // Tab-strip preferences, re-read on every settings write (updateSettings
  // announces each patch on this event) so turning grouping on regroups the
  // strip you are looking at rather than the one you get after a relaunch.
  const [tabPrefs, setTabPrefs] = useState(readTabPrefs);
  useEffect(() => {
    const onChange = () =>
      setTabPrefs((prev) => {
        const next = readTabPrefs();
        return prev.grouped === next.grouped &&
          prev.idleDelayMs === next.idleDelayMs
          ? prev
          : next;
      });
    window.addEventListener(SETTINGS_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(SETTINGS_CHANGE_EVENT, onChange);
  }, []);

  // Where each agent tab sits in the strip follows its agent: blocked-on-you
  // first, working next, quiet last — settled, so an agent pausing between tool
  // calls doesn't shuffle the strip (see tabGroups.ts). Computed for every agent
  // tab whether or not grouping is on: the state machine is cheap, and keeping
  // it running means turning the setting back on doesn't start every tab from
  // scratch in the wrong bucket.
  const { statusTargets, provenQuiet } = useMemo(() => {
    const targets = new Map<string, TabStatus>();
    // Quiet on the CLI's own say-so (turn ended, session ended) rather than
    // ours (a CPU dip). These fall on the short clock and through the
    // active-tab hold — see SettleHold in tabGroups.ts. The say-so is the
    // declaration (`via`), not the confidence grade: a needsTrust CLI like
    // codex never grades "proven", and keying on the grade left its active tab
    // unable to leave Working while its own dot said idle — see declaredQuiet.
    const provenIds = new Set<string>();
    for (const t of agentTabs) {
      const members = t.paneGroup
        ? tabs.filter(
            (member): member is TermSubTab =>
              member.type === "terminal" && member.paneGroup === t.paneGroup,
          )
        : [t];
      const verdicts = members.map((member) => {
        const life = lifeForPty(member.ptyId);
        return {
          life,
          bucket: bucketFor(
            life,
            (member.ptyId != null ? attention.get(member.ptyId) : undefined) ??
              NO_ATTENTION,
          ),
        };
      });
      const bucket: TabStatus = verdicts.some((v) => v.bucket === "attention")
        ? "attention"
        : verdicts.some((v) => v.bucket === "active")
          ? "active"
          : "quiet";
      targets.set(t.id, bucket);
      if (
        bucket === "quiet" &&
        verdicts.length > 0 &&
        verdicts.every((v) => declaredQuiet(v.life))
      )
        provenIds.add(t.id);
    }
    return { statusTargets: targets, provenQuiet: provenIds };
    // `attentionVersion`, not `attention`: the memory is mutated in place, so
    // its identity can never invalidate this memo — the version is what says
    // an attention-only change happened (a permission block arriving on the
    // fast lane with no stats tick alongside it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentTabs, tabLife, attentionVersion]);
  // …and it only ever moves when moving costs you nothing. Mid-gesture is
  // never such a moment: a tab that slides out from under a cursor already on
  // its way down is a misclick the strip caused. Pointer use and visible number
  // hints freeze the strip; everything held back lands when they end. See
  // SettleHold — the settling window makes a move rare, these make it wait for
  // you. (The pointer listeners live with stripRef, further down.)
  const [pointerInStrip, setPointerInStrip] = useState(false);
  const settledStatus = useSettledGroups(statusTargets, tabPrefs.idleDelayMs, {
    frozen: pointerInStrip || tabHints,
    hold: activeVisualTabId,
    proven: provenQuiet,
    provenDelayMs: POLICY.provenIdleDelayMs,
  });
  // Fall back to the raw status for a tab the settler hasn't seen yet (its
  // effect runs after this render), so a new tab is never briefly homeless.
  const groupOf = useCallback(
    (id: string): TabStatus =>
      settledStatus.get(id) ?? statusTargets.get(id) ?? "quiet",
    [settledStatus, statusTargets],
  );

  const grouped = tabPrefs.grouped;
  const byStatus = useCallback(
    (s: TabStatus) => (grouped ? agentTabs.filter((t) => groupOf(t.id) === s) : []),
    [grouped, agentTabs, groupOf],
  );
  const attentionTabs = useMemo(() => byStatus("attention"), [byStatus]);
  const workingTabs = useMemo(() => byStatus("active"), [byStatus]);
  const quietTabs = useMemo(() => byStatus("quiet"), [byStatus]);

  // Each status run is a stack: one chip standing in for the tabs folded behind
  // it, opened and closed by clicking it. Idle starts folded — six finished
  // agents are a pile you want out of the way, not six tabs to read past — and
  // the two runs that are still yours to act on start open.
  // Absent means open: only the fold you have actually asked for is stored, so
  // a stack that appears for the first time (a kind of document you just
  // opened) arrives open rather than guessing.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [openStacks, setOpenStacks] = useState<Record<string, boolean>>({
    quiet: false,
  });
  const toggleStack = useCallback(
    (key: string) => {
      const opening = openStacks[key] === false;
      setOpenStacks((p) => ({ ...p, [key]: p[key] === false }));
      if (!opening) return;

      // A sticky chip can be painted at the left edge while its section's real
      // start is already behind the scrollport. Opening it restores the tabs at
      // that real position, underneath the chip. Put the section back at its
      // start once React has laid the tabs out so the first one opens beside the
      // chip instead of behind it.
      requestAnimationFrame(() => {
        const root = stripRef.current;
        const group = root?.querySelector<HTMLElement>(`[${GROUP_ATTR}="${key}"]`);
        if (!root || !group) return;
        const left = contentLeft(root, group);
        const next = expandedStackScroll(root.scrollLeft, left);
        if (next != null) root.scrollLeft = next;
      });
    },
    [openStacks],
  );
  // A tab that starts wanting you is never left folded away: arriving in Needs
  // you pops that stack open, whatever state you last left it in. Fold it again
  // and the next arrival opens it again — the stack is yours to close, but not
  // at the cost of hiding a question.
  const attentionKey = attentionTabs.map((t) => t.id).join(",");
  const seenAttention = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(attentionKey ? attentionKey.split(",") : []);
    const arrived = [...now].some((id) => !seenAttention.current.has(id));
    seenAttention.current = now;
    if (arrived)
      setOpenStacks((p) => (p.attention === false ? { ...p, attention: true } : p));
  }, [attentionKey]);

  const tabGroups: StripGroup[] = useMemo(() => {
    const run = (
      key: string,
      label: string | null,
      status: TabStatus | null,
      icon: ReactNode,
      group: SubTab[],
    ): StripGroup => ({
      key,
      label,
      status,
      icon,
      tabs: group,
      shown: shownInStack(group, label == null || openStacks[key] !== false),
    });
    return [
      ...(grouped
        ? [
            // Always this order, whatever is in them: needs you, working,
            // idle. Read off STATUS_ORDER rather than spelled out here, so
            // there is one place that says what the priority is — the strip
            // stays stable even while sessions move between states.
            ...STATUS_ORDER.map((s) =>
              run(s, STATUS_LABEL[s], s, null, { attention: attentionTabs, active: workingTabs, quiet: quietTabs }[s]),
            ),
          ]
        : [run("all", null, null, null, agentTabs)]),
      ...DOC_STACKS.map((d) =>
        run(
          d.key,
          d.label,
          null,
          DOC_STACK_ICONS[d.key],
          refTabs.filter((t) => docStackFor(t.type) === d.key),
        ),
      ),
    ];
  }, [
    grouped,
    agentTabs,
    refTabs,
    attentionTabs,
    workingTabs,
    quietTabs,
    openStacks,
    activeTabId,
  ]);
  // The number hints, and the digits that jump to them, count what is on
  // screen — a hint on a tab folded into a stack would point at nothing.
  const barTabs = useMemo(() => tabGroups.flatMap((g) => g.shown), [tabGroups]);
  barTabsRef.current = barTabs;

  // Drag to reorder, confined to the run the tab was picked up from: a tab can
  // only be dropped among its own kind, and a tab dropped outside simply snaps
  // back. The order lives in `tabs` itself, so the panes (which are all
  // mounted) follow along without anything else having to know about the drag.
  // Only what is on screen is draggable — ids folded into a stack have no
  // element to hit. One handle for the whole strip rather than one per run:
  // there are a dozen runs now, and each useTabDrag costs its own listeners.
  const reorderGroup = useCallback(
    (ids: string[]) => setTabs((prev) => applyOrder(prev, (t) => t.id, ids)),
    [],
  );
  // Dragging a terminal tab past the strip and over the split surface offers
  // post-facto multiplexing: the half of the hovered pane nearest the pointer
  // lights up, and releasing there folds the dragged terminal into the visible
  // group (or forms one) exactly where the preview showed it. Only a solo
  // terminal can be dropped in — a grouped tab in the strip is the whole
  // group's representative, and a run tab lives in the rail, not the mux.
  const [paneDrop, setPaneDrop] = useState<PaneDropZone | null>(null);
  const paneDropRef = useRef<PaneDropZone | null>(null);
  const computePaneDrop = useCallback(
    (id: string, x: number, y: number): PaneDropZone | null => {
      const source = tabsRef.current.find(
        (t): t is TermSubTab => t.id === id && t.type === "terminal",
      );
      if (!source || source.run) return null;
      if (source.paneGroup && terminalGroupsRef.current[source.paneGroup])
        return null;
      const active = tabsRef.current.find(
        (t): t is TermSubTab =>
          t.id === activeTabIdRef.current && t.type === "terminal",
      );
      if (!active || active.run || active.id === source.id) return null;
      const content = contentRef.current;
      if (!content) return null;
      const rect = content.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const group = active.paneGroup
        ? terminalGroupsRef.current[active.paneGroup]
        : undefined;
      const panes = group
        ? layoutSplit(group.root, group.zoomedTabId).panes
        : [{ tabId: active.id, left: 0, top: 0, width: 1, height: 1 }];
      return paneDropZone(
        panes,
        (x - rect.left) / rect.width,
        (y - rect.top) / rect.height,
      );
    },
    [],
  );
  const onTabDragMove = useCallback(
    (id: string, e: PointerEvent) => {
      const zone = computePaneDrop(id, e.clientX, e.clientY);
      const prev = paneDropRef.current;
      if (
        prev === zone ||
        (prev &&
          zone &&
          prev.targetTabId === zone.targetTabId &&
          prev.axis === zone.axis &&
          prev.before === zone.before)
      )
        return;
      paneDropRef.current = zone;
      setPaneDrop(zone);
    },
    [computePaneDrop],
  );
  const onTabDrop = useCallback(
    (id: string, e: PointerEvent | null) => {
      paneDropRef.current = null;
      setPaneDrop(null);
      const zone = e ? computePaneDrop(id, e.clientX, e.clientY) : null;
      if (!zone) return;
      const source = tabsRef.current.find(
        (t): t is TermSubTab => t.id === id && t.type === "terminal",
      );
      const target = tabsRef.current.find(
        (t): t is TermSubTab =>
          t.id === zone.targetTabId && t.type === "terminal",
      );
      if (!source || !target) return;
      const current = target.paneGroup
        ? terminalGroupsRef.current[target.paneGroup]
        : undefined;
      const groupId = current?.id ?? splitId();
      const root = current?.root ?? { type: "leaf" as const, tabId: target.id };
      // No zoomedTabId on the merged group: a pane dropped into a zoomed
      // surface that stayed zoomed would vanish the moment it landed.
      const next: TerminalGroup = {
        id: groupId,
        root: splitLeaf(root, target.id, source.id, zone.axis, zone.before),
        activeTabId: source.id,
      };
      terminalGroupsRef.current = {
        ...terminalGroupsRef.current,
        [groupId]: next,
      };
      setTerminalGroups(terminalGroupsRef.current);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === source.id || t.id === target.id
            ? ({ ...t, paneGroup: groupId } as SubTab)
            : t,
        ),
      );
      setActiveTabId(source.id);
      setTimeout(() => termHandles.current.get(source.id)?.focus(), 50);
    },
    [computePaneDrop],
  );
  const stripDrag = useTabDragGroups(
    useMemo(() => tabGroups.map((g) => g.shown.map((t) => t.id)), [tabGroups]),
    reorderGroup,
    useMemo(
      () => ({ onDragMove: onTabDragMove, onDrop: onTabDrop }),
      [onTabDragMove, onTabDrop],
    ),
  );
  // Regrouping never touches which tab is open — every pane stays mounted and
  // `activeTabId` is untouched, so the view under a tab that goes idle is the
  // same view, mid-scroll and all. It does move in the strip, though, so follow
  // it there; a tab that slid out of sight would be the same disappearing act
  // this grouping exists to prevent.
  const activeGroupKey = activeVisualTabId ? groupOf(activeVisualTabId) : null;
  // …and slide it there rather than cutting, so the move is something you can
  // follow with your eyes instead of a tab teleporting mid-glance.
  useFlipStrip(stripRef);
  // Whether the pointer is in the strip — one of the two holds on regrouping
  // (see the settler above). Listeners on the element rather than props on the
  // bar: this is a fact about a DOM node the bar is already handing back, and
  // the bar has no other use for it. `pointerleave` fires for a window the
  // pointer leaves outright, so the hold cannot get stuck on.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const enter = () => setPointerInStrip(true);
    const leave = () => setPointerInStrip(false);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);
  /** Put the active tab somewhere you can actually see it. Every route that
   *  changes tabs ends here — clicking, Ctrl-Tab, a jump from the agents panel,
   *  a pick from a stack's overflow menu — because "the pane changed but the
   *  strip still shows something else" is the same disappearing act whichever
   *  door you came through.
   *
   *  Not `scrollIntoView`: it is happy to park a tab flush against the left
   *  edge, which is precisely where the pinned chips are painted. */
  const settleReveal = useRef(0);
  const revealActiveTab = useCallback(() => {
    const pass = () => {
      const root = stripRef.current;
      const el = activeTabElRef.current;
      if (!root || !el || root.offsetParent === null) return;
      const group = el.closest(".tab-group");
      const chip = group?.querySelector<HTMLElement>("[data-stack-chip]");
      // One full section chip owns the edge, so revealing a tab only has to
      // clear that chip.
      const pinned = chip?.offsetWidth ?? 0;
      const to = revealScroll(
        root.scrollLeft,
        root.clientWidth,
        contentLeft(root, el),
        el.offsetWidth,
        pinned,
      );
      // Instant, not smooth: a smooth scroll is driven by the frame loop, and
      // an occluded window's frame loop is asleep — the one case where the tab
      // most needs to be found is the one where the easing would never arrive.
      if (to != null) root.scrollLeft = to;
    };
    pass();
    // Twice, because leaving a tab can shrink the strip in the same beat: the
    // tab you were on was being held out of a folded stack, and it folds back
    // the moment it stops being active. The strip narrows under the scroll we
    // just set, the browser clamps it, and the tab we were revealing ends up
    // short of the right edge. The second pass measures what actually settled.
    window.clearTimeout(settleReveal.current);
    settleReveal.current = window.setTimeout(pass, 0);
  }, []);
  useEffect(() => {
    if (!visible) return;
    revealActiveTab();
    return () => window.clearTimeout(settleReveal.current);
  }, [activeTabId, activeGroupKey, visible, revealActiveTab]);
  // Which chips are pinned, and which tabs have scrolled in behind them. Keyed
  // off the rendered runs so it re-measures when a tab opens, closes or
  // Shells and runs each get a compact rail; Rail collapses to a dropdown at 2+.
  const shellChips: RailChip[] = useMemo(
    () =>
      shellTabs.map((tab) => ({
        id: tab.id,
        active: tab.id === activeVisualTabId,
        dot: <TerminalIcon size={11} className="run-chip-shell-dot" />,
        title: tab.multiplexTitle ?? tab.customTitle ?? tab.title,
        tooltip: `${tab.command ?? "shell"} — ${tab.cwd}`,
        onSelect: () => {
          const group = tab.paneGroup
            ? terminalGroupsRef.current[tab.paneGroup]
            : undefined;
          setActiveTabId(group?.activeTabId ?? tab.id);
        },
        onClose: () =>
          tab.paneGroup
            ? closeTerminalGroup(tab.paneGroup)
            : closeTab(tab.id, "user"),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shellTabs, activeVisualTabId, closeTab, closeTerminalGroup],
  );
  const runChips: RailChip[] = useMemo(
    () =>
      runTabs.map((tab) => {
        const ok = tab.exitCode === 0;
        const state = !tab.exited ? "live" : ok ? "done" : "failed";
        return {
          id: tab.id,
          active: tab.id === activeTabId,
          className: `run-chip-${state}`,
          dot: !tab.exited ? (
            <LiveDot size={7} className="run-chip-dot" />
          ) : ok ? (
            <CheckIcon size={11} className="run-chip-ok" />
          ) : (
            <FailIcon size={11} className="run-chip-fail" />
          ),
          title: tab.title,
          tooltip: tab.exited
            ? `${ok ? "finished" : `exited ${tab.exitCode ?? "?"}`} — ${tab.command ?? ""}`
            : `running — ${tab.command ?? ""}`,
          action: tab.exited ? (
            <Button icon className="run-chip-btn"
              title="Run again"
              onClick={(e) => {
                e.stopPropagation();
                restartRun(tab.id);
              }}>
              <RestartIcon size={11} />
            </Button>
          ) : undefined,
          onSelect: () => setActiveTabId(tab.id),
          onClose: () => closeTab(tab.id, "user"),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runTabs, activeTabId, closeTab, restartRun],
  );
  // Which pane-bar section owns the active tab. The other sections recede
  // (dimmed + softly blurred) so it's unmistakable where you are: closing a
  // shell no longer means squinting past an equally-bright "IDE" tab and
  // hitting it by mistake. Clicking a recessed section shifts focus here and
  // clears the dim.
  const activeSection: "tabs" | "shells" | "runs" = useMemo(
    () =>
      shellChips.some((c) => c.active)
        ? "shells"
        : runChips.some((c) => c.active)
          ? "runs"
          : "tabs",
    [shellChips, runChips],
  );

  // First-run coach-marks: spotlight each new workspace section the first time
  // it appears — the SHELLS rail when a terminal opens, RUNS when something
  // runs, and the agent's tab when one is focused. Each fires once (localStorage
  // -gated), only on the visible project, and only one shows at a time; the
  // effect re-picks the next eligible tip after one is dismissed.
  const [coachTip, setCoachTip] = useState<CoachTip | null>(null);
  const agentTabOpen = activeTab?.type === "agent";
  const multiplexOpen =
    activeTab?.type === "terminal" &&
    activeTab.paneGroup != null &&
    Boolean(terminalGroups[activeTab.paneGroup]);
  useEffect(() => {
    if (!visible || coachTip) return;
    // A newly-created multiplex is taught immediately; otherwise walk the rail
    // in order before teaching the surfaces it opens.
    if (multiplexOpen && shouldShowTip("multiplex")) setCoachTip("multiplex");
    else if (shouldShowTip("rail-project")) setCoachTip("rail-project");
    else if (shouldShowTip("rail-review")) setCoachTip("rail-review");
    else if (shouldShowTip("rail-agents")) setCoachTip("rail-agents");
    else if (agentTabOpen && shouldShowTip("agent")) setCoachTip("agent");
  }, [visible, coachTip, agentTabOpen, multiplexOpen]);

  const dismissCoach = () => {
    if (coachTip) markTipSeen(coachTip);
    setCoachTip(null);
  };
  const COACH_TIPS: Record<
    CoachTip,
    {
      selector: string;
      title: string;
      body: string;
      steps?: { label: string; shortcut: string }[];
    }
  > = {
    "rail-project": {
      selector: '[data-rail-group="project"]',
      title: "Your project lives here",
      body: "Components, files and every server you can start.",
    },
    "rail-review": {
      selector: '[data-rail-group="review"]',
      title: "Changes and review",
      body: "Session diffs, branches, pull requests and issues.",
    },
    "rail-agents": {
      selector: '[data-rail-group="agents"]',
      title: "Agents and what they produce",
      body: "Sessions, tasks, notes, research and your team.",
    },
    agent: {
      selector: ".tab.tab-active",
      title: "Your agent workspace lives here",
      body: "This tab is the agent's workspace — its terminal, diffs and activity. Reopen it any time from the tab strip.",
    },
    multiplex: {
      selector: ".pane-bar .tab.tab-active.tab-multiplexed",
      title: "This tab now holds multiple agents",
      body: "Each pane is still an independent agent. These shortcuts keep the group quick to use:",
      steps: [
        {
          label: "Split or add a pane to the right",
          shortcut: format("split-pane-right"),
        },
        {
          label: "Split or add a pane below",
          shortcut: format("split-pane-down"),
        },
        {
          label: "Focus another tab",
          // This is literal Ctrl on every platform. The macOS glyph form `⌃⇥`
          // is too cryptic in a small coachmark keycap.
          shortcut: "Ctrl+Tab",
        },
        {
          label: "Navigate between panes",
          shortcut: [
            format("focus-pane-left"),
            format("focus-pane-up"),
            format("focus-pane-down"),
            format("focus-pane-right"),
          ].join(" · "),
        },
        {
          label: "Open a new standalone agent tab",
          shortcut: `${format("new-launcher")} then ↵`,
        },
      ],
    },
  };

  // One summary glyph for the runs dropdown: any live wins, then any failure.
  const runSummary = useMemo(
    () =>
      runTabs.some((t) => !t.exited) ? (
        <LiveDot size={7} className="run-chip-dot" />
      ) : runTabs.some((t) => t.exitCode !== 0) ? (
        <FailIcon size={11} className="run-chip-fail" />
      ) : (
        <CheckIcon size={11} className="run-chip-ok" />
      ),
    [runTabs],
  );

  // Agent terminals that can receive a ticket, shared by the Issues panel and
  // the ticket tab.
  const agentTargets: AgentTarget[] = visibleTabs
    .filter(
      (t): t is TermSubTab =>
        t.type === "terminal" && !t.run && isAgentTab(t) && t.ptyId != null,
    )
    .map((t) => {
      // Which CLI is actually in there: the process tree first (it knows even
      // when the agent was typed by hand into a plain shell), then the launch
      // command as a fallback.
      const procs = projectStats.find((s) => s.id === t.ptyId)?.procs ?? [];
      // Folded through binName on both sides: an override can be a full path
      // while a process table reports a basename, and an exact fold is what
      // keeps `amp` from matching a process called `ramp`.
      const byProc = AGENT_CLIS.find((c) =>
        procs.some(
          (p) =>
            binName(p.name) === binName(c.bin) ||
            binName(p.cmd.split(" ")[0] ?? "") === binName(c.bin),
        ),
      );
      // Via the registry id, so a terminal remembered from before a rebind —
      // still carrying the vendor's name — keeps its agent and its icon.
      const byCommand = AGENT_CLIS.find(
        (c) => c.id === agentIdForCommand(t.command),
      );
      return {
        tabId: t.id,
        title: t.customTitle ?? t.title,
        ptyId: t.ptyId as number,
        agentId: (byProc ?? byCommand)?.id ?? "agent",
        dir: basename(t.cwd) ?? "",
        cwd: t.cwd,
      };
    });

  const agentTargetsRef = useRef<AgentTarget[]>([]);
  agentTargetsRef.current = agentTargets;

  // The session changeset shaped for the agent context builder: component
  // label plus each file's repo-relative path.
  const changeContextGroups = () =>
    changeGroups.map((g) => ({
      component: g.component,
      paths: g.files.map((f) => f.path),
    }));

  // Which component checkout an absolute path lives in — the cwd a fresh agent
  // opened on that file should start in. Falls back to the first component.
  const repoForFile = (abs: string) =>
    componentsRef.current.find(
      (c) => abs === c.path || abs.startsWith(`${c.path}/`),
    )?.path ??
    componentsRef.current[0]?.path ??
    null;

  // Every port something in this project's terminals is listening on, tied to
  // the component whose directory the terminal runs in. This is what makes a
  // previewed URL traceable to a codebase: the preview tab lists exactly these,
  // and feedback from a linked page targets that component. RUNS-rail servers
  // sort first — they're the configured dev servers, a shell's port is a bonus.
  const previewServers: PreviewServer[] = tabs
    .filter(
      (t): t is TermSubTab =>
        t.type === "terminal" && t.ptyId != null && !t.exited,
    )
    .flatMap((t) => {
      const ports = projectStats.find((s) => s.id === t.ptyId)?.ports ?? [];
      const comp =
        components.find(
          (c) => t.cwd === c.path || t.cwd.startsWith(`${c.path}/`),
        ) ?? null;
      return ports.map((p) => ({
        url: `http://localhost:${p}`,
        port: p,
        ptyId: t.ptyId as number,
        title: t.customTitle ?? t.title,
        command: t.command,
        cwd: t.cwd,
        componentLabel: comp?.label ?? null,
        componentPath: comp?.path ?? t.cwd,
        run: !!t.run,
      }));
    })
    .sort((a, b) => Number(b.run) - Number(a.run));

  // The Servers panel's rows: components that have something to execute, joined
  // to the run tabs and the ports they turned out to be listening on. Memoized
  // on its three inputs — the stats poller ticks every 2s and this must not
  // rebuild the panel's rows on ticks that changed no port.
  // What's alive and where, for the Git panel's one list: a workspace row can
  // say "a server is up in here, an agent is working in here" without the panel
  // having to know anything about tabs. Only live ones — a run tab that has
  // exited is output you can still read, not a server.
  const serverCwds = useMemo(
    () => runTabs.filter((t) => !t.exited).map((t) => t.cwd),
    [runTabs],
  );
  const agentCwds = useMemo(
    () =>
      tabs
        .filter(
          (t): t is TermSubTab =>
            t.type === "terminal" && !t.run && !t.exited && Boolean(t.command),
        )
        .map((t) => t.cwd),
    [tabs],
  );

  // Each component's copy in each workspace, hung under that component rather
  // than beside it. Listing them as top-level components instead turned four
  // components with four workspaces into sixteen headings — the panel became a
  // wall you read past to find the one server that was actually up.
  //
  // Still not gated on which workspace is "active": you cannot test two
  // branches side by side if starting the second one's server means first
  // moving your whole file tree onto it.
  const serverComponents = useMemo(() => {
    return components.map((c) => {
      const workspaces: ComponentWorkspace[] = [];
      for (const { trees } of allWorktrees) {
        for (const w of trees) {
          if (w.is_main || w.bare || w.prunable) continue;
          // A worktree mirrors its repo's tree, so this component sits at the
          // same relative path inside it. `repoOf` is the worktree's own repo,
          // which is the only one whose components it can hold.
          const repo = repoPaths.find(
            (r) => c.path === r || c.path.startsWith(`${r}/`),
          );
          if (!repo || !w.path.startsWith("/")) continue;
          if (!trees.some((t) => t.is_main && t.path === repo)) continue;
          const path = w.path + c.path.slice(repo.length);
          if (path === c.path) continue;
          workspaces.push({
            label: w.branch ?? w.name,
            path,
            port: portForPath(path),
            // Identities, not a count: a row that says "2 agents" cannot be
            // the thing you send a request through.
            agents: agentsIn(path, wsDigests, thisInstance),
          });
        }
      }
      return { ...c, workspaces };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [components, allWorktrees, repoPaths, wsDigests, thisInstance]);

  // Keep the digest poll's filter in step with the workspaces we know about —
  // every worktree, not only the ones holding a component that has something to
  // run. The Git panel names the agent on a branch, and a branch with a CLI in
  // it but no dev server is exactly the case that was invisible when this list
  // came from the Servers panel's components alone.
  digestRootsRef.current = useMemo(
    () => [
      ...new Set([
        ...roots,
        ...serverComponents.flatMap((c) => (c.workspaces ?? []).map((w) => w.path)),
        ...allWorktrees.flatMap(({ trees }) =>
          trees.filter((t) => !t.bare && !t.prunable).map((t) => t.path),
        ),
      ]),
    ],
    [rootsKey, serverComponents, allWorktrees],
    // eslint-disable-next-line react-hooks/exhaustive-deps
  );

  /** The agents in a folder, for any surface that has a folder and wants to
   *  name who is in it. One resolver over the one digest poll — no panel gets
   *  its own idea of who is where. */
  const agentsAt = useCallback(
    (dir: string) => agentsIn(dir, wsDigests, thisInstance),
    [wsDigests, thisInstance],
  );

  const serverGroups = useMemo(
    () =>
      groupServers(serverComponents, runTabs, (ptyId) =>
        ptyId == null
          ? []
          : (projectStats.find((s) => s.id === ptyId)?.ports ?? []),
      ),
    [serverComponents, runTabs, projectStats],
  );

  // ⌘K's context, memoised. A fresh object literal here re-ran every instant
  // palette source — tabs, clipboard, sessions, notes, research, PRs, servers,
  // task history — plus their fuzzy ranking, on every ProjectView render, i.e.
  // several times a second under a working agent, for a list the user has not
  // retyped. SpotSearch routes its *deferred* sources through a ref for exactly
  // this reason; the instant ones key on `ctx` directly.
  const spotCtx = useMemo(
    () => ({
      components: components.map((c) => ({ label: c.label, path: c.path })),
      tabs,
      serverGroups,
      digests: wsDigests,
      projectId: project.id,
      clis: AGENT_CLIS.filter((c) => installed[c.bin]).map((c) => ({
        id: c.id,
        name: c.name,
      })),
      installed,
    }),
    [components, tabs, serverGroups, wsDigests, project.id, installed],
  );

  const serversRunning = runningCount(serverGroups);


  /** Start a configured run command, from the Servers panel. Same call the
   *  files panel's run rows make, so both surfaces drive one tab. */
  const startServer = useCallback(
    (path: string, entry: ServerEntry) => {
      addTerminal(
        path,
        entry.command,
        entry.name,
        "▶",
        true,
        undefined,
        undefined,
        true,
        undefined,
        entry.componentId && entry.runCommandId
          ? {
              componentId: entry.componentId,
              runCommandId: entry.runCommandId,
            }
          : undefined,
      );
    },
    [addTerminal],
  );

  const vibeComponent =
    vibeTarget.kind === "ready"
      ? components.find((component) => component.id === vibeTarget.component.id) ?? null
      : null;
  const vibeRun =
    vibeTarget.kind === "ready"
      ? vibeComponent?.commands?.find(
          (command) => command.id === vibeTarget.runCommand.id,
        ) ?? null
      : null;
  const vibeCheck = vibeComponent?.commands?.find(
    (command) =>
      command.name !== vibeRun?.name &&
      /^(check|typecheck|test|build)$/i.test(command.name),
  );
  const vibeOwnedPreviewId = useRef<string | null>(null);
  const vibePreview =
    tabs.find(
      (tab): tab is PreviewSubTab =>
        tab.type === "preview" && tab.id === vibeOwnedPreviewId.current,
    ) ?? null;
  if (vibeOwnedPreviewId.current && !vibePreview) vibeOwnedPreviewId.current = null;
  const vibePreviewIdRef = useRef<string | null>(null);
  vibePreviewIdRef.current = vibePreview?.id ?? null;
  const claudeBin = AGENT_CLIS.find((cli) => cli.id === "claude")?.bin ?? "claude";
  const vibeComponentId = vibeComponent?.id ?? null;
  const vibeComponentLabel = vibeComponent?.label ?? null;
  const vibeComponentPath = vibeComponent?.path ?? null;
  const vibeSession = useMemo(
    () =>
      vibeComponentId && vibeComponentLabel && vibeComponentPath
        ? createVibeBuilderSession({
            projectId: project.id,
            projectName: project.name,
            componentId: vibeComponentId,
            componentPath: vibeComponentPath,
            cliBin: claudeBin,
            checkCommand: vibeCheck?.command ?? null,
            previewTabId: () => vibePreviewIdRef.current,
          })
        : null,
    [
      project.id,
      project.name,
      vibeComponentId,
      vibeComponentLabel,
      vibeComponentPath,
      vibeCheck?.command,
      claudeBin,
    ],
  );
  useEffect(() => () => void vibeSession?.stop(), [vibeSession]);

  const autoStartedVibeRun = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !vibe || !vibeComponent || !vibeRun) return;
    const key = `${vibeComponent.path}:${vibeComponent.id}:${vibeRun.id}`;
    const running = runTabs.some((tab) =>
      matchesVibeRun(tab, vibeComponent, vibeRun),
    );
    if (!running && autoStartedVibeRun.current !== key) {
      autoStartedVibeRun.current = key;
      addTerminal(
        vibeComponent.path,
        vibeRun.command,
        vibeRun.name,
        "▶",
        true,
        undefined,
        undefined,
        true,
        undefined,
        { componentId: vibeComponent.id, runCommandId: vibeRun.id },
      );
    }
  }, [visible, vibe, vibeComponent, vibeRun, runTabs, addTerminal]);

  const engineerTabBeforeVibe = useRef<string | null>(null);
  const vibeWasVisible = useRef(false);
  useEffect(() => {
    if (!visible) return;
    if (vibe) {
      if (!vibeWasVisible.current) {
        engineerTabBeforeVibe.current = activeTabIdRef.current;
      }
      const preview = tabsRef.current.find(
        (tab): tab is PreviewSubTab =>
          tab.type === "preview" && tab.id === vibeOwnedPreviewId.current,
      );
      if (preview) {
        if (!vibeWasVisible.current) setActiveTabId(preview.id);
      } else {
        vibeOwnedPreviewId.current = openPreview();
      }
    } else if (!vibe && vibeWasVisible.current) {
      const restore = engineerTabBeforeVibe.current;
      if (restore && tabsRef.current.some((tab) => tab.id === restore)) {
        setActiveTabId(restore);
      }
      engineerTabBeforeVibe.current = null;
    }
    vibeWasVisible.current = vibe;
  }, [visible, vibe, vibePreview?.id, openPreview]);

  useEffect(() => {
    if (!visible || !vibe || !vibeComponent || !vibeRun || !vibePreview || vibePreview.url) {
      return;
    }
    const running = runTabs.find((tab) =>
      matchesVibeRun(tab, vibeComponent, vibeRun),
    );
    const port = running?.ptyId == null
      ? null
      : projectStats.find((stat) => stat.id === running.ptyId)?.ports[0];
    if (port) patchTabRaw(vibePreview.id, { url: `http://localhost:${port}` });
  }, [
    visible,
    vibe,
    vibeComponent,
    vibeRun,
    vibePreview,
    runTabs,
    projectStats,
    patchTabRaw,
  ]);

  // Mirror this project's live shape — components, run servers, agents — into
  // the Rust context bridge, where `canopy-hook --mcp` serves it to agents as
  // the canopy_* tools. Runs every render, but the stringify diff means a
  // publish only crosses IPC when something actually changed.
  //
  // The caret is read here rather than subscribed as state: a per-keystroke
  // useSyncExternalStore re-rendered this whole component to feed one field.
  // The debounced subscription below re-publishes (no render) on caret moves.
  const lastContextRef = useRef("");
  const publishContextRef = useRef(() => {});
  useEffect(() => {
    const publish = () => {
      const caret = getCaret();
      // The companion's spotlight rides the same publish: what the visible
      // project has in front of the user, for the envelope every companion
      // message carries. Before the dedup check on purpose — visibility is
      // part of the spotlight's identity, and the module dedups itself.
      setCompanionSpotlight(
        project.id,
        visible
          ? {
              project: project.name,
              tab: describeTab(visibleTabs.find((t) => t.id === activeTabId)),
              caret:
                caret &&
                visibleTabs.some((t) => t.type === "file" && t.file.path === caret.path)
                  ? { path: caret.path, line: caret.line }
                  : null,
            }
          : null,
      );
      const snapshot = JSON.stringify({
        id: project.id,
        name: project.name,
        components: components.map((c) => ({
          id: c.id,
          label: c.label,
          path: c.path,
          commands: c.commands ?? [],
        })),
        runServers: tabs
          .filter((t): t is TermSubTab => t.type === "terminal" && !!t.run)
          .map((t) => ({
            ptyId: t.ptyId,
            title: t.customTitle ?? t.title,
            command: t.command ?? "",
            cwd: t.cwd,
            component:
              components.find(
                (c) => t.cwd === c.path || t.cwd.startsWith(`${c.path}/`),
              )?.label ?? null,
            listeningPorts:
              projectStats.find((s) => s.id === t.ptyId)?.ports ?? [],
            running: !t.exited && t.ptyId != null,
            exitCode: t.exitCode ?? null,
          })),
        agents: agentTargets.map((a) => ({
          ptyId: a.ptyId,
          agent: a.agentId,
          title: a.title,
          dir: a.dir,
        })),
        // Preview and device annotations, so canopy_annotations serves every
        // surface the user can mark up rather than only the web one. `surface`
        // says which kind an entry is; the fields either carries are the ones
        // that actually locate it (a selector on a page, a resource id or the
        // visible text on a device).
        annotations: [
          ...tabs
            .filter((t): t is PreviewSubTab => t.type === "preview")
            .flatMap((t) => {
              const server = serverForUrl(t.url, previewServers);
              return t.annotations
                .filter((a) => !a.sent)
                .map((a) => ({
                  surface: "preview",
                  n: a.n,
                  selector: a.selector,
                  component: a.components[0] ?? null,
                  tag: a.tag,
                  text: a.text,
                  comment: a.comment,
                  pageUrl: a.pageUrl || t.url,
                  servingComponent: server?.componentLabel ?? null,
                  servingComponentPath: server?.componentPath ?? null,
                }));
            }),
          ...tabs
            .filter((t): t is DeviceSubTab => t.type === "device")
            .flatMap((t) =>
              t.annotations.map((a) => ({
                surface: "device",
                n: a.n,
                serial: a.serial,
                // Absent under Jetpack Compose, which publishes no ids — the
                // text is the anchor there, and saying so beats implying a
                // precision the tree does not have.
                resourceId: a.resourceId || null,
                className: a.className,
                text: a.text,
                comment: a.comment,
                appComponent: a.component || null,
                servingComponentPath: t.projectDir || null,
              })),
            ),
        ],
        // Open preview tabs, so agents know what the browser-control tools
        // (canopy_browser_*) are currently pointed at.
        previews: visibleTabs
          .filter((t): t is PreviewSubTab => t.type === "preview")
          .map((t) => ({
            url: t.url || null,
            annotations: t.annotations.filter((a) => !a.sent).length,
          })),
        // What the user is looking at (canopy_editor_state) — the tab in front of
        // them, the caret, the selection. Deixis: "fix this" has a referent, and
        // this is it.
        editor: {
          focused: visible,
          activeTab: describeTab(visibleTabs.find((t) => t.id === activeTabId)),
          openTabs: visibleTabs.map(describeTab).filter(Boolean),
          caret:
            caret &&
            visibleTabs.some((t) => t.type === "file" && t.file.path === caret.path)
              ? caret
              : null,
        },
      });
      if (snapshot !== lastContextRef.current) {
        lastContextRef.current = snapshot;
        void ipc.contextPublish(project.id, snapshot);
      }
    };
    publishContextRef.current = publish;
    publish();
  });
  useEffect(() => {
    let t: number | undefined;
    const unsub = subscribeCaret(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => publishContextRef.current(), 250);
    });
    return () => {
      unsub();
      window.clearTimeout(t);
    };
  }, []);
  // A closed project's servers die with it; drop its snapshot too — and its
  // spotlight, or the companion would keep being told about a view that is gone.
  useEffect(
    () => () => {
      void ipc.contextRemove(project.id);
      setCompanionSpotlight(project.id, null);
    },
    [project.id],
  );

  // The agent behind the active *terminal* tab, if any — the "Agent Workspace"
  // toggle and its overlay only exist here. Identity is the live process (same
  // resolution as the tab icon), so it's right for every agent CLI — not just
  // the hook-reporting ones. The workspace is driven off the terminal's cwd;
  // the hook digest, when there is one, only rides along as enrichment, and
  // only when it genuinely belongs to this agent (a reused PTY can still carry
  // a previous CLI's digest — attaching it is exactly the bug this replaces).
  const agentTermWs =
    activeTab?.type === "terminal" &&
    isAgentTab(activeTab) &&
    activeTab.ptyId != null
      ? (() => {
          const stat = projectStats.find((s) => s.id === activeTab.ptyId);
          const procs = stat?.procs ?? [];
          const byProc = AGENT_CLIS.find((c) =>
            procs.some(
              (p) =>
                binName(p.name) === binName(c.bin) ||
                binName(p.cmd.split(" ")[0] ?? "") === binName(c.bin),
            ),
          );
          const byCommand = AGENT_CLIS.find(
            (c) => c.id === agentIdForCommand(activeTab.command),
          );
          const agent = (byProc ?? byCommand)?.id ?? "agent";
          // The live session cwd — the same source the Agents panel keys off,
          // so the overlay and a panel-opened tab resolve the same workspace.
          const cwd = stat?.cwd || activeTab.cwd || "";
          const repo =
            components.find(
              (c) => cwd === c.path || cwd.startsWith(c.path + "/"),
            )?.path ?? null;
          // Bind to the session actually running in this terminal by identity,
          // never by the digest's `surface` (the pty from whenever the hook last
          // wrote — stale across a restart, which is what stapled a dead session
          // onto a live tab). In order of reliability:
          //   1. Live hook events on this pty (`canopy_pty`) name the session
          //      directly, whatever pty number this launch happened to assign.
          //   2. A resume command carries the session id outright — restart-proof
          //      and correct even before the resumed agent's first event fires.
          //   3. Only a hookless CLI that was never resumed falls back to the
          //      surface binding, and even then a digest from another launch
          //      (untagged/other-instance) is rejected rather than shown.
          const boundSid =
            liveSessionByPty.get(activeTab.ptyId as number) ??
            resumeSessionId(activeTab.command);
          let digest: ipc.SessionDigest | undefined;
          let sessionId: string | undefined;
          if (boundSid) {
            const ld = wsDigests.find((x) => x.session_id === boundSid);
            digest = ld && (ld.agent ?? "agent") === agent ? ld : undefined;
            sessionId = boundSid;
          } else {
            const d = digestBySurface(wsDigests, thisInstance).get(
              String(activeTab.ptyId),
            );
            const belongs = d && (!thisInstance || d.instance === thisInstance);
            digest = belongs && (d.agent ?? "agent") === agent ? d : undefined;
            sessionId = digest?.session_id;
          }
          return {
            repo,
            agent,
            cwd,
            sessionId,
            digest,
            ptyId: activeTab.ptyId as number,
          };
        })()
      : null;
  // Derived, not stored: the overlay shows when the terminal in front is one you
  // opened it on. Anything else in front — another agent, a file, no agent tab
  // at all — and there is nothing to close, because it was never open for that.
  const wsDrawerPty = agentTermWs?.ptyId ?? null;
  const wsDrawerOpen = wsDrawerPty != null && wsOpenPtys.has(wsDrawerPty);
  const setWsDrawerOpen = useCallback(
    (open: boolean) => {
      if (wsDrawerPty == null) return;
      setWsOpenPtys((prev) => {
        if (prev.has(wsDrawerPty) === open) return prev;
        const next = new Set(prev);
        if (open) next.add(wsDrawerPty);
        else next.delete(wsDrawerPty);
        return next;
      });
    },
    [wsDrawerPty],
  );
  // Forget terminals that have gone away. PTY ids can be reused, and a stale
  // entry would open the workspace unbidden on whatever inherits the number.
  const liveTermPtys = useMemo(
    () =>
      tabs
        .filter((t): t is TermSubTab => t.type === "terminal")
        .map((t) => t.ptyId),
    [tabs],
  );
  useEffect(() => {
    setWsOpenPtys((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(liveTermPtys);
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [liveTermPtys]);
  // Esc closes the overlay, matching every other overlay in the app — and
  // counts as a layer, so the press that closes it is not also the press that
  // puts the side panel away underneath.
  useEscapeLayer(wsDrawerOpen);
  useEffect(() => {
    if (!wsDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWsDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wsDrawerOpen, setWsDrawerOpen]);

  const peerMembers = useMemo(
    () => relay.status.members.filter((m) => m.id !== relay.status.self_id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay.status.members, relay.status.self_id],
  );
  const isRelayConnectedWithPeers =
    relay.status.role !== "off" && peerMembers.length > 0;
  const activeFileTab = useMemo(
    () => (activeTab?.type === "file" ? activeTab : null),
    [activeTab],
  );
  const activeTermTab = useMemo(
    () => (activeTab?.type === "terminal" ? activeTab : null),
    [activeTab],
  );

  // Stable PaneBar callbacks — identity only changes when their actual deps change,
  // not on every 4s stats sample, so the memoized PaneBar stays put between samples.
  const isSharedFile = useMemo(
    () => activeFileTab != null && shared.current.has(activeFileTab.file.path),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeFileTab, relay.collabTick],
  );
  const isProjectShared = useCallback(
    (memberId: string) =>
      relay.collab.projectSharedWith(rootsRef.current[0] ?? "").has(memberId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [relay.collabTick],
  );
  const onSelectTab = useCallback(
    (id: string, clickCount?: number) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab?.type === "terminal" && clickCount === 2) startRename(tab);
      else {
        const group =
          tab?.type === "terminal" && tab.paneGroup
            ? terminalGroupsRef.current[tab.paneGroup]
            : undefined;
        setActiveTabId(group?.activeTabId ?? id);
      }
    },
    [startRename],
  );
  const closeVisualTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab?.type === "terminal" && tab.paneGroup)
        closeTerminalGroup(tab.paneGroup);
      else closeTab(id, "user");
    },
    [closeTab, closeTerminalGroup],
  );
  const onTabContextMenu = useCallback(
    (e: React.MouseEvent, tab: SubTab) => {
      // Every tab kind that names a concrete thing can seed a task about it —
      // the same create-form flow as a terminal selection, with the tab's
      // subject prefilled (and a quick-run action where one applies).
      const taskItem: MenuItem[] =
        tab.type === "file"
          ? [taskMenu(`In \`${tab.file.path}\`: `)]
          : tab.type === "pr"
            ? [
                taskMenu(
                  `About PR #${tab.pr.number} "${tab.pr.title}" (${tab.pr.url}): `,
                  [
                    {
                      id: reviewPrTask.id,
                      label: `Review PR #${tab.pr.number}`,
                      icon: reviewPrTask.icon,
                      run: () =>
                        void startMicroTask(
                          reviewPrTask,
                          { repo: tab.repo, pr: tab.pr },
                          "",
                        ),
                    },
                    {
                      id: addressPrCommentsTask.id,
                      label: `Address comments on #${tab.pr.number}`,
                      icon: addressPrCommentsTask.icon,
                      run: () =>
                        void startMicroTask(
                          addressPrCommentsTask,
                          { repo: tab.repo, pr: tab.pr },
                          "",
                        ),
                    },
                  ],
                ),
              ]
            : tab.type === "branch"
              ? [
                  taskMenu(
                    `On branch ${tab.branch.branch}: `,
                    tab.branch.merged
                      ? undefined
                      : [
                          {
                            id: raisePrTask.id,
                            label: `Raise PR for ${tab.branch.branch}`,
                            icon: raisePrTask.icon,
                            run: () =>
                              void startMicroTask(
                                raisePrTask,
                                {
                                  repo: tab.repo,
                                  branch: tab.branch.branch,
                                  worktree: tab.branch.worktree,
                                  unpushed:
                                    !tab.branch.upstream ||
                                    tab.branch.ahead > 0,
                                },
                                "",
                              ),
                          },
                        ],
                  ),
                ]
              : tab.type === "ticket"
                ? [
                    taskMenu(
                      `About ticket ${tab.ticket.id} "${tab.ticket.title}" (${tab.ticket.url}): `,
                    ),
                  ]
                : [];
      const items: MenuItem[] =
        tab.type === "terminal"
          ? [
              {
                label: "Rename",
                onClick: () => {
                  if (tab.type === "terminal") startRename(tab);
                },
              },
              ...(tab.run
                ? []
                : [
                    {
                      label: "Split right",
                      onClick: () => {
                        setActiveTabId(tab.id);
                        window.setTimeout(
                          () => splitActiveRef.current("horizontal"),
                          0,
                        );
                      },
                    },
                    {
                      label: "Split down",
                      onClick: () => {
                        setActiveTabId(tab.id);
                        window.setTimeout(
                          () => splitActiveRef.current("vertical"),
                          0,
                        );
                      },
                    },
                  ]),
              {
                label: tab.paneGroup ? "Close multiplexed tab" : "Close",
                danger: true,
                onClick: () => closeVisualTab(tab.id),
              },
            ]
          : [
              ...taskItem,
              { label: "Close", danger: true, onClick: () => closeTab(tab.id, "user") },
            ];
      tabMenu.open(e, items);
    },
    [startRename, closeTab, closeVisualTab, tabMenu.open, taskMenu, startMicroTask],
  );
  const onClearScrollback = useCallback(() => {
    if (activeTermTab)
      termHandles.current.get(activeTermTab.id)?.clearScrollback();
  }, [activeTermTab]);
  const onHardReset = useCallback(() => {
    if (activeTermTab) termHandles.current.get(activeTermTab.id)?.hardReset();
  }, [activeTermTab]);
  const onToggleView = useCallback(() => {
    if (activeFileTab) toggleView(activeFileTab.file.path);
  }, [activeFileTab, toggleView]);
  const onShareFile = useCallback(
    (memberId: string, memberName: string) => {
      if (activeFileTab)
        shareFileLive(
          activeFileTab.file.path,
          activeFileTab.file.name,
          memberId,
          memberName,
        );
    },
    [activeFileTab, shareFileLive],
  );
  const onShareProject = useCallback(
    (memberId: string, memberName: string) =>
      shareProjectLive(memberId, memberName),
    [shareProjectLive],
  );
  const onNewShell = useCallback(() => {
    if (pendingSplitRef.current) {
      completePendingSplit({ title: "shell" });
      return;
    }
    const cwd = componentsRef.current[0]?.path;
    if (cwd) addTerminal(cwd);
  }, [addTerminal, completePendingSplit]);
  const onLaunchCli = useCallback(
    (cli: AgentCli) => launchCli(cli),
    [launchCli],
  );
  const onRunCliUpdate = useCallback(
    (cli: AgentCli, _e: React.MouseEvent) => runCliUpdate(cli),
    [runCliUpdate],
  );
  const onOpenAllTabs = useCallback(
    (e: React.MouseEvent) =>
      tabMenu.open(
        e,
        stripTabs.map((t) => ({
          label: `${t.id === activeVisualTabId ? "› " : ""}${tabDisplayLabel(t)}`,
          onClick: () => {
            const group =
              t.type === "terminal" && t.paneGroup
                ? terminalGroupsRef.current[t.paneGroup]
                : undefined;
            setActiveTabId(group?.activeTabId ?? t.id);
          },
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabMenu.open, stripTabs, activeVisualTabId],
  );

  /** Everything Enter can do in SpotSearch, routed to the same handlers the
   *  panels and menus already use — the palette names the action, this owns
   *  the doing. */
  const onSpotAction = useCallback(
    (action: SpotAction) => {
      switch (action.type) {
        case "run-task": {
          const dir = componentsRef.current[0]?.path;
          if (!dir) return;
          const active = tabsRef.current.find(
            (t) => t.id === activeTabIdRef.current,
          );
          const termText =
            active?.type === "terminal"
              ? (termHandles.current.get(active.id)?.captureText(2000) ??
                undefined)
              : undefined;
          // Capture after the palette has left the screen — a snapshot taken
          // now would be a picture of the palette, not of the page under it.
          window.setTimeout(() => {
            void capturePageContext({
              activeTab: active,
              dir,
              termText,
              rect: rootRef.current?.getBoundingClientRect() ?? null,
            }).then((context) =>
              runAdhocTask(
                composeTaskBrief(action.brief, context),
                dir,
                adhocLabel(action.brief),
              ),
            );
          }, 120);
          return;
        }
        // The sibling of run-task: same typed sentence, sent off to find
        // something out rather than to change something. No page context is
        // captured — a research question is about the codebase, not about
        // whatever happens to be on screen.
        case "start-research":
          void startResearch(action.question);
          return;
        case "save-note":
          void saveNote(action.text, action.attachments);
          return;
        case "open-note": {
          const row = notesCached(project.id).find((n) => n.id === action.id);
          openNote(action.id, row?.title ?? action.id);
          return;
        }
        case "open-research":
          openResearch(
            action.id,
            researchCached(project.id).find((e) => e.id === action.id)?.title ??
              action.id,
          );
          return;
        case "new-shell":
          onNewShell();
          return;
        case "new-preview":
          openPreview();
          return;
        case "new-device":
          openDevice();
          return;
        case "launch-cli": {
          const cli = AGENT_CLIS.find((c) => c.id === action.cliId);
          if (cli) launchCli(cli);
          return;
        }
        case "open-file":
          void openFile(action.path);
          return;
        case "focus-tab":
          setActiveTabId(action.tabId);
          return;
        case "open-session": {
          const d = action.digest;
          void openAgent({
            agent: d.agent ?? "agent",
            // The directory the conversation lives in, not the one the agent
            // last reported from: this becomes the workspace tab's cwd, and
            // everything that tab offers to do with the session — resuming it
            // to deliver a message, above all — runs there.
            cwd: resumeCwd(d, componentsRef.current[0]?.path ?? ""),
            // The pty id only means anything inside the launch that assigned
            // it — a digest from another instance binds by session id instead.
            ptyId:
              d.surface != null && d.instance === thisInstanceRef.current
                ? Number(d.surface)
                : undefined,
            sessionId: d.session_id,
            digest: d,
          });
          return;
        }
        case "open-ticket":
          openTicket(action.ticket, action.source);
          return;
        case "switch-branch":
          // Straight into the funnel: a branch the palette offers is a branch
          // git may well refuse, and that refusal is a question like any other.
          void switchTo(action.repo, { kind: "branch", branch: action.branch });
          return;
        case "open-pr":
          openPr(action.repo, action.pr);
          return;
        case "open-server":
          if (action.tabId) setActiveTabId(action.tabId);
          else selectSideTab("servers");
          return;
        case "open-task-run":
          openTaskHistory(action.runId);
          return;
        // A clip, put back. Two things happen, and both are wanted: it goes on
        // the system clipboard (which is what a clipboard manager is *for* —
        // ⌘V then works anywhere, including the editor and other apps), and if
        // a terminal has the focus it also lands at the cursor, because
        // reaching for ⌘K and then still having to press ⌘V is the version of
        // this feature nobody would use.
        //
        // The text is fetched here rather than carried on the row: the palette
        // holds previews, and one clip's worth of text crosses the boundary
        // only when the user picks it.
        case "paste-clip": {
          const clipId = action.clipId;
          const active = tabsRef.current.find(
            (t) => t.id === activeTabIdRef.current,
          );
          void ipc
            .clipboardRead(clipId)
            .then(async (text) => {
              if (!text) return;
              await navigator.clipboard.writeText(text).catch(() => {});
              if (active?.type === "terminal") {
                termHandles.current.get(active.id)?.paste(text);
              } else {
                // No chord in the copy: paste is the OS's shortcut, not one of
                // ours, so there is nothing in the registry to format and
                // spelling it here is exactly what the guard test forbids.
                onNotice("Clip is back on the clipboard — paste it where you want it.");
              }
            })
            .catch(() => onNotice("That clip is gone.", "error"));
          return;
        }
        // A registered source's own opener (see registerSpotSource). It ran
        // from a click, so a rejection here is the source's to report — this
        // only keeps it from surfacing as an unhandled rejection.
        case "custom":
          void Promise.resolve()
            .then(action.run)
            .catch((err) => console.warn("[spot] custom action failed", err));
          return;
      }
    },
    [
      onNewShell,
      openPreview,
      openDevice,
      launchCli,
      openFile,
      openAgent,
      openTicket,
      openPr,
      selectSideTab,
      openTaskHistory,
      runAdhocTask,
      switchTo,
      startResearch,
      openResearch,
      onNotice,
      saveNote,
      openNote,
      project.id,
    ],
  );

  // ---------- document tabs ----------
  // Doc tabs used to render only while active, so switching away and back
  // rebuilt the view from scratch: scroll jumped to the top, loaded data was
  // refetched, and a preview reloaded its page (losing whatever you had it in
  // the middle of). They now stay mounted and are display-toggled, exactly
  // like the terminals above.
  //
  // The catch is that ProjectView re-renders often (pty stats tick every 2s),
  // and re-rendering ten mounted views on each tick — PR diffs, editors —
  // would be real work for nothing. So an inactive pane whose own tab data
  // hasn't changed is handed back the SAME element it last rendered: React
  // compares element identity and skips that subtree entirely. A pane is
  // rebuilt when it's in front (so it always sees current props) or when its
  // tab changed underneath it.
  const docTabs = tabs.filter((t): t is DocSubTab => t.type !== "terminal");
  const panes = useRef(new Map<string, { tab: DocSubTab; el: ReactNode }>());
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    for (const id of [...panes.current.keys()])
      if (!live.has(id)) panes.current.delete(id);
  }, [tabs]);
  const paneFor = (tab: DocSubTab): ReactNode => {
    const cached = panes.current.get(tab.id);
    if (cached && cached.tab === tab && tab.id !== activeTabId)
      return cached.el;
    const el = docTabView(tab);
    panes.current.set(tab.id, { tab, el });
    return el;
  };

  function docTabView(tab: DocSubTab): ReactNode {
    switch (tab.type) {
      case "branch":
        return (
          <BranchView
            relay={relay}
            repo={tab.repo}
            branch={tab.branch}
            onOpenCommit={openCommit}
            onOpenTerminal={(cwd, label) => addTerminal(cwd, undefined, label)}
            onNotice={onNotice}
            onMicroTask={startMicroTask}
          />
        );
      case "agent":
        return (
          <AgentWorkspaceView
            repo={tab.repo}
            agent={tab.agent}
            cwd={tab.cwd}
            sessionId={tab.sessionId}
            digest={tab.digest}
            onOpenCommit={openCommit}
            onOpenPr={openPr}
            onOpenPrNumber={(r, n, u) => void openPrByNumber(r, n, u)}
            onOpenTerminal={(cwd, label) => addTerminal(cwd, undefined, label)}
            onNotice={onNotice}
            onMessageAgent={(text) =>
              messageAgent({
                sessionId: tab.sessionId,
                agentId: tab.agent,
                cwd: tab.cwd,
                text,
              })
            }
            onFocusAgent={jumpToPty}
            onRaisePrTask={
              tab.repo
                ? (branch, worktree) =>
                    void startMicroTask(
                      raisePrTask,
                      { repo: tab.repo as string, branch, worktree },
                      "",
                    )
                : undefined
            }
            onReviewPrTask={
              tab.repo
                ? (pr) =>
                    void startMicroTask(
                      reviewPrTask,
                      { repo: tab.repo as string, pr },
                      "",
                    )
                : undefined
            }
            onAddressPrCommentsTask={
              tab.repo
                ? (pr) =>
                    void startMicroTask(
                      addressPrCommentsTask,
                      { repo: tab.repo as string, pr },
                      "",
                    )
                : undefined
            }
            onRunSavedTask={(task, dir) =>
              void startMicroTask(customTaskDef(task), { dir }, "")
            }
            savedTasks={project.customTasks ?? []}
            onRunOneOff={(brief, dir) => runAdhocTask(brief, dir)}
          />
        );
      case "commit":
        return (
          <CommitView repo={tab.repo} hash={tab.hash} onNotice={onNotice} />
        );
      case "ticket":
        return (
          <TicketView
            ticket={tab.ticket}
            source={tab.source}
            repo={tab.repo}
            worktree={ticketWorktree(tab.ticket, ticketWorktrees)}
            agentTargets={agentTargets}
            installed={installed}
            onStartNew={(agentId) =>
              void startTicketWork(tab.ticket, tab.repo ?? "", agentId)
            }
            onStartTask={() => startTicketTask(tab.ticket, tab.repo)}
            // The run's identity is its label (one adhoc task looks like any
            // other), so the live state the button shows is "a run with this
            // ticket's label is still in flight".
            taskRunning={microRuns.some(
              (r) =>
                r.taskId === ADHOC_TASK_ID &&
                r.label === ticketTaskLabel(tab.ticket),
            )}
            onShowTasks={() => {
              setPinned(true);
              setSideTab("tasks");
            }}
            onResearch={() => void researchTicket(tab.ticket)}
            onSendToAgent={(target) =>
              sendTicketToAgent(target, ticketContext(tab.ticket))
            }
          />
        );
      case "research":
        return (
          <ResearchView
            projectId={project.id}
            researchId={tab.researchId}
            agentTargets={agentTargets}
            installed={installed}
            onImplement={(entry, agentId) =>
              void implementResearch(entry, "", agentId)
            }
            onSendImplement={(target, entry) =>
              sendTicketToAgent(target, implementContext(entry))
            }
            onRaisePr={(entry) => void raiseResearchPr(entry)}
            // Continuing works on the same entry rather than opening a new
            // one — the point is to go further on this question, not to ask it
            // again — so the steer is passed through as the run's user context.
            onContinue={(entry, steer) =>
              void continueResearch(entry, steer)
            }
            onOpenPr={(pr) => void openPrByNumber(pr.repo, pr.number, pr.url)}
            onOpenFile={(path) => {
              const entry = researchEntryForFile(path);
              if (entry) openResearch(entry.id, entry.id);
              else void openFile(path);
            }}
            onWikilink={(t) => void followWikilink(t)}
            onClosed={() => closeTab(tab.id)}
            // The tab strip keeps its own copy of the title so it has a label
            // before the first read; a rename has to reach it or the tab keeps
            // showing the name the entry no longer has.
            onRenamed={(title) => patchTabRaw(tab.id, { title } as Partial<SubTab>)}
            onNotice={onNotice}
          />
        );
      case "note":
        return (
          <NoteView
            projectId={project.id}
            id={tab.noteId}
            agentTargets={agentTargets}
            installed={installed}
            onStartNew={(note, agentId) => void workOnNote(note, "", agentId)}
            onSendToAgent={(note, target) =>
              sendTicketToAgent(target, noteContext(note, note.dir))
            }
            onOpenResearch={(rid) => openResearch(rid, rid)}
            onWikilink={(t) => void followWikilink(t)}
            onClosed={() => closeTab(tab.id)}
            onNotice={onNotice}
          />
        );
      case "pr":
        return (
          <PrView
            repo={tab.repo}
            pr={tab.pr}
            onNotice={onNotice}
            relay={relay}
            agentTargets={agentTargets}
            installed={installed}
            onStartReview={(agentId) =>
              void startPrReview(tab.repo, tab.pr, agentId)
            }
            onSendToAgent={(target) =>
              sendTicketToAgent(target, prReviewContext(tab.pr))
            }
            onStartResolve={(agentId) =>
              void startPrConflictResolve(tab.repo, tab.pr, agentId)
            }
            onSendResolve={(target) =>
              sendTicketToAgent(target, prConflictContext(tab.pr))
            }
            onMicroTask={startMicroTask}
            liveSessions={liveSessions}
            onSendToRaiser={(to, text) =>
              void sendToRaiser(tab.repo, tab.pr, to, text)
            }
          />
        );
      case "review":
        return (
          <ReviewView
            review={tab.review}
            agentBar={
              <AgentQueryBar
                placeholder="Ask an agent to review this…"
                onRunTask={(query) =>
                  void writeReviewPatch(tab.review).then((path) => {
                    const dir = componentsRef.current[0]?.path;
                    if (!path || !dir) return;
                    runAdhocTask(
                      reviewContext(tab.review, path, query),
                      dir,
                      `Review ${tab.review.branch}`,
                    );
                  })
                }
              />
            }
          />
        );
      case "preview":
        return (
          <PreviewView
            tabId={tab.id}
            url={tab.url}
            annotations={tab.annotations}
            shots={tab.shots ?? []}
            feedbackPanelHidden={tab.feedbackPanelHidden}
            dir={componentsRef.current[0]?.path ?? firstRoot}
            visible={tab.id === activeTabId && visible}
            streaming={shownBrowserPips.some((p) => p.tabId === tab.id)}
            onPatch={(patch) => patchTabRaw(tab.id, patch as Partial<SubTab>)}
            servers={previewServers}
            agentTargets={agentTargets}
            primaryTarget={previewAgentTarget(
              agentTargets,
              tab.recipientPtyId,
              tab.initiatorPtyId,
              serverForUrl(tab.url, previewServers),
            )}
            installed={installed}
            onSendToAgent={sendTicketToAgent}
            onStartNew={(agentId, text, cwd) => {
              // The serving component's checkout when the page is linked to
              // one; the first component only as a last resort.
              const dir = cwd ?? componentsRef.current[0]?.path;
              if (!dir) {
                onNotice("No project directory to start the agent in.");
                return Promise.resolve(false);
              }
              return startAgentInDir(dir, agentId, text, "Preview feedback");
            }}
            onRunOneOff={(brief, dir) =>
              // Named, so the Tasks list says what it is rather than opening
              // with the first line of a brief about four screenshots.
              runAdhocTask(brief, dir, "Preview screenshots")
            }
            onNotice={onNotice}
          />
        );
      case "device":
        return (
          <DeviceView
            serial={tab.serial}
            projectDir={tab.projectDir}
            annotations={tab.annotations}
            visible={tab.id === activeTabId && visible}
            onPatch={(patch) => patchTabRaw(tab.id, patch as Partial<SubTab>)}
            agentTargets={agentTargets}
            installed={installed}
            onSendToAgent={sendTicketToAgent}
            onStartNew={(agentId, text, cwd) => {
              const dir = cwd ?? componentsRef.current[0]?.path;
              if (!dir) {
                onNotice("No project directory to start the agent in.");
                return Promise.resolve(false);
              }
              return startAgentInDir(dir, agentId, text, "Device feedback");
            }}
            projects={components.map((c) => ({ label: c.label, path: c.path }))}
          />
        );
      case "agents":
        return (
          <AgentsView
            active={tab.id === activeTabId && visible}
            projectName={project.name}
            roots={roots}
            stats={projectStats}
            hookPath={hookPath}
            pending={pending}
            onDismissPending={onDismissPending}
            onAnswer={answerQuestions}
            onRespond={respondPermission}
            onJumpToTerminal={jumpToTerminal}
            onJumpToPty={jumpToPty}
            onPreviewUrl={openPreview}
            onOpenAgent={(p) => void openAgent(p)}
            tabNames={tabNames}
            shareContext={Boolean(project.shareContext)}
            onShareContext={onShareContext}
            liveSessionIds={liveSessionIds}
            onRestore={(cwd, cmd, title, agentId) =>
              addTerminal(
                cwd,
                cmd,
                title,
                AGENT_CLIS.find((c) => c.id === agentId)?.icon,
              )
            }
            onOpenInstructions={openInstructions}
            onOpenClaim={openClaim}
            onNotice={onNotice}
            attentionFor={attentionFor}
          />
        );
      case "research-list":
        return (
          <ResearchPanel page projectId={project.id} onOpen={(e) => openResearch(e.id, e.title)} onStart={(q) => void startResearch(q)} canStart={AGENT_CLIS.some((c) => getInstalled()[c.bin])} />
        );
      case "notes-list":
        return (
          <NotesPanel page projectId={project.id} projectName={project.name} roots={roots} onOpen={(n) => openNote(n.id, n.title)} />
        );
      case "prs-list":
        return (
          <PrsPanel page localRepos={repoPaths} projectFor={(repo) => repoPaths.includes(repo) ? project.name : undefined} onOpen={(repo, pr) => openPr(repo, pr)} onQuickTask={startPrQuickTask} relay={relay} onNotice={onNotice} onOpenChat={openChat} />
        );
      case "issues-list":
        return (
          <TicketsPanel page components={project.components.map((c) => ({ label: c.label, path: c.path }))} agentTargets={agentTargets} installed={installed} onStartWork={startTicketWork} onSendToAgent={sendTicketToAgent} onResearch={(t) => void researchTicket(t)} onOpenTicket={openTicket} onOpenIntegrations={() => window.dispatchEvent(new CustomEvent("canopy:open-settings", { detail: { tab: "integrations" } }))} />
        );
      case "task-history":
        return (
          <TaskHistoryView
            projectId={project.id}
            projectName={project.name}
            // Re-runs the stored brief rather than the task definition: a
            // built-in's payload came from the surface it was clicked on
            // (a branch tab, a PR), which is long gone — but the brief that
            // payload produced was recorded, and it says everything.
            onRunAgain={(run: TaskRun) =>
              runAdhocTask(run.brief, run.cwd, run.label)
            }
            onContinueSession={continueTaskSession}
            onOpenFile={(path) => void openFile(path)}
            focus={tab.focus}
          />
        );
      case "mcp":
        return <McpView server={tab.server} onNotice={onNotice} />;
      case "claim":
        return (
          <ClaimView
            claimId={tab.claimId}
            fallback={tab.claim}
            active={tab.id === activeTabId && visible}
            // The claim's own pty when it names one (exact, and it survives
            // an agent that cd'd into a subdirectory); the cwd parse only for
            // claims recorded before the field existed. Either way the page
            // only offers the jump when there is something to jump to.
            ownerPtyId={claimOwnerPty(tab.claim, projectStats, thisInstance)}
            onJumpToPty={jumpToPty}
            onOpenFile={(path) => void openFile(path)}
            onOpenClaim={openClaim}
            onNotice={onNotice}
          />
        );
      case "instructions":
        return (
          <InstructionsView
            roots={roots}
            installed={installed}
            focus={tab.focus}
            active={tab.id === activeTabId && visible}
            onNotice={onNotice}
          />
        );
      case "chat":
        return (
          <ChatView
            peer={tab.peer}
            title={tab.name}
            relay={relay}
            onNotice={onNotice}
          />
        );
      case "collab": {
        const session = relay.collab.get(tab.doc);
        return session instanceof GuestSession ? (
          <CollabView
            session={session}
            ownerName={tab.ownerName}
            onNotice={onNotice}
          />
        ) : (
          <div className="editor-empty">
            <h2>{tab.name}</h2>
            <p>This live session has ended.</p>
          </div>
        );
      }
      case "shared-project":
        return (
          <SharedProjectView
            name={tab.name}
            ownerName={tab.ownerName}
            paths={relay.collab.joinedProjects.get(tab.doc)?.paths ?? []}
            onOpen={(relPath) => relay.collab.openProjectFile(tab.doc, relPath)}
          />
        );
      case "file": {
        // Only markdown, and only a file that is not already an entry: loose
        // notes in the repo are research that predates the store, and this is
        // how one gets adopted without anybody retyping it.
        const cta = /\.(md|markdown)$/i.test(tab.file.path) ? (
          <ResearchImportCta
            projectId={project.id}
            projectName={project.name}
            roots={roots}
            path={tab.file.path}
            onOpen={(id) => openResearch(id, tab.file.name)}
            onNotice={onNotice}
          />
        ) : null;
        // It floats over whichever view FileView picks, but the diff views own
        // that corner already — there it rides in their toolbar instead, so it
        // stops landing on top of Split/Unified and Edit file.
        const inToolbar = hasDiffToolbar(tab.file);
        return (
          <div className="file-tab-wrap">
            {!inToolbar && cta}
            <FileView
            toolbarExtra={inToolbar ? cta : undefined}
            file={tab.file}
            onCursor={
              // Only a shared file broadcasts a caret; every other tab passes
              // undefined and the subscription in MonacoEditor short-circuits.
              sharedDocFor(tab.file.path)
                ? (anchor, head) => sendOwnerCursor(tab.file.path, anchor, head)
                : undefined
            }
            onSave={() => void saveFile(tab.file.path)}
            onDirty={(dirty) => {
              if (tab.file.dirty !== dirty) patchFile(tab.file.path, { dirty });
            }}
            onAcceptExternal={() => acceptExternal(tab.file.path)}
            onKeepMine={() => keepMine(tab.file.path)}
            onCloseDiff={() =>
              patchFile(tab.file.path, { view: "source", diffOriginal: null })
            }
            onOpenAnyway={() => void openFile(tab.file.path, { force: true })}
            diffAgentBar={
              <AgentQueryBar
                placeholder="Ask an agent about this file's changes…"
                onRunTask={(query) => {
                  const dir = repoForFile(tab.file.path);
                  if (!dir)
                    return onNotice("No git repository in this project.");
                  runAdhocTask(
                    fileDiffContext(tab.file.path, query),
                    dir,
                    tab.file.name,
                  );
                }}
                tasks={
                  hasTasksToList({ saved: project.customTasks })
                    ? () =>
                        taskRows(
                          `About the changes in \`${tab.file.path}\`: `,
                          repoForFile(tab.file.path) ?? "",
                        )
                    : undefined
                }
              />
            }
            />
          </div>
        );
      }
    }
  }

  const activeTerminalGroup =
    activeTermTab?.paneGroup != null
      ? terminalGroups[activeTermTab.paneGroup]
      : undefined;
  const activeTerminalLayout = activeTerminalGroup
    ? layoutSplit(activeTerminalGroup.root, activeTerminalGroup.zoomedTabId)
    : null;
  const activePaneRects = new Map(
    activeTerminalLayout?.panes.map((pane) => [pane.tabId, pane]) ?? [],
  );

  const startPaneResize = useCallback(
    (divider: SplitDivider, event: React.PointerEvent<HTMLDivElement>) => {
      if (!activeTerminalGroup || !contentRef.current) return;
      event.preventDefault();
      const groupId = activeTerminalGroup.id;
      const content = contentRef.current.getBoundingClientRect();
      const grip = event.currentTarget;
      grip.setPointerCapture?.(event.pointerId);
      let frame = 0;
      let pendingRatio = 0.5;
      const move = (e: PointerEvent) => {
        const x = (e.clientX - content.left) / content.width;
        const y = (e.clientY - content.top) / content.height;
        pendingRatio =
          divider.axis === "horizontal"
            ? (x - divider.parentLeft) / divider.parentWidth
            : (y - divider.parentTop) / divider.parentHeight;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setTerminalGroups((prev) => {
            const group = prev[groupId];
            if (!group) return prev;
            const next = {
              ...prev,
              [groupId]: {
                ...group,
                root: updateSplitRatio(group.root, divider.nodeId, pendingRatio),
              },
            };
            terminalGroupsRef.current = next;
            return next;
          });
        });
      };
      const up = () => {
        if (frame) cancelAnimationFrame(frame);
        if (grip.hasPointerCapture?.(event.pointerId))
          grip.releasePointerCapture(event.pointerId);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [activeTerminalGroup],
  );

  const mainArea = (
    <div className="project-main">
      {tabMenu.menu && (
        <ContextMenu
          x={tabMenu.menu.x}
          y={tabMenu.menu.y}
          items={tabMenu.menu.items}
          onClose={tabMenu.close}
        />
      )}
      {termMenu.menu && (
        <ContextMenu
          x={termMenu.menu.x}
          y={termMenu.menu.y}
          items={termMenu.menu.items}
          onClose={termMenu.close}
        />
      )}
      <PaneBar
        tabGroups={tabGroups}
        stripDrag={stripDrag}
        stripRef={stripRef}
        paneRef={contentRef}
        termText={termTailFor}
        openStacks={openStacks}
        onToggleStack={toggleStack}
        stripTabs={stripTabs}
        activeTabId={activeVisualTabId}
        flashTabId={
          tabs.find((t) => t.id === flashTabId)?.type === "terminal" &&
          (tabs.find((t) => t.id === flashTabId) as TermSubTab | undefined)?.paneGroup
            ? stripTabs.find(
                (t) =>
                  t.type === "terminal" &&
                  t.paneGroup ===
                    (tabs.find((x) => x.id === flashTabId) as TermSubTab).paneGroup,
              )?.id ?? flashTabId
            : flashTabId
        }
        renamingTabId={renamingTabId}
        renameDraft={renameDraft}
        collabPaths={collabPaths}
        isAgentTab={isAgentTab}
        tabState={tabState}
        tabRing={(t) =>
          tabs.some(
            (member) =>
              member.type === "terminal" &&
              (member.id === t.id ||
                (Boolean(t.paneGroup) && member.paneGroup === t.paneGroup)) &&
              member.ptyId != null &&
              ringFor(attention.get(member.ptyId) ?? NO_ATTENTION),
          )
        }
        account={accountBanner}
        profileLabels={profileLabels}
        shellChips={shellChips}
        runChips={runChips}
        runSummary={runSummary}
        shellMenuOpen={shellMenuOpen}
        setShellMenuOpen={setShellMenuOpen}
        runMenuOpen={runMenuOpen}
        setRunMenuOpen={setRunMenuOpen}
        activeSection={activeSection}
        activeFileKind={activeFileTab?.file.kind}
        activeFileView={activeFileTab?.file.view}
        isSharedFile={isSharedFile}
        isRelayConnectedWithPeers={isRelayConnectedWithPeers}
        cliMenuOpen={cliMenuOpen}
        setCliMenuOpen={setCliMenuOpen}
        installed={installed}
        cliUpdates={cliUpdates}
        shareMenuOpen={shareMenuOpen}
        setShareMenuOpen={setShareMenuOpen}
        shareProjectMenuOpen={shareProjectMenuOpen}
        setShareProjectMenuOpen={setShareProjectMenuOpen}
        relayMembers={peerMembers}
        isProjectShared={isProjectShared}
        isTerminalTab={activeTermTab !== null}
        onSelectTab={onSelectTab}
        onTabContextMenu={onTabContextMenu}
        onCloseTab={closeVisualTab}
        onCommitRename={commitRename}
        onCancelRename={cancelRename}
        onRenameDraftChange={setRenameDraft}
        showHints={tabHints}
        onNewShell={onNewShell}
        onClearScrollback={onClearScrollback}
        onHardReset={onHardReset}
        onToggleView={onToggleView}
        onShareFile={onShareFile}
        onShareProject={onShareProject}
        onOpenPreview={openPreview}
        onLaunchCli={onLaunchCli}
        onRunCliUpdate={onRunCliUpdate}
        onRefreshInstalled={refreshInstalled}
        onRefreshUpdates={refreshUpdates}
        onOpenAllTabs={onOpenAllTabs}
        activeTabElRef={activeTabElRef}
      />
      {fleetLaunchNote && (
        <div
          className={`fleet-launch-note fleet-launch-note-${fleetLaunchNote.kind}`}
          role={fleetLaunchNote.kind === "unusable" ? "alert" : "status"}
        >
          <span>{fleetLaunchNote.text}</span>
          <button
            type="button"
            aria-label="Dismiss fleet launch note"
            onClick={() => setFleetLaunchNote(null)}
          >
            ×
          </button>
        </div>
      )}
      <div className="project-content" ref={contentRef}>
        {tabs
          .filter((t): t is TermSubTab => t.type === "terminal")
          .map((tab) => {
            const softClosed = pendingAgentIds.has(tab.id);
            const group = tab.paneGroup
              ? terminalGroups[tab.paneGroup]
              : undefined;
            const pane = group?.id === activeTerminalGroup?.id
              ? activePaneRects.get(tab.id)
              : undefined;
            const grouped = Boolean(group && leafIds(group.root).length > 1);
            const paneAgent =
              tab.ptyId != null
                ? identifyAgent(statsByPty.get(tab.ptyId)?.agent_hint)
                : null;
            const shown =
              !softClosed &&
              visible &&
              (pane != null || (!grouped && tab.id === activeTabId));
            const paneStyle: CSSProperties = pane
              ? {
                  display: "block",
                  position: "absolute",
                  left: `${pane.left * 100}%`,
                  top: `${pane.top * 100}%`,
                  width: `${pane.width * 100}%`,
                  height: `${pane.height * 100}%`,
                }
              : { display: shown ? "block" : "none" };
            return (
            <div
              key={tab.id}
              // Which tab's pane this is, for the switcher's thumbnails: they
              // are clones of the live host, and a hidden host has to be
              // findable without the pane knowing anything about them.
              data-tab-id={tab.id}
              className={`fill term-host ${grouped ? "term-host-multiplexed" : ""} ${tab.id === activeTabId ? "term-host-focused" : ""}`}
              style={paneStyle}
              onPointerDown={() => {
                if (!group || group.activeTabId === tab.id) return;
                const next = { ...group, activeTabId: tab.id };
                terminalGroupsRef.current = {
                  ...terminalGroupsRef.current,
                  [group.id]: next,
                };
                setTerminalGroups(terminalGroupsRef.current);
                setActiveTabId(tab.id);
              }}
              // Selected text is a task waiting to be written down — an error,
              // a TODO the shell just printed, a command worth automating.
              // Right-click offers to make one; without a selection the event
              // passes through untouched.
              onContextMenu={(e) => {
                const sel = termHandles.current
                  .get(tab.id)
                  ?.getSelection()
                  .trim();
                if (!sel) return;
                termMenu.open(e, [taskMenu(sel)]);
              }}
            >
              {grouped && (
                <div className="multiplex-pane-head">
                  {paneAgent?.id ? (
                    <AgentIcon id={paneAgent.id} size={12} />
                  ) : (
                    <TerminalIcon size={12} />
                  )}
                  <span
                    className={`tab-status tab-status-${lifeForPty(tab.ptyId).state} ${
                      tab.ptyId != null &&
                      ringFor(attention.get(tab.ptyId) ?? NO_ATTENTION)
                        ? "tab-status-unread"
                        : ""
                    }`}
                    aria-hidden
                  />
                  <span className="multiplex-pane-title">
                    {tab.customTitle ?? tab.title}
                  </span>
                  <span className="multiplex-pane-path" title={tab.cwd}>
                    {basename(tab.cwd)}
                  </span>
                  <button
                    type="button"
                    className="multiplex-pane-action"
                    title="Split right"
                    onClick={(e) => {
                      e.stopPropagation();
                      const pending = { sourceTabId: tab.id, axis: "horizontal" as const };
                      pendingSplitRef.current = pending;
                      setPendingSplit(pending);
                      setLauncherOpen(true);
                    }}
                  >
                    ◫
                  </button>
                  <button
                    type="button"
                    className="multiplex-pane-action"
                    title="Move pane to its own tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      breakPaneOut(tab.id);
                    }}
                  >
                    ↗
                  </button>
                  <button
                    type="button"
                    className="multiplex-pane-action"
                    title="Close pane"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id, "user");
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
              <TermPorts
                ptyId={tab.ptyId}
                stats={stats}
                onPreview={openPreview}
              />
              <Term
                // epoch remounts the Term (fresh PTY) when a run tab restarts
                key={`${tab.id}:${tab.epoch ?? 0}`}
                ref={(h) => {
                  termHandles.current.set(tab.id, h);
                }}
                cwd={tab.cwd}
                active={!softClosed && tab.id === activeTabId && visible}
                attachId={tab.attachId}
                killAttachedOnClose={tab.killAttachedOnClose}
                // A run tab hands its command to the shell to run-and-exit
                // (runCommand) so the pty's exit code is the command's own —
                // one-shot runs (build, install) report truthfully instead of
                // sitting at a prompt looking "running" forever — and it's
                // correct on cmd.exe / PowerShell, not just POSIX. A non-run tab
                // types its command (e.g. launching an agent CLI).
                //
                // Micro-tasks go the runCommand way too, for a different
                // reason: their brief is a whole paragraph on one line, and a
                // command that long typed at a shell that is still starting
                // loses its Enter to zsh's line editor — the task sat unrun at
                // a prompt. As an argv it never touches the tty.
                initialCommand={tab.run || tab.micro ? undefined : tab.command}
                runCommand={
                  (tab.run || tab.micro) && tab.command
                    ? tab.command
                    : undefined
                }
                env={tab.env}
                runId={tab.micro?.runId}
                attemptId={tab.micro?.attemptId}
                onSpawned={(ptyId) => {
                  // A freshly spawned pty is alive by definition, so clear any
                  // stale exited/failed state. Restart kills the old pty and
                  // remounts a beat later; that kill's late pty:exit can land in
                  // the gap and wrongly mark the tab failed while THIS new
                  // process is the one now running (a red ✕ on a live server).
                  patchTab(tab.id, {
                    ptyId,
                    exited: false,
                    exitCode: undefined,
                  });
                  if (tab.micro?.runId) updateTaskRun(tab.micro.runId, { ptyId });
                  const prompt = pendingTerminalPrompts.current.get(tab.id);
                  if (prompt == null) return;
                  pendingTerminalPrompts.current.delete(tab.id);
                  // The shell has only just started the CLI. Give its TUI time
                  // to enter raw mode, then type and submit as separate writes
                  // so autocomplete cannot swallow the Enter.
                  setTimeout(() => {
                    void ipc.ptyWrite(ptyId, prompt);
                    setTimeout(() => void ipc.ptyWrite(ptyId, "\r"), 250);
                  }, 2500);
                }}
                onExited={(code) => {
                  // Shell tabs close on exit; run tabs stay so the output and
                  // exit status remain readable.
                  if (tab.run) {
                    patchTab(tab.id, {
                      exited: true,
                      exitCode: code,
                      ptyId: null,
                    });
                    // An installer or updater finishing is the moment
                    // "install" labels and update badges go stale — re-probe
                    // right now, not on a timer. Announced rather than
                    // refreshed in place: what changed is on this machine, and
                    // every open project draws its own launcher from its own
                    // probe, so the other tabs must hear about it too.
                    if (
                      tab.command?.startsWith("brew upgrade ") ||
                      AGENT_CLIS.some(
                        (c) =>
                          c.install != null &&
                          (c.install === tab.command ||
                            updateCommand(c) === tab.command),
                      )
                    ) {
                      announceCliInstallsChanged();
                    }
                    // A chore that worked has nothing left to show: let the ✓
                    // land, then take the chip away. Re-checked when the timer
                    // fires, because "Run again" in the meantime puts a live
                    // process on this same tab.
                    scheduleReap(
                      tab.id,
                      code,
                      tab,
                      reapTimers.current,
                      (id) =>
                        tabsRef.current.find(
                          (t): t is TermSubTab =>
                            t.type === "terminal" && t.id === id,
                        ),
                      closeTab,
                    );
                  } else closeTab(tab.id);
                }}
                onTitle={(title) =>
                  patchTab(tab.id, {
                    // cmd.exe titles itself with its own full path, which every
                    // chip then truncates to "C:\\Windows\\syste…".
                    title: shellTitle(title || tab.command || "shell"),
                  })
                }
                onNotify={(notice) => {
                  // Only a ring if you aren't already looking at it — a ring on
                  // the tab you're watching is noise. The notice itself is
                  // still the tab's, but where the tab *sits* is no longer this
                  // decision's to make: a bell is unseen activity, and unseen
                  // activity selects no bucket.
                  patchTab(tab.id, { notice });
                  if (
                    tab.ptyId != null &&
                    !(tab.id === activeTabId && visible)
                  ) {
                    pushAttention(
                      tab.ptyId,
                      { t: "osc", at: Date.now(), body: notice },
                      agentIdForCommand(tab.command) ?? null,
                    );
                  }
                }}
              />
              {livePips
                .filter((pip) => pip.ptyId === tab.ptyId)
                .map(({ tabId, ptyId }) => {
                  const preview = tabs.find(
                    (item): item is PreviewSubTab =>
                      item.type === "preview" && item.id === tabId,
                  );
                  if (!preview?.url) return null;
                  const agent = agentTargets.find((item) => item.ptyId === ptyId);
                  const slot = shownBrowserPips.findIndex(
                    (pip) => pip.tabId === tabId,
                  );
                  return (
                    <AgentBrowserPip
                      key={tabId}
                      tabId={tabId}
                      url={preview.url}
                      agentId={agent?.agentId ?? "agent"}
                      agentTitle={agent?.title || "Agent browser"}
                      supported={browserEngine === "webview"}
                      slot={Math.max(0, slot)}
                      hidden={slot < 0}
                      onClose={() => {
                        dismissedBrowserPips.current.add(tabId);
                        setBrowserPips((prev) =>
                          prev.filter((pip) => pip.tabId !== tabId),
                        );
                      }}
                    />
                  );
                })}
            </div>
            );
          })}
        {activeTerminalGroup &&
          activeTerminalLayout?.dividers.map((divider) => (
            <div
              key={divider.nodeId}
              className={`multiplex-divider multiplex-divider-${divider.axis}`}
              style={{
                left: `${divider.left * 100}%`,
                top: `${divider.top * 100}%`,
                width: `${divider.width * 100}%`,
                height: `${divider.height * 100}%`,
              }}
              onPointerDown={(event) => startPaneResize(divider, event)}
              onDoubleClick={equalizePanes}
              role="separator"
              aria-orientation={
                divider.axis === "horizontal" ? "vertical" : "horizontal"
              }
              title="Drag to resize · double-click to equalize"
            />
          ))}
        {paneDrop && (
          <div
            className="pane-drop-preview"
            style={{
              left: `${paneDrop.rect.left * 100}%`,
              top: `${paneDrop.rect.top * 100}%`,
              width: `${paneDrop.rect.width * 100}%`,
              height: `${paneDrop.rect.height * 100}%`,
            }}
            aria-hidden
          />
        )}
        {/* Doc tabs, mounted for as long as they're open and shown by display
            like the terminals above — see docTabView. Each pane carries its own
            boundary: a view throwing (a PR diff, an editor, a ticket) must not
            take the app — or the running terminals beside it — down, and only
            the offending tab shows the fallback ("Reload this panel" clears it).
            Terminals stay outside: catching around them would kill their PTYs. */}
        {docTabs.map((tab) => (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            className="fill doc-host"
            style={hostStyle(
              tab.id === activeTabId && visible,
              tab.type === "preview" && browserEngine === "proxy",
            )}
          >
            <ErrorBoundary label="this tab">{paneFor(tab)}</ErrorBoundary>
          </div>
        ))}
        {visibleTabs.length === 0 && (
          <div className="editor-empty">
            <h2>{project.name}</h2>
            {/* Missing foundations the CLI installers themselves need (Node for
                `npm install -g …`, git for everything). One-click install runs
                the OS-correct command in a terminal, same as a CLI install, and
                the tab's exit re-probes so the banner clears itself. */}
            {PREREQS.some((p) => prereqs[p.bin] === false) && (
              <div className="prereq-banner">
                <span className="prereq-note">
                  Missing prerequisites — the agent CLIs need these:
                </span>
                <div className="prereq-actions">
                  {PREREQS.filter((p) => prereqs[p.bin] === false).map((p) => (
                    <button
                      key={p.id}
                      className="prereq-install"
                      title={`For ${p.why}\nruns: ${p.install[currentPlatform()]}`}
                      onClick={() =>
                        components[0] &&
                        addTerminal(
                          components[0].path,
                          p.install[currentPlatform()],
                          `install ${p.name}`,
                          "⬇",
                          "chore",
                        )
                      }
                    >
                      Install {p.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* Same launchers as the ＋ menu, surfaced where the eye already is. */}
            <div className="launch-grid">
              <button
                className="launch-card"
                onClick={() => components[0] && addTerminal(components[0].path)}
              >
                <TerminalIcon size={26} />
                <span>Shell</span>
              </button>
              {AGENT_CLIS.map((cli) => (
                <button
                  key={cli.id}
                  className="launch-card"
                  onClick={() => launchCli(cli)}
                  title={
                    installed[cli.bin]
                      ? cli.bin
                      : cli.install
                        ? `not installed — runs: ${cli.install}`
                        : `${cli.bin} isn't on this machine — check Settings → Agents`
                  }
                >
                  <AgentIcon id={cli.id} size={26} />
                  <span>{cli.name}</span>
                  {/* An entry with no installer can only say what's true: the
                      binary isn't there. Offering "install" would be a button
                      that cannot work. */}
                  {!installed[cli.bin] && (
                    <span className="launch-install">
                      {cli.install ? "install" : "not found"}
                    </span>
                  )}
                  {installed[cli.bin] && cliUpdates[cli.bin]?.hasUpdate && (
                    <span
                      className="launch-update"
                      title={`${cliUpdates[cli.bin]?.installed} → ${cliUpdates[cli.bin]?.latest} — click to update`}
                      onClick={(e) => {
                        // The card launches; only the badge updates. A span
                        // because a button can't nest inside the card button.
                        e.stopPropagation();
                        runCliUpdate(cli);
                      }}
                    >
                      ⇡ {cliUpdates[cli.bin]?.latest}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {resumeCards.length > 0 && (
              <div className="resume-block">
                <div className="resume-head">
                  <span>
                    Pick up where you left off
                    <span className="badge">{resumeTerminalCount} terminals</span>
                  </span>
                  <span className="resume-head-actions">
                    <Button
                      title={
                        chosen.length > 0
                          ? `Reopen ${resumeItems
                              .filter((item) => chosen.includes(item.key))
                              .reduce((sum, item) => sum + item.count, 0)} selected terminals`
                          : "Reopen everything below — agent sessions with their history, terminals with their command"
                      }
                      onClick={() =>
                        runResume(
                          chosen.length > 0
                            ? resumeItems.filter((i) => chosen.includes(i.key))
                            : resumeItems,
                        )
                      }>
                      {chosen.length > 0
                        ? `Restore selected (${resumeItems
                            .filter((item) => chosen.includes(item.key))
                            .reduce((sum, item) => sum + item.count, 0)})`
                        : "Restore all"}
                    </Button>
                    <Button icon
                      title="Forget everything here — remembered terminals and restorable agent sessions — for this project"
                      onClick={() => {
                        forgetTerminals(project.id);
                        setRemembered([]);
                        // Every row's whole directory, not just the session it
                        // happens to be showing — otherwise "forget everything
                        // here" leaves the next-oldest behind in each.
                        forgetSessions(
                          restorable.flatMap((r) => [r.digest, ...r.superseded]),
                        );
                        setRestorable([]);
                      }}>
                      ✕
                    </Button>
                  </span>
                </div>
                {resumeCards.map((card) => (
                  <div
                    key={card.key}
                    className={card.group ? "resume-group" : "resume-standalone"}
                  >
                    {card.group && (
                      <div className="resume-group-head">
                        {pickBox(card.key)}
                        <span className="tab-multiplex-icon" aria-hidden>▦</span>
                        <strong>Multiplexed agents</strong>
                        <span className="resume-branch">{card.leaves.length} panes</span>
                        <Button
                          size="sm"
                          variant="accent"
                          onClick={() => void restoreResumeCard(card)}
                        >
                          Resume group
                        </Button>
                      </div>
                    )}
                    {card.leaves.map((leaf) => {
                      const r = leaf.restorable;
                      const t = leaf.remembered;
                      const agentId = r?.agentId ?? agentIdForCommand(t?.command);
                      const title = r?.prompt || t?.title || t?.command || "shell";
                      const cwd = r?.cwd ?? t?.cwd ?? "";
                      return (
                        <div
                          key={leaf.key}
                          className="resume-row resume-row-click resume-child"
                          title={`${agentId ?? t?.command ?? "shell"} · ${cwd}`}
                          onClick={() => void restoreResumeCard(card, leaf)}
                        >
                          {!card.group && pickBox(card.key)}
                          {agentId ? (
                            <AgentIcon id={agentId} size={14} />
                          ) : (
                            <TerminalIcon size={13} />
                          )}
                          <span className="resume-prompt">{title}</span>
                          <span className="resume-dir">{basename(cwd)}</span>
                          {r?.digest.branch && (
                            <span className="resume-branch">⑂ {r.digest.branch}</span>
                          )}
                          {r && <span className="resume-age">{ago(r.digest.updated)}</span>}
                          <Button
                            size="sm"
                            variant={!card.group && r ? "accent" : "default"}
                            onClick={(e) => {
                              e.stopPropagation();
                              void restoreResumeCard(card, leaf);
                            }}
                          >
                            {card.group ? "Resume separately" : r ? "Resume" : "Reopen"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Agent Workspace — a full-screen glassmorphic overlay for the active
            agent terminal, opened from a handle on the terminal's right edge.
            An OVERLAY, never a layout panel or a new tab: the terminal
            underneath stays mounted (unmounting a Term kills its PTY) and shows
            faintly through the frosted glass. The layer stays in the DOM so it
            can fade; the heavy AgentWorkspaceView only mounts while open. */}
        {agentTermWs && (
          <>
            {!wsDrawerOpen && (
              <button
                className="workspace-handle"
                title="Open agent workspace — files, diffs, commits & PR"
                aria-label="Open agent workspace"
                onClick={() => setWsDrawerOpen(true)}
              >
                <AgentIcon id={agentTermWs.agent} size={15} />
                <span className="workspace-handle-label">Workspace</span>
              </button>
            )}
            <div
              className={`workspace-overlay-layer ${wsDrawerOpen ? "open" : ""}`}
              aria-hidden={!wsDrawerOpen}
            >
              <section
                className="workspace-overlay"
                role="dialog"
                aria-modal="true"
                aria-label="Agent workspace"
              >
                {/* No chrome header here — AgentWorkspaceView's own banner is
                    the single header, and it renders the close button (passed
                    below) so the agent name/branch aren't repeated twice.
                    The extra wrapper carries the entrance animation: it must not
                    be the pane holding the frost, because a transform or a
                    part-way opacity above backdrop-filter switches the blur
                    off. */}
                <div className="workspace-overlay-in">
                  <div className="workspace-overlay-body">
                    {wsDrawerOpen && (
                      <AgentWorkspaceView
                        key={agentTermWs.ptyId}
                        repo={agentTermWs.repo}
                        agent={agentTermWs.agent}
                        cwd={agentTermWs.cwd}
                        sessionId={agentTermWs.sessionId}
                        digest={agentTermWs.digest}
                        onOpenCommit={openCommit}
                        onOpenPr={openPr}
                        onOpenTerminal={(cwd, label) =>
                          addTerminal(cwd, undefined, label)
                        }
                        onNotice={onNotice}
                        onMessageAgent={(text) =>
                          messageAgent({
                            ptyId: agentTermWs.ptyId,
                            sessionId: agentTermWs.sessionId,
                            agentId: agentTermWs.agent,
                            cwd: agentTermWs.cwd,
                            text,
                          })
                        }
                        onFocusAgent={jumpToPty}
                        onClose={() => setWsDrawerOpen(false)}
                        onRaisePrTask={
                          agentTermWs.repo
                            ? (branch, worktree) =>
                                void startMicroTask(
                                  raisePrTask,
                                  {
                                    repo: agentTermWs.repo as string,
                                    branch,
                                    worktree,
                                  },
                                  "",
                                )
                            : undefined
                        }
                        onReviewPrTask={
                          agentTermWs.repo
                            ? (pr) =>
                                void startMicroTask(
                                  reviewPrTask,
                                  { repo: agentTermWs.repo as string, pr },
                                  "",
                                )
                            : undefined
                        }
                        onAddressPrCommentsTask={
                          agentTermWs.repo
                            ? (pr) =>
                                void startMicroTask(
                                  addressPrCommentsTask,
                                  { repo: agentTermWs.repo as string, pr },
                                  "",
                                )
                            : undefined
                        }
                        onRunSavedTask={(task, dir) =>
                          void startMicroTask(customTaskDef(task), { dir }, "")
                        }
                        savedTasks={project.customTasks ?? []}
                        onRunOneOff={(brief, dir) => runAdhocTask(brief, dir)}
                      />
                    )}
                  </div>
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );

  // ---------- side panels ----------
  // The rail has the same problem the doc tabs had: a panel unmounted the
  // moment you picked another icon, so coming back collapsed the file tree you
  // had expanded, threw away a commit message you had half-typed, and refetched
  // the ticket list. They stay mounted now, and are display-toggled — but only
  // from the first time each is opened, so a project never pays for a panel you
  // never look at (trackers talks to GitHub/Jira on mount).
  //
  // `display: contents` rather than block: the panels are flex children of
  // .sidebar and size themselves with flex, so the wrapper has to disappear
  // from the layout rather than become a box in it.
  //
  // Inactive panels reuse their last element for the same reason doc panes do —
  // a hidden panel has nothing to say. It still updates itself if its own state
  // changes (a file watcher firing, a fetch landing); the bailout only skips
  // re-rendering it from here. What it must NOT do is keep polling while nobody
  // is looking, so the two panels that poll take a `visible` prop.
  const [sideSeen, setSideSeen] = useState<SideTab[]>([sideTab]);
  useEffect(() => {
    setSideSeen((prev) => (prev.includes(sideTab) ? prev : [...prev, sideTab]));
  }, [sideTab]);
  const sidePanes = useRef(
    new Map<SideTab, { active: boolean; el: ReactNode }>(),
  );
  const sidePane = (key: SideTab, build: () => ReactNode) => {
    if (!sideSeen.includes(key)) return null;
    const active = sideTab === key;
    const cached = sidePanes.current.get(key);
    // Rebuilt while in front, and once more on the way out — that last build is
    // what hands a polling panel `visible: false`. After that it sits still.
    if (cached && !active && !cached.active) {
      return <div style={{ display: "none" }}>{cached.el}</div>;
    }
    const el = build();
    sidePanes.current.set(key, { active, el });
    return <div style={{ display: active ? "contents" : "none" }}>{el}</div>;
  };

  const sidePanel = (
    <div className="sidebar">
      {compMenu.menu && (
        <ContextMenu
          x={compMenu.menu.x}
          y={compMenu.menu.y}
          items={compMenu.menu.items}
          onClose={compMenu.close}
        />
      )}
      {reloadAsk && (
        <Dialog
          variant="accent"
          title={`Reload agents as ${reloadAsk.label}?`}
          body="An agent keeps the account it started on until it is reloaded. Reloading picks up this account's own work in the same folder — the conversations already open stay where they are, on the account that made them."
          meta={`${reloading(reloadAsk.plan).length} of ${reloadAsk.plan.length} agents in this project`}
          dismissLabel="Leave them"
          onDismiss={() => setReloadAsk(null)}
          actions={[
            {
              label: `Reload ${reloading(reloadAsk.plan).length}`,
              primary: true,
              onClick: () => void runReload(reloadAsk),
            },
          ]}
        >
          <div className="reload-plan">
            {reloadAsk.plan.map((item) => (
              <div
                key={item.agent.tabId}
                className={`reload-row ${item.action ? "" : "reload-row-skip"}`}
              >
                <AgentIcon id={item.agent.agentId} size={13} />
                <span className="reload-agent">{item.agent.label}</span>
                <span className="reload-what">{reloadSummary(item)}</span>
              </div>
            ))}
          </div>
        </Dialog>
      )}
      {rootCreate && (
        <Dialog
          variant="accent"
          title={`New ${rootCreate.kind === "dir" ? "folder" : "file"} in ${basename(rootCreate.dir)}`}
          meta={rootCreate.dir}
          dismissLabel="Cancel"
          onDismiss={() => setRootCreate(null)}
          actions={[
            {
              label: "Create",
              primary: true,
              disabled: !rootCreate.value.trim(),
              onClick: () => void submitRootCreate(),
            },
          ]}
        >
          <input
            // Beats the primary button to focus: the name is what you came to
            // type, and Enter still commits from inside the field.
            data-autofocus
            className="git-branch-input"
            placeholder={rootCreate.kind === "dir" ? "folder name" : "name.ext"}
            value={rootCreate.value}
            onChange={(e) =>
              setRootCreate((p) => (p ? { ...p, value: e.target.value } : p))
            }
          />
        </Dialog>
      )}
      {sidePane("files", () => (
        <div
          className="components-panel"
          // The empty area below the file list still belongs to the last
          // component's tree. FileTree rows/containers stopPropagation, so this
          // fires only for genuinely blank space.
          onContextMenu={(e) => {
            const dir = components[components.length - 1]?.path;
            if (!dir) return;
            compMenu.open(e, [
              {
                label: "New File…",
                onClick: () => setRootCreate({ dir, kind: "file", value: "" }),
              },
              {
                label: "New Folder…",
                onClick: () => setRootCreate({ dir, kind: "dir", value: "" }),
              },
            ]);
          }}
        >
          <div className="side-panel-head">
            <span>Components</span>
            <Button icon title="Edit project" onClick={onEdit}>
              ⚙
            </Button>
          </div>
          {/* Which checkout these files come from. Always visible while a
              worktree is active, so you can never edit the wrong tree without
              knowing it. */}
          {worktreeEnv && (
            <div
              className="wt-env-tag"
              title={`Files, search and new terminals are using this worktree:\n${worktreeEnv.path}`}
            >
              <span className="wt-env-mark">⑂</span>
              <span className="wt-env-branch">{worktreeEnv.branch}</span>
              <Button icon
                title="Go back to your own checkout"
                onClick={() => void leaveWorktreeEnv(worktreeEnv)}>
                ✕
              </Button>
            </div>
          )}
          {components.map((c) => (
            <div key={`${c.id}:${c.path}`} className="component-section">
              <div
                className="component-header"
                onClick={() =>
                  setOpenSections((prev) => ({
                    ...prev,
                    [c.path]: !sectionOpen(c.path),
                  }))
                }
                onContextMenu={(e) => compMenu.open(e, launcherItems(c.path))}
              >
                <span
                  className={`tree-chevron ${sectionOpen(c.path) ? "tree-chevron-open" : ""}`}
                >
                  <ChevronIcon />
                </span>
                <span className="component-title">{c.label}</span>
                <span className="component-actions">
                  <Button icon
                    title={`New terminal in ${c.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      addTerminal(c.path);
                    }}>
                    <TerminalIcon size={13} />
                  </Button>
                </span>
              </div>
              {sectionOpen(c.path) && (
                <>
                  {(c.commands ?? []).filter((cmd) => cmd.command.trim())
                    .length > 0 && (
                    <div className="component-commands">
                      {(c.commands ?? [])
                        .filter((cmd) => cmd.command.trim())
                        .map((cmd) => {
                          const tab = tabs.find(
                            (t): t is TermSubTab =>
                              t.type === "terminal" &&
                              Boolean(t.run) &&
                              t.cwd === c.path &&
                              (t.runCommandId
                                ? t.componentId === c.id && t.runCommandId === cmd.id
                                : t.command === cmd.command),
                          );
                          // An open-but-finished tab isn't running: one-shot
                          // commands end on their own and must say so.
                          const running = tab && !tab.exited ? tab : undefined;
                          const finished = tab?.exited ? tab : undefined;
                          const start = () =>
                            tab
                              ? restartRun(tab.id, {
                                  command: cmd.command,
                                  name: cmd.name || cmd.command,
                                  componentId: c.id,
                                  runCommandId: cmd.id,
                                })
                              : addTerminal(
                                  c.path,
                                  cmd.command,
                                  cmd.name || cmd.command,
                                  "▶",
                                  true,
                                  undefined,
                                  undefined,
                                  true,
                                  undefined,
                                  { componentId: c.id, runCommandId: cmd.id },
                                );
                          const ok = finished?.exitCode === 0;
                          return (
                            <div
                              key={cmd.id}
                              className={`command-run-row ${running ? "command-running" : ""} ${
                                finished
                                  ? ok
                                    ? "command-done"
                                    : "command-failed"
                                  : ""
                              }`}
                              title={
                                running
                                  ? `running — ${cmd.command}`
                                  : finished
                                    ? `${ok ? "finished" : `exited ${finished.exitCode ?? "?"}`} — ${cmd.command}`
                                    : cmd.command
                              }
                              onClick={() =>
                                tab ? setActiveTabId(tab.id) : start()
                              }
                            >
                              {running ? (
                                <LiveDot
                                  size={9}
                                  className="command-live-dot"
                                />
                              ) : finished ? (
                                ok ? (
                                  <CheckIcon size={11} className="command-ok" />
                                ) : (
                                  <FailIcon
                                    size={11}
                                    className="command-fail"
                                  />
                                )
                              ) : (
                                <PlayIcon size={11} className="command-play" />
                              )}
                              <span className="command-run-name">
                                {cmd.name || cmd.command}
                              </span>
                              {finished && !ok && (
                                <span className="command-exit-code">
                                  {finished.exitCode}
                                </span>
                              )}
                              <span
                                className="command-run-actions"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {running ? (
                                  <>
                                    <Button icon
                                      title="Restart"
                                      onClick={() => restartRun(running.id)}>
                                      <RestartIcon size={14} />
                                    </Button>
                                    <Button icon variant="danger"
                                      title="Stop"
                                      onClick={() => {
                                        if (running.ptyId != null)
                                          void ipc.ptyKill(running.ptyId);
                                      }}>
                                      <StopIcon size={13} />
                                    </Button>
                                  </>
                                ) : (
                                  <Button icon
                                    title={finished ? "Run again" : "Run"}
                                    onClick={start}>
                                    {finished ? (
                                      <RestartIcon size={14} />
                                    ) : (
                                      <PlayIcon size={12} />
                                    )}
                                  </Button>
                                )}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  )}
                  <FileTree
                    roots={[c.path]}
                    changedPaths={changedPaths}
                    selectedPath={activeFileTab?.file.path ?? null}
                    onOpenFile={(p) => void openFile(p)}
                    onNotice={onNotice}
                    hideRootHeader
                    taskMenuFor={(p) => taskMenu(`In \`${p}\`: `)}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      {sidePane("servers", () => (
        <ServersPanel
          groups={serverGroups}
          onStart={startServer}
          onRestart={restartRun}
          onStop={(ptyId) => void ipc.ptyKill(ptyId)}
          onOpenRun={setActiveTabId}
          onOpenPreview={(url) => openPreview(url)}
          onNewTerminal={(path) => addTerminal(path)}
          // The agent named on a workspace row is a terminal this project
          // already owns, so this focuses it rather than attaching a new view.
          onOpenAgent={(ptyId) => {
            const tab = tabs.find(
              (t): t is TermSubTab => t.type === "terminal" && t.ptyId === ptyId,
            );
            if (tab) setActiveTabId(tab.id);
          }}
          onEdit={onEdit}
        />
      ))}
      {sidePane("git", () => (
        <GitPanel
          visible={sideTab === "git" && visible && sideOpen}
          components={project.components.map((c) => ({
            label: c.label,
            path: c.path,
          }))}
          activeWorktree={worktreeEnv?.path ?? null}
          serverCwds={serverCwds}
          agentCwds={agentCwds}
          agentsAt={agentsAt}
          onOpenAgent={jumpToPty}
          onOpenPreview={(url) => openPreview(url)}
          onOpenCommit={openCommit}
          onOpenBranch={openBranch}
          onOpenTerminal={(cwd, label) => addTerminal(cwd, undefined, label)}
          onNotice={onNotice}
          branchTaskMenu={(repo, branch, worktree, merged) =>
            taskMenu(
              `On branch ${branch}: `,
              merged
                ? undefined
                : [
                    {
                      id: raisePrTask.id,
                      label: `Raise PR for ${branch}`,
                      icon: raisePrTask.icon,
                      run: () =>
                        void startMicroTask(
                          raisePrTask,
                          { repo, branch, worktree },
                          "",
                        ),
                    },
                  ],
            )
          }
        />
      ))}
      {sidePane("changes", () => (
        <ChangesPanel
          groups={changeGroups}
          loading={changesLoading}
          onOpen={(p) => void openFile(p, { diff: true })}
          onRefresh={() => void refreshChanges()}
          collab={collabChanges}
          onOpenCollab={(p) => void openFile(p, { diff: true })}
          onStage={(repo, paths) =>
            void ipc
              .gitStage(repo, paths)
              .then(() => refreshChanges())
              .catch((err) => onNotice(String(err), "error"))
          }
          onUnstage={(repo, paths) =>
            void ipc
              .gitUnstage(repo, paths)
              .then(() => refreshChanges())
              .catch((err) => onNotice(String(err), "error"))
          }
          onDiscard={(repo, file) =>
            void ipc
              .gitDiscard(
                repo,
                file.untracked ? [] : [file.path],
                file.untracked ? [file.path] : [],
              )
              .then(() => refreshChanges())
              .catch((err) => onNotice(String(err), "error"))
          }
          onCommit={(repo, message) =>
            ipc
              .gitCommit(repo, message, false)
              .then((msg) => {
                onNotice(msg, "success");
                void refreshChanges();
              })
              .catch((err) => {
                onNotice(String(err), "error");
                throw err;
              })
          }
          onSaveCollab={(p) =>
            void saveFile(p).then(() => {
              relay.collab.markOwnerSaved(p);
              void refreshChanges();
            })
          }
          agentBar={
            <AgentQueryBar
              placeholder="Ask an agent about these changes…"
              onRunTask={(query) => {
                const dir =
                  changeGroups[0]?.repo ?? componentsRef.current[0]?.path;
                if (!dir) return onNotice("No git repository in this project.");
                runAdhocTask(
                  sessionChangesContext(changeContextGroups(), query),
                  dir,
                  "Changes",
                );
              }}
              tasks={
                hasTasksToList({ saved: project.customTasks })
                  ? () =>
                      taskRows(
                        "About the current changes: ",
                        changeGroups[0]?.repo ??
                          componentsRef.current[0]?.path ??
                          "",
                      )
                  : undefined
              }
            />
          }
        />
      ))}
      {sidePane("prs", () => (
        <PrsPanel
          localRepos={repoPaths}
          projectFor={(repo) =>
            repoPaths.includes(repo) ? project.name : undefined
          }
          onOpen={(repo, pr) => openPr(repo, pr)}
          onOpenAll={() => openCollectionPage("prs-list")}
          onQuickTask={startPrQuickTask}
          relay={relay}
          onNotice={onNotice}
          onOpenChat={openChat}
        />
      ))}
      {sidePane("trackers", () => (
        <TicketsPanel
          components={project.components.map((c) => ({
            label: c.label,
            path: c.path,
          }))}
          agentTargets={agentTargets}
          installed={installed}
          onStartWork={startTicketWork}
          onSendToAgent={sendTicketToAgent}
          onResearch={(t) => void researchTicket(t)}
          onOpenTicket={openTicket}
          onOpenIntegrations={() => {
            window.dispatchEvent(
              new CustomEvent("canopy:open-settings", {
                detail: { tab: "integrations" },
              }),
            );
          }}
          onOpenAll={() => openCollectionPage("issues-list")}
        />
      ))}
      {sidePane("team", () => (
        <TeamPanel
          relay={relay}
          onOpenChat={openChat}
          onOpenInboxItem={(item) => void openInboxItem(item)}
          onNotice={onNotice}
        />
      ))}
      {sidePane("tasks", () => (
        <TasksPanel
          components={components.map((c) => ({ label: c.label, path: c.path }))}
          running={runningMicro}
          seed={taskSeed}
          onShow={(t) =>
            t.ptyId != null
              ? showMicroRun(t.ptyId)
              : t.tabId && setActiveTabId(t.tabId)
          }
          onStop={(t) =>
            t.ptyId != null
              ? stopMicroRun(t.ptyId)
              : t.tabId && closeTab(t.tabId)
          }
          onRunCustom={(task: CustomMicroTask, dir: string, query: string) =>
            void startMicroTask(customTaskDef(task), { dir }, query)
          }
          onRunOneOff={(brief: string, dir: string) => runAdhocTask(brief, dir)}
          onOpenHistory={openTaskHistory}
          custom={project.customTasks ?? []}
          onSaveCustom={onSaveCustomTasks}
          projectId={project.id}
        />
      ))}
      {sidePane("notes", () => (
        <NotesPanel
          projectId={project.id}
          projectName={project.name}
          roots={roots}
          onOpen={(n) => openNote(n.id, n.title)}
          onOpenAll={() => openCollectionPage("notes-list")}
        />
      ))}
      {sidePane("research", () => (
        <ResearchPanel
          projectId={project.id}
          onOpen={(e) => openResearch(e.id, e.title)}
          onStart={(q) => void startResearch(q)}
          canStart={AGENT_CLIS.some((c) => getInstalled()[c.bin])}
          onOpenAll={() => openCollectionPage("research-list")}
        />
      ))}
      {sidePane("agents", () => (
        <AgentsPanel
          visible={sideTab === "agents" && visible && sideOpen}
          stats={projectStats}
          hookPath={hookPath}
          pending={pending}
          onDismissPending={onDismissPending}
          onAnswer={answerQuestions}
          onRespond={respondPermission}
          onJumpToTerminal={jumpToTerminal}
          onJumpToPty={jumpToPty}
          onPreviewUrl={openPreview}
          onOpenAgent={(p) => void openAgent(p)}
          activePty={activePty}
          tabNames={tabNames}
          roots={roots}
          shareContext={Boolean(project.shareContext)}
          onShareContext={onShareContext}
          liveSessionIds={liveSessionIds}
          onRestore={(cwd, cmd, title, agentId) =>
            addTerminal(
              cwd,
              cmd,
              title,
              AGENT_CLIS.find((c) => c.id === agentId)?.icon,
            )
          }
          onNotice={onNotice}
          onOpenInstructions={openInstructions}
          onOpenAgentsPage={openAgentsPage}
          onOpenClaim={openClaim}
          installed={installed}
          attentionFor={attentionFor}
        />
      ))}
      {sidePane("tools", () => (
        <McpToolsPanel
          rootsKey={rootsKey}
          visible={sideTab === "tools" && visible && sideOpen}
          onOpen={openMcpServer}
        />
      ))}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`project-view ${vibe ? "project-view-vibe" : ""}`}
      style={{ display: visible ? "flex" : "none" }}
    >
      {/* Rail + panels share a row; the status bar sits below it so it spans the
          full window width (rail + sidebar + main), not just the editor column. */}
      <div className="project-body">
        {!zen && !vibe && (
          <ActivityRail
            sideTab={sideTab}
            open={sideOpen}
            pinned={pinned}
            hoverPeeks={sidePrefs.hover}
            changeBadge={changeCount + collabEditedCount}
            serversBadge={serversRunning}
            prsBadge={prsBadge}
            tasksBadge={runningMicro.length}
            pendingCount={pending.length}
            urgentCount={urgentCount}
            teamBadge={teamBadge}
            relayRole={relay.status.role}
            onSelectTab={selectSideTab}
            onHoverTab={hoverSideTab}
            onHoverCancel={cancelPeekOpen}
            onHoverLeave={leaveSideHover}
            onOpenSettings={openSettings}
            onToggleSidebar={toggleSidebar}
          />
        )}
        {/* Docked (Appearance → "Sidebar as overlay", off): the panel takes a
            column of its own and the main area moves over for it, instead of
            floating above it. It costs a reflow of the main area every time it
            opens — which is what re-wraps the terminals in it — so it is the
            non-default, but it's the right trade for anyone who wants the panel
            up while they work. Same `sidePanel` element either way; only one of
            the two branches renders it. */}
        {!zen && !vibe && !sidePrefs.overlay && (
          <div
            className={`side-dock ${sideOpen ? "open" : ""}`}
            // Collapsed to nothing rather than unmounted, for the same reason
            // the overlay slides out of frame instead of leaving: a panel that
            // unmounts re-fetches on the way back, and the trackers panel
            // mounting means a round trip to GitHub before it can paint.
            style={{ width: sideOpen ? sideWidth : 0 }}
            onMouseEnter={cancelPeekClose}
            onMouseLeave={() => schedulePeekClose()}
          >
            {sidePanel}
          </div>
        )}
        {/* The docked panel's grip is a sibling, not a child. .side-dock clips
            its contents — that is how it collapses to nothing without
            unmounting — so a handle inside it was clipped to a 3px strip lying
            on the border, invisible and all but unhittable, which is why the
            docked panel read as fixed-width. Out here it straddles the seam at
            its full width and nothing clips it. */}
        {!zen && !vibe && !sidePrefs.overlay && sideOpen && (
          <div
            className="side-dock-grip"
            style={{ left: RAIL_W + sideWidth - 4 }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize side panel"
            aria-valuenow={sideWidth}
            aria-valuemin={SIDE_MIN_W}
            aria-valuemax={SIDE_MAX_W}
            tabIndex={0}
            onPointerDown={startSideResize}
            onKeyDown={onSideResizeKey}
            // The grip sits outside the panel, so reaching for it is a mouseleave
            // as far as the dock is concerned — without this a hover-opened panel
            // starts retracting the moment you go to resize it.
            onMouseEnter={cancelPeekClose}
            onMouseLeave={() => schedulePeekClose()}
          />
        )}
        <aside className="vibe-chat-placeholder" aria-label="Build chat">
          <VibeBuilderPane
            session={
              vibeSession ??
              vibeTargetQuestionSession ??
              vibeTargetStatusSession
            }
          />
        </aside>
        {/* The PanelGroup renders in every mode on purpose. Swapping mainArea
            between a bare child and a <Panel> changes its element type, which
            unmounts the subtree — and Term's cleanup kills the PTY. Toggling
            focus mode would silently kill every terminal (and any agent running
            in one). Keeping the tree shape fixed keeps the PTYs alive. */}
        <PanelGroup direction="horizontal">
          <Panel id="main" order={2}>
            {mainArea}
          </Panel>
        </PanelGroup>
        {/* The side panel floats over the editor instead of displacing it: the
            main area never reflows, so a peek costs nothing but a repaint — and
            a terminal never re-wraps because you glanced at the file tree.
            Always mounted, slid out of frame when closed, for the same reason
            the panes inside it are display-toggled. */}
        {!zen && !vibe && sidePrefs.overlay && (
          <div className="side-peek-layer">
            <div
              className={`side-peek ${sideOpen ? "open" : ""}`}
              style={{ width: sideWidth }}
              onMouseEnter={cancelPeekClose}
              onMouseLeave={() => schedulePeekClose()}
            >
              {/* The frost is its own layer, not a background on .side-peek.
                  backdrop-filter makes an element a containing block for fixed
                  descendants — with it on the wrapper, every context menu and
                  confirm dialog inside the panel would anchor to the panel
                  instead of the viewport. */}
              <div className="side-peek-frost" />
              {sidePanel}
              {/* No title here either — a tooltip on the panel's own edge would
                  cover the panel. The col-resize cursor is the affordance. */}
              <div className="side-peek-grip" onPointerDown={startSideResize} />
            </div>
          </div>
        )}
      </div>
      {/* Full-width, spanning rail + sidebar + main. Zen hides it via CSS. */}
      <StatusBar
        roots={roots}
        agents={runningAgents}
        events={projectEvents}
        visible={visible}
        projects={allProjects}
        onSetModel={modelTarget ? setAgentModel : undefined}
        modelSwitch={modelTarget?.sw ?? null}
        agentLabel={modelTarget?.label}
        agentId={activeAgentId}
        agentProfile={activeAgent.profile}
        activePtyId={activeTab?.type === "terminal" ? activeTab.ptyId : null}
      />
      <AgentCloseUndo
        pending={[...pendingAgentCloses.values()]}
        onRestore={restorePendingAgentClose}
      />
      {/* This action starts in the editor's empty state, so its confirmation
          must not live in sidePanel: overlay mode slides that whole subtree
          off-screen when the sidebar is closed. */}
      {confirmResume && (
        <Dialog
          variant="danger"
          title="Reopen every one of these?"
          body="Each one starts its own agent process. A dozen at once will take the machine down with them."
          meta={`${confirmResume.count} terminals`}
          dismissLabel="Cancel"
          onDismiss={() => setConfirmResume(null)}
          actions={[
            {
              label: `Reopen all ${confirmResume.count}`,
              primary: true,
              onClick: () => {
                confirmResume.go();
                setConfirmResume(null);
              },
            },
          ]}
        />
      )}
      {confirmCloseGroup && (
        <Dialog
          variant="danger"
          title="Close this multiplexed tab?"
          body={`This will stop ${confirmCloseGroup.live} live terminal${
            confirmCloseGroup.live === 1 ? "" : "s"
          } and close every pane in the tab.`}
          meta={`${confirmCloseGroup.live} running`}
          dismissLabel="Keep open"
          onDismiss={() => setConfirmCloseGroup(null)}
          actions={[
            {
              label: "Stop and close",
              primary: true,
              onClick: () => {
                closeTerminalGroupNow(confirmCloseGroup.groupId);
                setConfirmCloseGroup(null);
              },
            },
          ]}
        />
      )}
      {launcherOpen && visible && (
        <LaunchPalette
          installed={installed}
          cliUpdates={cliUpdates}
          targetLabel={pendingSplit ? "new split pane" : components[0]?.label}
          onShell={() => {
            onNewShell();
            setLauncherOpen(false);
          }}
          onLaunchCli={(cli) => {
            void launchCli(cli).finally(() => {
              setLauncherOpen(false);
              // A successful split consumes this itself. Clear only a launch
              // that failed before it reached completePendingSplit.
              if (pendingSplitRef.current) {
                pendingSplitRef.current = null;
                setPendingSplit(null);
              }
            });
          }}
          onCancel={() => {
            setLauncherOpen(false);
            pendingSplitRef.current = null;
            setPendingSplit(null);
          }}
        />
      )}
      {palette && visible && (
        <Palette
          mode={palette}
          components={components.map((c) => ({ label: c.label, path: c.path }))}
          onOpen={(p) => void openFile(p)}
          onClose={() => setPalette(null)}
        />
      )}
      {spotOpen && visible && (
        <SpotSearch
          ctx={spotCtx}
          onAction={onSpotAction}
          onClose={() => setSpotOpen(false)}
        />
      )}
      {/* Ctrl+Tab walks the switcher; releasing Ctrl commits the selection. */}
      {switcherOpen && visible && switcherTabs.length > 1 && switcher && (
        <TabSwitcher
          tabs={switcherTabs}
          rows={switcher.rows ?? undefined}
          selectedId={switcher.selectedId}
          status={(tab) =>
            cardStatus(
              tab,
              statusTargets.has(tab.id) ? groupOf(tab.id) : undefined,
            )
          }
          paneRef={contentRef}
          termText={termTailFor}
          onPick={(id) => {
            cancelSwitcher();
            const tab = tabsRef.current.find((item) => item.id === id);
            const group =
              tab?.type === "terminal" && tab.paneGroup
                ? terminalGroupsRef.current[tab.paneGroup]
                : undefined;
            setActiveTabId(group?.activeTabId ?? id);
          }}
        />
      )}
      {coachTip && visible && (
        <Coachmark
          targetSelector={COACH_TIPS[coachTip].selector}
          title={COACH_TIPS[coachTip].title}
          body={COACH_TIPS[coachTip].body}
          steps={COACH_TIPS[coachTip].steps}
          onDismiss={dismissCoach}
        />
      )}
    </div>
  );
});

/** One project, wrapped in the one branch-switch funnel.
 *
 *  The provider is mounted here rather than inside the body for two reasons.
 *  A component can't consume the context it renders, and the body is what calls
 *  switchTo. And the question a switch asks has to outlive the surface that
 *  asked it: a PR tab's "check it out locally" stays answerable while the Git
 *  panel this logic used to live inside isn't even mounted.
 *
 *  Mounted per open project, which is right — a switch is scoped to a repo, and
 *  only one project is on screen at a time. */
export const ProjectView = memo(function ProjectView(props: ProjectViewProps) {
  // The redirection itself stays with the body (it owns worktreeEnv and the
  // side panel); the funnel only asks for it, and owns the label and notice.
  const useWorktreeRef = useRef<UseWorktreeRef["current"]>(() => {});
  const onUseWorktree = useCallback(
    (repo: string, path: string, branch: string) =>
      useWorktreeRef.current(repo, path, branch),
    [],
  );
  return (
    // The dialog is a sibling of this project's view, not a child of it, so the
    // view hiding itself is not enough: a switch started in a project that
    // isn't on screen (the review loop arming itself in a background project)
    // would put its question over whichever project the user IS looking at.
    // `display: contents` while visible leaves the layout exactly as it was —
    // the view stays a flex item of App's row — and `none` takes the whole
    // project, question included, off screen with it.
    <div style={{ display: props.visible ? "contents" : "none" }}>
      <BranchSwitchProvider
        onNotice={props.onNotice}
        onUseWorktree={onUseWorktree}
        projectId={props.project.id}
        projectName={props.project.name}
        visible={props.visible}
      >
        <ProjectViewBody {...props} useWorktreeRef={useWorktreeRef} />
      </BranchSwitchProvider>
    </div>
  );
});
