// Create/edit a project: name + labeled component directories.
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Component, Project } from "../projects";
import { newProjectId } from "../projects";

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
        <div className="field">
          <span>
            Components <small>(labeled directories: frontend, backend, …)</small>
          </span>
          {components.map((c, i) => (
            <div key={c.path} className="component-block">
              <div className="component-row">
                <input
                  className="component-label"
                  value={c.label}
                  onChange={(e) => patch(i, e.target.value)}
                />
                <span className="component-path" title={c.path}>
                  {c.path}
                </span>
                <button
                  className="btn-icon"
                  onClick={() =>
                    setComponents((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  ✕
                </button>
              </div>
              {(c.commands ?? []).map((cmd, k) => (
                <div key={k} className="command-row">
                  <input
                    className="command-name"
                    placeholder="name (e.g. dev)"
                    value={cmd.name}
                    onChange={(e) => patchCommand(i, k, "name", e.target.value)}
                  />
                  <input
                    className="command-cmd"
                    placeholder="command (e.g. npm run dev)"
                    value={cmd.command}
                    onChange={(e) => patchCommand(i, k, "command", e.target.value)}
                  />
                  <button className="btn-icon" onClick={() => removeCommand(i, k)}>
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn btn-mini" onClick={() => addCommand(i)}>
                ＋ run command
              </button>
            </div>
          ))}
          <button className="btn" onClick={() => void addComponent()}>
            ＋ Add directory…
          </button>
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
