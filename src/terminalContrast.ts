/**
 * A renderer-side contrast floor for CLIs whose own TUI can emit foreground /
 * background pairs that disagree about whether the terminal is light or dark.
 *
 * Codex currently paints some dark true-colour surfaces while leaving their
 * text on the terminal palette, and also emits pale bold command colours on a
 * light terminal. xterm can correct those actual cell pairs without changing
 * the palette or any other CLI. A ratio of 4.5 is the WCAG AA text floor.
 */
export function terminalMinimumContrast(agentId: string | null): number {
  return agentCliFor(agentId)?.capabilities?.terminalMinimumContrast ?? 1;
}
import { agentCliFor } from "./projects";
