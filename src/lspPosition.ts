// Where in a file to ask the language server about. Its own module because it
// is pure string work that must be testable without dragging Monaco (and its
// stylesheets) into a test runner.

export interface LspPosition {
  line: number;
  character: number;
}

/** An explicit 1-based line/column, or the first whole-word occurrence of a
 *  symbol — "who calls handleFoo" shouldn't require the agent to grep for the
 *  line number first. Throws rather than guessing when the name isn't there. */
export function positionOf(
  text: string,
  op: { line?: number | null; column?: number | null; symbol?: string | null },
): LspPosition {
  if (op.line != null) {
    return { line: Math.max(0, op.line - 1), character: Math.max(0, (op.column ?? 1) - 1) };
  }
  const symbol = op.symbol ?? "";
  const lines = text.split("\n");
  const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].search(pattern);
    if (at >= 0) return { line: i, character: at };
  }
  throw new Error(`"${symbol}" doesn't appear in that file`);
}
