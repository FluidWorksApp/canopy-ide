// Inline SVG icons. Sized via the `size` prop (default 14) and coloured with
// currentColor so they inherit the row's text colour.
//
// One weight, one grid: 24×24, stroked at 1.8 with round caps and joins,
// declared once in `svgProps` and never overridden per glyph. Seven weights in
// one set is why the rail used to read as mixed-weight in a screenshot even
// though the shapes were right. A glyph that looks wrong at 1.8 is too dense,
// and the fix is fewer lines, not a thinner one.
//
// Every shape the remote portal draws too lives in shared/icons.tsx and is
// re-exported from here: shared/ is compiled into the portal, which has no
// access to src/, so the drawing has to live on that side and this side takes
// it under the name the desktop already imports.
import type { ReactElement } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

// ---------- drawn once, in shared/ ----------
// The shapes both shells use. Same rule as ChevronIcon has always followed: the
// shared FileTree and the portal need them and must not import from src/, so
// the geometry lives in shared/icons.tsx and every existing `from "./icons"`
// still resolves through these lines. One shape, not two.
import { IconIssue, IconStop, IconTerminal } from "../../shared/icons";

export {
  ChevronIcon,
  IconBell as BellIcon,
  IconCheck as CheckIcon,
  IconClose as CloseIcon,
  // A failed check is the same cross as a dismiss, under the name the status
  // rows read by.
  IconClose as FailIcon,
  IconDiff as DiffIcon,
  IconFolder as FilesIcon,
  IconGit as GitBranchIcon,
  IconPlug as PlugIcon,
  IconPr as PullRequestIcon,
  IconSearch as SearchIcon,
  IconStopwatch as StopwatchIcon,
} from "../../shared/icons";

export { IconIssue as IssueIcon, IconTerminal as TerminalIcon };

/** Kill: the transport square. The drawing is shared/`IconStop`; it is filled
 *  here because in the run controls it sits directly beside PlayIcon's solid
 *  triangle, and a hollow square next to a solid triangle reads as two
 *  different kinds of button rather than one pair. */
export function StopIcon({ size = 14, className }: IconProps) {
  return <IconStop size={size} className={className} fill="currentColor" stroke="none" />;
}

// ---------- desktop-only shapes ----------

export function PlayIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="currentColor" stroke="none">
      <path d="M8.5 5.4 19.5 12l-11 6.6z" />
    </svg>
  );
}

/** Snowflake: a project that is hibernating. An SVG rather than the ❄ glyph
 *  because the glyph renders as a colour emoji on macOS at tab size, which
 *  can't take the row's colour and reads as a sticker on a 34px bar. */
export function FrostIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3v18M4.9 7.1l14.2 8.2M19.1 7.1 4.9 15.3" />
      <path d="M9.9 5 12 7.1 14.1 5M14.1 19 12 16.9 9.9 19" />
      <path d="M5.3 10.5 6.1 7.7l2.8.5M18.7 13.5l-.8 2.8-2.8-.5" />
      <path d="M15.1 8.2l2.8-.5.8 2.8M8.9 15.8l-2.8.5-.8-2.8" />
    </svg>
  );
}

/** Fetch: the circle that doesn't quite close, with the arrow head at the gap. */
export function RestartIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M20.5 12a8.5 8.5 0 1 1-3-6.5" />
      <path d="M20.5 4v5h-5" />
    </svg>
  );
}

/** A solid dot: something is live right now. The only glyph in the set with no
 *  outline, because it is a state light rather than a picture of anything.
 *
 *  On the same 24 grid as everything else — it used to be the one 12-unit
 *  viewBox in the file — at the radius that keeps the dot exactly the size it
 *  rendered before, since callers size it to sit in a text row. */
export function LiveDot({ size = 10, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="currentColor" stroke="none">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

/** Server rack + play: the rail's execution tab. Two stacked rack units with a
 *  status LED each say "the things this project runs"; the play mark says they
 *  are yours to start. A wrench used to stand in for the rack and kept reading
 *  as settings.
 *
 *  The rack is kept left of x=15 so the play mark has the bottom-right corner
 *  to itself. Not the top right: the rail's running-count badge lands there and
 *  would eat the play mark exactly when servers are up. The play is stroked in
 *  currentColor like the rest of it — it was filled with --ok green, which made
 *  this the one two-colour glyph in the rail and left it green on Daylight and
 *  every other light skin. */
export function ServersIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M2.5 4.5h11v5.5h-11zM2.5 14h11v5.5h-11z" />
      <path d="M10.4 7.25h1.4M10.4 16.75h1.4" />
      <circle cx="5.4" cy="7.3" r="1" fill="currentColor" stroke="none" />
      <circle cx="5.4" cy="16.8" r="1" fill="currentColor" stroke="none" />
      <path d="M16.4 14.2l5.4 3.3-5.4 3.3z" />
    </svg>
  );
}

