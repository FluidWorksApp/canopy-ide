export type VibeRequestMode = "question" | "change";

const CHANGE_VERB =
  "add|build|change|connect|create|delete|deploy|design|edit|fix|implement|install|integrate|link|make|move|remove|rename|replace|set up|setup|ship|update|write";

const DIRECT_CHANGE = new RegExp(
  `^(?:please\\s+)?(?:${CHANGE_VERB})\\b|^(?:can|could|would|will)\\s+you\\b[\\s\\S]*\\b(?:${CHANGE_VERB})\\b|\\b(?:i want you to|let(?:'|’)s|go ahead and)\\b[\\s\\S]*\\b(?:${CHANGE_VERB})\\b|[?!.,;:]\\s*(?:please\\s+)?(?:${CHANGE_VERB})\\b`,
  "i",
);

const QUESTION =
  /^(?:what(?:'|’)?s|what|why|how|where|when|who|which|is|are|am|was|were|do|does|did|can|could|would|should|will|explain|tell me|help me understand|identify|diagnose)\b/i;

/** Build defaults to action, but an unmistakable question stays read-only.
 * Direct requests such as “can you fix this?” win over their question-shaped
 * grammar because they still ask Canopy to change the project. */
export function vibeRequestMode(message: string): VibeRequestMode {
  const text = message.trim();
  if (!text) return "change";
  if (DIRECT_CHANGE.test(text)) return "change";
  return QUESTION.test(text) || text.endsWith("?") ? "question" : "change";
}

/** Explicit editor events override the initial language classification. */
export function vibeToolChangesProject(name: string): boolean {
  return /(?:^|[_. -])(edit|write|patch|create|delete|move|rename)(?:$|[_. -])/i.test(
    name,
  );
}
