// Everything that shapes an agent before it reads a line of your code, in one
// place and editable. Left: every instruction file the installed CLIs read,
// grouped by reach — this project, your own files, and the skills and subagents
// that apply everywhere. Right: the selected file as editable sections rather
// than a wall of markdown.
//
// The sections are the point. A CLAUDE.md is mostly `## heading` + a bullet
// list, and "add a rule" should be a button, not a cursor hunt. Anything the
// parser can't model edits raw instead (see instructionDoc.ts) — and either way
// only the parts you touched are rewritten, so this never reformats a file your
// team shares.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import { AGENT_CLIS } from "../projects";
import {
  parseDoc,
  parseFrontmatter,
  serializeDoc,
  setFrontmatterField,
  type DocSection,
  type InstructionDoc,
} from "../instructionDoc";
import type { Notify } from "../types";
import { AgentIcon, BRAND_ICONS, InstructionKindIcon, TrashIcon } from "./icons";

/** Display names for agents Canopy doesn't ship a launcher for. Their files
 *  still turn up on disk — a `.cursor/rules` or a `.windsurfrules` is worth
 *  showing whether or not that tool is the one you're using today. */
const OTHER_AGENT_NAMES: Record<string, string> = {
  "cursor-agent": "Cursor",
  copilot: "Copilot",
  gemini: "Gemini CLI",
  goose: "Goose",
  qwen: "Qwen Code",
  droid: "Factory",
  windsurf: "Windsurf",
  junie: "Junie",
  cline: "Cline",
  kiro: "Kiro",
  roo: "Roo Code",
  continue: "Continue",
  zed: "Zed",
};

function agentName(id: string): string {
  return AGENT_CLIS.find((c) => c.id === id)?.name ?? OTHER_AGENT_NAMES[id] ?? id;
}

const KIND_LABEL: Record<string, string> = {
  instructions: "instructions",
  rule: "rule",
  skill: "skill",
  subagent: "subagent",
  command: "command",
  style: "output style",
};

/** Plural headings for the sub-groups inside each group, in the order they read
 *  best: the always-on files first, the on-demand packs after. A kind missing
 *  from here still gets a heading — see `kindTitle`. */
const KIND_ORDER = ["instructions", "rule", "skill", "subagent", "command", "style"];
const KIND_PLURAL: Record<string, string> = {
  instructions: "Instructions",
  rule: "Rules",
  skill: "Skills",
  subagent: "Subagents",
  command: "Commands",
  style: "Output styles",
};
const kindTitle = (kind: string) => KIND_PLURAL[kind] ?? `${KIND_LABEL[kind] ?? kind}s`;
const kindRank = (kind: string) => {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
};

/** One agent's mark. A brand logo where the vendor has one; otherwise a
 *  two-letter monogram, because eight identical fallback glyphs would say less
 *  than the text chips they replaced. */
function AgentMark({ id, size = 13 }: { id: string; size?: number }) {
  const name = agentName(id);
  if (BRAND_ICONS[id])
    return (
      <span className="instr-mark" title={name}>
        <AgentIcon id={id} size={size} />
      </span>
    );
  return (
    <span className="instr-mark instr-mark-mono" title={name}>
      {name.slice(0, 2)}
    </span>
  );
}

/** Split a label into the part that identifies the file and the path leading to
 *  it, so the name can carry the row and the path can recede. */
function splitLabel(label: string): { name: string; dir: string } {
  const i = label.lastIndexOf("/");
  return i === -1
    ? { name: label, dir: "" }
    : { name: label.slice(i + 1), dir: label.slice(0, i + 1) };
}

/** Three groups, by how far the file reaches rather than by which CLI reads it:
 *  the question you open this to answer is "what is being fed to agents here?",
 *  and the agent chips on each row answer the follow-up. */
type GroupId = "project" | "global" | "packs";

const GROUPS: { id: GroupId; title: string; note: string }[] = [
  { id: "project", title: "This project", note: "Committed with the repo — your whole team gets these" },
  { id: "global", title: "Your files", note: "Every project you open, on this machine only" },
  { id: "packs", title: "Skills & subagents", note: "Loaded on demand, when the work calls for them" },
];

function groupOf(f: ipc.InstructionFile): GroupId {
  if (f.kind === "skill" || f.kind === "subagent" || f.kind === "command" || f.kind === "style")
    return "packs";
  return f.scope === "global" ? "global" : "project";
}