/** Pull: work coming down onto the line. */
export function DownloadIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3.5v11" />
      <path d="M7.2 10.2 12 15l4.8-4.8" />
      <path d="M4.5 20h15" />
    </svg>
  );
}

// ---------- Agent CLI brand marks ----------
// Real vector logos, not emoji stand-ins. They are drawn in shared/agentGlyphs
// — the portal shows the same marks in the same brand colours — and re-exported
// here so the desktop's terminal menu and the phone cannot drift apart.
export {
  AiderIcon,
  AmpIcon,
  ClaudeIcon,
  CodexIcon,
  GeminiIcon,
  OmpIcon,
  OpenCodeIcon,
} from "../../shared/agentGlyphs";
import {
  AiderIcon as Aider,
  AmpIcon as Amp,
  ClaudeIcon as Claude,
  CodexIcon as Codex,
  GeminiIcon as Gemini,
  OmpIcon as Omp,
  OpenCodeIcon as OpenCode,
} from "../../shared/agentGlyphs";

export const BRAND_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  claude: Claude,
  codex: Codex,
  gemini: Gemini,
  amp: Amp,
  aider: Aider,
  opencode: OpenCode,
  omp: Omp,
};

// ---------- sidebar rail ----------
// One distinct silhouette each: these sit in a column where the only way to
// tell them apart at 18px is shape. Deliberately NOT reusing any agent brand
// mark — the Agents rail button used Claude's asterisk, which read as "Claude"
// rather than "agents".

/** Research: a magnifier over a page. The page is what distinguishes it from a
 *  plain search glass — this is a *written* finding, not a query — and at rail
 *  size the two strokes of the document edge are enough to read as one. */
export function ResearchIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M13.5 20.5H6.5a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5h7L19 9v3" />
      <path d="M13 3.6V9.5h5.6" />
      <circle cx="15.2" cy="16.2" r="3.1" />
      <path d="M17.5 18.5L20 21" />
    </svg>
  );
}

/** Scratchpad: a lightbulb.
 *
 *  It has to survive sitting one row above Research (a page with a magnifier)
 *  and Tasks (a checklist) at 14px, where interior detail turns to mush and
 *  only the silhouette reads. Nothing else in the set is a round top on a short
 *  stem, so this one stays legible when the strokes blur together — and "idea"
 *  is the right word for what the list mostly holds. */
export function NoteIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M9 17.5a5.8 5.8 0 1 1 6 0v1.2a1.3 1.3 0 0 1-1.3 1.3h-3.4A1.3 1.3 0 0 1 9 18.7z" />
      <path d="M9.6 17.4h4.8" />
    </svg>
  );
}

/** Archive: a lidded box. The lid is what separates it from a plain rectangle
 *  at 14px, and from the document mark it sits beside. */
export function ArchiveIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3.5 5a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v3.5h-17z" />
      <path d="M4.8 8.5v10a1.5 1.5 0 0 0 1.5 1.5h11.4a1.5 1.5 0 0 0 1.5-1.5v-10" />
      <path d="M10 12.5h4" />
    </svg>
  );
}

/** Blocked: a circle with a slash through it — the "no entry" sign. Not a pause
 *  bar: pause reads as "I stopped this", and blocked means the run is waiting on
 *  the person looking at it. Two strokes and nothing inside, so it survives the
 *  11px it gets in an agent row. */
export function BlockedIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.2 6.2l11.6 11.6" />
    </svg>
  );
}

/** Agents: a bot head. Distinct from every CLI brand mark on purpose. */
export function AgentsIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 12a3.5 3.5 0 0 1 3.5-3.5h9A3.5 3.5 0 0 1 20 12v4a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16z" />
      <path d="M12 8.5V5" />
      <circle cx="12" cy="3.6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="14" r="1.45" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1.45" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Tasks: a checklist — a ticked row over plain rows. Distinct from Issues
 *  (a circle) and Agents (a bot) at rail size. */
export function TasksIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 6.5l1.8 1.8L9 5" />
      <path d="M12 6.5h8" />
      <path d="M4 12.5h16" />
      <path d="M4 18.5h16" />
    </svg>
  );
}

/** Statistics: a bar chart. Reads as "totals & breakdowns" at rail size. */
export function StatsIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 20h16" />
      <path d="M5.6 12.2h3.2v6H5.6zM10.4 8.2h3.2v10h-3.2zM15.2 4.7h3.2v13.5h-3.2z" />
    </svg>
  );
}

