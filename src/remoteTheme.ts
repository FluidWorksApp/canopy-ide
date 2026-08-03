/** The browser-safe token contract shared by the desktop and Remote shells. */
export const REMOTE_THEME_VARS = [
  "bg-deep",
  "bg-alt",
  "bg",
  "bg-raised",
  "bg-overlay",
  "border",
  "border-strong",
  "text",
  "text-dim",
  "text-faint",
  "accent",
  "accent-soft",
  "danger",
  "ok",
  "warn",
  "magenta",
  "cyan",
  "on-accent",
  "on-danger",
  "ring",
  "r-xs",
  "r-sm",
  "r-md",
  "r-lg",
  "shadow-1",
  "shadow-2",
  "shadow-3",
  "ease-out",
  "dur-fast",
  "dur-press",
  "dur-med",
  "dur-pop",
  "font-ui",
  "font-mono",
  "fs-xs",
  "fs-sm",
  "fs-md",
  "fs-lg",
  "fs-xl",
  "lh-tight",
  "lh-ui",
  "lh-code",
] as const;

export function readRemoteThemeTokens(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of REMOTE_THEME_VARS) {
    const value =
      styles.getPropertyValue(`--${name}-opaque`).trim() ||
      styles.getPropertyValue(`--${name}`).trim();
    if (value) tokens[name] = value;
  }
  return tokens;
}