/** A starting point for a file being created, so "Create" never leaves someone
 *  staring at an empty buffer wondering what goes in it. */
function template(f: ipc.InstructionFile): string {
  const name = f.label.split("/").pop()?.replace(/\.mdc?$/, "") ?? "instructions";
  if (f.kind === "skill")
    return `---\nname: ${name}\ndescription: What this skill does, and when an agent should reach for it\n---\n\n## Instructions\n\n- \n`;
  if (f.kind === "subagent")
    return `---\nname: ${name}\ndescription: When to delegate to this subagent\n---\n\n## Instructions\n\n- \n`;
  return `# ${name}\n\n## Commands\n\n- \n\n## Conventions\n\n- \n`;
}

/** A row is one line: what it is, what it's called, and who reads it.
 *
 *  The leading mark carries most of the load. A file only one CLI reads *is*
 *  that CLI's — `~/.claude/CLAUDE.md` is Claude's, and its logo says so faster
 *  than the word "Claude" ever did. A file several read has no owner to show,
 *  so it gets the shape of its kind instead and its readers ride along on the
 *  right. Either way the row is a mark and a name, not four runs of text. */
function Row({
  file: f,
  selected,
  showRoot,
  onSelect,
}: {
  file: ipc.InstructionFile;
  selected: boolean;
  /** True when another root holds a file by the same name — see `ambiguous`. */
  showRoot: boolean;
  onSelect: (path: string) => void;
}) {
  const { name, dir } = splitLabel(f.label);
  // A pack names itself in its frontmatter; anything else is named by where it
  // lives, so that path stays on the row rather than retreating to the tooltip.
  const titled = f.title != null && f.title !== "";
  const sole = f.agents.length === 1 ? f.agents[0] : null;
  const readers = f.agents.map(agentName).join(", ");
  return (
    <div
      className={`instr-row ${selected ? "is-sel" : ""} ${f.exists ? "" : "is-missing"}`}
      title={`${f.path}\n${KIND_LABEL[f.kind] ?? f.kind} · read by ${readers}${
        f.description ? `\n\n${f.description}` : ""
      }`}
      onClick={() => onSelect(f.path)}
    >
      <span className="instr-row-icon">
        {sole ? <AgentMark id={sole} size={14} /> : <InstructionKindIcon kind={f.kind} size={14} />}
      </span>
      <span className="instr-row-label">{titled ? f.title : name}</span>
      {!titled && dir !== "" && <span className="instr-row-dir">{dir}</span>}
      {showRoot && f.root !== "" && (
        <span className="instr-root">{f.root.split("/").filter(Boolean).pop()}</span>
      )}
      {!f.exists && <span className="instr-missing">not created</span>}
      {/* Only when there's something the leading mark didn't already say: a
          sole reader is the icon on the left, and repeating it here is noise. */}
      {f.agents.length > 1 && (
        <span className="instr-row-agents" title={`Read by ${readers}`}>
          {f.agents.slice(0, 3).map((a) => (
            <AgentMark key={a} id={a} />
          ))}
          {f.agents.length > 3 && <span className="instr-chip-more">+{f.agents.length - 3}</span>}
        </span>
      )}
    </div>
  );
}

/** A run of rows, split by kind and sorted by name.
 *
 *  This is the second level of the outline: the group says how far these files
 *  reach, the heading here says what they are, and only then does a row have to
 *  carry anything. A run holding one kind skips the heading — it would repeat
 *  what the group title already said — and its rows sit flush instead, so an
 *  indent always means there is a heading above it. */
