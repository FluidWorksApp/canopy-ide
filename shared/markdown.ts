// The only sanctioned way to turn text into HTML in this app.
//
// `marked` has had no `sanitize` option since v5 — it passes raw HTML blocks
// and inline HTML through verbatim, by design. Anything rendered with
// dangerouslySetInnerHTML therefore has to be sanitized here first, and every
// such call site imports from this module rather than reaching for
// marked.parse itself, so the next renderer can't quietly reintroduce the gap.
//
// This is not theoretical: issue bodies (GitHub and Linear) are authored by
// whoever can file an issue on a repo you open. Rendering them raw meant an
// `<img src=x onerror=…>` in an issue got script execution in the webview —
// and every Tauri command registered by the app (pty_write into your running
// login shell, fs_read_file, git_push) is reachable from page script, so that
// was arbitrary command execution as the user, triggered by reading a ticket.
//
// That threat model is also what splits markdown into two grades here. Every
// surface gets the same *rendering* (see components/Markdown.tsx); only content
// the app itself owns — a note, a research entry, a file in your own workspace —
// gets the features that mint internal navigation or write back. See
// `RenderOptions.wikilinks`.
import DOMPurify, { type Config } from "dompurify";
import { Marked, type Tokens } from "marked";

/** Links open externally (see main.tsx) — keep href/target/rel, drop the rest
 *  of the attribute surface that carries script (on*, formaction, srcdoc…).
 *
 *  `data-*` survives (DOMPurify allows it by default) and that is deliberate
 *  but load-bearing: it means a hostile issue body can hand-write
 *  `<a class="wikilink" data-wikilink="…">` and have it survive sanitising. It
 *  cannot *do* anything, because the click handler that gives those meaning is
 *  only attached on surfaces that opted into wikilinks — see Markdown.tsx. */
const CONFIG: Config = {
  USE_PROFILES: { html: true },
  // javascript:/data: URLs in href or src stay out regardless of profile.
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
  ADD_ATTR: ["target", "rel", "type", "checked"],
  // `ALLOWED_URI_REGEXP` above is applied to every attribute value DOMPurify
  // does not already know to be URI-free — not just to href and src. So a
  // perfectly ordinary `type="checkbox"` fails the "is this an allowed URL"
  // test and is dropped, and an <input> with no type is a *text field*: every
  // task list in the app, including every GitHub PR description with a
  // checklist in it, rendered as a row of disabled text boxes.
  //
  // Naming them here says "these are not URIs, don't URL-check them". It grants
  // nothing else: the vectors on an input are `on*` and `formaction`, and both
  // stay excluded.
  ADD_URI_SAFE_ATTR: ["type", "checked"],
};

export interface RenderOptions {
  /** Turn `[[target]]` and `[[target|label]]` into internal links.
   *
   *  Off by default, and only ever on for content the app owns. On a GitHub
   *  issue body it would be both meaningless — nobody writing a ticket means a
   *  Canopy note — and a phishing surface, since an internal-looking link is
   *  exactly what you would forge to get someone to click it. */
  wikilinks?: boolean;
}

/** `[[target]]` / `[[target|label]]`, as a marked inline extension.
 *
 *  An extension rather than a regex over the source text, because the source
 *  text is the one place this must NOT apply everywhere: `[[foo]]` inside a
 *  code span or a fenced block is code someone is quoting, and rewriting it
 *  into a link corrupts the very thing they were showing you. Tokenizers run
 *  after code has already been claimed, so this gets that for free. */
const wikilinkExtension = {
  name: "wikilink",
  level: "inline" as const,
  start: (src: string) => src.indexOf("[["),
  tokenizer(src: string) {
    // No nested `]` in the target, so an unclosed `[[` cannot swallow the rest
    // of the document.
    const match = /^\[\[([^\][|\n]+)(?:\|([^\][\n]*))?\]\]/.exec(src);
    if (!match) return undefined;
    const target = match[1].trim();
    if (!target) return undefined;
    return {
      type: "wikilink",
      raw: match[0],
      target,
      label: (match[2] ?? "").trim() || target,
    };
  },
  renderer(token: Tokens.Generic) {
    const target = escapeAttr(String(token.target));
    // No href: the anchor is inert until a surface's own click handler picks it
    // up by `data-wikilink`. A real href would make it navigable — and this
    // never points anywhere a browser could go.
    return `<a class="wikilink" data-wikilink="${target}">${escapeText(String(token.label))}</a>`;
  },
};

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Two instances rather than toggling options on the shared singleton: `marked`
// holds extensions as global state, so registering per call would leak
// wikilinks onto every subsequent render — including the ticket bodies that
// must never have them.
const plain = new Marked();
const withWikilinks = new Marked({ extensions: [wikilinkExtension] });

/** Render untrusted markdown to HTML that is safe to inject. */
export function renderMarkdown(text: string, opts: RenderOptions = {}): string {
  const engine = opts.wikilinks ? withWikilinks : plain;
  return DOMPurify.sanitize(engine.parse(text, { async: false }) as string, {
    ...CONFIG,
    RETURN_TRUSTED_TYPE: false,
  });
}

/** Sanitize a string that is already HTML (an .html file, a notebook cell). */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { ...CONFIG, RETURN_TRUSTED_TYPE: false });
}

// ---------- outline ----------

export interface Heading {
  /** Anchor id, assigned by the renderer (see Markdown.tsx). */
  id: string;
  level: number;
  text: string;
}

/** A slug for a heading, GitHub-style: lowercased, punctuation dropped, spaces
 *  to dashes. Collisions get a numeric suffix by the caller, because a document
 *  with two "## Notes" headings is normal and both need to be reachable. */
export function headingSlug(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "section";
}

// ---------- callouts ----------

/** The callout kinds GitHub renders and Obsidian popularised, plus the aliases
 *  each spells differently. Anything else stays an ordinary blockquote rather
 *  than being invented into a callout nobody styled. */
const CALLOUTS: Record<string, string> = {
  note: "note",
  info: "note",
  todo: "note",
  tip: "tip",
  hint: "tip",
  important: "important",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  danger: "danger",
  error: "danger",
  bug: "danger",
  success: "success",
  check: "success",
  done: "success",
  question: "question",
  help: "question",
  faq: "question",
  quote: "quote",
  cite: "quote",
  example: "example",
  abstract: "example",
  summary: "example",
};

/** Match a callout marker at the head of a blockquote: `[!NOTE]`, with an
 *  optional `-`/`+` fold hint (Obsidian) and an optional title after it. */
const CALLOUT_RE = /^\s*\[!([A-Za-z]+)\]([-+]?)\s*(.*)$/;

export interface Callout {
  kind: string;
  title: string;
  /** Obsidian's `-` means "start folded"; `+` means foldable but open. */
  folded: boolean;
  foldable: boolean;
}

/** Read the callout marker out of a blockquote's first line, or null when the
 *  blockquote is just a blockquote. */
export function parseCallout(firstLine: string): Callout | null {
  const m = CALLOUT_RE.exec(firstLine);
  if (!m) return null;
  const kind = CALLOUTS[m[1].toLowerCase()];
  if (!kind) return null;
  return {
    kind,
    // Untitled callouts take the kind as their heading, which is what both
    // GitHub and Obsidian do.
    title: m[3].trim() || m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(),
    folded: m[2] === "-",
    foldable: m[2] !== "",
  };
}
