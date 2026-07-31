// LSP hover payloads arrive in four shapes across three protocol revisions
// (plain string, {language,value}, MarkupContent, or an array of any of those).
// Flattening them is pure string work, so it lives here and is tested without
// Monaco.

/** Chars kept of a hover body. Long enough for a real signature plus the first
 *  paragraph of docs; short enough that a well-documented stdlib symbol can't
 *  spend the agent's context on prose it didn't ask for. */
export const MAX_HOVER_CHARS = 2000;

type MarkedString = string | { language?: string; value?: string };
export type HoverContents =
  | MarkedString
  | MarkedString[]
  | { kind?: string; value?: string }
  | null
  | undefined;

const one = (part: MarkedString): string =>
  typeof part === "string" ? part : (part?.value ?? "");

/** The hover as plain text: fenced blocks unwrapped, blank runs collapsed,
 *  capped. Empty string when the server had nothing to say — the caller turns
 *  that into an honest "no hover here" rather than an empty success. */
export function flattenHover(contents: HoverContents): string {
  const parts: string[] = Array.isArray(contents)
    ? contents.map(one)
    : contents == null
      ? []
      : typeof contents === "string"
        ? [contents]
        : [contents.value ?? ""];

  const text = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n")
    // Fences carry no information once this is plain text, and the closing one
    // often lands mid-truncation looking like broken output.
    .replace(/^```[a-zA-Z0-9_-]*\n?/gm, "")
    .replace(/^```$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.length > MAX_HOVER_CHARS ? `${text.slice(0, MAX_HOVER_CHARS).trimEnd()}…` : text;
}
