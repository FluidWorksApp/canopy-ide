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

// Render an agent CLI's brand mark by registry id, falling back to a terminal
// glyph for CLIs we don't have a mark for.
export function AgentIcon({ id, size = 14, className }: IconProps & { id: string }) {
  const Brand = BRAND_ICONS[id];
  return Brand ? <Brand size={size} className={className} /> : <TerminalIcon size={size} className={className} />;
}
