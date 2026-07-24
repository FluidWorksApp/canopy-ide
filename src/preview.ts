// Preview-tab annotations: what the injected picker reports for a clicked
// element, plus the user's comment — and the opening context an agent gets
// when the feedback is handed over (same single-line contract as
// ticketContext/prReviewContext: PTY-typed prompts must not contain newlines,
// which would submit early in some TUIs).

/** A server detected listening inside one of this project's terminals (lsof
 *  ports from SessionStats), tied back to the component whose directory the
 *  terminal runs in — the link from "a URL" to "the codebase that serves it". */
export interface PreviewServer {
  url: string;
  port: number;
  ptyId: number;
  /** Terminal title, e.g. the run command's name ("server"). */
  title: string;
  command?: string;
  cwd: string;
  /** Component whose path contains the terminal's cwd; null when the terminal
   *  runs somewhere outside every component (componentPath falls back to cwd). */
  componentLabel: string | null;
  componentPath: string;
  /** From the RUNS rail (a configured run command) vs. a plain shell. */
  run: boolean;
}

/** The server a previewed URL belongs to: loopback host + matching port. */
export function serverForUrl(url: string, servers: PreviewServer[]): PreviewServer | null {
  try {
    const u = new URL(url);
    if (!["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(u.hostname)) return null;
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return servers.find((s) => s.port === port) ?? null;
  } catch {
    return null;
  }
}

export interface PreviewAnnotation {
  n: number;
  selector: string;
  tag: string;
  id: string | null;
  classes: string;
  text: string;
  html: string;
  /** React component names walked up from the element, most specific first. */
  components: string[];
  rect: { x: number; y: number; w: number; h: number };
  pageUrl: string;
  pageTitle: string;
  comment: string;
}

/** One flat line per annotation; the HTML excerpt is elided down to a tag
 *  skeleton so the prompt stays a prompt, not a page dump. */
function annotationLine(a: PreviewAnnotation): string {
  const where = [
    a.components.length ? `component ${a.components.join(" < ")}` : null,
    `selector \`${a.selector}\``,
  ]
    .filter(Boolean)
    .join(", ");
  const label = a.text ? ` — visible text "${flat(a.text, 120)}"` : "";
  const note = a.comment.trim() ? ` Feedback: ${flat(a.comment.trim(), 500)}` : "";
  return `(${a.n}) <${a.tag}${a.id ? ` id="${a.id}"` : ""}${
    a.classes ? ` class="${flat(a.classes, 100)}"` : ""
  }> at ${where}${label}.${note}`;
}

const flat = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

export function previewFeedbackContext(
  url: string,
  annotations: PreviewAnnotation[],
  server?: PreviewServer | null,
): string {
  const parts = annotations.map(annotationLine).join(" ");
  // Name the serving codebase when we know it, so the agent doesn't guess
  // which component (or sibling repo) produced the page.
  const source = server
    ? `The page is served by the "${server.title}" run` +
      (server.command ? ` (\`${server.command}\`)` : "") +
      ` working in ${
        server.componentLabel ? `the "${server.componentLabel}" component, ` : ""
      }\`${server.componentPath}\` — that is the codebase to change. `
    : "";
  return (
    `I was previewing this project's running page at ${url} and marked ` +
    `${annotations.length === 1 ? "an element" : `${annotations.length} elements`} with feedback. ` +
    source +
    `For each item, find where that element is produced in the source (the component ` +
    `names and CSS selectors are hints from the live DOM) and make the requested change: ${parts} ` +
    `Verify the result compiles/renders, and summarize what you changed per item.`
  );
}
