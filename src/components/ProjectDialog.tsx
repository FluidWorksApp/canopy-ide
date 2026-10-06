// Create/edit a project: name + labeled component directories.
import { useState, useRef } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "../ipc";
import { basename } from "../paths";
import type { Component, Project } from "../projects";
import { newComponentId, newProjectId, newRunCommandId } from "../projects";
import { useEscape } from "../useEscape";
import { FilesIcon } from "./icons";
import { Button } from "./ui";
import { getSettings } from "../settings";
import {isRemoteHost} from "../host";
import {Dialog} from "./Dialog";
import {DirectoryPicker} from "../remoteExecution/DirectoryPicker";

interface ProjectDialogProps {
  existing?: Project;
  onSave: (project: Project) => void | Promise<void>;
  onCancel: () => void;
}

export function ProjectDialog({ existing, onSave, onCancel }: ProjectDialogProps) {
  const [saving,setSaving]=useState(false);
  const [name, setName] = useState(existing?.name ?? "");
  const [components, setComponents] = useState<Component[]>(
    existing?.components ?? [],
  );
  const knownVibe = existing?.vibe?.version === 1 ? existing.vibe : undefined;
  const [vibeComponentId, setVibeComponentId] = useState(
    knownVibe?.componentId ?? "",
  );
  const [vibeRunCommandId, setVibeRunCommandId] = useState(
    knownVibe?.runCommandId ?? "",
  );
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneProgress,setCloneProgress]=useState<ipc.GitCloneProgress|null>(null);
  const [cloneCancelling,setCloneCancelling]=useState(false);
  const pendingCloneCancel=useRef(false);
  const [cloneParent,setCloneParent]=useState("");
  const [cloneError, setCloneError] = useState<string | null>(null);

  const [picker,setPicker]=useState<{multiple:boolean;resolve:(value:string|string[]|null)=>void}|null>(null);
  const chooseDirectory=(options:{directory:true;multiple:boolean;title?:string}):Promise<string|string[]|null> => isRemoteHost()
    ? new Promise(resolve=>setPicker({multiple:options.multiple,resolve}))
    : openDialog(options);
  const addComponent = async () => {
    const selection = await chooseDirectory({ directory: true, multiple: true });
    const paths = Array.isArray(selection) ? selection : selection ? [selection] : [];
    const additions = paths
      .filter((p) => !components.some((c) => c.path === p))
      .map((p) => ({ id: newComponentId(), path: p, label: basename(p) || p }));
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
    const parent = await chooseDirectory({
      directory: true,
      multiple: false,
      title: "Choose a folder to clone the repository into",
    });
    if (typeof parent !== "string") return; // cancelled the picker
    setCloneError(null);
    setCloning(true);setCloneParent(parent);setCloneProgress(null);setCloneCancelling(false);pendingCloneCancel.current=false;
    let stop:(()=>void)|undefined;
    try {
      if(isRemoteHost())stop=await ipc.onGitCloneProgress(p=>{if(p.url===url&&p.parent===parent){setCloneProgress(p);if(pendingCloneCancel.current){pendingCloneCancel.current=false;void ipc.gitCloneCancel(p.id).catch(e=>{setCloneError(String(e));setCloneCancelling(false);});}}});
      const res = await ipc.gitClone(parent, url);
      if (components.some((c) => c.path === res.path)) {
        setCloneError("That folder is already part of this project.");
        return;
      }
      setComponents((prev) => [
        ...prev,
        { id: newComponentId(), path: res.path, label: res.name },
      ]);
      if (!name) setName(res.name);
      setCloneUrl("");
    } catch (e) {
      setCloneError(String(e));
    } finally {
      stop?.();setCloneProgress(null);
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
          ? {
              ...c,
              commands: [
                ...(c.commands ?? []),
                { id: newRunCommandId(), name: "", command: "" },
              ],
            }
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
  const vibeComponent = components.find((component) => component.id === vibeComponentId);
  const vibeCommand = vibeComponent?.commands?.find(
    (command) => command.id === vibeRunCommandId,
  );

  useEscape(onCancel,!cloning);

  if(cloning&&isRemoteHost())return <Dialog title="Cloning repository" size="sm" body="Please wait while Git downloads the repository." meta={cloneProgress?.path??cloneParent} dismissLabel={cloneCancelling?'Cancelling…':'Cancel clone'} onDismiss={()=>{if(cloneCancelling)return;setCloneCancelling(true);if(!cloneProgress){pendingCloneCancel.current=true;return;}void ipc.gitCloneCancel(cloneProgress.id).catch(e=>{setCloneError(String(e));setCloneCancelling(false);});}}>
    <div className="workspace-tools">
      <p className="workspace-feedback">{cloneUrl}</p>
      <div role="status">{cloneProgress?.stage??'Connecting to repository…'}</div>
      <progress aria-label="Git clone progress" {...(cloneProgress?.percent!=null?{value:cloneProgress.percent,max:100}:{})}/>
      <small>{cloneProgress?.percent!=null?`${cloneProgress.percent}% · `:''}{cloneProgress?.elapsedSeconds??0}s elapsed</small>
      {cloneError&&<p role="alert" className="workspace-feedback error">{cloneError}</p>}
      <small>Cancellation keeps incomplete files on the remote workspace.</small>
    </div>
  </Dialog>;
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
            <div key={c.id} className="pd-dir-card">
              <div className="pd-dir-head">
                <FilesIcon size={16} className="pd-dir-glyph" />
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
                <Button icon
                  title="Remove from project — the folder on disk is untouched"
                  onClick={() =>
                    setComponents((prev) => prev.filter((_, j) => j !== i))
                  }>
                  ✕
                </Button>
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
                  <div key={cmd.id} className="pd-cmd-row">
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
                    <Button icon onClick={() => removeCommand(i, k)}>
                      ✕
                    </Button>
                  </div>
                ))}
                <Button size="sm" onClick={() => addCommand(i)}>
                  ＋ Add command
                </Button>
              </div>
            </div>
          ))}
          <div className="pd-add-row">
            <Button className="pd-add-choice" onClick={() => void addComponent()}>
              ＋ Add directory…
            </Button>
            {!cloneOpen && (
              <Button className="pd-add-choice"
                onClick={() => setCloneOpen(true)}
                title="Clone a git repository and add it as a directory">
                ↧ Clone from git…
              </Button>
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
                <Button variant="accent" className="pd-clone-go"
                  disabled={!cloneUrl.trim() || cloning}
                  onClick={() => void cloneFromUrl()}>
                  {cloning ? "Cloning…" : "Clone"}
                </Button>
              </div>
              {!cloning && (
                <Button icon className="pd-clone-cancel"
                  title="Cancel"
                  onClick={() => {
                    setCloneOpen(false);
                    setCloneError(null);
                  }}>
                  ✕
                </Button>
              )}
            </div>
          )}
          {cloneError && <div className="pd-clone-error">{cloneError}</div>}
          {cloning && (
            <div className="pd-clone-hint">Cloning — this can take a moment for large repos…</div>
          )}
        </div>
        {knownVibe && (
          <div className="pd-section">
            <div className="pd-section-head">
              <span>Build target</span>
              <small>
                Build mode uses this exact directory and run command. Missing or
                removed selections stay in needs setup instead of guessing.
              </small>
            </div>
            <label className="field">
              <span>Component</span>
              <select
                value={vibeComponent ? vibeComponentId : ""}
                onChange={(event) => {
                  setVibeComponentId(event.target.value);
                  setVibeRunCommandId("");
                }}
              >
                <option value="">Needs setup</option>
                {components.map((component) => (
                  <option key={component.id} value={component.id}>
                    {component.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Run command</span>
              <select
                value={vibeCommand ? vibeRunCommandId : ""}
                disabled={!vibeComponent}
                onChange={(event) => setVibeRunCommandId(event.target.value)}
              >
                <option value="">Needs setup</option>
                {(vibeComponent?.commands ?? [])
                  .filter((command) => command.command.trim())
                  .map((command) => (
                    <option key={command.id} value={command.id}>
                      {command.name || command.command}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
        <div className="modal-actions">
          <Button onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="accent"
            disabled={!valid || saving || cloning}
            onClick={async () => {
              if(saving)return;
              setSaving(true);
              try { await onSave({
                // Spread first: this dialog only edits name/components, and the
                // caller replaces the whole project object. Rebuilding from
                // scratch silently dropped fields it doesn't own (shareContext),
                // which revoked the hook scope on every Save.
                ...existing,
                id: existing?.id ?? newProjectId(),
                name: name.trim(),
                components,
                ...(knownVibe
                  ? {
                      vibe: {
                        ...knownVibe,
                        componentId: vibeComponentId || undefined,
                        runCommandId: vibeRunCommandId || undefined,
                      },
                    }
                  : existing
                    ? {}
                    : {
                        vibe: {
                          version: 1,
                          enabled: getSettings().defaultProjectLens === "build",
                        },
                      }),
              }); } finally { setSaving(false); }
            }}>
            {saving ? "Saving…" : existing ? "Save" : "Create & open"}
          </Button>
        </div>
      </div>
    {picker && <DirectoryPicker multiple={picker.multiple} onCancel={()=>{picker.resolve(null);setPicker(null);}} onSelect={paths=>{picker.resolve(picker.multiple?paths:paths[0]);setPicker(null);}}/>}
      </div>
  );
}