/** Reclaiming disk: a broom. Distinct from the trash can on purpose — this one
 *  sweeps up what a build can make again, it doesn't delete your work. The
 *  bristles are two strokes, not four: at 1.8 any more of them close up into a
 *  solid wedge by 14px. */
export function BroomIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M19.5 4.5 12 12" />
      <path d="M13.2 9.4 6 16.6l3.2 3.2 7.2-7.2z" />
      <path d="M6.6 17.2 4 19.8M9 19.6l-2.6 2.6" />
    </svg>
  );
}

/** Storage: a stack of platters. */
export function DiskIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4.5 6.5c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3-3.36-3-7.5-3-7.5 1.34-7.5 3z" />
      <path d="M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </svg>
  );
}

/** Delete/forget: a trash can. The two ribs are set wider apart than a drawing
 *  at hairline would put them — at 1.8 the old spacing filled the gap between
 *  them and the can read as solid at 14px. */
export function TrashIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 7h16" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.5 7.5 7.3 19a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-11.5" />
      <path d="M10 11.5v5M14 11.5v5" />
    </svg>
  );
}

/** A crescent moon — hibernate an idle agent (kill its terminal to reclaim
 *  memory; the session stays resumable). */
export function MoonIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
    </svg>
  );
}

/** Support the project: a heart. Stroked like the rest so it sits in the status
 *  bar as one of the row rather than as decoration; filled on hover via CSS. */
export function HeartIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 20.5s-7.5-4.7-7.5-9.8a4.2 4.2 0 0 1 7.5-2.6 4.2 4.2 0 0 1 7.5 2.6c0 5.1-7.5 9.8-7.5 9.8z" />
    </svg>
  );
}

/** A commit: a node on a line, the way every git UI draws one. */
export function CommitIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3v5.5M12 15.5V21" />
    </svg>
  );
}

/** A browser preview: a globe. */
export function GlobeIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13.5 13.5 0 0 1 0 18 13.5 13.5 0 0 1 0-18" />
    </svg>
  );
}

/** A clipboard — the ⌘K section, and Settings' tab. */
export function ClipboardIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z" />
      <path d="M9.4 4a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v1.4a.6.6 0 0 1-.6.6h-4a.6.6 0 0 1-.6-.6z" />
      <path d="M9.5 11h5M9.5 15h3.5" />
    </svg>
  );
}

/** Copy: one sheet lifted off another. Distinct from ClipboardIcon on purpose —
 *  a clipboard is a place things are kept, this is the act of duplicating one. */
export function CopyIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M9 11a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2z" />
      <path d="M5 15V5a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

/** Settings: a gear. Eight teeth cut as one outline rather than the twelve-arc
 *  cog it used to be — at 1.8 the arcs merged into a blob below 16px. */
export function SettingsIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M10.6 3.2h2.8l.4 2.5 2 1.15 2.35-.95 1.4 2.4-1.9 1.65V13l1.9 1.65-1.4 2.4-2.35-.95-2 1.15-.4 2.5h-2.8l-.4-2.5-2-1.15-2.35.95-1.4-2.4L5.7 13v-2.1L3.8 9.25l1.4-2.4 2.35.95 2-1.15z" />
    </svg>
  );
}

/** Sidebar toggle: a panel with its side rail. */
export function SidebarIcon({ size = 18, className, collapsed }: IconProps & { collapsed?: boolean }) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9.5 5v14" />
      {/* The arrow says what the click does, not what is showing. */}
      <path d={collapsed ? "M13.8 9.8l2.4 2.2-2.4 2.2" : "M16.2 9.8l-2.4 2.2 2.4 2.2"} />
    </svg>
  );
}

// ---------- issue tracker brand marks ----------

/** GitHub's Octocat mark. Left on GitHub's own 16 grid — a third-party mark is
 *  redrawn by its owner, not by us. */
export function GitHubIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Linear's mark, on Linear's own 100 grid, for the same reason. */
export function LinearIcon({ size = 14, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M1.2 61.5a49 49 0 0 0 37.3 37.3L1.2 61.5Z" />
      <path d="M.1 47.9 52.1 99.9a49.5 49.5 0 0 0 10.4-2L2.1 37.5a49.5 49.5 0 0 0-2 10.4Z" />
      <path d="M6 27.2 72.8 94a50 50 0 0 0 7.6-5.9L11.9 19.6A50 50 0 0 0 6 27.2Z" />
      <path d="M18.6 12.6a49.9 49.9 0 1 1 68.8 68.8L18.6 12.6Z" />
    </svg>
  );
}

/** A tracker's mark by registry id — same shape as AgentIcon. */
export const TRACKER_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  github: GitHubIcon,
  linear: LinearIcon,
};

export function TrackerIcon({ id, size = 14, className }: IconProps & { id: string }) {
  const Brand = TRACKER_ICONS[id];
  return Brand ? <Brand size={size} className={className} /> : <IconIssue size={size} className={className} />;
}

