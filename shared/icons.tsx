// Line icons for the portal — inline SVG so they ship offline (no icon font, no
// CDN), scale crisply, and inherit `currentColor` so they follow whatever the
// surrounding text colour is. Deliberately hairline + geometric to sit with the
// instrument aesthetic. One shape, one job; sized by the `s` prop.

import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { s?: number }

function Svg({ s = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="6" cy="18" r="2.4" />
    <circle cx="17.5" cy="7.5" r="2.4" />
    <path d="M6 8.4v7.2M17.5 10v1.5a4 4 0 0 1-4 4H8" />
  </Svg>
)

export const IconCpu = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M10 2.5v3M14 2.5v3M10 18.5v3M14 18.5v3M2.5 10h3M2.5 14h3M18.5 10h3M18.5 14h3" />
  </Svg>
)

export const IconToken = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v9M9.5 9.8h3.4a1.8 1.8 0 0 1 0 3.6H9.5h3.6a1.8 1.8 0 0 1 0 3.6H9.2" opacity="0.9" />
  </Svg>
)

/** Stopwatch — elapsed work, not a time of day. */
export const IconStopwatch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="13.5" r="7.5" />
    <path d="M12 10v3.5l2.2 1.6" />
    <path d="M9.5 2.5h5M18.6 6.4 20 5" />
  </Svg>
)

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h3.6l1.6 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5z" />
  </Svg>
)

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

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20V5M6 11l6-6 6 6" />
  </Svg>
)

export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
  </Svg>
)

export const IconPower = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5v7.5" />
    <path d="M7 6.5a7 7 0 1 0 10 0" />
  </Svg>
)

export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M7 9.5l3 2.5-3 2.5M13 15h4" />
  </Svg>
)

export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
)

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5h7l5 5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
    <path d="M13 3.5V8.5h5" />
  </Svg>
)

export const IconResume = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5l10 6.5-10 6.5z" />
  </Svg>
)

// ---- the panel rail -------------------------------------------------------
// One per remote module that lists something. Same hairline geometry as above,
// and deliberately close to the desktop rail's shapes so the two apps read as
// one product rather than two that happen to share a backend.

export const IconDiff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4v10" />
    <path d="M3 7h6" />
    <path d="M18 20V10" />
    <path d="M15 17h6" />
  </Svg>
)

export const IconGit = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="6" r="2.5" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="12" r="2.5" />
    <path d="M6.5 8.5v7" />
    <path d="M15 12H9a2.5 2.5 0 0 1-2.5-2.5" />
  </Svg>
)

export const IconPr = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="6" r="2.5" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="18" r="2.5" />
    <path d="M6.5 8.5v7" />
    <path d="M17.5 15.5V9a3 3 0 0 0-3-3h-2.5" />
    <path d="M14 3.5 11.5 6 14 8.5" />
  </Svg>
)

export const IconIssue = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8v4.5" />
    <path d="M12 16h.01" />
  </Svg>
)

export const IconServer = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="6" rx="1.5" />
    <rect x="3.5" y="14" width="17" height="6" rx="1.5" />
    <path d="M7 7h.01" />
    <path d="M7 17h.01" />
  </Svg>
)

export const IconBook = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M8 4v16" />
  </Svg>
)

export const IconFlask = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3.5v6L4.8 18a1.6 1.6 0 0 0 1.4 2.5h11.6a1.6 1.6 0 0 0 1.4-2.5L14 9.5v-6" />
    <path d="M9 3.5h6" />
    <path d="M7.5 14.5h9" />
  </Svg>
)

export const IconPlug = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3.5v5" />
    <path d="M15 3.5v5" />
    <path d="M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0z" />
    <path d="M12 17v3.5" />
  </Svg>
)

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 10a6 6 0 0 1 12 0c0 3.5.8 5.2 1.5 6H4.5C5.2 15.2 6 13.5 6 10z" />
    <path d="M10 19.5a2 2 0 0 0 4 0" />
  </Svg>
)

export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17a8 8 0 1 1 16 0" />
    <path d="M12 17l4-4.5" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M15.8 15.8 20 20" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </Svg>
)

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M4 12h16" />
    <path d="M4 17h16" />
  </Svg>
)

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20 4v4.5h-4.5" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5 10 17.5 19 7" />
  </Svg>
)
