// Line icons for the portal — inline SVG so they ship offline (no icon font, no
// CDN), scale crisply, and inherit `currentColor` so they follow whatever the
// surrounding text colour is. Deliberately hairline + geometric to sit with the
// instrument aesthetic. One shape, one job.
//
// One weight, one grid. Every glyph is drawn on 24×24 and stroked at 1.8 with
// round caps and joins, declared once in `Svg` and never overridden per glyph:
// a set with seven weights in it reads as mixed-weight in a screenshot even
// when every shape is right. A glyph that looks wrong at 1.8 is too dense, and
// the fix is fewer lines, not a thinner one.
//
// This file is canonical for every shape the desktop and the portal both draw.
// It cannot import from `src/` — it is compiled into the remote portal, which
// has no access to that tree — so the direction is fixed: the drawing lives
// here and `src/components/icons.tsx` re-exports it under the desktop's name.
//
// Sized by `s` (what the portal writes) or `size` (what the desktop writes);
// they are the same number, and each glyph carries the default its own surface
// has always used.

import type { ReactNode, SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 's' | 'size'> & { s?: number; size?: number }

function Svg({ s = 16, size, children, ...rest }: IconProps & { children: ReactNode }) {
  const n = size ?? s
  return (
    <svg
      width={n}
      height={n}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Branch: the fork, drawn for the tray. Wider nodes and a shorter run than the
 *  rail's `IconGit` because this one has to survive 12px beside text. */
export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="17.5" cy="7.5" r="2.4" />
    <path d="M6 8.4v7.2M17.5 10v1.5a4 4 0 0 1-4 4H8" />
  </Svg>
)

/** Ash, reduced to a rail glyph: the rounded face and two eyes. Presence, not
 *  a portrait — the real face lives in the desktop's Ash.tsx. */
export const CompanionIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="6" width="16" height="13" rx="4.5" />
    <path d="M9.5 12v1.5M14.5 12v1.5" />
    <path d="M12 6V3.5" />
    <circle cx="12" cy="3" r="0.6" />
  </Svg>
)

/** A chip: pins on four sides of a square die. Machine, not process — the load
 *  reading beside it is the machine's. */
export const IconCpu = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M10 2.5v3M14 2.5v3M10 18.5v3M14 18.5v3M2.5 10h3M2.5 14h3M18.5 10h3M18.5 14h3" />
  </Svg>
)

/** Token spend: a currency mark. A coin rather than a gauge because the number
 *  beside it is a total that only goes up. */
export const IconToken = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v9M9.6 9.8h3.3a1.8 1.8 0 0 1 0 3.5H9.6h3.4a1.8 1.8 0 0 1 0 3.5H9.4" />
  </Svg>
)

/** Stopwatch — elapsed work, not a time of day. The crown and the winder are
 *  what separate it from `IconClock` at tray size. */
export const IconStopwatch = (p: IconProps) => (
  <Svg s={12} {...p}>
    <circle cx="12" cy="13.5" r="7.5" />
    <path d="M12 10v3.5l2.2 1.6" />
    <path d="M9.5 2.5h5M18.6 6.4 20 5" />
  </Svg>
)

/** A folder, with the tab. Detail inside it — document lines, a fold — turns to
 *  mush at rail size, so the silhouette carries the whole signal. The desktop's
 *  Files rail button is this same shape. */
export const IconFolder = (p: IconProps) => (
  <Svg s={18} {...p}>
    <path d="M3 8a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.5.7l1.2 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Svg>
)

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 10 9-7 9 7" />
    <path d="M5 9v11h14V9" />
    <path d="M9 20v-7h6v7" />
  </Svg>
)

/** A wall clock: a time of day. Deliberately not the stopwatch. */
export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
)

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
)

/** A bolt: start something now. */
export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2.5 4.5 13.5H11l-1 8L19.5 10H13z" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

/** Send: an arrow up out of the composer. */
export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20V5M6 11l6-6 6 6" />
  </Svg>
)

