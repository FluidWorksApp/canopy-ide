// The team board's one line about whether agents are being told about each
// other's changes, and if not, why — kept apart from the component so the
// wording is testable on its own.
import type { AwarenessState } from "./engine";

const PAUSED: Record<string, string> = {
  "no-brain": "No brain is connected, so agents get hotspot warnings but no change notes.",
  "signed-out": "The brain's CLI is signed out, so change notes are paused. Hotspot warnings still go out.",
  "rate-limited": "The brain is rate-limited. Change notes resume when it recovers.",
  "over-budget": "Today's brain budget is spent. Change notes resume tomorrow.",
};

/** The one line that says whether agents are being told, and if not why. */
export function statusLine(s: AwarenessState): string {
  switch (s.state) {
    case "on":
      return "When an agent finishes a change, the agents it affects are told.";
    case "off":
      return "Agents aren't told about each other's changes. Turn it on to start.";
    case "remote":
      return "Not available in cloud workspaces yet. The board still shows what is running.";
    case "paused":
      return PAUSED[s.reason] ?? "The last change note failed. Canopy will try again on the next change.";
  }
}
