// The one way markdown is displayed in this app.
//
// Before this existed, `renderMarkdown` was shared but everything *around* it
// was not: fenced-code highlighting and mermaid diagrams lived inside the file
// viewer, so the same text rendered with different capabilities depending on
// which tab you happened to be in. A diagram in a PR description was a wall of
// mermaid source; the identical diagram in a committed .md file drew. That is
// the bug this component closes, and the reason every surface now goes through
// one place: a markdown feature added here appears everywhere at once, which is
// the only version of "we support markdown" that stays true.
//
// Two grades, and the split is a security boundary rather than a preference.
// Rendering — highlighting, diagrams, callouts, heading anchors, the image
// lightbox — is safe on anything, because none of it takes an action. Features
// that mint internal navigation or write back to disk are `owned` only: a
// GitHub issue body is authored by whoever can file an issue on a repo you
// opened, and an internal-looking link is exactly what you would forge.
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  headingSlug,
  parseCallout,
  renderMarkdown,
  type Heading,
} from "../markdown";

export interface MarkdownProps {
  text: string;
  /** Where the text came from.
   *
   *  `owned` — a note, a research entry, a file in the user's workspace. Gets
   *  wikilinks and (with `onToggleTask`) live checkboxes.
   *  `external` — a PR body, an issue from a tracker, anything authored
   *  elsewhere. Renders identically; navigates and writes nothing. */
  origin?: "owned" | "external";
  className?: string;
  /** Follow a `[[wikilink]]`. Only ever called for `owned` text — without it,
   *  wikilinks render as plain inert text rather than as dead links. */
  onWikilink?: (target: string) => void;
  /** Toggle a `- [ ]` task. Given the source text with that one checkbox
   *  flipped, for the caller to persist however it persists things. `owned`
   *  only. Absent means the checkboxes render, disabled, as GitHub shows them. */
  onToggleTask?: (nextText: string) => void;
  /** Called with the document's headings whenever they change — what an outline
   *  or a table of contents renders from. */
  onOutline?: (headings: Heading[]) => void;
}

/** Flip the nth `- [ ]` / `- [x]` in the source.
 *
 *  Counted in the source rather than matched by label: two tasks in a document
 *  routinely say the same thing ("- [ ] test it" under two headings), and
 *  matching text would tick whichever came first. Exported for its test.
 */
export function toggleTaskAt(text: string, index: number): string {
  let seen = -1;
  return text.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/gm, (all, head, mark, tail) => {
    seen += 1;
    if (seen !== index) return all;
    return `${head}${mark === " " ? "x" : " "}${tail}`;
  });
}

/** Memoised: marked + DOMPurify per call is too expensive to run inside a
 *  render loop, and a PR tab renders one of these per comment. */