/** Kill: the transport square. */
export const IconStop = (p: IconProps) => (
  <Svg s={14} {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
  </Svg>
)

export const IconPower = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v7.5" />
    <path d="M7 6.5a7 7 0 1 0 10 0" />
  </Svg>
)

/** A shell: a prompt and a cursor rule *inside a screen*. The box is the whole
 *  point — a bare chevron and underscore reads as a stray caret at 14px, not as
 *  a terminal. */
export const IconTerminal = (p: IconProps) => (
  <Svg s={14} {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M7 9.8l2.8 2.4L7 14.6M12.8 15h4.4" />
  </Svg>
)

export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
)

/** A document with the corner turned. */
export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5h7l5 5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    <path d="M13 3.5V8.5h5" />
  </Svg>
)

/** Resume: the transport triangle. Hollow here — the portal's row controls are
 *  all outlines, and a solid mark in among them reads as a badge. */
export const IconResume = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.5 5.4 19.5 12l-11 6.6z" />
  </Svg>
)

// ---- the panel rail -------------------------------------------------------
// One per remote module that lists something. Same geometry as above, and
// deliberately close to the desktop rail's shapes so the two apps read as one
// product rather than two that happen to share a backend.

/** Agents: a bot head, distinct from every individual CLI brand. */
export const AgentsIcon = (p: IconProps) => (
  <Svg s={18} {...p}>
    <path d="M4 12a3.5 3.5 0 0 1 3.5-3.5h9A3.5 3.5 0 0 1 20 12v4a3.5 3.5 0 0 1-3.5 3.5h-9A3.5 3.5 0 0 1 4 16z" />
    <path d="M12 8.5V5" />
    <circle cx="12" cy="3.6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="9" cy="14" r="1.45" fill="currentColor" stroke="none" />
    <circle cx="15" cy="14" r="1.45" fill="currentColor" stroke="none" />
  </Svg>
)

/** Servers: the desktop rail's two rack units plus its start action. */
export const ServersIcon = (p: IconProps) => (
  <Svg s={18} {...p}>
    <path d="M2.5 4.5h11v5.5h-11zM2.5 14h11v5.5h-11z" />
    <path d="M10.4 7.25h1.4M10.4 16.75h1.4" />
    <circle cx="5.4" cy="7.3" r="1" fill="currentColor" stroke="none" />
    <circle cx="5.4" cy="16.8" r="1" fill="currentColor" stroke="none" />
    <path d="M16.4 14.2l5.4 3.3-5.4 3.3z" />
  </Svg>
)

/** Research: a magnifier over the written finding it investigates. */
export const ResearchIcon = (p: IconProps) => (
  <Svg s={18} {...p}>
    <path d="M13.5 20.5H6.5a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5h7L19 9v3" />
    <path d="M13 3.6V9.5h5.6" />
    <circle cx="15.2" cy="16.2" r="3.1" />
    <path d="M17.5 18.5L20 21" />
  </Svg>
)

/** Changes: an added line over a removed line — the shape of a diff hunk. An
 *  earlier attempt combined a plus, a minus and a chevron and read as a shell
 *  prompt at 17px; two marks and two rules is all that survives. */
export const IconDiff = (p: IconProps) => (
  <Svg s={18} {...p}>
    <path d="M4 8h4M6 6v4" />
    <path d="M11.5 8H20" />
    <path d="M4 16h4" />
    <path d="M11.5 16H20" />
  </Svg>
)

/** Git: the branch fork everyone recognises, at rail size. */
export const IconGit = (p: IconProps) => (
  <Svg s={18} {...p}>
    <circle cx="7" cy="5.5" r="2.3" />
    <circle cx="7" cy="18.5" r="2.3" />
    <circle cx="17" cy="9" r="2.3" />
    <path d="M7 7.8v8.4" />
    <path d="M17 11.3c0 3.6-3.3 4.7-7 5" />
  </Svg>
)

/** A pull request: a branch landing on a third node, with the arrow back into
 *  the trunk. The arrow is what separates it from `IconGit` at 12px. */
