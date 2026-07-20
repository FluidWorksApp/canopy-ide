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
import DOMPurify, { type Config } from "dompurify";
import { marked } from "marked";

/** Links open externally (see main.tsx) — keep href/target/rel, drop the rest
 *  of the attribute surface that carries script (on*, formaction, srcdoc…). */
const CONFIG: Config = {
  USE_PROFILES: { html: true },
  // javascript:/data: URLs in href or src stay out regardless of profile.
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
  ADD_ATTR: ["target", "rel"],
};

/** Render untrusted markdown to HTML that is safe to inject. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }), {
    ...CONFIG,
    RETURN_TRUSTED_TYPE: false,
  });
}

/** Sanitize a string that is already HTML (an .html file, a notebook cell). */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, { ...CONFIG, RETURN_TRUSTED_TYPE: false });
}