export const Markdown = memo(function Markdown({
  text,
  origin = "external",
  className,
  onWikilink,
  onToggleTask,
  onOutline,
}: MarkdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const owned = origin === "owned";
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const html = useMemo(
    () => renderMarkdown(text, { wikilinks: owned }),
    [text, owned],
  );

  // ---- heading anchors + outline ----
  //
  // Runs before the other passes so an outline is available even for a document
  // whose diagrams are still loading.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const seen = new Map<string, number>();
    const headings: Heading[] = [];
    el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((h) => {
      const label = h.textContent ?? "";
      const base = headingSlug(label);
      // Two "## Notes" in one document is normal, and both have to be
      // addressable, so a repeat gets a suffix rather than the same id twice.
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = n === 0 ? base : `${base}-${n}`;
      h.id = id;
      h.classList.add("md-heading");
      headings.push({ id, level: Number(h.tagName[1]), text: label });
    });
    onOutline?.(headings);
  }, [html, onOutline]);

  // ---- callouts ----
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>("blockquote").forEach((quote) => {
      const first = quote.querySelector("p");
      if (!first) return;
      const callout = parseCallout(first.textContent?.split("\n")[0] ?? "");
      if (!callout) return;
      quote.classList.add("md-callout", `md-callout-${callout.kind}`);
      // Drop the marker line but keep whatever followed it on the same
      // paragraph — `> [!NOTE] and some prose` is one paragraph, and eating the
      // whole node would lose the prose.
      const rest = (first.innerHTML.split("\n").slice(1).join("\n")).trim();
      const head = document.createElement("div");
      head.className = "md-callout-title";
      head.textContent = callout.title;
      first.innerHTML = rest;
      if (!rest) first.remove();
      quote.prepend(head);
      if (callout.folded) quote.classList.add("md-callout-folded");
    });
  }, [html]);

  // ---- task checkboxes ----
  //
  // Rendered by marked as disabled inputs. On owned text with a handler they
  // become live; everywhere else they stay exactly as GitHub shows them, which
  // is readable and inert.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const boxes = el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    boxes.forEach((box, i) => {
      box.classList.add("md-task");
      const live = owned && !!onToggleTask;
      box.disabled = !live;
      if (!live) return;
      box.dataset.taskIndex = String(i);
      box.closest("li")?.classList.add("md-task-item");
    });
  }, [html, owned, onToggleTask]);

  // ---- syntax highlighting ----
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const blocks = el.querySelectorAll<HTMLElement>(
      'pre code[class*="language-"]:not(.language-mermaid)',
    );
    if (blocks.length === 0) return;
    let cancelled = false;
    void import("highlight.js/lib/common").then(({ default: hljs }) => {
      if (cancelled) return;
      blocks.forEach((block) => {
        try {
          hljs.highlightElement(block);
        } catch {
          // unknown language; leave plain
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [html]);

  // ---- mermaid ----
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const blocks = el.querySelectorAll("code.language-mermaid");
    if (blocks.length === 0) return;
    let cancelled = false;
    void import("mermaid").then(({ default: mermaid }) => {
      if (cancelled) return;
      mermaid.initialize({ startOnLoad: false, theme: "dark" });
      blocks.forEach((block, i) => {
        const pre = block.parentElement;
        if (!pre) return;
        const container = document.createElement("div");
        container.className = "mermaid-diagram";
        pre.replaceWith(container);
        mermaid
          // Ids must be unique across every diagram alive in the document, not
          // just within this one render — two markdown panes open at once
          // otherwise collide and the second overwrites the first.
          .render(`mmd-${diagramSeq++}-${i}`, block.textContent ?? "")
          .then(({ svg }) => {
            if (!cancelled) container.innerHTML = svg;
          })
          .catch((err) => {
            container.innerHTML = `<pre class="mermaid-error">mermaid: ${String(err)}</pre>`;
          });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [html]);

  // ---- clicks: wikilinks, task boxes, images ----
  //
  // One delegated listener rather than per-node handlers: the content is
  // replaced wholesale on every render, and re-binding dozens of nodes each
  // time is both slower and a leak waiting to happen.
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;

      const box = target.closest<HTMLInputElement>('input[type="checkbox"]');
      if (box && owned && onToggleTask) {
        e.preventDefault();
        const i = Number(box.dataset.taskIndex);
        if (Number.isInteger(i)) onToggleTask(toggleTaskAt(text, i));
        return;
      }

      // Only honoured for owned content. An external body can hand-write this
      // exact anchor — data-* survives sanitising — and this is where that
      // stops being interesting: the handler simply isn't wired up there.
      const wiki = target.closest<HTMLElement>("a.wikilink");
      if (wiki && owned && onWikilink) {
        e.preventDefault();
        const to = wiki.dataset.wikilink;
        if (to) onWikilink(to);
        return;
      }

      const img = target.closest<HTMLImageElement>("img");
      if (img?.src) {
        e.preventDefault();
        setLightbox({ src: img.src, alt: img.alt });
      }
    },
    [owned, onToggleTask, onWikilink, text],
  );

  return (
    <>
      <div
        ref={ref}
        className={`markdown-body${className ? ` ${className}` : ""}`}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {lightbox && (
        <Lightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
});

/** Module-scoped so ids stay unique across every pane, not just within one. */
let diagramSeq = 0;

/** Full-size view of an image in the document.
 *
 *  Worth its own layer because the alternative is what the note attachments
 *  did: a screenshot rendered into a 110px strip, cover-cropped, which is
 *  exactly the case where you pasted the picture *because* the detail mattered.
 */
function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture, so this closes before any surface-level Escape handler decides
    // the whole tab or palette should close instead.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="md-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image"}
      onClick={onClose}
    >
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      {alt && <figcaption>{alt}</figcaption>}
      <button className="md-lightbox-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