// Render an agent CLI's brand mark by registry id, falling back to a terminal
// glyph for CLIs we don't have a mark for.
export function AgentIcon({ id, size = 14, className }: IconProps & { id: string }) {
  const Brand = BRAND_ICONS[id];
  return Brand ? <Brand size={size} className={className} /> : <IconTerminal size={size} className={className} />;
}

/** Two people — the team relay. One head in front of the other rather than side
 *  by side, so the pair still reads as two at 11px. */
export function TeamIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 20v-1.6a3.4 3.4 0 0 1 3.4-3.4h4.2a3.4 3.4 0 0 1 3.4 3.4V20" />
      <circle cx="9.5" cy="8.4" r="3.3" />
      <path d="M17.6 20v-1.6a3.4 3.4 0 0 0-2.4-3.25" />
      <path d="M15.4 5.5a3.3 3.3 0 0 1 0 5.8" />
    </svg>
  );
}

// ---------- instruction kinds ----------
// What a file *is*, where the brand mark says who reads it. One silhouette per
// kind, distinct at 14px, because these sit in a list where every row is a
// filename and the shape is the only thing that separates a skill from a rule.

/** A plain instructions file — CLAUDE.md, AGENTS.md. */
export function DocumentIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7M8.5 16.5h4.5" />
    </svg>
  );
}

/** A rule: a constraint that holds, so a shield with a check. */
export function RuleIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3 5 6v5.4c0 4.2 2.9 7.9 7 9.6 4.1-1.7 7-5.4 7-9.6V6Z" />
      <path d="M9 12l2.2 2.2L15 10.4" />
    </svg>
  );
}

/** A skill: the sparkle every tool uses for "loaded when the work calls for it". */
export function SkillIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M10 3.5 11.6 8 16 9.6 11.6 11.2 10 15.7 8.4 11.2 4 9.6 8.4 8Z" />
      <path d="M17.5 14.2 18.3 16.4 20.5 17.2 18.3 18 17.5 20.2 16.7 18 14.5 17.2 16.7 16.4Z" />
    </svg>
  );
}

/** A subagent: something delegated to, so a small machine. */
export function SubagentIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 11a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" />
      <path d="M12 4.8V8" />
      <circle cx="12" cy="3.6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9.2" cy="13.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="13.2" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A slash command: the slash you type to reach it. */
export function SlashCommandIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3.5 7.5a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3z" />
      <path d="M14 8.5 10 15.5" />
    </svg>
  );
}

/** An output style: a painter's palette. */
export function StyleIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3.2a8.8 8.8 0 1 0 0 17.6 2.3 2.3 0 0 0 1.8-3.8 2.3 2.3 0 0 1 1.8-3.8h1.9a3.3 3.3 0 0 0 3.3-3.3c0-3.7-3.9-6.7-8.8-6.7Z" />
      <circle cx="7.6" cy="12.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="9.4" cy="8.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="14" cy="7.6" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

const KIND_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  instructions: DocumentIcon,
  rule: RuleIcon,
  skill: SkillIcon,
  subagent: SubagentIcon,
  command: SlashCommandIcon,
  style: StyleIcon,
};

/** An instruction file's kind mark, falling back to a plain document for a kind
 *  the backend grows before this map does. */
export function InstructionKindIcon({ kind, size = 14, className }: IconProps & { kind: string }) {
  const Kind = KIND_ICONS[kind] ?? DocumentIcon;
  return <Kind size={size} className={className} />;
}

/** Two arrows passing each other: work traded between sessions on this machine.
 *  Deliberately not LiveShareIcon's broadcast arcs — those mean sharing with
 *  other people, and shared context never leaves this project. */
export function ExchangeIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 9h13" />
      <path d="M14 6l3 3-3 3" />
      <path d="M20 15H7" />
      <path d="M10 12l-3 3 3 3" />
    </svg>
  );
}

/** Angle brackets around a stem: a code symbol from the language server. */
export function SymbolIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M7.5 8 4 12l3.5 4" />
      <path d="M16.5 8 20 12l-3.5 4" />
      <path d="M13.5 6.5 10.5 17.5" />
    </svg>
  );
}

/** Broadcast: a solid core with signal arcs, for sharing a file or project live
 *  with the team. */
export function LiveShareIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
      <path d="M7.4 7.4a6.5 6.5 0 0 0 0 9.2" />
      <path d="M16.6 16.6a6.5 6.5 0 0 0 0-9.2" />
      <path d="M4.6 4.6a10.4 10.4 0 0 0 0 14.8" />
      <path d="M19.4 19.4a10.4 10.4 0 0 0 0-14.8" />
    </svg>
  );
}