export const IconPr = (p: IconProps) => (
  <Svg s={14} {...p}>
    <circle cx="7" cy="6" r="2.2" />
    <circle cx="7" cy="18" r="2.2" />
    <circle cx="17" cy="18" r="2.2" />
    <path d="M7 8.2v7.6" />
    <path d="M17 15.8V11a2.5 2.5 0 0 0-2.5-2.5H11" />
    <path d="M12.8 6.4l-1.9 2.1 1.9 2.1" />
  </Svg>
)

/** Issues: the circle-dot every tracker uses for an open issue. */
export const IconIssue = (p: IconProps) => (
  <Svg s={18} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
  </Svg>
)

/** A rack: two units, an LED each. Things this project runs. */
export const IconServer = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="6" rx="1.5" />
    <rect x="3.5" y="14" width="17" height="6" rx="1.5" />
    <path d="M7 7h.01" />
    <path d="M7 17h.01" />
  </Svg>
)

/** A book: written knowledge, as opposed to a run of it. */
export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M8 4v16" />
  </Svg>
)

/** A flask: an experiment. */
export const IconFlask = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3.5v6L4.8 18a1.6 1.6 0 0 0 1.4 2.5h11.6a1.6 1.6 0 0 0 1.4-2.5L14 9.5v-6" />
    <path d="M9 3.5h6" />
    <path d="M7.5 14.5h9" />
  </Svg>
)

/** MCP tools: a plug going into a socket. The set already has a rack and a bot,
 *  so the shape has to say "something external connected to the agents" rather
 *  than "a tool" in the generic sense. */
export const IconPlug = (p: IconProps) => (
  <Svg s={18} {...p}>
    <path d="M9 3v5" />
    <path d="M15 3v5" />
    <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
    <path d="M12 17v4" />
  </Svg>
)

/** A bell: the attention channel. */
export const IconBell = (p: IconProps) => (
  <Svg s={14} {...p}>
    <path d="M18 8.5a6 6 0 1 0-12 0c0 5.5-2 7-2 7h16s-2-1.5-2-7" />
    <path d="M13.7 19.5a2 2 0 0 1-3.4 0" />
  </Svg>
)

/** A gauge with the needle over: machine load, which has a ceiling. */
export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17a8 8 0 1 1 16 0" />
    <path d="M12 17l4-4.5" />
  </Svg>
)

/** A magnifier: find. */
export const IconSearch = (p: IconProps) => (
  <Svg s={14} {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.4 15.4 20 20" />
  </Svg>
)

/** A cross: dismiss. Also what a failed check looks like — same mark, and the
 *  desktop exports it under both names. */
export const IconClose = (p: IconProps) => (
  <Svg s={14} {...p}>
    <path d="M6.5 6.5l11 11" />
    <path d="M17.5 6.5l-11 11" />
  </Svg>
)

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h16" />
  </Svg>
)

/** Fetch: the circle that doesn't quite close, with the arrow head at the gap. */
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.5 12a8.5 8.5 0 1 1-3-6.5" />
    <path d="M20.5 4v5h-5" />
  </Svg>
)

/** A tick: passed. */
export const IconCheck = (p: IconProps) => (
  <Svg s={14} {...p}>
    <path d="M4 12.5l5 5L20 6.5" />
  </Svg>
)

// ---- shared with the desktop -----------------------------------------------

/** Disclosure caret — a stroked "›". Rotate it 90° (via a class on the wrapping
 *  element) to point down when the section/folder is open. Shared by the file
 *  tree rows and the component-section headers so they read the same.
 *
 *  Lives here rather than in the desktop's icons.tsx because the shared FileTree
 *  needs it and must not import from `src/`. `src/components/icons.tsx`
 *  re-exports it, so there is exactly one of these shapes in the product. It is
 *  `IconChevron` at the size a disclosure row wants — not a second drawing. */
export const ChevronIcon = (p: IconProps) => <IconChevron s={10} {...p} />
