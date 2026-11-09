// Draft a pull request's title and description from what the branch holds.
//
// Framework-free and offline on purpose: the dialog must open with something
// useful on a plane. Title style follows docs/pull-request-etiquette.md (an
// imperative outcome in sentence case, no `feat:` prefix). An AI pass can be
// layered on with `generatePrDraftRefined`, which always falls back here.

import { basename } from "./paths";

export interface PrDraftInput {
  branch: string;
  /** Commit subjects since the merge-base, oldest first. */
  commits: string[];
  files: string[];
  /** `git diff --shortstat`. */
  stat: string;
  /** The repo's PR template, when it keeps one. */
  template: string | null;
  ticket?: { id: string; title: string; url: string } | null;
}

export interface PrDraft {
  title: string;
  body: string;
}

const CONVENTIONAL = /^(feat|fix|docs|test|perf|refactor|chore|build|ci|style|revert)(\([^)]*\))?!?:\s*/i;
const BRANCH_TYPE = /^(feat|fix|docs|test|perf|refactor|chore|release)\//i;

const sentence = (s: string): string => {
  const t = s.trim().replace(/[.\s]+$/, "");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
};

const stripPrefix = (s: string): string => s.replace(CONVENTIONAL, "");

/** `feat/remote-search` -> "remote search"; empty when what is left is a bare
 *  name like `main-2` or a number that says nothing about the change. */
function branchPhrase(branch: string): string {
  const slug = basename(branch.replace(BRANCH_TYPE, ""));
  const words = slug.replace(/^\d+[-_]?/, "").replace(/[-_]+/g, " ").trim();
  if (!words || /^(main|master|develop|trunk|dev|wip|patch|test)( \d+)?$/i.test(words)) return "";
  if (/^\w+ \d+$/.test(words)) return "";
  return words;
}

function draftTitle(i: PrDraftInput): string {
  if (i.ticket?.title.trim()) return sentence(i.ticket.title);
  if (i.commits.length === 1) return sentence(stripPrefix(i.commits[0]));
  const fromBranch = branchPhrase(i.branch);
  if (fromBranch) return sentence(fromBranch);
  if (i.commits.length) return sentence(stripPrefix(i.commits[0]));
  return sentence(i.branch);
}

/** Group by the area a reader would name: `src`, `crates/core`, a top folder. */
function areaOf(file: string): string {
  const parts = file.split("/");
  if (parts.length === 1) return "Repository root";
  if (parts.length > 2 && ["crates", "packages", "src-tauri"].includes(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function changesList(files: string[]): string {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const a = areaOf(f);
    groups.set(a, [...(groups.get(a) ?? []), f]);
  }
  return [...groups]
    .map(([area, fs]) => {
      const names = fs.slice(0, 3).map((f) => basename(f));
      const more = fs.length > 3 ? `, +${fs.length - 3} more` : "";
      return `- \`${area}\`: ${fs.length} file${fs.length === 1 ? "" : "s"} (${names.join(", ")}${more})`;
    })
    .join("\n");
}

function ticketLine(t: NonNullable<PrDraftInput["ticket"]>): string {
  return /^#\d+$/.test(t.id) ? `Closes ${t.id}` : `Ticket: ${t.id} (${t.url})`;
}

function summaryText(i: PrDraftInput): string {
  const subjects = i.commits.map((c) => stripPrefix(c).trim().replace(/[.\s]+$/, "")).filter(Boolean);
  const lines = subjects.length ? subjects.map((s) => (subjects.length > 1 ? `- ${s}` : s)) : [];
  return lines.length ? lines.join("\n") : draftTitle(i);
}

const TESTING_PLACEHOLDER = "Describe how this was verified.";
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

type Kind = "summary" | "changes" | "testing";
const kindOf = (heading: string): Kind | null => {
  const h = heading.toLowerCase();
  if (/test|verif/.test(h)) return "testing";
  if (/summary|description|overview|what|why|about/.test(h)) return "summary";
  if (/changes|changelog/.test(h)) return "changes";
  return null;
};

function fillTemplate(template: string, parts: Record<Kind, string>, tail: string): string {
  const lines = template.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const used = new Set<Kind>();
  let i = 0;
  while (i < lines.length) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    const kind = m ? kindOf(m[2]) : null;
    if (!m || !kind || used.has(kind)) {
      out.push(lines[i++]);
      continue;
    }
    used.add(kind);
    out.push(lines[i++]);
    // Swallow the section's old content: placeholder comments and blank
    // lines, but never a checklist or prose the author wrote on purpose.
    const start = i;
    while (i < lines.length && !/^#{1,6}\s/.test(lines[i])) i++;
    const kept = lines
      .slice(start, i)
      .join("\n")
      .replace(HTML_COMMENT, "")
      .trim();
    out.push(parts[kind], ...(kept ? ["", kept] : []), "");
  }
  if (!used.size) return `${tail}\n\n${template.trim()}\n`;
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function generatePrDraft(input: PrDraftInput): PrDraft {
  const title = draftTitle(input);
  const link = input.ticket ? ticketLine(input.ticket) : "";
  const summary = [summaryText(input), link].filter(Boolean).join("\n\n");
  const changes = [changesList(input.files), input.stat && `\n${input.stat}`]
    .filter(Boolean)
    .join("\n");
  const section = (h: string, text: string) => `## ${h}\n${text}`;

  if (input.template?.trim()) {
    const tail = section("Summary", summary);
    const body = fillTemplate(
      input.template,
      { summary, changes: changes || "No file changes yet.", testing: TESTING_PLACEHOLDER },
      tail,
    );
    return { title, body };
  }
  const body =
    [
      section("Summary", summary),
      section("Changes", changes || "No file changes yet."),
      section("Testing", `- [ ] ${TESTING_PLACEHOLDER}`),
    ].join("\n\n") + "\n";
  return { title, body };
}

export type PrRefiner = (draft: PrDraft, input: PrDraftInput) => Promise<PrDraft>;

/** The heuristic draft, improved by `refine` when one is supplied and
 *  answers. Anything else (no refiner, offline, an empty reply) keeps the
 *  heuristic draft, so generation never fails for want of a model. */
export async function generatePrDraftRefined(
  input: PrDraftInput,
  refine: PrRefiner | null,
): Promise<PrDraft> {
  const draft = generatePrDraft(input);
  if (!refine) return draft;
  try {
    const out = await refine(draft, input);
    return out.title.trim() && out.body.trim() ? out : draft;
  } catch {
    return draft;
  }
}
