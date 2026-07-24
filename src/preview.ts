// Preview-tab annotations: what the injected picker reports for a clicked
// element, plus the user's comment — and the opening context an agent gets
// when the feedback is handed over (same single-line contract as
// ticketContext/prReviewContext: PTY-typed prompts must not contain newlines,
// which would submit early in some TUIs).

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

export function previewFeedbackContext(url: string, annotations: PreviewAnnotation[]): string {
  const parts = annotations.map(annotationLine).join(" ");
  return (
    `I was previewing this project's running page at ${url} and marked ` +
    `${annotations.length === 1 ? "an element" : `${annotations.length} elements`} with feedback. ` +
    `For each item, find where that element is produced in this project's source (the component ` +
    `names and CSS selectors are hints from the live DOM) and make the requested change: ${parts} ` +
    `Verify the result compiles/renders, and summarize what you changed per item.`
  );
}