function KindSections({
  rows,
  selected,
  ambiguous,
  onSelect,
}: {
  rows: ipc.InstructionFile[];
  selected: string | null;
  ambiguous: Set<string>;
  onSelect: (path: string) => void;
}) {
  const kinds = [...new Set(rows.map((f) => f.kind))].sort((a, b) => kindRank(a) - kindRank(b));
  const headed = kinds.length > 1;
  return (
    <>
      {kinds.map((kind) => {
        const inKind = rows
          .filter((f) => f.kind === kind)
          .sort((a, b) =>
            (a.title ?? a.label).localeCompare(b.title ?? b.label, undefined, {
              sensitivity: "base",
            }),
          );
        return (
          <div key={kind}>
            {headed && (
              <div className="instr-kind-head">
                <InstructionKindIcon kind={kind} size={12} />
                {kindTitle(kind)}
                <span className="instr-kind-count">{inKind.length}</span>
              </div>
            )}
            <div className={`instr-rows ${headed ? "is-nested" : ""}`}>
              {inKind.map((f) => (
                <Row
                  key={f.path}
                  file={f}
                  selected={f.path === selected}
                  showRoot={ambiguous.has(f.title ?? f.label)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** One file's in-progress edit, parked while another file is on screen. */
interface Draft {
  doc: InstructionDoc;
  raw: string;
  rawMode: boolean;
}

interface InstructionsViewProps {
  /** Workspace roots to scan, and the allowlist the backend re-derives. */
  roots: string[];
  /** Which agent CLIs are on PATH, keyed by bin (projects.ts). */
  installed: Record<string, boolean>;
  /** File to open. Changes when a panel row is clicked while the tab is already
   *  open, so it has to be watched, not just read at mount. */
  focus?: string;
  /** False while another tab is in front. Doc tabs stay mounted (display:none),
   *  so without this the ⌘S handler below would fire for a dirty Instructions
   *  tab sitting in the background — swallowing the keystroke from the editor
   *  the user is actually in, and silently writing an instruction file. */
  active: boolean;
  onNotice: Notify;
}

export function InstructionsView({
  roots,
  installed,
  focus,
  active,
  onNotice,
}: InstructionsViewProps) {
  const [files, setFiles] = useState<ipc.InstructionFile[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  /** Which groups have their "Others" (formats not created here) drawer open. */
  const [openOthers, setOpenOthers] = useState<Record<string, boolean>>({});

  const [doc, setDoc] = useState<InstructionDoc | null>(null);
  const [raw, setRaw] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Unsaved edits, per file. Switching to another row and back restores what
   *  you had rather than losing it — the row list sits one click from the
   *  editor and the dirty dot is easy to miss, so silently discarding on a
   *  stray click was the wrong trade. Cleared for a file once it saves. */
  const drafts = useRef(new Map<string, Draft>());

  // Keyed on the roots' contents rather than the array: ProjectView rebuilds
  // that array on every render, so depending on its identity would re-walk the
  // filesystem every time an agent event ticked the view. The same `rootsKey`
  // idiom is used throughout ProjectView and the Palette.
  const rootsKey = roots.join("\n");
  const rescan = useCallback(() => {
    void ipc
      .instructionsScan(rootsKey.split("\n"))
      .then(setFiles)
      .catch((e) => {
        setFiles([]);
        onNotice(`Couldn't look for instruction files: ${e}`, "error");
      });
  }, [rootsKey, onNotice]);

  useEffect(rescan, [rescan]);

  const installedAgents = useMemo(() => {
    const ids = new Set(AGENT_CLIS.filter((c) => installed[c.bin]).map((c) => c.id));
    // Antigravity and Gemini CLI share ~/.gemini, so one implies the other's files.
    if (ids.has("agy")) ids.add("gemini");
    return ids;
  }, [installed]);

  /** A row earns its place if its CLI is installed here, or if the file exists
   *  regardless — Canopy only probes for the CLIs it launches, so for Cursor,
   *  Copilot and the rest, a file on disk is the evidence that they're in use. */
  const relevant = useMemo(() => {
    if (!files) return [];
    return files.filter(
      (f) => showAll || f.exists || f.agents.some((a) => installedAgents.has(a)),
    );
  }, [files, showAll, installedAgents]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return relevant;
    return relevant.filter((f) =>
      [f.label, f.title, f.description, f.path, ...f.agents.map(agentName)]
        .filter(Boolean)
        .some((s) => (s as string).toLowerCase().includes(q)),
    );
  }, [relevant, query]);

  /** Labels that appear under more than one workspace root. Three rows all
   *  reading "AGENTS.md" are indistinguishable, so those rows — and only those
   *  — carry the root they belong to. */
  const ambiguous = useMemo(() => {
    const roots = new Map<string, string>();
    const dupes = new Set<string>();
    for (const f of shown) {
      const key = f.title ?? f.label;
      const seen = roots.get(key);
      if (seen === undefined) roots.set(key, f.root);
      else if (seen !== f.root) dupes.add(key);
    }
    return dupes;
  }, [shown]);

  const current = files?.find((f) => f.path === selected) ?? null;

  /** Switch files, parking whatever is unsaved on the way out. */
  const select = useCallback(
    (path: string) => {
      setSelected((prev) => {
        if (prev && prev !== path && dirtyRef.current && docRef.current) {
          drafts.current.set(prev, {
            doc: docRef.current,
            raw: rawRef.current,
            rawMode: rawModeRef.current,
          });
        }
        return path;
      });
    },
    [],
  );

  // Read by `select`, which runs inside a state updater and so can't close over
  // the current render's values.
  const docRef = useRef(doc);
  docRef.current = doc;
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const rawModeRef = useRef(rawMode);
  rawModeRef.current = rawMode;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Load the selected file — from its parked draft if it has one, otherwise
  // from disk. A file that doesn't exist yet opens on its template, unsaved, so
  // nothing hits the disk until the user actually writes it.
  useEffect(() => {
    if (!current) {
      setDoc(null);
      return;
    }
    let live = true;
    setLoadError(null);
    const parked = drafts.current.get(current.path);
    if (parked) {
      setDoc(parked.doc);
      setRaw(parked.raw);
      setRawMode(parked.rawMode);
      setDirty(true);
      return;
    }
    setDirty(false);
    setRawMode(false);
    if (!current.exists) {
      const t = template(current);
      setRaw(t);
      setDoc(parseDoc(t));
      setDirty(true);
      return;
    }
    void ipc
      .instructionsRead(current.path, roots)
      .then((text) => {
        if (!live) return;
        setRaw(text);
        setDoc(parseDoc(text));
      })
      .catch((e) => live && setLoadError(String(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.path, current?.exists]);

  /** Edit a section: mark it dirty so the serializer regenerates that one and
   *  re-emits every other verbatim. */
  const patchSection = (id: string, patch: Partial<DocSection>) => {
    setDoc((d) =>
      d
        ? {
            ...d,
            sections: d.sections.map((s) => (s.id === id ? { ...s, ...patch, dirty: true } : s)),
          }
        : d,
    );
    setDirty(true);
  };

  const save = () => {
    if (!current || !doc) return;
    const text = rawMode ? raw : serializeDoc(doc);
    void ipc
      .instructionsWrite(current.path, roots, text)
      .then(() => {
        // Re-parse from what was written, so section `raw` matches the file
        // again and the next edit diffs against the truth rather than a stale
        // pre-save copy.
        setRaw(text);
        setDoc(parseDoc(text));
        setDirty(false);
        // Saved, so there is nothing left to park for this file.
        drafts.current.delete(current.path);
        rescan();
        onNotice(`Saved ${current.label}`, "success");
      })
      .catch((e) => onNotice(`Couldn't save ${current.label}: ${e}`, "error"));
  };

  // ⌘S, but only while this tab is the one in front — see `active`. The
  // listener is on window because that is where the keystroke lands, so the
  // gate has to be explicit; "scoped to the view" is not something a window
  // listener gets for free.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!active || !dirty) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, dirty]);

  // The tab is reused: clicking a second file in the Agents panel patches
  // `focus` onto the open tab rather than opening another, so reading it only
  // at mount left the previous file on screen.
  useEffect(() => {
    if (focus) select(focus);
  }, [focus, select]);

  const addSection = () => {
    setDoc((d) =>
      d
        ? {
            ...d,
            sections: [
              ...d.sections,
              {
                id: `new-${d.sections.length}-${Date.now()}`,
                level: 2,
                heading: "New section",
                raw: "",
                body: "",
                items: [""],
                dirty: true,
              },
            ],
          }
        : d,
    );
    setDirty(true);
  };

  const removeSection = (id: string) => {
    setDoc((d) => (d ? { ...d, sections: d.sections.filter((s) => s.id !== id) } : d));
    setDirty(true);
  };

  const moveSection = (id: string, by: number) => {
    setDoc((d) => {
      if (!d) return d;
      const i = d.sections.findIndex((s) => s.id === id);
      const j = i + by;
      if (i === -1 || j < 0 || j >= d.sections.length) return d;
      const sections = [...d.sections];
      [sections[i], sections[j]] = [sections[j], sections[i]];
      // Reordering rewrites both, so both have to be regenerated — a moved
      // section's verbatim source carries its old neighbours' spacing.
      sections[i] = { ...sections[i], dirty: true };
      sections[j] = { ...sections[j], dirty: true };
      return { ...d, sections };
    });
    setDirty(true);
  };

  const frontmatterFields = useMemo(
    () => parseFrontmatter(doc?.frontmatter ?? null).filter((f) => f.key !== ""),
    [doc?.frontmatter],
  );

  return (
    <div className="instr">
      <div className="instr-list">
        <div className="instr-list-head">
          <input
            className="agent-query-input"
            placeholder="Search instructions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="instr-toggle" title="Include formats for CLIs you don't have installed">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            All formats
          </label>
        </div>

        {files === null ? (
          <div className="tree-empty">Looking…</div>
        ) : shown.length === 0 ? (
          <div className="tree-empty">
            Nothing matches. Turn on “All formats” to see every instruction file Canopy
            knows how to create.
          </div>
        ) : (
          GROUPS.map((g) => {
            const rows = shown.filter((f) => groupOf(f) === g.id);
            if (rows.length === 0) return null;
            // The list answers "what is shaping agents here?" — so the files
            // that exist are the list, and every format that could exist but
            // doesn't waits in a drawer. Left flat, a dozen "not created" rows
            // bury the three that are actually being read.
            const present = rows.filter((f) => f.exists);
            const others = rows.filter((f) => !f.exists);
            // A search that only matches uncreated formats must not come back
            // empty-handed, so searching opens the drawer rather than toggling.
            const searching = query.trim() !== "";
            const othersOpen = searching || openOthers[g.id] === true;
            return (
              <div className="instr-group" key={g.id}>
                <div className="instr-group-head" title={g.note}>
                  <span>{g.title}</span>
                  {present.length > 0 && <span className="badge">{present.length}</span>}
                </div>
                {/* Split again by kind, so "Skills & subagents" isn't one run of
                    eleven identical-looking lines. */}
                <KindSections
                  rows={present}
                  selected={selected}
                  ambiguous={ambiguous}
                  onSelect={select}
                />
                {present.length === 0 && !othersOpen && (
                  <div className="instr-none">None here yet</div>
                )}
                {others.length > 0 && (
                  <div
                    className="instr-others"
                    title="Formats Canopy knows how to create in this project, but that don't exist yet"
                    onClick={
                      searching
                        ? undefined
                        : () => setOpenOthers((o) => ({ ...o, [g.id]: !o[g.id] }))
                    }
                  >
                    <span className="tree-chevron">{othersOpen ? "▾" : "▸"}</span>
                    Others — not created
                    <span className="badge">{others.length}</span>
                  </div>
                )}
                {othersOpen && (
                  // Sectioned the same way as the files that do exist: the
                  // drawer holds several kinds at once, and an uncreated skill
                  // and an uncreated rule are not the same offer.
                  <div className="instr-drawer">
                    <KindSections
                      rows={others}
                      selected={selected}
                      ambiguous={ambiguous}
                      onSelect={select}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="instr-doc">
        {!current ? (
          <div className="editor-empty">
            <h2>Agent instructions</h2>
            <p>
              Pick a file to read or edit it. These are the files your agents load before
              they see any of your code — the project's own, yours across every project,
              and the skills and subagents they reach for on demand.
            </p>
          </div>
        ) : (
          <>
            <div className="instr-doc-head">
              <div className="instr-doc-title">
                <InstructionKindIcon kind={current.kind} size={15} />
                <span>{current.label}</span>
                <span className="instr-kind">{KIND_LABEL[current.kind] ?? current.kind}</span>
                {dirty && <span className="instr-dot" title="Unsaved changes" />}
              </div>
              <div className="instr-doc-meta">
                <span className="instr-doc-read">
                  Read by
                  {current.agents.map((a) => (
                    <span className="instr-read-agent" key={a}>
                      <AgentMark id={a} size={12} />
                      {agentName(a)}
                    </span>
                  ))}
                </span>
                <span className="status-spacer" />
                <button
                  className={`btn ${rawMode ? "btn-accent" : ""}`}
                  title="Edit the markdown directly — for anything the section editor can't model"
                  onClick={() => {
                    // Leaving raw mode re-parses, so section edits carry on from
                    // whatever the raw editor left behind rather than from a
                    // stale tree.
                    if (rawMode) setDoc(parseDoc(raw));
                    else if (doc) setRaw(serializeDoc(doc));
                    setRawMode(!rawMode);
                  }}
                >
                  Raw
                </button>
                <button className="btn btn-accent" disabled={!dirty} onClick={save}>
                  {current.exists ? "Save" : "Create"}
                </button>
              </div>
            </div>

            {loadError ? (
              <div className="tree-empty">Couldn't read this file: {loadError}</div>
            ) : rawMode ? (
              /* A plain textarea, not Monaco: a Monaco model is keyed by file
                 URI, so the same CLAUDE.md open in a file tab would share one
                 buffer with two dirty states. This is the escape hatch, not the
                 main editor. */
              <textarea
                className="instr-raw"
                spellCheck={false}
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value);
                  setDirty(true);
                }}
              />
            ) : (
              doc && (
                <div className="instr-sections">
                  {frontmatterFields.length > 0 && (
                    <div className="instr-card instr-fm">
                      {frontmatterFields.map((f) => (
                        <label className="instr-fm-field" key={f.key}>
                          <span>{f.key}</span>
                          <input
                            className="agent-query-input"
                            value={f.value}
                            onChange={(e) => {
                              setDoc((d) =>
                                d
                                  ? {
                                      ...d,
                                      frontmatter: setFrontmatterField(
                                        d.frontmatter,
                                        f.key,
                                        e.target.value,
                                      ),
                                    }
                                  : d,
                              );
                              setDirty(true);
                            }}
                          />
                        </label>
                      ))}
                    </div>
                  )}

                  {/* Editable, not a read-only <pre>: a file organised with a
                      single `#` per section lands wholly in the preamble (the
                      section split starts at `##`), and so does the title and
                      intro of most CLAUDE.md files. Read-only meant those were
                      reachable only through Raw. */}
                  <div className="instr-card instr-preamble">
                    <label className="instr-preamble-label">
                      Intro — everything above the first section
                    </label>
                    <textarea
                      className="instr-body"
                      spellCheck={false}
                      rows={Math.min(14, Math.max(2, doc.preamble.trim().split("\n").length + 1))}
                      value={doc.preamble.trim()}
                      onChange={(e) => {
                        setDoc((d) => (d ? { ...d, preamble: e.target.value, preambleDirty: true } : d));
                        setDirty(true);
                      }}
                    />
                  </div>

                  {doc.sections.map((s, i) => (
                    <div className="instr-card" key={s.id}>
                      <div className="instr-card-head">
                        <input
                          className="instr-heading"
                          value={s.heading}
                          onChange={(e) => patchSection(s.id, { heading: e.target.value })}
                        />
                        <button
                          className="btn-icon"
                          title="Move up"
                          disabled={i === 0}
                          onClick={() => moveSection(s.id, -1)}
                        >
                          ↑
                        </button>
                        <button
                          className="btn-icon"
                          title="Move down"
                          disabled={i === doc.sections.length - 1}
                          onClick={() => moveSection(s.id, 1)}
                        >
                          ↓
                        </button>
                        <button
                          className="btn-icon btn-danger"
                          title="Delete this section"
                          onClick={() => removeSection(s.id)}
                        >
                          <TrashIcon size={12} />
                        </button>
                      </div>

                      {s.items ? (
                        <div className="instr-items">
                          {s.items.map((item, k) => (
                            <div className="instr-item" key={k}>
                              <span className="instr-bullet">–</span>
                              <input
                                className="agent-query-input"
                                value={item}
                                onChange={(e) =>
                                  patchSection(s.id, {
                                    items: s.items?.map((x, n) => (n === k ? e.target.value : x)),
                                  })
                                }
                              />
                              <button
                                className="btn-icon btn-danger"
                                title="Remove this item"
                                onClick={() =>
                                  patchSection(s.id, {
                                    items: s.items?.filter((_, n) => n !== k),
                                  })
                                }
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          <button
                            className="instr-add-item"
                            onClick={() => patchSection(s.id, { items: [...(s.items ?? []), ""] })}
                          >
                            ＋ Add item
                          </button>
                        </div>
                      ) : (
                        <textarea
                          className="instr-body"
                          spellCheck={false}
                          rows={Math.min(18, Math.max(3, s.body.split("\n").length + 1))}
                          value={s.body}
                          onChange={(e) => patchSection(s.id, { body: e.target.value })}
                        />
                      )}
                    </div>
                  ))}

                  <button className="instr-add-section" onClick={addSection}>
                    ＋ Add section
                  </button>
                </div>
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}
