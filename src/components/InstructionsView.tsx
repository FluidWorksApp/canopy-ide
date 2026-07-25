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
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { TrashIcon } from "./icons";

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

interface InstructionsViewProps {
  /** Workspace roots to scan, and the allowlist the backend re-derives. */
  roots: string[];
  /** Which agent CLIs are on PATH, keyed by bin (projects.ts). */
  installed: Record<string, boolean>;
  /** Path to open on mount — set when a panel row was clicked. */
  focus?: string;
  onNotice: Notify;
}

export function InstructionsView({ roots, installed, focus, onNotice }: InstructionsViewProps) {
  const [files, setFiles] = useState<ipc.InstructionFile[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(focus ?? null);

  const [doc, setDoc] = useState<InstructionDoc | null>(null);
  const [raw, setRaw] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const rescan = useCallback(() => {
    void ipc
      .instructionsScan(roots)
      .then(setFiles)
      .catch((e) => {
        setFiles([]);
        onNotice(`Couldn't look for instruction files: ${e}`, "error");
      });
  }, [roots, onNotice]);

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

  const current = files?.find((f) => f.path === selected) ?? null;

  // Load the selected file. A missing one opens on its template — unsaved, so
  // nothing hits the disk until the user actually writes it.
  useEffect(() => {
    if (!current) {
      setDoc(null);
      return;
    }
    let live = true;
    setLoadError(null);
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
        rescan();
        onNotice(`Saved ${current.label}`, "success");
      })
      .catch((e) => onNotice(`Couldn't save ${current.label}: ${e}`, "error"));
  };

  // ⌘S while this tab is in front. Scoped to the view, so it can't fight the
  // editor's own save when a file tab is the one focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && dirty) {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
            return (
              <div key={g.id}>
                <div className="ticket-state-head" title={g.note}>
                  {g.title}
                  <span className="badge">{rows.length}</span>
                </div>
                {rows.map((f) => (
                  <div
                    className={`instr-row ${f.path === selected ? "is-sel" : ""} ${
                      f.exists ? "" : "is-missing"
                    }`}
                    key={f.path}
                    title={f.description ?? f.path}
                    onClick={() => setSelected(f.path)}
                  >
                    <div className="instr-row-main">
                      <span className="instr-row-label">{f.title ?? f.label}</span>
                      {!f.exists && <span className="instr-missing">not created</span>}
                    </div>
                    <div className="instr-row-sub">
                      <span className="instr-kind">{KIND_LABEL[f.kind] ?? f.kind}</span>
                      {/* Three chips, then a count: AGENTS.md is read by a dozen
                          tools and naming them all would bury the filename. */}
                      {f.agents.slice(0, 3).map((a) => (
                        <span className="instr-chip" key={a}>
                          {agentName(a)}
                        </span>
                      ))}
                      {f.agents.length > 3 && (
                        <span
                          className="instr-chip instr-chip-more"
                          title={f.agents.map(agentName).join(", ")}
                        >
                          +{f.agents.length - 3}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
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
                <span>{current.label}</span>
                {dirty && <span className="instr-dot" title="Unsaved changes" />}
              </div>
              <div className="instr-doc-meta">
                <span>Read by {current.agents.map(agentName).join(", ")}</span>
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

                  {doc.preamble.trim() && (
                    <div className="instr-card instr-preamble">
                      <pre>{doc.preamble.trim()}</pre>
                    </div>
                  )}

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
