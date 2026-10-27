// The Agent instructions tab's `focus` value that opens the Rules panel rather
// than a file: `canopy:rules`, or `canopy:rules:<rule ledger id>` to land on
// one rule. A separate module so ProjectView can name it without importing the
// panel.
export const RULES_FOCUS = "canopy:rules";
export const rulesFocus = (ruleId?: string) => (ruleId ? `${RULES_FOCUS}:${ruleId}` : RULES_FOCUS);
