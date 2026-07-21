// Create/edit a project: name + labeled component directories.
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "../ipc";
import type { Component, Project } from "../projects";
import { newProjectId } from "../projects";
import { useEscape } from "../useEscape";

interface ProjectDialogProps {
  existing?: Project;
  onSave: (project: Project) => void;
  onCancel: () => void;
}

export function ProjectDialog({ existing, onSave, onCancel }: ProjectDialogProps) {
  const [name, setName] = useState(existing?.name ?? "");
  const [components, setComponents] = useState<Component[]>(
    existing?.components ?? [],
  );
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  const addComponent = async () => {
    const selection = await openDialog({ directory: true, multiple: true });
    const paths = Array.isArray(selection) ? selection : selection ? [selection] : [];
    const additions = paths
      .filter((p) => !components.some((c) => c.path === p))
      .map((p) => ({ path: p, label: p.split("/").pop() ?? p }));
    if (additions.length) {
      setComponents((prev) => [...prev, ...additions]);
      if (!name && additions[0]) setName(additions[0].label);
    }
  };

  // Clone a repo and add its working tree as a directory — same Component shape
  // the rest of the flow already consumes, so nothing downstream changes. The
  // user picks WHERE to clone (a parent folder); git makes the repo subdir.
  const cloneFromUrl = async () => {
    const url = cloneUrl.trim();
    if (!url || cloning) return;
    const parent = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose a folder to clone the repository into",
    });
    if (typeof parent !== "string") return; // cancelled the picker
    setCloneError(null);
    setCloning(true);
    try {
      const res = await ipc.gitClone(parent, url);
      if (components.some((c) => c.path === res.path)) {
        setCloneError("That folder is already part of this project.");
        return;
      }
      setComponents((prev) => [...prev, { path: res.path, label: res.name }]);
      if (!name) setName(res.name);
      setCloneUrl("");
    } catch (e) {
      setCloneError(String(e));
    } finally {
      setCloning(false);
    }
  };

  const patch = (i: number, label: string) =>
    setComponents((prev) => prev.map((c, j) => (j === i ? { ...c, label } : c)));

  const patchCommand = (i: number, k: number, field: "name" | "command", value: string) =>
    setComponents((prev) =>
      prev.map((c, j) =>
        j === i
          ? {
              ...c,
              commands: (c.commands ?? []).map((cmd, l) =>
                l === k ? { ...cmd, [field]: value } : cmd,
              ),
            }
          : c,
      ),
    );

  const addCommand = (i: number) =>
    setComponents((prev) =>
      prev.map((c, j) =>
        j === i
          ? { ...c, commands: [...(c.commands ?? []), { name: "", command: "" }] }
          : c,
      ),
    );

  const removeCommand = (i: number, k: number) =>
    setComponents((prev) =>
      prev.map((c, j) =>
        j === i
          ? { ...c, commands: (c.commands ?? []).filter((_, l) => l !== k) }
          : c,
      ),
    );

  const valid = name.trim().length > 0 && components.length > 0;

  useEscape(onCancel);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{existing ? "Edit project" : "New project"}</h3>
        <label className="field">
          <span>Project name</span>
          <input
            autoFocus
            value={name}
            placeholder="my-app"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {/* Two visual levels, because the flat version read as a wall of
            identical boxes: directory CARDS (folder glyph + name + dimmed
            path) contain an indented, labeled "Run commands" zone whose ▶
            marks match the play buttons those commands become in the
            sidebar. */}
        <div className="pd-section">
          <div className="pd-section-head">
            <span>Directories</span>
            <small>
              The folders this project is made of — one repo, or several
              (frontend, backend, …). Each gets its own file tree and
              terminals.
            </small>
          </div>
          {components.map((c, i) => (
            <div key={c.path} className="pd-dir-card">
              <div className="pd-dir-head">
                <svg width="16" height="14" viewBox="0 0 16 14" className="pd-dir-glyph">
                  <path
                    d="M1.5 2.5h4l1.5 1.5h7.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"
                    fill="#dcb67a"
                  />
                </svg>
                <div className="pd-dir-title">
                  <input
                    className="pd-dir-label"
                    value={c.label}
                    title="Display name for this directory"
                    onChange={(e) => patch(i, e.target.value)}
                  />
                  <span className="pd-dir-path" title={c.path}>
                    {c.path}
                  </span>
                </div>
                <button
                  className="btn-icon"
                  title="Remove from project — the folder on disk is untouched"
                  onClick={() =>
                    setComponents((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  ✕
                </button>
              </div>
              <div className="pd-cmds">
                <div className="pd-cmds-head">
                  <span>Run commands</span>
                  <small>
                    Servers and tasks for this folder — they show up as ▶ play
                    buttons in the sidebar.
                  </small>
                </div>
                {(c.commands ?? []).map((cmd, k) => (
                  <div key={k} className="pd-cmd-row">
                    <span className="pd-cmd-play">▶</span>
                    <input
                      className="pd-cmd-name"
                      placeholder="name — e.g. web"
                      value={cmd.name}
                      onChange={(e) => patchCommand(i, k, "name", e.target.value)}
                    />
                    <input
                      className="pd-cmd-cmd"
                      placeholder="command — e.g. pnpm run dev"
                      value={cmd.command}
                      onChange={(e) => patchCommand(i, k, "command", e.target.value)}
                    />
                    <button className="btn-icon" onClick={() => removeCommand(i, k)}>
                      ✕
                    </button>
                  </div>
                ))}
                <button className="btn btn-mini" onClick={() => addCommand(i)}>
                  ＋ Add command
                </button>
              </div>
            </div>
          ))}
          <div className="pd-add-row">
            <button className="btn pd-add-choice" onClick={() => void addComponent()}>
              ＋ Add directory…
            </button>
            {!cloneOpen && (
              <button
                className="btn pd-add-choice"
                onClick={() => setCloneOpen(true)}
                title="Clone a git repository and add it as a directory"
              >
                ↧ Clone from git…
              </button>
            )}
          </div>
          {cloneOpen && (
            <div className="pd-clone">
              <div className="pd-clone-group">
                <span className="pd-clone-icon" aria-hidden>↧</span>
                <input
                  className="pd-clone-url"
                  autoFocus
                  placeholder="https://github.com/user/repo.git"
                  value={cloneUrl}
                  disabled={cloning}
                  onChange={(e) => {
                    setCloneUrl(e.target.value);
                    if (cloneError) setCloneError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void cloneFromUrl();
                    }
                  }}
                />
                <button
                  className="btn btn-accent pd-clone-go"
                  disabled={!cloneUrl.trim() || cloning}
                  onClick={() => void cloneFromUrl()}
                >
                  {cloning ? "Cloning…" : "Clone"}
                </button>
              </div>
              {!cloning && (
                <button
                  className="btn-icon pd-clone-cancel"
                  title="Cancel"
                  onClick={() => {
                    setCloneOpen(false);
                    setCloneError(null);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          )}
          {cloneError && <div className="pd-clone-error">{cloneError}</div>}
          {cloning && (
            <div className="pd-clone-hint">Cloning — this can take a moment for large repos…</div>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={!valid}
            onClick={() =>
              onSave({
                // Spread first: this dialog only edits name/components, and the
                // caller replaces the whole project object. Rebuilding from
                // scratch silently dropped fields it doesn't own (shareContext),
                // which revoked the hook scope on every Save.
                ...existing,
                id: existing?.id ?? newProjectId(),
                name: name.trim(),
                components,
              })
            }
          >
            {existing ? "Save" : "Create & open"}
          </button>
        </div>
      </div>
    </div>
  );
}
