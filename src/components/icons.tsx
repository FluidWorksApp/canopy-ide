// Inline SVG icons. Sized via the `size` prop (default 14) and coloured with
// currentColor so they inherit the row's text colour.
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
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

export function PlayIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="currentColor" stroke="none">
      <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

export function StopIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

export function RestartIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M21 12a9 9 0 1 1-3.2-6.9" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function LiveDot({ size = 10, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)} viewBox="0 0 12 12" fill="currentColor" stroke="none">
      <circle cx="6" cy="6" r="4" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

export function FailIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function TerminalIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m5 8 4 4-4 4" />
      <path d="M13 16h6" />
    </svg>
  );
}

export function DownloadIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

// ---------- Agent CLI brand marks ----------
// Real vector logos, not emoji stand-ins. Sources:
//   Claude    — simple-icons `claude`, official brand #D97757
//   Codex     — lobe-icons `codex` (OpenAI's Codex CLI mark, not the blossom)
//   Gemini    — simple-icons `googlegemini`, official #8E75B2
//   Amp       — ampcode.com/amp-mark-color.svg, official #F34E3F
//   OpenCode  — lobe-icons `opencode` / opencode.ai favicon
// Aider ships only a text wordmark (no vector mark), so it gets a lettermark
// in its own brand green rather than an invented logo.

function brand(size: number, className: string | undefined, viewBox: string) {
  return { width: size, height: size, viewBox, className, "aria-hidden": true };
}

export function ClaudeIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...brand(size, className, "0 0 24 24")} fill="#D97757">
      <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  );
}

export function CodexIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...brand(size, className, "0 0 24 24")} fill="#7A9DFF">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}

export function GeminiIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...brand(size, className, "0 0 24 24")} fill="#8E75B2">
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  );
}

export function AmpIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...brand(size, className, "0 0 24 24")} fill="#F34E3F">
      <path
        fillRule="evenodd"
        d="M15.087 23.18L12.03 24l-2.097-7.823-5.738 5.738-2.251-2.251 5.718-5.719-7.769-2.082.82-3.057 11.294 3.08 3.08 11.295z"
      />
      <path
        fillRule="evenodd"
        d="M19.505 18.762l-3.057.82-2.564-9.573-9.572-2.564.819-3.057 11.295 3.079 3.08 11.295z"
      />
      <path
        fillRule="evenodd"
        d="M23.893 14.374l-3.057.82-2.565-9.572L8.7 3.057 9.52 0l11.295 3.08 3.079 11.294z"
      />
    </svg>
  );
}

export function OpenCodeIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...brand(size, className, "0 0 24 24")} fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
    </svg>
  );
}

// Aider has no official vector mark — only a terminal-font wordmark. A
// lettermark in its brand green is honest; a made-up logo would not be.
export function AiderIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...brand(size, className, "0 0 24 24")}>
      <text
        x="12"
        y="18"
        textAnchor="middle"
        fill="#14b014"
        fontSize="20"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        a
      </text>
    </svg>
  );
}

// oh-my-pi (omp) — stylized π. Source: omp.sh/favicon.svg. The real mark is a
// pink→purple→cyan gradient; we keep the gradient since it's the identity.
export function OmpIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...brand(size, className, "0 0 64 64")}>
      <defs>
        <linearGradient id="omp-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ed4abf" />
          <stop offset="0.5" stopColor="#9b4dff" />
          <stop offset="1" stopColor="#5ad8e6" />
        </linearGradient>
      </defs>
      <path d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" fill="url(#omp-g)" />
    </svg>
  );
}

export const BRAND_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  gemini: GeminiIcon,
  amp: AmpIcon,
  aider: AiderIcon,
  opencode: OpenCodeIcon,
  omp: OmpIcon,
};


// ---------- sidebar rail ----------
// One distinct silhouette each: these sit in a 5-icon column where the only
// way to tell them apart at 18px is shape. Deliberately NOT reusing any agent
// brand mark — the Agents rail button used Claude's asterisk, which read as
// "Claude" rather than "agents".

/** Files: a plain folder. Detail inside it (document lines, a fold) turns to
 *  mush at rail size — the silhouette is the whole signal. */
export function FilesIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 8a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.5.7l1.2 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/** Changes: an added line over a removed line — the shape of a diff hunk.
 *  The previous attempt combined a plus, a minus and a chevron and read as a
 *  shell prompt at 17px; two marks and two rules is all that survives. */
export function DiffIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 8h4M6 6v4" />
      <path d="M11.5 8H20" />
      <path d="M4 16h4" />
      <path d="M11.5 16H20" />
    </svg>
  );
}

/** Git: the branch fork everyone recognises. */
export function GitBranchIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="7" cy="5.5" r="2.3" />
      <circle cx="7" cy="18.5" r="2.3" />
      <circle cx="17" cy="9" r="2.3" />
      <path d="M7 7.8v8.4" />
      <path d="M17 11.3c0 3.6-3.3 4.7-7 5" />
    </svg>
  );
}

/** Issues: the circle-dot every tracker uses for an open issue. */
export function IssueIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Agents: a bot head. Distinct from every CLI brand mark on purpose. */
export function AgentsIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="4" y="8.5" width="16" height="11" rx="3.5" />
      <path d="M12 8.5V5" />
      <circle cx="12" cy="3.6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="14" r="1.45" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1.45" fill="currentColor" stroke="none" />
    </svg>
  );
}


/** Delete/forget: a trash can. */
export function TrashIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 7h16" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.5 7.5 7.3 19a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7.5" />
      <path d="M10.5 11v6M13.5 11v6" strokeWidth={1.5} />
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

/** A pull request: a branch merging back. */
export function PullRequestIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="18" r="2.2" />
      <path d="M7 8.2v7.6" />
      <path d="M17 15.8V11a2.5 2.5 0 0 0-2.5-2.5H11" />
      <path d="m12.8 6.4-1.9 2.1 1.9 2.1" strokeWidth={1.6} />
    </svg>
  );
}

// ---------- issue tracker brand marks ----------

/** GitHub's Octocat mark. */
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

/** Linear's mark. */
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
  return Brand ? <Brand size={size} className={className} /> : <IssueIcon size={size} className={className} />;
}

// Render an agent CLI's brand mark by registry id, falling back to a terminal
// glyph for CLIs we don't have a mark for.
export function AgentIcon({ id, size = 14, className }: IconProps & { id: string }) {
  const Brand = BRAND_ICONS[id];
  return Brand ? <Brand size={size} className={className} /> : <TerminalIcon size={size} className={className} />;
}
