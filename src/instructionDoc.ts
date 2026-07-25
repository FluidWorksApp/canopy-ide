// Parsing an agent instruction file into pieces you can edit one at a time,
// and putting it back together without disturbing anything you didn't touch.
//
// The whole difficulty of a structured editor over a file someone hand-wrote is
// that re-serializing it normally rewrites the lot: spacing, list markers, the
// order of frontmatter keys. Editing one bullet in a CLAUDE.md should produce a
// one-line `git diff`, not a reformat of a file the user shares with their team.
//
// So every section keeps its verbatim source, and only sections actually marked
// `dirty` are regenerated. The invariant, which instructionDoc.test.ts pins
// down: serializeDoc(parseDoc(t)) === t, for any t.

export interface DocSection {
  /** Stable for the life of one parse — a React key, not an identity. */
  id: string;
  /** 2 for `##`, 3 for `###`, and so on. */
  level: number;
  heading: string;
  /** Verbatim source, heading line included. Re-emitted as-is unless dirty. */
  raw: string;
  /** The body alone, blank lines trimmed off both ends. What the editor binds
   *  a textarea to. */
  body: string;
  /** Set when the body is nothing but top-level bullets — then the section
   *  edits as a list of items (add / remove / update) instead of a blob. */
  items?: string[];
  /** The user changed this section, so it gets regenerated rather than
   *  re-emitted. Nothing else in the file is touched. */
  dirty?: boolean;
}

export interface InstructionDoc {
  /** The leading `---` block, fences and trailing newline included. */
  frontmatter: string | null;
  /** Everything between the frontmatter and the first `##` heading — usually
   *  the `# Title` and an intro paragraph. */
  preamble: string;
  sections: DocSection[];
}

/** A heading that opens a section. `#` is left alone: a document's title is not
 *  one of its sections, and treating it as one would nest the whole file inside
 *  its first card. */
const HEADING = /^(#{2,6})\s+(.*)$/;

/** A fence opener/closer — ``` or ~~~, any length from three. */
const FENCE = /^\s*(```|~~~)/;

/** Split keeping line terminators, so the parts join back to the original
 *  exactly — including whether the file ended with a newline, and whether its
 *  line endings were CRLF. */
function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

/** A bullet at column zero. Indented bullets are continuations or nesting, and
 *  a section containing any of them falls back to the plain-text editor rather
 *  than being flattened into a list that would lose the structure. */
const BULLET = /^[-*]\s+(.*)$/;

function bulletItems(body: string): string[] | undefined {
  const lines = body.split("\n");
  const content = lines.filter((l) => l.trim() !== "");
  if (content.length === 0) return undefined;
  const items: string[] = [];
  for (const line of content) {
    const m = BULLET.exec(line);
    if (!m) return undefined;
    items.push(m[1]);
  }
  return items;
}

/** Strip blank lines from both ends, leaving the interior alone. */
function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

export function parseDoc(text: string): InstructionDoc {
  const lines = splitLines(text);
  let i = 0;

  // Frontmatter: a `---` on the very first line, closed by another `---`. An
  // unclosed opener is not frontmatter — it's a horizontal rule, or a file
  // mid-edit — and swallowing the document would be the worse reading.
  let frontmatter: string | null = null;
  if (lines.length > 0 && lines[0].trim() === "---") {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === "---") {
        frontmatter = lines.slice(0, j + 1).join("");
        i = j + 1;
        break;
      }
    }
  }

  // Where each section begins. Headings inside a fenced code block don't count:
  // a shell snippet full of `## comments` is content, not structure.
  const starts: { index: number; level: number; heading: string }[] = [];
  let fenced = false;
  for (let j = i; j < lines.length; j++) {
    const line = lines[j].replace(/\r?\n$/, "");
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = HEADING.exec(line);
    if (m) starts.push({ index: j, level: m[1].length, heading: m[2].trim() });
  }

  const preamble = lines.slice(i, starts.length > 0 ? starts[0].index : lines.length).join("");

  const sections: DocSection[] = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index : lines.length;
    const raw = lines.slice(s.index, end).join("");
    const body = trimBlankLines(lines.slice(s.index + 1, end).join(""));
    return {
      id: `s${k}`,
      level: s.level,
      heading: s.heading,
      raw,
      body,
      items: bulletItems(body),
    };
  });

  return { frontmatter, preamble, sections };
}

/** Regenerate one section from its edited parts. Only ever called for a section
 *  the user changed — which is what keeps the rest of the file byte-identical. */
function render(section: DocSection): string {
  const head = `${"#".repeat(section.level)} ${section.heading}\n`;
  const body = section.items
    ? section.items
        .map((it) => it.trim())
        .filter((it) => it !== "")
        .map((it) => `- ${it}\n`)
        .join("")
    : `${trimBlankLines(section.body)}\n`;
  if (trimBlankLines(body) === "") return `${head}\n`;
  return `${head}\n${body}\n`;
}

export function serializeDoc(doc: InstructionDoc): string {
  return (
    (doc.frontmatter ?? "") +
    doc.preamble +
    doc.sections.map((s) => (s.dirty ? render(s) : s.raw)).join("")
  );
}

// ---------- frontmatter fields ----------

export interface FrontmatterLine {
  /** "" for a line that isn't a plain `key: value` — kept verbatim so comments,
   *  nested maps and lists survive an edit to the field next to them. */
  key: string;
  value: string;
  raw: string;
}

const FM_FIELD = /^([A-Za-z][\w-]*):[ \t]*(.*)$/;

/** The `key: value` lines of a frontmatter block, in order. Deliberately not a
 *  YAML parser: a skill's `name` and `description` are the fields worth a form,
 *  and anything more structured has to survive untouched rather than be
 *  round-tripped through a model of YAML this app has no business having. */
export function parseFrontmatter(frontmatter: string | null): FrontmatterLine[] {
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/);
  // Drop the fences; the last element is the "" after the trailing newline.
  const inner = lines.slice(1, lines.lastIndexOf("---"));
  return inner.map((raw) => {
    const m = FM_FIELD.exec(raw);
    return m ? { key: m[1], value: unquote(m[2]), raw } : { key: "", value: "", raw };
  });
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))))
    return t.slice(1, -1);
  return t;
}

/** Quote only when the value would otherwise change meaning as YAML — a bare
 *  string stays bare, so setting `name` doesn't gratuitously add quotes to a
 *  file that had none. */
function quote(v: string): string {
  if (v === "") return '""';
  if (/^[\w][\w \-./]*$/.test(v) && !/^\s|\s$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Set one frontmatter field, leaving every other line exactly as it was. A key
 *  that isn't there yet is appended. */
export function setFrontmatterField(
  frontmatter: string | null,
  key: string,
  value: string,
): string {
  const fields = parseFrontmatter(frontmatter);
  const line = `${key}: ${quote(value)}`;
  const i = fields.findIndex((f) => f.key === key);
  const next = i === -1 ? [...fields.map((f) => f.raw), line] : fields.map((f, j) => (j === i ? line : f.raw));
  return `---\n${next.join("\n")}\n---\n`;
}
